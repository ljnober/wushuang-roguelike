/**
 * QA1 硬约束独立回归（DESIGN.md §2.1/§2.2/§4/§9/§13、ARCHITECTURE.md §6.1/§6.3）。
 *
 * 本文件不重复既有 determinism.test.ts 的"文件存在性"式验证，而是独立证明：
 *  1. 帧率 / 画质 / 抖动与逻辑完全解耦（逐 tick 采样哈希、敌人数、生成序列、掉落、BOSS 阶段）；
 *  2. accumulator 在大 dt 下逐 tick 完整执行，simTick 连续无缺口且与 session 一致；
 *  3. Culled 实体仍参与 AI / 碰撞 / 伤害 / 掉落，只有绘制被跳过；
 *  4. CAP 固定、eid < CAP 断言生效、协议字段只使用 NetId；
 *  5. 1 真人 + N 影子共享玩家组件，控制源可切换，敌人多目标 policy 正确；
 *  6. 静态审查：业务层无 bitECS 直连、逻辑层无 Math.random / 墙钟 / quality。
 *
 * 注意：本环境禁止 `import { describe } from 'vitest'`（第二份 runner 会破坏 runner.config），
 * vite.config.ts 已开启 globals:true，直接使用全局 describe / it / expect。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAP, TICK_DT, TICK_RATE, WushuangError } from '../../core/Constants';
import { DeterministicSim } from '../../net/DeterministicSim';
import { EntityRegistry } from '../../net/EntityRegistry';
import { encodeInputPayload, decodeInputPayload } from '../../net/messages';
import {
  createBattleState,
  getControlRegistry,
  registerBattleSystems,
} from '../../registration/systems';
import { AIPolicy } from '../components/ai';
import { add, has, query, spawn, type BattleWorld } from '../bit/adapter';
import {
  ALL_COMPONENTS,
  AIState,
  Attack,
  Behavior,
  Culled,
  ControlSource,
  Dead,
  Faction,
  Health,
  InputCmd,
  NetId,
  Pickup,
  PlayerId,
  PlayerTag,
  Position,
  Projectile,
  RenderRef,
  SpawnTick,
  Threat,
  Velocity,
} from '../bit/components';
import type { Eid } from '../bit/types';
import { GameEventType } from '../bridge/enums';
import { createEventSlot } from '../bridge/GameEventBus';
import { createBattleWorld } from '../world';
import {
  getAlpha,
  getSimTick,
  registerSimSystem,
  resetScheduler,
  simulateTick,
  stepTick,
  type SimState,
} from '../scheduler';
import { AISystem } from '../systems/AISystem';
import { InputSystem } from '../systems/InputSystem';
import { RenderSyncSystem } from '../systems/RenderSystems';
import { spawnCombatEntity } from '../systems/LifecycleSystems';
import { createInputFrame, type IControlSource, type InputFrame } from '../systems/control/IControlSource';
import type { PixiPools } from '../../engine/PixiPools';

const SEED = 0x51a7c0de;
const ERR_EID_OVER_CAP = 2002;

interface FakeApp {
  registerSimSystem(order: number, fn: (s: SimState, t: number) => void, id: string): void;
}

const fakeApp: FakeApp = {
  registerSimSystem(order, fn, id) {
    registerSimSystem(order, fn, id);
  },
};

function install(state: SimState): void {
  resetScheduler();
  registerBattleSystems(fakeApp, state);
}

function sessionOf(state: SimState): Record<string, number> {
  return state.session as unknown as Record<string, number>;
}

/** 每秒 fps 帧、每帧 1/fps+ε：一秒恰好 60 tick，ε 只进入 alpha 余量。 */
function oneSecondFrames(fps: 30 | 60 | 144): number[] {
  const dt = 1 / fps + 1e-12;
  const frames: number[] = [];
  for (let i = 0; i < fps; i++) frames.push(dt);
  return frames;
}

interface RunResult {
  ticks: number;
  alpha: number;
  hashes: number[];
  enemies: number;
  bullets: number;
  netIds: number[];
  spawnTicks: number[];
  pickups: number;
  pickupKinds: number[];
  bossSpawned: number;
  waveIndex: number;
}

