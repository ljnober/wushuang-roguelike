/**
 * 敌人 AI（ARCHITECTURE §6.3 order 5 / DESIGN §4）。
 *
 * 敌人多目标策略：最近 / 最弱 / 最高威胁；retargetTimer 到期才重新选目标；
 * targetNetId 经 EntityRegistry 端口解析回 eid，避免 eid 漂移。
 * 影子玩家的 Brain 由批次 A 的 AIShadowPlayerSystem 通过 ControlSourceRegistry 负责，
 * 本系统只处理 Faction=Enemy 的真实敌人，不重复实现玩家 AI。
 */
import { TICK_DT } from '../../core/Constants';
import { hash32, Rng } from '../../core/Rng';
import { DamageFlag } from '../components/core';
import { AIPolicy, AIStateValue } from '../components/ai';
import type { Eid } from '../bit/types';
import { has, query, type BattleWorld } from '../bit/adapter';
import {
  AIState,
  Attack,
  Behavior,
  Faction,
  Health,
  NetId,
  PlayerTag,
  Position,
  Threat,
} from '../bit/components';
import { FactionValue } from '../components/core';
import { cosLut, sinLut } from '../../engine/SweptCollision';
import { fireProjectile, writeHit } from './CombatSystems';
import { battleSession, netIdOf, resolveTargetNetId } from './LifecycleSystems';
import type { SimState } from '../scheduler';

const BEHAVIOR_KITE = 1;
const BEHAVIOR_CHARGE = 2;
const BEHAVIOR_BOSS = 5;
const TELEGRAPH = 4;

/** order 5：敌人选目标 + 追击 + 攻击。 */
export class AISystem {
  private readonly rng = new Rng(1);
  private readonly playerTerms = [PlayerTag, Position, Health];
  private readonly enemyTerms = [AIState, Behavior, Position, Faction, Health, Attack];

  run(state: SimState, tick: number): void {
    const world = state.world;
    const session = battleSession(state);
    const players = query(world, this.playerTerms);
    if (players.length === 0) {
      return;
    }
    const enemies = query(world, this.enemyTerms);

    for (let i = 0; i < enemies.length; i++) {
      const eid = enemies[i];
      if (Faction.value[eid] !== FactionValue.Enemy || Health.cur[eid] <= 0) {
        continue;
      }

      AIState.retargetTimer[eid] -= TICK_DT;
      let target = AIState.target[eid] as Eid;
      const resolved = resolveTargetNetId(AIState.targetNetId[eid], AIState.target[eid] as Eid);
      if (AIState.retargetTimer[eid] <= 0 || resolved === 0 || !has(world, resolved, Health) || Health.cur[resolved] <= 0) {
        target = this.pickTarget(state, eid, players, tick, session.roomSeed);
        AIState.target[eid] = target >>> 0;
        AIState.targetNetId[eid] = has(world, target, NetId) ? NetId.value[target] : netIdOf(world, target);
        AIState.retargetTimer[eid] = 0.45 + this.rng.next() * 0.35;
      }

      const tx = Position.x[target];
      const ty = Position.y[target];
      const dx = tx - Position.x[eid];
      const dy = ty - Position.y[eid];
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inv = dist > 0 ? 1 / dist : 0;
      const dirX = dx * inv;
      const dirY = dy * inv;
      Behavior.p0[eid] = dirX;
      Behavior.p1[eid] = dirY;

      const behavior = Behavior.type[eid];
      const ranged = behavior === BEHAVIOR_KITE || behavior === BEHAVIOR_BOSS;
      const standoff = behavior === BEHAVIOR_KITE ? 170 : behavior === BEHAVIOR_BOSS ? 80 : 0;
      if (standoff > 0 && dist < standoff) {
        Behavior.p0[eid] = -dirX;
        Behavior.p1[eid] = -dirY;
      } else if (standoff > 0 && dist < standoff * 1.25) {
        Behavior.p0[eid] = -dirY * 0.6;
        Behavior.p1[eid] = dirX * 0.6;
      }
      if (behavior === BEHAVIOR_CHARGE) {
        Behavior.p0[eid] = dirX * 1.25;
        Behavior.p1[eid] = dirY * 1.25;
      }

      AIState.state[eid] = dist <= Attack.range[eid] ? AIStateValue.Attack : AIStateValue.Chase;
      if (Attack.cd[eid] <= 0 && dist <= Attack.range[eid] && AIState.state[eid] !== TELEGRAPH) {
        const sourceStats = has(world, eid, Threat) ? Threat.value[eid] : 1;
        const chance = Math.min(0.5, 0.05 + sourceStats * 0.02);
        const crit = this.rng.next() < chance;
        const damage = Attack.damage[eid] * (crit ? 1.5 : 1);
        const flags = crit ? DamageFlag.Critical : 0;
        if (ranged) {
          fireProjectile(state, eid, dirX, dirY, 340, damage, 2.5, FactionValue.Enemy, 0);
        } else {
          writeHit(world, target, damage, flags, eid);
        }
        Attack.cd[eid] = Attack.rate[eid] > 0 ? 1 / Attack.rate[eid] : 1;
      }

      // BOSS 预警：telegraph 期间停步，倒计时结束后按确定性扇形放出弹幕。
      if (behavior === BEHAVIOR_BOSS) {
        if (AIState.state[eid] === AIStateValue.Telegraph) {
          AIState.timer[eid] -= TICK_DT;
          if (AIState.timer[eid] <= 0) {
            this.bossPattern(state, eid, tick);
            AIState.state[eid] = AIStateValue.Attack;
          }
        } else if ((tick % 300) === 0) {
          AIState.state[eid] = AIStateValue.Telegraph;
          AIState.timer[eid] = 0.9;
          Behavior.p0[eid] = 0;
          Behavior.p1[eid] = 0;
        }
      }
    }
  }

