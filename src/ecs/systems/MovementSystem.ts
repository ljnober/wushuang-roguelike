/**
 * 移动系统（ARCHITECTURE §6.3 order 6）。
 *
 * InputCmd / AI 的 Behavior → Velocity → Position += v·TICK_DT。
 * 积分前把 x/y 存入 px/py，供渲染 alpha 插值与扫掠碰撞线段使用。
 * Culled 实体不参与绘制但完全参与本系统（设计 §2.2 硬性约束）。
 */
import { TICK_DT } from '../../core/Constants';
import type { Eid } from '../bit/types';
import { add, has, query, type BattleWorld } from '../bit/adapter';
import {
  AIState,
  Behavior,
  EffectContext,
  Heading,
  InputCmd,
  PlayerTag,
  Position,
  Projectile,
  RenderRef,
  Speed,
  StatBlock,
  Velocity,
} from '../bit/components';
import { TriggerBit } from '../components/effect';
import { InputButton } from '../components/view';
import type { SimState } from '../scheduler';

/** 传送 / 生成 / 和解后调用：清插值拖影，让 px/py 对齐当前 x/y。 */
export function snapInterpolation(world: BattleWorld, eid: Eid): void {
  if (!has(world, eid, Position)) {
    return;
  }
  Position.px[eid] = Position.x[eid];
  Position.py[eid] = Position.y[eid];
  if (has(world, eid, RenderRef)) {
    RenderRef.dirty[eid] = 1;
  }
}

/** 从 StatBlock 读取移动速度；没有属性块的实体回退到 Speed.value。 */
function speedOf(world: BattleWorld, eid: Eid): number {
  const block = StatBlock as unknown as Record<string, Float32Array | undefined>;
  const arr = block['moveSpeed'];
  if (has(world, eid, StatBlock) && arr !== undefined && arr[eid] > 0) {
    return arr[eid];
  }
  return Speed.value[eid];
}

/**
 * 移动系统。玩家查询与敌人查询分开，避免不同来源互相覆盖 Velocity；
 * 最终积分只查一次 [Position, Velocity]，弹幕由 BulletSystem 单独积分。
 */
export class MovementSystem {
  private readonly playerTerms = [PlayerTag, InputCmd, Velocity, Position, Heading];
  private readonly enemyTerms = [AIState, Behavior, Velocity, Position];
  private readonly moveTerms = [Position, Velocity];

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;

    // 玩家：摇杆方向归一化后乘移速；瞄准方向写 Heading。
    const players = query(world, this.playerTerms);
    for (let i = 0; i < players.length; i++) {
      const eid = players[i];
      let mx = InputCmd.moveX[eid];
      let my = InputCmd.moveY[eid];
      const len = Math.sqrt(mx * mx + my * my);
      if (len > 1) {
        mx /= len;
        my /= len;
      }
      const speed = speedOf(world, eid);
      Velocity.x[eid] = mx * speed;
      Velocity.y[eid] = my * speed;
      const ax = InputCmd.aimX[eid];
      const ay = InputCmd.aimY[eid];
      if (ax !== 0 || ay !== 0) {
        Heading.angle[eid] = Math.atan2(ay, ax);
      }
      if ((InputCmd.buttons[eid] & InputButton.Basic) !== 0) {
        EffectContext.flags[0] |= TriggerBit.onCast;
        EffectContext.source[0] = eid >>> 0;
      }
    }

    // 敌人：AISystem 已把目标方向写入 Behavior.p0/p1。
    const enemies = query(world, this.enemyTerms);
    for (let i = 0; i < enemies.length; i++) {
      const eid = enemies[i];
      let dx = Behavior.p0[eid];
      let dy = Behavior.p1[eid];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      const speed = speedOf(world, eid);
      Velocity.x[eid] = dx * speed;
      Velocity.y[eid] = dy * speed;
      if (has(world, eid, AIState) && AIState.state[eid] === 4) {
        Velocity.x[eid] = 0;
        Velocity.y[eid] = 0;
      }
    }

    // 统一积分：先存 px/py，再推进 x/y。
    const moving = query(world, this.moveTerms);
    for (let i = 0; i < moving.length; i++) {
      const eid = moving[i];
      if (has(world, eid, Projectile)) {
        continue;
      }
      Position.px[eid] = Position.x[eid];
      Position.py[eid] = Position.y[eid];
      Position.x[eid] += Velocity.x[eid] * TICK_DT;
      Position.y[eid] += Velocity.y[eid] * TICK_DT;
      if (has(world, eid, RenderRef) && (Velocity.x[eid] !== 0 || Velocity.y[eid] !== 0)) {
        RenderRef.dirty[eid] = 1;
      }
    }
  }
}

/** 统一入口：外部（如快照和解）可直接给实体打回插值初值。 */
export function snapAll(state: SimState): void {
  const entities = query(state.world, [Position]);
  for (let i = 0; i < entities.length; i++) {
    snapInterpolation(state.world, entities[i]);
  }
}

/** 给新生成实体补挂 InputCmd（A 的 spawnLocalPlayers 已挂，这里供 B2 远端实体复用）。 */
export function ensureMovementComponents(world: BattleWorld, eid: Eid): void {
  if (!has(world, eid, Velocity)) {
    add(world, eid, Velocity);
  }
  if (!has(world, eid, Speed)) {
    add(world, eid, Speed);
    Speed.value[eid] = 220;
  }
}