/** 跑 N 个逻辑 tick（N 必须是 60 的倍数），逐 60 tick 采样 FNV 状态哈希。 */
function runEquivalentTicks(fps: 30 | 60 | 144, quality: string, totalTicks: number): RunResult {
  const state = createBattleState({ seed: SEED, shadowCount: 2 });
  sessionOf(state).quality = quality === 'high' ? 2 : quality === 'medium' ? 1 : 0;
  install(state);
  const hasher = new DeterministicSim(state, []);
  const frames = oneSecondFrames(fps);
  const rounds = totalTicks / 60;
  const hashes: number[] = [];
  let lastObservedTick = 0;

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < frames.length; i++) {
      simulateTick(state, frames[i]);
      // 高帧率下一帧可能不推进 tick，必须只在 tick 真正变化时采样。
      const tick = getSimTick();
      if (tick > lastObservedTick) {
        lastObservedTick = tick;
        if ((tick % 60) === 0) hashes.push(hasher.hash(state));
      }
    }
  }

  const enemies = query(state.world, [Faction]);
  let enemyCount = 0;
  for (let i = 0; i < enemies.length; i++) {
    if (Faction.value[enemies[i]] === 1) enemyCount++;
  }
  const networks = query(state.world, [NetId]);
  const netIds: number[] = [];
  const spawnTicks: number[] = [];
  for (let i = 0; i < networks.length; i++) {
    netIds.push(NetId.value[networks[i]]);
    spawnTicks.push(SpawnTick.value[networks[i]]);
  }
  const drops = query(state.world, [Pickup, Position]);
  const pickupKinds: number[] = [];
  for (let i = 0; i < drops.length; i++) pickupKinds.push(Pickup.kind[drops[i]]);
  const session = sessionOf(state);
  return {
    ticks: getSimTick(),
    alpha: getAlpha(),
    hashes,
    enemies: enemyCount,
    bullets: query(state.world, [Projectile]).length,
    netIds,
    spawnTicks,
    pickups: drops.length,
    pickupKinds,
    bossSpawned: session.bossSpawned,
    waveIndex: session.waveIndex,
  };
}

