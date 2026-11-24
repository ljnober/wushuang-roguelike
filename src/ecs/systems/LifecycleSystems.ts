/**
 * 生命周期系统族（ARCHITECTURE §6.3 order 1/3/4/19）。
 *
 * - TimeSystem：权威时钟由 scheduler 维护；这里维护会话派生时间、清空本 tick 触发位；
 * - LifetimeSystem：倒计时到期打 Dead；
 * - SpawnSystem：按 WaveStage 的 spawnRate 逐 tick 累加生成敌人，Host 分配 NetId；
 * - DeadRecycleSystem：最后统一回收实体 / NetId / 快照槽 / 控制源。
 *
 * 同时提供 B1 共享的轻量接口（EntityRegistryLike、BattleSessionLike、NetId 分配器），
 * 战斗层不硬依赖 net/*：B2 的 EntityRegistry 可按接口注入，Standalone 自带兜底。
 */
import { EFFECT_ENTITY_BASE, INVALID_EID, INVALID_NET_ID, TICK_DT } from '../../core/Constants';
import { hash32, Rng } from '../../core/Rng';
import type { Eid } from '../bit/types';
import { add, has, query, queryNoCommit, remove, type BattleWorld } from '../bit/adapter';
import {
  AIState,
  Attack,
  Behavior,
  Collider,
  Damage,
  Dead,
  EffectContext,
  EnemyTag,
  ExpValue,
  Faction,
  Health,
  Heading,
  Invulnerable,
  Lifetime,
  NetId,
  Owner,
  Pickup,
  PlayerTag,
  Position,
  Replicated,
  RenderRef,
  SpawnTick,
  Speed,
  StatSnapshotRef,
  Threat,
  Velocity,
} from '../bit/components';
import type { SimState } from '../scheduler';
import { cosLut, sinLut } from '../../engine/SweptCollision';

export { INVALID_EID, INVALID_NET_ID };

/** EntityRegistry 的最小结构端口；B2 的 net/EntityRegistry 天然满足。 */
export interface EntityRegistryLike {
  alloc(eid: Eid, playerId: number): number;
  bind(eid: Eid, netId: number, playerId: number): void;
  byNetId(netId: number): Eid;
  byEid(eid: Eid): number;
  playerOf(netId: number): number;
  release(netId: number): void;
}

/** 会话运行态：字段与 §5.8 NetSession 完全一致，附加字段仅供逻辑层派生。 */
export interface BattleSessionLike {
  role: number;
  localNetId: number;
  hostNetId: number;
  localPlayerId: number;
  roomSeed: number;
  simTick: number;
  lastAckedTick: number;
  tickRate: number;
  playerCount: number;
  elapsed: number;
  spawnAcc: number;
  waveIndex: number;
  nextNetId: number;
  bossSpawned: number;
  result: number;
  /** HUD 连续量：击杀/积分/展示等级(1-based)/当前经验/升级所需经验。 */
  kills: number;
  score: number;
  level: number;
  exp: number;
  expNext: number;
  /** 1=战斗进行中；0=菜单/结算期间，全部 B1 系统跳过。 */
  running: number;
  /** 本局第 0 tick 对应的 scheduler 全局 tick。 */
  startTick: number;
  [key: string]: number;
}

/** scheduler 的 session 是可变普通对象；这里做零分配视图转换。 */
export function battleSession(state: SimState): BattleSessionLike {
  return state.session as unknown as BattleSessionLike;
}

let activeRegistry: EntityRegistryLike | null = null;
let activeControlSink: { unbind(eid: Eid): void } | null = null;
const freeNetIds: number[] = [];

export function setEntityRegistry(registry: EntityRegistryLike | null): void {
  activeRegistry = registry;
}
export function getEntityRegistry(): EntityRegistryLike | null {
  return activeRegistry;
}
export function setControlSink(sink: { unbind(eid: Eid): void } | null): void {
  activeControlSink = sink;
}
export function resetNetIdAllocator(): void {
  freeNetIds.length = 0;
}

