/**
 * 战斗系统族（ARCHITECTURE §6.3 order 7/8/9）。
 *
 * BulletSystem 负责弹幕积分；CollisionSystem 用 [px,py]→[x,y] 线段扫掠判命中；
 * DamageSystem 消费 Damage 分量、处理无敌帧与死亡事件。所有命中统一走
 * applyDamage / writeHit，保证伤害、暴击、事件与效果触发位只有一处实现。
 */
import { TICK_DT } from '../../core/Constants';
import { GameEventType } from '../bridge/enums';
import type { Eid } from '../bit/types';
import { add, has, query, queryNoCommit, type BattleWorld } from '../bit/adapter';
import {
  Attack,
  Collider,
  Damage,
  Dead,
  EffectContext,
  Faction,
  Health,
  Heading,
  Invulnerable,
  Lifetime,
  PlayerTag,
  Position,
  Projectile,
  RenderRef,
  StatBlock,
  Velocity,
} from '../bit/components';
import { DamageFlag } from '../components/core';
import { TriggerBit } from '../components/effect';
import { FactionValue } from '../components/core';
import { sweepCircleCircle, type SweepHit } from '../../engine/SweptCollision';
import type { SimState } from '../scheduler';

/** 受击无敌帧：设计 §8.1 固定 0.4s。 */
export const INVULNERABLE_SEC = 0.4;

/**
 * 统一写入伤害分量（本 tick 由 DamageSystem 消费）。
 * source 仅用于事件与效果上下文，不上线。
 */
export function writeHit(
  world: BattleWorld,
  target: Eid,
  amount: number,
  flags: number,
  source: Eid,
): void {
  if (amount <= 0 || has(world, target, Dead) || has(world, target, Projectile)) {
    return;
  }
  if (!has(world, target, Damage)) {
    add(world, target, Damage);
  }
  Damage.amount[target] += amount;
  Damage.flags[target] |= flags;
  EffectContext.source[target] = source >>> 0;
}

/**
 * 立即造成伤害（效果 Action 在 order 11 执行，已经过了 DamageSystem，
 * 因此直接落 Health 并发出同样格式的事件）。
 */
export function applyDamage(
  state: SimState,
  target: Eid,
  rawAmount: number,
  flags: number,
  source: Eid,
): number {
  const world = state.world;
  if (rawAmount <= 0 || !has(world, target, Health) || has(world, target, Dead)) {
    return 0;
  }
  if (has(world, target, Invulnerable) && Invulnerable.remaining[target] > 0) {
    return 0;
  }

  const block = StatBlock as unknown as Record<string, Float32Array | undefined>;
  const armorArr = block['armor'];
  const armor = has(world, target, StatBlock) && armorArr !== undefined ? armorArr[target] : 0;
  const dealt = Math.max(1, rawAmount - armor * 0.2);
  Health.cur[target] -= dealt;

  if ((flags & DamageFlag.Critical) !== 0) {
    EffectContext.flags[0] |= TriggerBit.onCritical;
  }
  EffectContext.flags[0] |= TriggerBit.onHit | TriggerBit.onDamaged;
  EffectContext.target[0] = target >>> 0;
  EffectContext.hitValue[0] = dealt;
  state.buses.events.emit(GameEventType.Damage, target, dealt, source);

  if (has(world, target, PlayerTag)) {
    if (!has(world, target, Invulnerable)) {
      add(world, target, Invulnerable);
    }
    Invulnerable.remaining[target] = INVULNERABLE_SEC;
  }

  if (Health.cur[target] <= 0) {
    Health.cur[target] = 0;
    if (!has(world, target, Dead)) {
      add(world, target, Dead);
      EffectContext.flags[0] |= TriggerBit.onKill | TriggerBit.onDeath;
      state.buses.events.emit(GameEventType.Kill, target, source, dealt);
      if (has(world, target, PlayerTag)) {
        state.buses.events.emit(GameEventType.Death, target, source, 0);
      }
    }
  }
  return dealt;
}