describe('硬约束 1：性能与游戏性解耦', () => {
  it('30/60/144fps 跑相同 tick 数，逐 60 tick 的状态哈希、敌人数、生成序列、掉落完全一致', () => {
    // Arrange + Act：同一 roomSeed、同一输入序列（空输入），不同帧序列与画质档位。
    const at30 = runEquivalentTicks(30, 'low', 600);
    const at60 = runEquivalentTicks(60, 'medium', 600);
    const at144 = runEquivalentTicks(144, 'high', 600);

    // Assert：逻辑 tick 数、采样序列与全部游戏性输出严格相等。
    expect(at30.ticks).toBe(600);
    expect(at60.ticks).toBe(600);
    expect(at144.ticks).toBe(600);
    expect(at30.hashes).toHaveLength(10);
    expect(at144.hashes).toHaveLength(10);
    expect(at60.hashes).toEqual(at30.hashes);
    expect(at144.hashes).toEqual(at30.hashes);
    expect(at60.enemies).toBe(at30.enemies);
    expect(at144.enemies).toBe(at30.enemies);
    expect(at60.bullets).toBe(at30.bullets);
    expect(at144.bullets).toBe(at30.bullets);
    expect(at60.netIds).toEqual(at30.netIds);
    expect(at144.netIds).toEqual(at30.netIds);
    expect(at60.spawnTicks).toEqual(at30.spawnTicks);
    expect(at144.spawnTicks).toEqual(at30.spawnTicks);
    expect(at60.pickupKinds).toEqual(at30.pickupKinds);
    expect(at144.pickupKinds).toEqual(at30.pickupKinds);
    expect(at30.bossSpawned).toBe(0);
    expect(at60.bossSpawned).toBe(at30.bossSpawned);
    expect(at144.bossSpawned).toBe(at30.bossSpawned);
    expect(at30.waveIndex).toBe(0);
  });

  it('quality 不参与逻辑：low/medium/high 与非法档位在 60fps 下产生同一状态序列', () => {
    const low = runEquivalentTicks(60, 'low', 300);
    const medium = runEquivalentTicks(60, 'medium', 300);
    const high = runEquivalentTicks(60, 'high', 300);
    const bogus = runEquivalentTicks(60, 'ultra', 300);
    expect(medium.hashes).toEqual(low.hashes);
    expect(high.hashes).toEqual(low.hashes);
    expect(bogus.hashes).toEqual(low.hashes);
    expect(high.netIds).toEqual(low.netIds);
    expect(high.enemies).toBe(low.enemies);
    expect(high.pickups).toBe(low.pickups);
  });

  it('BOSS 登场与阶段阈值不受帧率 / 画质影响', () => {
    type BossRun = { spawned: number; index: number; hp: number; phase: number; bullets: number };
    const runBoss = (fps: 30 | 60 | 144, quality: string): BossRun => {
      const state = createBattleState({ seed: SEED, shadowCount: 1 });
      sessionOf(state).quality = quality === 'medium' ? 1 : quality === 'high' ? 2 : 0;
      install(state);
      // 把会话时间轴直接推进到 420s（不改变任何系统，只改派生的 startTick）。
      sessionOf(state).startTick = -420 * TICK_RATE;
      const frames = oneSecondFrames(fps);
      for (let i = 0; i < fps / 2; i++) simulateTick(state, frames[i]);

      const candidates = query(state.world, [AIState, Behavior, Health, Faction]);
      let boss: Eid = 0;
      for (let i = 0; i < candidates.length; i++) {
        if (Behavior.p2[candidates[i]] > 0) {
          boss = candidates[i];
          break;
        }
      }
      expect(boss).toBeGreaterThan(0);
      const index = Behavior.p2[boss];
      const hp = Health.cur[boss];
      // 压到 50% 触发第 2 阶段（阈值 0.6），再走一个 tick 采集 BossPhase 事件。
      Health.cur[boss] = Health.max[boss] * 0.5;
      stepTick(state, getSimTick() + 1);
      // GameEventBus.drain 只写入调用方预分配的槽位，空数组会导致 0 写入。
      const events = Array.from({ length: 16 }, () => createEventSlot());
      state.buses.events.drain(events);
      const phaseEvents = events.filter((e) => e.type === GameEventType.BossPhase);
      const phase = phaseEvents.length > 0 ? phaseEvents[phaseEvents.length - 1].b : -1;
      return {
        spawned: sessionOf(state).bossSpawned,
        index,
        hp,
        phase,
        bullets: query(state.world, [Projectile]).length,
      };
    };

    const a = runBoss(30, 'low');
    const b = runBoss(60, 'medium');
    const c = runBoss(144, 'high');
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.spawned).toBe(1);
    expect(a.index).toBeGreaterThanOrEqual(1);
    expect(a.index).toBeLessThanOrEqual(8);
    expect(a.phase).toBe(1); // 0.6 阈值对应 phase 1
  });

  it('CAP 与 tickRate 是跨设备固定常量，quality 字段无法改写', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 3 });
    for (const quality of [0, 1, 2]) {
      sessionOf(state).quality = quality;
      expect(CAP).toBe(4096);
      expect(TICK_RATE).toBe(60);
      expect(TICK_DT).toBeCloseTo(1 / 60, 12);
      expect(sessionOf(state).tickRate).toBe(60);
      expect(state.config.waves.length).toBe(6);
      let maxCap = 0;
      for (let i = 0; i < state.config.waves.length; i++) {
        maxCap = Math.max(maxCap, state.config.waves[i].cap);
      }
      expect(maxCap).toBeLessThanOrEqual(300);
    }
  });
});