/** Host / Standalone 分配 NetId；Client 不分配。 */
export function allocNetId(session: BattleSessionLike, eid: Eid, playerId: number): number {
  if (activeRegistry !== null && session.role <= 1) {
    const netId = activeRegistry.alloc(eid, playerId);
    if (netId !== INVALID_NET_ID) {
      return netId;
    }
  }
  const reused = freeNetIds.pop();
  const netId = reused === undefined ? session.nextNetId++ : reused;
  if (activeRegistry !== null && session.role <= 1) {
    activeRegistry.bind(eid, netId, playerId);
  }
  return netId;
}

export function releaseNetId(netId: number): void {
  if (netId === INVALID_NET_ID) {
    return;
  }
  if (activeRegistry !== null) {
    activeRegistry.release(netId);
    return;
  }
  if (freeNetIds.indexOf(netId) < 0) {
    freeNetIds.push(netId);
  }
}

/** targetNetId → eid。无注入注册表时回退到本地缓存的 AIState.target。 */
export function resolveTargetNetId(netId: number, fallback: Eid = INVALID_EID): Eid {
  if (activeRegistry !== null) {
    return netId === INVALID_NET_ID ? INVALID_EID : activeRegistry.byNetId(netId);
  }
  return fallback;
}

export function netIdOf(world: BattleWorld, eid: Eid): number {
  if (has(world, eid, NetId)) {
    return NetId.value[eid];
  }
  if (activeRegistry !== null) {
    return activeRegistry.byEid(eid);
  }
  return INVALID_NET_ID;
}

const BEHAVIOR_NAMES: readonly string[] = ['chase', 'kite', 'charge', 'charger', 'guard', 'boss', 'summon'];
function behaviorCode(name: string): number {
  for (let i = 0; i < BEHAVIOR_NAMES.length; i++) {
    if (BEHAVIOR_NAMES[i] === name) {
      return i;
    }
  }
  return 0;
}

export interface SpawnOptions {
  enemyId: string;
  x: number;
  y: number;
  faction: number;
  elite?: boolean;
  bossIndex?: number;
  ownerPlayerId?: number;
  lifetime?: number;
  hpOverride?: number;
  damageOverride?: number;
}

/** 生成一个战斗实体；所有组件一次挂齐，运行期不再 addComponent。 */
export function spawnCombatEntity(state: SimState, opts: SpawnOptions): Eid {
  const world = state.world;
  const session = battleSession(state);
  const eid = state.pool.entities.acquire();

  add(world, eid, Position);
  add(world, eid, Velocity);
  add(world, eid, Heading);
  add(world, eid, Collider);
  add(world, eid, Speed);
  add(world, eid, Health);
  add(world, eid, Faction);
  add(world, eid, Attack);
  add(world, eid, Damage);
  add(world, eid, Invulnerable);
  add(world, eid, ExpValue);
  add(world, eid, AIState);
  add(world, eid, Behavior);
  add(world, eid, Threat);
  add(world, eid, RenderRef);
  add(world, eid, NetId);
  add(world, eid, Replicated);
  if (opts.faction === 1) {
    add(world, eid, EnemyTag);
  }

  const bossIndex = opts.bossIndex ?? 0;
  const isBoss = bossIndex > 0;
  const elite = opts.elite === true;
  const def = state.config.enemies.tryGet(opts.enemyId);
  const hp = opts.hpOverride ?? (isBoss ? 1200 : (def?.hp ?? 40)) * (elite ? 3 : 1);
  const damage = opts.damageOverride ?? (isBoss ? 32 : (def?.damage ?? 8)) * (elite ? 1.5 : 1);
  const radius = (def?.radius ?? 12) * (elite ? 1.4 : 1);

  Position.x[eid] = opts.x;
  Position.y[eid] = opts.y;
  Position.px[eid] = opts.x;
  Position.py[eid] = opts.y;
  Velocity.x[eid] = 0;
  Velocity.y[eid] = 0;
  Heading.angle[eid] = 0;
  Collider.r[eid] = radius;
  Collider.type[eid] = 0;
  Collider.w[eid] = 0;
  Collider.h[eid] = 0;
  Collider.layer[eid] = opts.faction;
  Speed.value[eid] = def?.speed ?? 90;
  Health.cur[eid] = hp;
  Health.max[eid] = hp;
  Health.regen[eid] = 0;
  Faction.value[eid] = opts.faction;
  Attack.damage[eid] = damage;
  Attack.rate[eid] = def?.attackRate ?? 1;
  Attack.cd[eid] = 0;
  Attack.range[eid] = def?.range ?? 24;
  Damage.amount[eid] = 0;
  Damage.flags[eid] = 0;
  Invulnerable.remaining[eid] = 0;
  ExpValue.value[eid] = isBoss ? 150 : (def?.exp ?? 1) * (elite ? 10 : 1);
  AIState.state[eid] = 0;
  AIState.timer[eid] = 0;
  AIState.target[eid] = INVALID_EID;
  AIState.policy[eid] = 0;
  AIState.retargetTimer[eid] = 0;
  AIState.targetNetId[eid] = INVALID_NET_ID;
  Behavior.type[eid] = isBoss ? behaviorCode('boss') : behaviorCode(def?.behavior ?? 'chase');
  Behavior.p0[eid] = 0;
  Behavior.p1[eid] = 0;
  Behavior.p2[eid] = bossIndex;
  Threat.value[eid] = isBoss ? 3 : elite ? 2 : 1;
  RenderRef.slot[eid] = -1;
  RenderRef.kind[eid] = isBoss ? 2 : 1;
  RenderRef.dirty[eid] = 1;

  if (opts.lifetime !== undefined) {
    add(world, eid, Lifetime);
    Lifetime.remaining[eid] = opts.lifetime;
  }

  const playerId = opts.ownerPlayerId ?? 0;
  const netId = allocNetId(session, eid, playerId);
  NetId.value[eid] = netId;
  SpawnTick.value[eid] = session.simTick;
  Owner.netId[eid] = netId;
  Owner.playerId[eid] = playerId;
  return eid;
}

