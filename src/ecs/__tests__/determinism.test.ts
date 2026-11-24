/**
 * 批次 B1 确定性 harness（ARCHITECTURE §2.2 #63 / DESIGN §13）。
 *
 * 验证：同 seed 在 30/60/144fps 帧序列与不同 quality 下跑相同 tick 数，
 * 敌人数 / 生成序列 / 掉落 / BOSS 阶段 / 状态哈希完全一致；
 * 另覆盖 NetId 往返回收与属性金标准 ADD/MUL/MAX/OVERRIDE/MUTEX/CONDITIONAL。
 *
 * 注意：本环境禁止 `import { describe } from 'vitest'`（会加载第二份 runner 实例）；
 * vite.config.ts 已开启 globals:true，故直接使用全局 describe / it / expect。
 */
import { EXP_CURVE, INVALID_EID, INVALID_NET_ID } from '../../core/Constants';
import { hash32 } from '../../core/Rng';
import { add, query } from '../bit/adapter';
import {
  Culled,
  Dead,
  EffectContext,
  Faction,
  Health,
  NetId,
  Pickup,
  PlayerTag,
  Position,
  StatBlock,
} from '../bit/components';
import {
  getSimTick,
  registerSimSystem as schedulerRegisterSimSystem,
  resetScheduler,
  simulateTick,
  type SimState,
} from '../scheduler';
import { createBattleState, registerBattleSystems } from '../../registration/systems';
import type { EntityRegistryLike } from '../systems/LifecycleSystems';
import { createModifier, StatResolveSystem } from '../systems/StatResolveSystem';
import type { Eid } from '../bit/types';

const SEED = 0x1234abcd;

interface FakeApp {
  registerSimSystem(order: number, fn: (s: SimState, t: number) => void, id: string): void;
}

const fakeApp: FakeApp = {
  registerSimSystem(order, fn, id) {
    schedulerRegisterSimSystem(order, fn, id);
  },
};

/** 安装同一套系统链到权威 scheduler（每轮先 reset，避免重复注册）。 */
function install(state: SimState): void {
  resetScheduler();
  registerBattleSystems(fakeApp, state);
}

/** 30/60/144fps 的等价帧序列：总时长恒为 1 秒 = 60 tick。 */
function framesFor(fps: 30 | 60 | 144): number[] {
  const dt = 1 / fps + 1e-12;
  const frames: number[] = [];
  for (let i = 0; i < fps; i++) {
    frames.push(dt);
  }
  return frames;
}

/** 状态哈希：位置量化到 0.01px，覆盖阵营 / 生命 / NetId / 掉落物。 */
function hashState(state: SimState): number {
  let h = 0x811c9dc5;
  const mix = (value: number): void => {
    h = hash32(h, value | 0);
  };
  const units = query(state.world, [Position, Faction]);
  mix(units.length);
  for (let i = 0; i < units.length; i++) {
    const eid = units[i];
    mix(eid);
    mix(Math.round(Position.x[eid] * 100));
    mix(Math.round(Position.y[eid] * 100));
    mix(Faction.value[eid]);
    mix(Math.round(Health.cur[eid] * 100));
    mix(NetId.value[eid]);
  }
  const items = query(state.world, [Pickup, Position]);
  mix(items.length);
  for (let i = 0; i < items.length; i++) {
    mix(Math.round(Position.x[items[i]] * 100));
    mix(Math.round(Position.y[items[i]] * 100));
  }
  return h >>> 0;
}

interface RunResult {
  hash: number;
  unitCount: number;
  netIds: number[];
  pickups: number;
  bossPhase: number;
  ticks: number;
}

function runFrames(fps: 30 | 60 | 144, quality: string): RunResult {
  const state = createBattleState({ seed: SEED, shadowCount: 2 });
  // quality 只写会话附加字段：逻辑系统从不读取它。
  (state.session as unknown as Record<string, unknown>).quality = quality;
  install(state);
  const frames = framesFor(fps);
  for (let i = 0; i < frames.length; i++) {
    simulateTick(state, frames[i]);
  }
  const units = query(state.world, [Position, Faction]);
  const netIds: number[] = [];
  for (let i = 0; i < units.length; i++) {
    netIds.push(NetId.value[units[i]]);
  }
  const session = state.session as unknown as Record<string, number>;
  return {
    hash: hashState(state),
    unitCount: units.length,
    netIds,
    pickups: query(state.world, [Pickup]).length,
    bossPhase: session.bossSpawned ?? 0,
    ticks: getSimTick(),
  };
}