describe('硬约束 2：accumulator 不跳 tick', () => {
  it('单个大 dt 逐 tick 完整执行，simTick 连续无缺口且与 session 一致', () => {
    // Arrange：500 tick 的压力帧 + 一个探针记录每个 tick。
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    install(state);
    const trace: number[] = [];
    const sessionTrace: number[] = [];
    registerSimSystem(50, (s, tick) => {
      trace.push(tick);
      sessionTrace.push(s.session.simTick as unknown as number);
    }, 'QaTickProbe');

    // Act：5 秒 + 1/4 tick 的余量一次性喂入。
    const rawDt = 500 * TICK_DT + 0.25 * TICK_DT;
    const executed = simulateTick(state, rawDt);

    // Assert：500 个 tick 一个不少、一个不重。
    expect(executed).toBe(500);
    expect(trace).toHaveLength(500);
    for (let i = 0; i < 500; i++) {
      expect(trace[i]).toBe(i + 1);
      expect(sessionTrace[i]).toBe(i + 1);
    }
    expect(getSimTick()).toBe(500);
    expect(sessionOf(state).simTick).toBe(500);
    expect(getAlpha()).toBeCloseTo(0.25, 6);
  });

  it('等长的不同帧序列（含 3x 大帧与抖动）得到相同 tick 数与状态哈希', () => {
    const pattern = [1, 3, 2, 1, 2, 3]; // 每轮 12 tick
    const makeFrames = (): number[] => {
      const frames: number[] = [];
      for (let r = 0; r < 10; r++) {
        for (let i = 0; i < pattern.length; i++) {
          frames.push(pattern[i] * TICK_DT + 1e-10);
        }
      }
      return frames; // 总 tick = 120
    };
    const run = (frames: number[], quality: number): { ticks: number; hash: number; enemies: number } => {
      const state = createBattleState({ seed: SEED, shadowCount: 2 });
      sessionOf(state).quality = quality;
      install(state);
      const hasher = new DeterministicSim(state, []);
      for (let i = 0; i < frames.length; i++) {
        simulateTick(state, frames[i]);
      }
      return {
        ticks: getSimTick(),
        hash: hasher.hash(state),
        enemies: query(state.world, [Faction]).length,
      };
    };
    const jitter = makeFrames();
    const uniform: number[] = [];
    for (let i = 0; i < 120; i++) uniform.push(TICK_DT + 1e-10);

    const a = run(jitter, 0);
    const b = run(uniform, 2);
    expect(a.ticks).toBe(120);
    expect(b.ticks).toBe(120);
    expect(a.hash).toBe(b.hash);
    expect(a.enemies).toBe(b.enemies);
  });
});

describe('硬约束 3：Culled 只跳过绘制', () => {
  it('Culled 敌人仍被 AI 选为目标并追击', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    install(state);
    const players = query(state.world, [PlayerTag, Position, Health]);
    expect(players.length).toBe(2);
    const enemy = spawnCombatEntity(state, {
      enemyId: 'huangjin',
      x: Position.x[players[0]] + 160,
      y: Position.y[players[0]],
      faction: 1,
    });
    add(state.world, enemy, Culled);

    const beforeX = Position.x[enemy];
    simulateTick(state, TICK_DT + 1e-9);
    const target = AIState.target[enemy];
    expect(target).toBeGreaterThan(0);
    expect(has(state.world, target, PlayerTag)).toBe(true);
    expect(Position.x[enemy]).toBeLessThan(beforeX);
  });

  it('Culled 单位仍参与碰撞与伤害', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    install(state);
    const player = query(state.world, [PlayerTag, Health])[0];
    const before = Health.cur[player];
    const enemy = spawnCombatEntity(state, {
      enemyId: 'huangjin',
      x: Position.x[player] + 5,
      y: Position.y[player],
      faction: 1,
    });
    add(state.world, enemy, Culled);

    stepTick(state, 1);
    expect(Health.cur[player]).toBeLessThan(before);
  });

  it('Culled 敌人死亡后仍触发掉落', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 1 });
    install(state);
    const player = query(state.world, [PlayerTag])[0];
    const enemy = spawnCombatEntity(state, {
      enemyId: 'huangjin',
      x: Position.x[player] + 200,
      y: Position.y[player],
      faction: 1,
    });
    add(state.world, enemy, Culled);
    Health.cur[enemy] = 0;
    const beforeDrops = query(state.world, [Pickup]).length;
    add(state.world, enemy, Dead); // 触发 DropSystem（order 13）
    stepTick(state, 1);

    const afterDrops = query(state.world, [Pickup]).length;
    expect(afterDrops).toBeGreaterThan(beforeDrops);
  });

  it('RenderSyncSystem 跳过 Culled：只有可见实体被分配绘制槽', () => {
    const world: BattleWorld = createBattleWorld('qa-cull-render');
    const visible = spawn(world);
    const culled = spawn(world);
    add(world, visible, Position);
    add(world, visible, RenderRef);
    add(world, culled, Position);
    add(world, culled, RenderRef);
    add(world, culled, Culled);
    Position.x[visible] = 10;
    Position.x[culled] = 20;
    RenderRef.slot[visible] = -1;
    RenderRef.slot[culled] = -1;

    const acquired: Eid[] = [];
    const fakePools = {
      capacity: 8,
      slotToEid: new Uint32Array(8),
      eidToSlot: new Int32Array(8),
      acquire: (_kind: string, _texture: string, eid: Eid): number => {
        acquired.push(eid);
        return acquired.length - 1;
      },
      release: (): void => undefined,
      getSlot: (): number => -1,
      setPosition: (): void => undefined,
      setVisual: (): void => undefined,
      snap: (): void => undefined,
    } as unknown as PixiPools;

    new RenderSyncSystem(fakePools, world).run(0.5);
    expect(acquired).toEqual([visible]);
    expect(acquired).not.toContain(culled);
  });
});