/** 生成一枚弹幕。所有字段一次写齐，运行期只改 Position/Lifetime。 */
export function fireProjectile(
  state: SimState,
  source: Eid,
  dirX: number,
  dirY: number,
  speed: number,
  damage: number,
  lifetime: number,
  faction: number,
  pierce: number,
): Eid {
  const world = state.world;
  const eid = state.pool.entities.acquire();
  add(world, eid, Position);
  add(world, eid, Velocity);
  add(world, eid, Collider);
  add(world, eid, Projectile);
  add(world, eid, Faction);
  add(world, eid, Damage);
  add(world, eid, Lifetime);
  add(world, eid, RenderRef);

  const sx = has(world, source, Position) ? Position.x[source] : 0;
  const sy = has(world, source, Position) ? Position.y[source] : 0;
  let dx = dirX;
  let dy = dirY;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 0) {
    dx /= len;
    dy /= len;
  } else {
    dx = 1;
    dy = 0;
  }
  Position.x[eid] = sx + dx * 18;
  Position.y[eid] = sy + dy * 18;
  Position.px[eid] = Position.x[eid];
  Position.py[eid] = Position.y[eid];
  Velocity.x[eid] = dx * speed;
  Velocity.y[eid] = dy * speed;
  Collider.r[eid] = 6;
  Collider.type[eid] = 0;
  Collider.w[eid] = 0;
  Collider.h[eid] = 0;
  Collider.layer[eid] = faction;
  Projectile.dx[eid] = dx;
  Projectile.dy[eid] = dy;
  Projectile.speed[eid] = speed;
  Projectile.pierce[eid] = pierce;
  Projectile.hitMask[eid] = 0;
  Faction.value[eid] = faction;
  Damage.amount[eid] = damage;
  Damage.flags[eid] = faction === FactionValue.Player ? DamageFlag.Skill | DamageFlag.Projectile : 0;
  Lifetime.remaining[eid] = lifetime;
  RenderRef.kind[eid] = 4;
  RenderRef.slot[eid] = -1;
  RenderRef.dirty[eid] = 1;
  EffectContext.source[eid] = source >>> 0;
  return eid;
}

/** order 7：弹幕积分（积分前存 px/py）。 */
export class BulletSystem {
  private readonly terms = [Projectile, Position, Velocity];

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;
    const bullets = query(world, this.terms);
    for (let i = 0; i < bullets.length; i++) {
      const eid = bullets[i];
      if (has(world, eid, Dead)) {
        continue;
      }
      Position.px[eid] = Position.x[eid];
      Position.py[eid] = Position.y[eid];
      Position.x[eid] += Velocity.x[eid] * TICK_DT;
      Position.y[eid] += Velocity.y[eid] * TICK_DT;
      if (has(world, eid, RenderRef)) {
        RenderRef.dirty[eid] = 1;
      }
    }
  }
}

/** order 8：扫掠碰撞。弹幕 vs 敌我单位 + 敌人近战 vs 玩家。 */
export class CollisionSystem {
  private readonly bulletTerms = [Projectile, Position, Faction];
  private readonly unitTerms = [Health, Position, Collider, Faction];
  private readonly meleeTerms = [Attack, Position, Faction];
  private readonly playerTerms = [PlayerTag, Position, Collider];
  private readonly hit: SweepHit = { t: 0, nx: 0, ny: 0 };

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;
    const bullets = query(world, this.bulletTerms);
    const units = query(world, this.unitTerms);
    for (let i = 0; i < bullets.length; i++) {
      const bullet = bullets[i];
      if (has(world, bullet, Dead)) {
        continue;
      }
      const faction = Faction.value[bullet];
      const bx = Position.x[bullet];
      const by = Position.y[bullet];
      const br = Collider.r[bullet];
      for (let j = 0; j < units.length; j++) {
        const target = units[j];
        if (has(world, target, Dead) || Faction.value[target] === faction) {
          continue;
        }
        // hitMask 复用为「上一命中的 eid + 1」；0 表示尚未命中，避免 eid=0 与哨兵冲突。
        if (Projectile.hitMask[bullet] === target + 1) {
          continue;
        }
        if (!sweepCircleCircle(
          Position.px[bullet],
          Position.py[bullet],
          bx,
          by,
          br,
          Position.x[target],
          Position.y[target],
          Collider.r[target],
          this.hit,
        )) {
          continue;
        }
        writeHit(world, target, Damage.amount[bullet], Damage.flags[bullet], EffectContext.source[bullet]);
        Projectile.hitMask[bullet] = target + 1;
        Projectile.pierce[bullet] -= 1;
        if (Projectile.pierce[bullet] <= 0 && !has(world, bullet, Dead)) {
          add(world, bullet, Dead);
        }
        break;
      }
    }