describe('确定性：帧率抖动 / 画质档位不影响逻辑', () => {
  it('30/60/144fps 跑相同 tick 数得到完全一致的状态', () => {
    const a = runFrames(30, 'low');
    const b = runFrames(60, 'medium');
    const c = runFrames(144, 'high');
    expect(a.ticks).toBe(60);
    expect(b.ticks).toBe(60);
    expect(c.ticks).toBe(60);
    expect(a.unitCount).toBe(b.unitCount);
    expect(b.unitCount).toBe(c.unitCount);
    expect(a.pickups).toBe(b.pickups);
    expect(b.pickups).toBe(c.pickups);
    expect(a.netIds).toEqual(b.netIds);
    expect(b.netIds).toEqual(c.netIds);
    expect(a.bossPhase).toBe(b.bossPhase);
    expect(b.bossPhase).toBe(c.bossPhase);
    expect(a.hash).toBe(b.hash);
    expect(b.hash).toBe(c.hash);
  });

  it('同 seed 重复运行哈希稳定，不同 seed 产生不同序列', () => {
    const first = runFrames(60, 'high');
    const second = runFrames(60, 'low');
    expect(first.hash).toBe(second.hash);

    const other = createBattleState({ seed: SEED + 1, shadowCount: 2 });
    install(other);
    const frames = framesFor(60);
    for (let i = 0; i < frames.length; i++) {
      simulateTick(other, frames[i]);
    }
    expect(hashState(other)).not.toBe(first.hash);
  });

  it('Culled 实体仍完整参与逻辑', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    install(state);
    const frames = framesFor(60);
    for (let i = 0; i < frames.length; i++) simulateTick(state, frames[i]);
    const enemies = query(state.world, [Faction, Position]);
    let target: Eid = INVALID_EID;
    for (let i = 0; i < enemies.length; i++) {
      if (Faction.value[enemies[i]] === 1) {
        target = enemies[i];
        break;
      }
    }
    expect(target).not.toBe(INVALID_EID);
    add(state.world, target, Culled);
    const beforeX = Position.x[target];
    const beforeY = Position.y[target];
    for (let i = 0; i < frames.length; i++) simulateTick(state, frames[i]);
    const moved = Math.abs(Position.x[target] - beforeX) + Math.abs(Position.y[target] - beforeY);
    expect(moved).toBeGreaterThan(0);
  });
});

/** 测试用注册表：结构与 net/EntityRegistry 完全一致，避免跨批次硬依赖。 */
class LocalRegistry implements EntityRegistryLike {
  readonly eidToNet = new Map<number, number>();
  readonly netToEid = new Map<number, number>();
  readonly playerOfNet = new Map<number, number>();
  readonly free: number[] = [];
  private next = 1;
  roundTrips = 0;

  alloc(eid: number, playerId: number): number {
    const netId = this.free.pop() ?? this.next++;
    this.bind(eid, netId, playerId);
    return netId;
  }
  bind(eid: number, netId: number, playerId: number): void {
    this.eidToNet.set(eid, netId);
    this.netToEid.set(netId, eid);
    this.playerOfNet.set(netId, playerId);
  }
  byNetId(netId: number): number {
    return this.netToEid.get(netId) ?? INVALID_EID;
  }
  byEid(eid: number): number {
    return this.eidToNet.get(eid) ?? INVALID_NET_ID;
  }
  playerOf(netId: number): number {
    return this.playerOfNet.get(netId) ?? -1;
  }
  release(netId: number): void {
    const eid = this.netToEid.get(netId);
    if (eid === undefined) {
      return;
    }
    this.eidToNet.delete(eid);
    this.netToEid.delete(netId);
    this.playerOfNet.delete(netId);
    this.free.push(netId);
    this.roundTrips++;
  }
}