/** 生成一枚拾取物（DropSystem / dropItem 共用）。 */
export function spawnPickup(
  state: SimState,
  x: number,
  y: number,
  kind: number,
  amount: number,
  cfgId: number,
): Eid {
  const world = state.world;
  const eid = state.pool.entities.acquire();
  add(world, eid, Position);
  add(world, eid, Velocity);
  add(world, eid, Collider);
  add(world, eid, Pickup);
  add(world, eid, Lifetime);
  add(world, eid, RenderRef);
  Position.x[eid] = x;
  Position.y[eid] = y;
  Position.px[eid] = x;
  Position.py[eid] = y;
  Velocity.x[eid] = 0;
  Velocity.y[eid] = 0;
  Collider.r[eid] = 10;
  Collider.type[eid] = 0;
  Collider.w[eid] = 0;
  Collider.h[eid] = 0;
  Collider.layer[eid] = 2;
  Pickup.kind[eid] = kind;
  Pickup.amount[eid] = amount;
  Pickup.cfgId[eid] = cfgId;
  Lifetime.remaining[eid] = 30;
  RenderRef.kind[eid] = 3;
  RenderRef.slot[eid] = -1;
  RenderRef.dirty[eid] = 1;
  return eid;
}

/** order 1：清空本 tick 触发位、推进派生时间并定位波次。 */
export class TimeSystem {
  run(state: SimState, tick: number): void {
    const session = battleSession(state);
    EffectContext.flags[0] = 0;
    session.simTick = tick;
    session.elapsed = Math.max(0, tick - session.startTick) * TICK_DT;
    const waves = state.config.waves;
    let index = 0;
    for (let i = 0; i < waves.length; i++) {
      if (session.elapsed >= waves[i].startSec) {
        index = i;
      }
    }
    session.waveIndex = index;
  }
}

/** order 3：生命周期倒计时，到期打 Dead（真正回收在 order 19）。 */
export class LifetimeSystem {
  private readonly terms = [Lifetime];

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;
    const entities = queryNoCommit(world, this.terms);
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (Lifetime.remaining[eid] <= TICK_DT) {
        Lifetime.remaining[eid] = 0;
        if (!has(world, eid, Dead)) {
          add(world, eid, Dead);
        }
      } else {
        Lifetime.remaining[eid] -= TICK_DT;
      }
    }
  }
}