    // 敌人近战接触：Attack.cd 控制频率，无敌帧由 DamageSystem 统一裁决。
    const attackers = query(world, this.meleeTerms);
    const players = query(world, this.playerTerms);
    for (let i = 0; i < attackers.length; i++) {
      const attacker = attackers[i];
      if (Faction.value[attacker] !== FactionValue.Enemy || has(world, attacker, Dead)) {
        continue;
      }
      if (Attack.cd[attacker] > 0) {
        continue;
      }
      for (let j = 0; j < players.length; j++) {
        const target = players[j];
        if (has(world, target, Dead)) {
          continue;
        }
        if (!sweepCircleCircle(
          Position.px[attacker],
          Position.py[attacker],
          Position.x[attacker],
          Position.y[attacker],
          Collider.r[attacker],
          Position.x[target],
          Position.y[target],
          Collider.r[target],
          this.hit,
        )) {
          continue;
        }
        writeHit(world, target, Attack.damage[attacker], DamageFlag.Contact, attacker);
        Attack.cd[attacker] = Attack.rate[attacker] > 0 ? 1 / Attack.rate[attacker] : 1;
        break;
      }
    }
  }
}

/** order 9：消费本 tick 的 Damage 分量，应用无敌帧、暴击与死亡事件。 */
export class DamageSystem {
  private readonly terms = [Damage, Health];

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;
    const entities = queryNoCommit(world, this.terms);
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const amount = Damage.amount[eid];
      const flags = Damage.flags[eid];
      Damage.amount[eid] = 0;
      Damage.flags[eid] = 0;
      if (amount <= 0 || has(world, eid, Dead)) {
        continue;
      }
      const source = EffectContext.source[eid] >>> 0;
      applyDamage(state, eid, amount, flags, source);
    }

    // 攻击冷却按 tick 推进（只依赖固定步长）。
    const attackers = query(world, [Attack]);
    for (let i = 0; i < attackers.length; i++) {
      const eid = attackers[i];
      if (Attack.cd[eid] > 0) {
        Attack.cd[eid] = Math.max(0, Attack.cd[eid] - TICK_DT);
      }
    }
  }
}

/** 供外部在命中前设定暴击标记（保持伤害计算单点）。 */
export function markCritical(state: SimState, target: Eid, source: Eid): void {
  const world = state.world;
  if (!has(world, target, Damage)) {
    add(world, target, Damage);
  }
  Damage.flags[target] |= DamageFlag.Critical;
  EffectContext.source[target] = source >>> 0;
}

/** 供 AISystem / ActionDispatch 读取 StatBlock 的暴击率。 */
export function critChance(world: BattleWorld, eid: Eid): number {
  const block = StatBlock as unknown as Record<string, Float32Array | undefined>;
  const arr = block['crit'];
  if (!has(world, eid, StatBlock) || arr === undefined) {
    return 0;
  }
  return arr[eid];
}

/** 供 AISystem 读取朝向（Heading.angle）。 */
export function headingOf(world: BattleWorld, eid: Eid): number {
  return has(world, eid, Heading) ? Heading.angle[eid] : 0;
}