describe('NetId 往返回收', () => {
  it('DeadRecycleSystem 通过 EntityRegistry 端口释放并可复用 NetId', () => {
    const registry = new LocalRegistry();
    const state = createBattleState({ seed: SEED, shadowCount: 1, registry });
    install(state);
    const frames = framesFor(60);
    for (let i = 0; i < 60; i++) simulateTick(state, frames[i]);

    const enemies = query(state.world, [Faction, NetId, Health]);
    let victim: Eid = INVALID_EID;
    for (let i = 0; i < enemies.length; i++) {
      if (Faction.value[enemies[i]] === 1) {
        victim = enemies[i];
        break;
      }
    }
    expect(victim).not.toBe(INVALID_EID);
    const released = NetId.value[victim];
    expect(registry.byEid(victim)).toBe(released);
    expect(registry.byNetId(released)).toBe(victim);

    add(state.world, victim, Dead);
    simulateTick(state, frames[0]);
    expect(registry.byEid(victim)).toBe(INVALID_NET_ID);
    expect(registry.byNetId(released)).toBe(INVALID_EID);
    expect(registry.roundTrips).toBeGreaterThan(0);

    const reused = registry.alloc(victim, 0);
    expect(reused).toBe(released);
    expect(registry.playerOf(reused)).toBe(0);
  });
});

function statIndex(config: SimState['config'], id: string): number {
  const all = config.stats.all();
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === id) {
      return i;
    }
  }
  return 0;
}

function firstPlayer(state: SimState): Eid {
  return query(state.world, [PlayerTag])[0];
}

function resolveOnce(state: SimState): void {
  new StatResolveSystem(state.config).run(state, 1);
}

function atkOf(state: SimState): number {
  const block = StatBlock as unknown as Record<string, Float32Array>;
  return block['atk'][firstPlayer(state)];
}

describe('属性金标准', () => {
  it('EXP_CURVE 与冻结公式一致', () => {
    expect(EXP_CURVE(1)).toBe(19);
    expect(EXP_CURVE(10)).toBe(170);
  });

  it('ADD', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    createModifier(state, firstPlayer(state), {
      stat: statIndex(state.config, 'atk'), op: 'ADD', value: 6, group: 1001,
    });
    resolveOnce(state);
    expect(atkOf(state)).toBeCloseTo(30, 5);
  });

  it('MUL（乘区分桶）', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    createModifier(state, firstPlayer(state), {
      stat: statIndex(state.config, 'atk'), op: 'MUL', value: 0.5, bucket: 0, group: 1002,
    });
    resolveOnce(state);
    expect(atkOf(state)).toBeCloseTo(36, 5);
  });

  it('MAX（同组取最高值）', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    const stat = statIndex(state.config, 'atk');
    createModifier(state, firstPlayer(state), { stat, op: 'MAX', value: 10, group: 1003 });
    createModifier(state, firstPlayer(state), { stat, op: 'MAX', value: 20, group: 1003 });
    resolveOnce(state);
    expect(atkOf(state)).toBeCloseTo(44, 5);
  });

  it('OVERRIDE（同组取最高优先级）', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    const stat = statIndex(state.config, 'atk');
    createModifier(state, firstPlayer(state), { stat, op: 'OVERRIDE', value: 5, group: 1004, priority: 1 });
    createModifier(state, firstPlayer(state), { stat, op: 'OVERRIDE', value: 9, group: 1004, priority: 9 });
    resolveOnce(state);
    expect(atkOf(state)).toBeCloseTo(33, 5);
  });

  it('MUTEX（同组互斥，高优先级胜出）', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    const stat = statIndex(state.config, 'atk');
    createModifier(state, firstPlayer(state), { stat, op: 'MUTEX', value: 3, group: 1005, priority: 2 });
    createModifier(state, firstPlayer(state), { stat, op: 'MUTEX', value: 11, group: 1005, priority: 7 });
    resolveOnce(state);
    expect(atkOf(state)).toBeCloseTo(35, 5);
  });

  it('CONDITIONAL（掩码不成立剔除，成立后生效）', () => {
    const off = createBattleState({ seed: SEED, shadowCount: 1 });
    createModifier(off, firstPlayer(off), {
      stat: statIndex(off.config, 'atk'), op: 'CONDITIONAL', value: 7, group: 1006, condMask: 1,
    });
    resolveOnce(off);
    expect(atkOf(off)).toBeCloseTo(24, 5);

    const on = createBattleState({ seed: SEED, shadowCount: 1 });
    createModifier(on, firstPlayer(on), {
      stat: statIndex(on.config, 'atk'), op: 'CONDITIONAL', value: 7, group: 1007, condMask: 1,
    });
    EffectContext.flags[0] = 1;
    resolveOnce(on);
    expect(atkOf(on)).toBeCloseTo(31, 5);
    EffectContext.flags[0] = 0;
  });
});