/** order 4：波次刷怪；spawnAcc 逐 tick 累加，生成序列与帧率完全解耦。 */
export class SpawnSystem {
  private readonly rng = new Rng(1);
  private readonly enemyTerms = [EnemyTag];
  private readonly playerTerms = [PlayerTag, Position];
  private readonly eliteHandled: number[] = [];
  private originX = 0;
  private originY = 0;
  private spawnX = 0;
  private spawnY = 0;
  private lastTick = -1;

  run(state: SimState, tick: number): void {
    const session = battleSession(state);
    if (tick <= this.lastTick) {
      this.eliteHandled.length = 0;
    }
    this.lastTick = tick;
    const waves = state.config.waves;
    const waveIndex = session.waveIndex;
    if (waveIndex < 0 || waveIndex >= waves.length) {
      return;
    }
    const wave = waves[waveIndex];
    const span = wave.endSec - wave.startSec;
    const ratio = span > 0 ? Math.min(1, Math.max(0, (session.elapsed - wave.startSec) / span)) : 1;
    const rate = wave.spawnRateStart + (wave.spawnRateEnd - wave.spawnRateStart) * ratio;

    const world = state.world;
    const alive = query(world, this.enemyTerms).length;
    const roomFor = Math.max(0, wave.cap - alive);
    session.spawnAcc += rate * TICK_DT;
    let toSpawn = Math.floor(session.spawnAcc);
    session.spawnAcc -= toSpawn;
    if (toSpawn > roomFor) {
      toSpawn = roomFor;
    }

    this.rng.setState(hash32(session.roomSeed, tick, 0x5350));
    this.findSpawnOrigin(state);
    if (toSpawn > 0 && wave.enemies.length > 0) {
      for (let i = 0; i < toSpawn; i++) {
        const enemyId = wave.enemies[this.rng.int(wave.enemies.length)];
        this.computeSpot();
        spawnCombatEntity(state, { enemyId, x: this.spawnX, y: this.spawnY, faction: 1 });
      }
    }

    for (let i = 0; i < wave.elitesAt.length; i++) {
      if (this.eliteHandled.indexOf(i) >= 0) {
        continue;
      }
      const at = wave.elitesAt[i];
      if (at < wave.startSec || at > wave.endSec || tick < Math.round(at / TICK_DT)) {
        continue;
      }
      this.eliteHandled.push(i);
      if (wave.enemies.length === 0) {
        continue;
      }
      const enemyId = wave.enemies[this.rng.int(wave.enemies.length)];
      this.computeSpot();
      spawnCombatEntity(state, {
        enemyId, x: this.spawnX, y: this.spawnY, faction: 1, elite: true,
      });
    }
  }

  private findSpawnOrigin(state: SimState): void {
    const players = query(state.world, this.playerTerms);
    if (players.length > 0) {
      this.originX = Position.x[players[0]];
      this.originY = Position.y[players[0]];
    } else {
      this.originX = 0;
      this.originY = 0;
    }
  }

  /** 环形散布，角度取自确定性查表；不分配对象、不调用 Math.random。 */
  private computeSpot(): void {
    const angle = this.rng.next() * Math.PI * 2;
    const dist = 520 + this.rng.next() * 160;
    this.spawnX = this.originX + cosLut(angle) * dist;
    this.spawnY = this.originY + sinLut(angle) * dist;
  }
}

/** order 19：统一回收；玩家实体只清 Dead 标记，绝不回收（控制源需保持稳定）。 */
export class DeadRecycleSystem {
  private readonly terms = [Dead];

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;
    const entities = queryNoCommit(world, this.terms);
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (has(world, eid, PlayerTag)) {
        remove(world, eid, Dead);
        continue;
      }
      const netId = netIdOf(world, eid);
      if (netId !== INVALID_NET_ID) {
        releaseNetId(netId);
      }
      if (activeControlSink !== null) {
        activeControlSink.unbind(eid);
      }
      if (has(world, eid, StatSnapshotRef)) {
        state.pool.snapshots.release(StatSnapshotRef.poolIndex[eid]);
      }
      if (eid >= EFFECT_ENTITY_BASE) {
        state.pool.effects.release(eid);
      } else {
        state.pool.entities.release(eid);
      }
    }
  }
}