describe('硬约束 4：CAP 固定与 eid 不上线', () => {
  it('所有 SoA 字段长度为 CAP；spawn 越界抛 WushuangError(2002)', () => {
    const world = createBattleWorld('qa-cap');
    for (let i = 0; i < ALL_COMPONENTS.length; i++) {
      const fields = Object.keys(ALL_COMPONENTS[i]);
      for (let f = 0; f < fields.length; f++) {
        const array = ALL_COMPONENTS[i][fields[f]];
        if (array !== undefined) {
          expect((array as Float32Array).length).toBe(CAP);
        }
      }
    }
    let spawned = 0;
    let overCapError: unknown = null;
    while (spawned <= CAP) {
      try {
        const eid = spawn(world);
        expect(eid).toBeLessThan(CAP);
        spawned++;
      } catch (err) {
        overCapError = err;
        break;
      }
    }
    expect(overCapError).toBeInstanceOf(WushuangError);
    expect((overCapError as WushuangError).code).toBe(ERR_EID_OVER_CAP);
  });

  it('协议负载只携带 NetId：eid 不出现在输入/快照的线上字段', () => {
    // Arrange：先抬高 eid，再用 EntityRegistry 分配一个必然不同的 NetId。
    const world = createBattleWorld('qa-wire-netid');
    const registry = new EntityRegistry(world);
    for (let i = 0; i < 8; i++) spawn(world);
    const eid = spawn(world);
    const netId = registry.alloc(eid, 0);
    expect(netId).toBeGreaterThan(0);
    expect(netId).not.toBe(eid);

    const frame = createInputFrame();
    frame.tick = 7;
    frame.seq = 9;
    // Act
    const payload = encodeInputPayload(netId, frame);
    // Assert：线上第 0 个字段是 NetId，绝不可能是本地 eid。
    expect(payload.byteLength).toBe(32);
    expect(new DataView(payload).getFloat32(0, true)).toBe(netId);
    expect(new DataView(payload).getFloat32(0, true)).not.toBe(eid);
    const decoded = createInputFrame();
    expect(decodeInputPayload(payload, decoded)).toBe(netId);
  });
});

describe('硬约束 5：控制源切换与敌人多目标', () => {
  it('1 真人 + 3 影子共享同一套玩家组件，仅 ControlSource.kind 不同', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 3 });
    const players = query(state.world, [PlayerTag, PlayerId, ControlSource]);
    expect(players.length).toBe(4);
    const shared = [Position, Velocity, Health, Attack, InputCmd, NetId, PlayerId, PlayerTag];
    for (let i = 0; i < players.length; i++) {
      const eid = players[i];
      for (let c = 0; c < shared.length; c++) {
        expect(has(state.world, eid, shared[c])).toBe(true);
      }
      expect(PlayerId.value[eid]).toBe(i);
      expect(ControlSource.kind[eid]).toBe(i === 0 ? 0 : 1);
    }
  });

  it('切换控制源后 InputCmd 立即按新源的 poll 结果写入', () => {
    const state = createBattleState({ seed: SEED, shadowCount: 2 });
    install(state);
    const registry = getControlRegistry();
    expect(registry).not.toBeNull();
    const shadow = query(state.world, [PlayerTag, PlayerId])[1];

    const remoteStub: IControlSource = {
      kind: 2,
      poll(tick: number, out: InputFrame): void {
        out.moveX = 0.875;
        out.moveY = -0.25;
        out.seq = tick;
      },
    };
    registry!.bind(shadow, remoteStub);

    new InputSystem(registry!).run(state, 17);
    expect(ControlSource.kind[shadow]).toBe(2);
    expect(InputCmd.moveX[shadow]).toBeCloseTo(0.875, 6);
    expect(InputCmd.moveY[shadow]).toBeCloseTo(-0.25, 6);
    expect(InputCmd.tick[shadow]).toBe(17);
    expect(InputCmd.seq[shadow]).toBe(17);
  });

  it('敌人 AI 的 policy 分别为最近 / 最弱 / 最高威胁时选对目标', () => {
    const makeCase = (policy: number): number => {
      const state = createBattleState({ seed: SEED, shadowCount: 2 });
      install(state);
      const players = query(state.world, [PlayerTag, Health, Position]);
      expect(players.length).toBe(3);
      // p0：最近但血最多；p1：最远且血最少；p2：最远且威胁最高。
      Position.x[players[0]] = 0;
      Position.y[players[0]] = 0;
      Health.cur[players[0]] = 120;
      Position.x[players[1]] = 900;
      Position.y[players[1]] = 0;
      Health.cur[players[1]] = 10;
      Position.x[players[2]] = 900;
      Position.y[players[2]] = 10;
      Health.cur[players[2]] = 110;
      add(state.world, players[2], Threat);
      Threat.value[players[2]] = 50;

      const enemy = spawnCombatEntity(state, {
        enemyId: 'huangjin',
        x: 30,
        y: 0,
        faction: 1,
      });
      AIState.policy[enemy] = policy;
      new AISystem().run(state, 1);
      const target = AIState.target[enemy];
      for (let i = 0; i < players.length; i++) {
        if (players[i] === target) return i;
      }
      return -1;
    };

    expect(makeCase(AIPolicy.Nearest)).toBe(0);
    expect(makeCase(AIPolicy.Weakest)).toBe(1);
    expect(makeCase(AIPolicy.HighestThreat)).toBe(2);
  });
});