  /** 按 AIState.policy 选目标；BOSS 走威胁加权确定性抽样。 */
  private pickTarget(
    state: SimState,
    enemy: Eid,
    players: Readonly<Uint32Array>,
    tick: number,
    seed: number,
  ): Eid {
    const world = state.world;
    const policy = AIState.policy[enemy];
    const boss = Behavior.type[enemy] === BEHAVIOR_BOSS;
    this.rng.setState(hash32(seed, enemy, tick, 0xa1ee));

    if (boss) {
      let total = 0;
      for (let i = 0; i < players.length; i++) {
        const eid = players[i];
        if (Health.cur[eid] <= 0) {
          continue;
        }
        total += this.threatOf(world, eid);
      }
      if (total <= 0) {
        return players[0];
      }
      let roll = this.rng.next() * total;
      for (let i = 0; i < players.length; i++) {
        const eid = players[i];
        if (Health.cur[eid] <= 0) {
          continue;
        }
        roll -= this.threatOf(world, eid);
        if (roll <= 0) {
          return eid;
        }
      }
      return players[players.length - 1];
    }

    let best = players[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < players.length; i++) {
      const eid = players[i];
      if (Health.cur[eid] <= 0) {
        continue;
      }
      const dx = Position.x[eid] - Position.x[enemy];
      const dy = Position.y[eid] - Position.y[enemy];
      const distSq = dx * dx + dy * dy;
      let score: number;
      if (policy === AIPolicy.Weakest) {
        score = Health.cur[eid];
      } else if (policy === AIPolicy.HighestThreat) {
        score = -this.threatOf(world, eid);
      } else {
        score = distSq;
      }
      if (score < bestScore) {
        bestScore = score;
        best = eid;
      }
    }
    return best;
  }

  /** 玩家没有 Threat 组件时以剩余生命与攻击力加权，结果仍完全确定。 */
  private threatOf(world: BattleWorld, eid: Eid): number {
    let threat = 1;
    if (has(world, eid, Threat)) {
      threat = Threat.value[eid];
    }
    return Math.max(0.001, threat + Health.cur[eid] * 0.002 + Attack.damage[eid] * 0.01);
  }

  /** BOSS 预警结束：8 向弹幕，角度由确定性查表得出。 */
  private bossPattern(state: SimState, eid: Eid, tick: number): void {
    this.rng.setState(hash32(battleSession(state).roomSeed, eid, tick, 0xb055));
    const base = this.rng.next() * Math.PI * 2;
    for (let i = 0; i < 8; i++) {
      const angle = base + (i * Math.PI * 2) / 8;
      fireProjectile(state, eid, cosLut(angle), sinLut(angle), 260, Attack.damage[eid], 3, FactionValue.Enemy, 0);
    }
  }
}