describe('硬约束 6：静态源码审查', () => {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const sourceRoot = join(projectRoot, 'src');

  function collectTs(dir: string, out: string[] = []): string[] {
    const entries = readdirSync(dir);
    for (let i = 0; i < entries.length; i++) {
      const full = join(dir, entries[i]);
      if (statSync(full).isDirectory()) collectTs(full, out);
      else if (entries[i].endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const relativePath = (file: string): string => relative(projectRoot, file).replace(/\\/g, '/');
  // 静态审查针对业务/逻辑源码：测试文件里的说明文字与断言字符串不算实际调用。
  const allTs = collectTs(sourceRoot).filter((file) => !relativePath(file).includes('__tests__'));

  it("bitecs 只允许在 src/ecs/bit/adapter.ts 被 import", () => {
    const offenders: string[] = [];
    for (let i = 0; i < allTs.length; i++) {
      const text = readFileSync(allTs[i], 'utf8');
      if (/(?:from\s+|import\s*\()\s*['"]bitecs['"]/.test(text)) {
        offenders.push(relativePath(allTs[i]));
      }
    }
    expect(offenders).toEqual(['src/ecs/bit/adapter.ts']);
  });

  it('全工程无 Math.random(...) 实际调用', () => {
    const offenders: string[] = [];
    for (let i = 0; i < allTs.length; i++) {
      if (/Math\.random\s*\(/.test(readFileSync(allTs[i], 'utf8'))) {
        offenders.push(relativePath(allTs[i]));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('墙钟只出现在帧驱动 / 渲染 / UI / 存档节流入口', () => {
    const allowed = new Set([
      'src/app/App.ts',
      'src/game/SaveSystem.ts',
      'src/game/scenes/index.ts',
      'src/ui/HUD.ts',
      'src/registration/presentation.ts',
      'src/ecs/systems/RenderSystems.ts',
    ]);
    const offenders: string[] = [];
    for (let i = 0; i < allTs.length; i++) {
      if (!/(?:Date\.now|performance\.now)\s*\(/.test(readFileSync(allTs[i], 'utf8'))) continue;
      const path = relativePath(allTs[i]);
      if (!allowed.has(path)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it('逻辑层（core/data/ecs/systems/net/registration/systems）不读取 quality', () => {
    const logicRoots = [
      join(sourceRoot, 'core'),
      join(sourceRoot, 'data'),
      join(sourceRoot, 'net'),
      join(sourceRoot, 'ecs', 'systems'),
      join(sourceRoot, 'registration', 'systems.ts'),
    ];
    const logicFiles = allTs.filter((file) => {
      const path = relativePath(file);
      if (path.includes('__tests__')) return false;
      return logicRoots.some((root) => file.startsWith(root));
    });
    expect(logicFiles.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (let i = 0; i < logicFiles.length; i++) {
      if (/\bquality\b/.test(readFileSync(logicFiles[i], 'utf8'))) {
        offenders.push(relativePath(logicFiles[i]));
      }
    }
    expect(offenders).toEqual([]);
  });
});
