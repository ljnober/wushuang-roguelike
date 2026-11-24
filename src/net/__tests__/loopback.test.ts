/**
 * 批次 B2 验收单测：Host↔Client 消息闭环、chaos（丢包/乱序/重复）、快照精确集合与和解收敛。
 * 本环境使用 vite.config.ts 的 globals:true，直接用全局 describe/it/expect，
 * 不 import vitest 的第二份 runner。
 */
import { Rng } from '../../core/Rng';
import { createBattleWorld } from '../../ecs/world';
import { add, spawn } from '../../ecs/bit/adapter';
import {
  ControlSource,
  Health,
  NetId,
  Owner,
  PlayerId,
  PlayerTag,
  Position,
  Replicated,
} from '../../ecs/bit/components';
import type { Eid } from '../../ecs/bit/types';
import { createInputFrame } from '../../ecs/systems/control/IControlSource';
import { GameEventBus } from '../../ecs/bridge/GameEventBus';
import { GameEventType } from '../../ecs/bridge/enums';
import type { App } from '../../app/App';
import { register as registerNetSideLoad } from '../../registration/net';
import { DeterministicSim, type SimState, type SimSystem } from '../DeterministicSim';
import { EntityRegistry } from '../EntityRegistry';
import {
  NetInputBuffer,
  NetMsgType,
  encodeInputPayload,
  type NetMessage,
} from '../messages';
import {
  FullSnapshotStrategy,
  configureNetRuntime,
  installNetSystems,
  resetNetSystems,
} from '../NetSystems';
import { PredictionBuffer } from '../PredictionBuffer';
import {
  applySnapshot,
  buildSnapshot,
  readPositions,
} from '../Snapshot';
import { AuthorityRole, NetSessionManager } from '../session';
import { LoopbackTransport, NullTransport } from '../transport';

/** 造一个带完整网络组件的最小玩家实体。 */
function makePlayer(
  world: ReturnType<typeof createBattleWorld>,
  replicated: boolean,
): Eid {
  const eid = spawn(world);
  add(world, eid, Position);
  // 组件 SoA 由 A 层定义为模块级共享数组：显式清零避免跨 world 的测试串扰。
  Position.x[eid] = 0;
  Position.y[eid] = 0;
  Position.px[eid] = 0;
  Position.py[eid] = 0;
  add(world, eid, Health);
  add(world, eid, PlayerId);
  add(world, eid, NetId);
  add(world, eid, Owner);
  add(world, eid, PlayerTag);
  add(world, eid, ControlSource);
  if (replicated) add(world, eid, Replicated);
  return eid;
}

/** 构造 DeterministicSim 需要的最小状态（只用到 world 与 session）。 */
function makeSimState(world: ReturnType<typeof createBattleWorld>): SimState {
  return {
    world,
    config: {} as SimState['config'],
    session: { simTick: 0 } as unknown as SimState['session'],
    pool: {} as SimState['pool'],
    buses: {} as SimState['buses'],
    rng: new Rng(1234),
  } as unknown as SimState;
}

describe('EntityRegistry 三向映射', () => {
  it('alloc → 查询 → release → 复用，eid 永不上线', () => {
    const world = createBattleWorld('registry-test');
    const registry = new EntityRegistry(world);
    const eidA = makePlayer(world, true);
    const eidB = makePlayer(world, true);

    const netId = registry.alloc(eidA, 0);
    expect(netId).toBe(1);
    expect(registry.byNetId(netId)).toBe(eidA);
    expect(registry.byEid(eidA)).toBe(netId);
    expect(registry.playerOf(netId)).toBe(0);
    expect(registry.byEid(eidB)).toBe(0);

    expect(registry.alloc(eidA, 0)).toBe(0); // 同一 eid 不可重复分配
    expect(registry.alloc(-1, 0)).toBe(0);
    expect(registry.alloc(eidB, 99)).toBe(0);

    registry.release(netId);
    expect(registry.byNetId(netId)).toBe(0);
    expect(registry.byEid(eidA)).toBe(0);
    expect(registry.playerOf(netId)).toBe(-1);
    expect(registry.alloc(eidB, 1)).toBe(netId); // 空闲 NetId 优先复用
  });

  it('客户端模式禁止 alloc，但允许 bind/rebuild', () => {
    const world = createBattleWorld('registry-client');
    const registry = new EntityRegistry(world);
    const eid = makePlayer(world, true);
    registry.setAuthority(false);
    expect(registry.alloc(eid, 0)).toBe(0);
    registry.bind(eid, 7, 2);
    expect(registry.byNetId(7)).toBe(eid);
    expect(registry.playerOf(7)).toBe(2);

    const snap = buildSnapshot(world, registry, 1);
    registry.rebuild(snap);
    expect(registry.byNetId(7)).toBe(eid);
  });
});

describe('LoopbackTransport 消息闭环与 chaos', () => {
  it('Host↔Client link 后按 tick 投递输入报告', () => {
    const host = new LoopbackTransport(1, { latencyMs: 4, seed: 11 });
    // 发送方是 client，延迟条件必须装在 client 上。
    const client = new LoopbackTransport(2, { latencyMs: 4, seed: 11 });
    host.link(client);
    const received: NetMessage[] = [];
    host.onMessage((msg) => received.push(msg));

    const frame = createInputFrame();
    frame.moveX = 0.75;
    const msg: NetMessage = {
      type: NetMsgType.InputReport,
      from: 2,
      to: 1,
      tick: 42,
      payload: encodeInputPayload(2, frame),
    };
    client.send(msg);
    expect(received.length).toBe(0);
    client.tick(3);
    expect(received.length).toBe(0);
    client.tick(4);
    expect(received.length).toBe(1);
    expect(received[0].tick).toBe(42);
    expect(received[0].payload.byteLength).toBe(msg.payload.byteLength);
  });

  it('相同 seed 的丢包/抖动/重复序列完全可复现', () => {
    const run = (seed: number): number[] => {
      const sender = new LoopbackTransport(1, {
        latencyMs: 2, jitterMs: 6, dropRate: 0.3, duplicateRate: 0.4, seed,
      });
      const receiver = new LoopbackTransport(2, { seed });
      sender.link(receiver);
      const ticks: number[] = [];
      receiver.onMessage((msg) => ticks.push(msg.tick));
      for (let t = 1; t <= 20; t++) {
        sender.send({
          type: NetMsgType.InputReport,
          from: 1,
          to: 2,
          tick: t,
          payload: encodeInputPayload(1, createInputFrame()),
        });
      }
      sender.flush();
      return ticks;
    };
    const a = run(777);
    expect(a.length).toBeGreaterThan(0);
    expect(run(777)).toEqual(a);
    expect(run(778)).not.toEqual(a);
  });

  it('dropRate=1 全丢；duplicateRate=1 产生两份副本', () => {
    const dropSender = new LoopbackTransport(1, { dropRate: 1, seed: 5 });
    const dropReceiver = new LoopbackTransport(2);
    dropSender.link(dropReceiver);
    let drops = 0;
    dropReceiver.onMessage(() => { drops++; });
    dropSender.send({
      type: NetMsgType.InputReport, from: 1, to: 2, tick: 1,
      payload: encodeInputPayload(1, createInputFrame()),
    });
    dropSender.flush();
    expect(drops).toBe(0);

    const dupSender = new LoopbackTransport(1, { duplicateRate: 1, seed: 5 });
    const dupReceiver = new LoopbackTransport(2);
    dupSender.link(dupReceiver);
    let dups = 0;
    dupReceiver.onMessage(() => { dups++; });
    dupSender.send({
      type: NetMsgType.InputReport, from: 1, to: 2, tick: 1,
      payload: encodeInputPayload(1, createInputFrame()),
    });
    dupSender.flush();
    expect(dups).toBe(2);
  });

  it('大抖动可产生乱序投递', () => {
    let sawOutOfOrder = false;
    for (let seed = 1; seed <= 20 && !sawOutOfOrder; seed++) {
      const sender = new LoopbackTransport(1, { jitterMs: 100, seed });
      const receiver = new LoopbackTransport(2);
      sender.link(receiver);
      const ticks: number[] = [];
      receiver.onMessage((msg) => ticks.push(msg.tick));
      for (let t = 1; t <= 10; t++) {
        sender.send({
          type: NetMsgType.InputReport, from: 1, to: 2, tick: t,
          payload: encodeInputPayload(1, createInputFrame()),
        });
      }
      sender.flush();
      for (let i = 1; i < ticks.length; i++) {
        if (ticks[i] < ticks[i - 1]) sawOutOfOrder = true;
      }
    }
    expect(sawOutOfOrder).toBe(true);
  });
});

describe('Snapshot 精确等于 Replicated 集合', () => {
  it('只复制带 Replicated 标签的实体，按 NetId 排序', () => {
    const hostWorld = createBattleWorld('snap-host');
    const registry = new EntityRegistry(hostWorld);
    const eidA = makePlayer(hostWorld, true);
    const eidB = makePlayer(hostWorld, false);
    const netA = registry.alloc(eidA, 0);
    const netB = registry.alloc(eidB, 1);
    expect(netB).toBe(netA + 1);
    Position.x[eidA] = 12.5;
    Position.y[eidA] = -3.25;
    Health.cur[eidA] = 88;

    const snap = buildSnapshot(hostWorld, registry, 9);
    expect(snap.tick).toBe(9);
    expect(Array.from(snap.netIds)).toEqual([netA]);
    expect(snap.mask).not.toBe(0);

    const clientWorld = createBattleWorld('snap-client');
    const clientRegistry = new EntityRegistry(clientWorld);
    applySnapshot(snap, clientWorld, clientRegistry);
    const clientEid = clientRegistry.byNetId(netA);
    expect(clientEid).toBeGreaterThan(0);
    expect(Position.x[clientEid]).toBe(12.5);
    expect(Position.y[clientEid]).toBe(-3.25);
    expect(Health.cur[clientEid]).toBe(88);
    expect(clientRegistry.byNetId(netB)).toBe(0);
    expect(readPositions(snap)).not.toBeNull();
    expect(readPositions(snap)![0]).toBe(12.5);
  });

  it('晚加入者从全量快照重建三向映射', () => {
    const world = createBattleWorld('snap-rebuild');
    const registry = new EntityRegistry(world);
    const eid = makePlayer(world, true);
    const netId = registry.alloc(eid, 2);
    const snap = buildSnapshot(world, registry, 3);

    const lateRegistry = new EntityRegistry(world, 4096);
    lateRegistry.rebuild(snap);
    expect(lateRegistry.byNetId(netId)).toBe(eid);
    expect(lateRegistry.playerOf(netId)).toBe(2);
  });
});

describe('DeterministicSim 纯入口与状态哈希', () => {
  it('系统按 order 执行，同状态哈希一致，状态变化后哈希改变', () => {
    const world = createBattleWorld('sim-hash');
    const registry = new EntityRegistry(world);
    const eid = makePlayer(world, true);
    registry.alloc(eid, 0);
    Position.x[eid] = 100;

    const state = makeSimState(world);
    const trace: string[] = [];
    const systems: SimSystem[] = [
      { id: 'second', order: 2, run: (_s, tick) => { trace.push(`second${tick}`); } },
      { id: 'first', order: 1, run: (_s, tick) => { trace.push(`first${tick}`); } },
    ];
    const sim = new DeterministicSim(state, systems);
    const frame = createInputFrame();
    frame.moveX = 0.5;
    sim.step(5, frame, state);
    expect(trace).toEqual(['first5', 'second5']);
    expect(sim.systemCount).toBe(2);

    const hashA = sim.hash(state);
    expect(hashA).toBe(sim.hash(state));
    Position.x[eid] = 101;
    expect(sim.hash(state)).not.toBe(hashA);
  });
});

describe('PredictionBuffer 和解收敛', () => {
  it('小误差插值、大误差直接 snap，并返回重放 tick 数', () => {
    const world = createBattleWorld('prediction-world');
    const registry = new EntityRegistry(world);
    const eid = makePlayer(world, true);
    const netId = registry.alloc(eid, 0);
    Position.x[eid] = 100;
    const authoritative = buildSnapshot(world, registry, 3);

    const buffer = new PredictionBuffer(16);
    for (let tick = 1; tick <= 6; tick++) {
      const frame = createInputFrame();
      frame.tick = tick;
      frame.moveX = tick;
      buffer.recordInput(tick, frame);
    }

    const applied: ReturnType<typeof buildSnapshot>[] = [];
    const replayed: number[] = [];
    buffer.setPredictedPositions(new Float32Array([100.5, 0]));
    const replayCount = buffer.reconcile(
      authoritative,
      (snap) => applied.push(snap),
      (tick) => replayed.push(tick),
    );
    expect(replayCount).toBe(3);
    expect(replayed).toEqual([4, 5, 6]);
    expect(applied.length).toBe(1);
    expect(applied[0].data).not.toBe(authoritative.data);
    expect(readPositions(applied[0])![0]).toBeCloseTo(100.25, 4);
    expect(buffer.lastAckedTick()).toBe(3);
    expect(buffer.inputsAfter(3).length).toBe(3);

    const secondApplied: ReturnType<typeof buildSnapshot>[] = [];
    buffer.setPredictedPositions(new Float32Array([300, 0]));
    buffer.reconcile(authoritative, (snap) => secondApplied.push(snap), () => undefined);
    expect(secondApplied[0].data).toBe(authoritative.data); // 传送级误差直接 snap
    expect(buffer.lastAckedTick()).toBe(3);
    expect(netId).toBe(1);
  });
});

describe('NetSessionManager 角色 FSM 与掉线影子', () => {
  it('选举取最小 NetId，掉线玩家降级为 AI 影子', () => {
    const world = createBattleWorld('session-world');
    const registry = new EntityRegistry(world);
    const eid = makePlayer(world, true);
    const netId = registry.alloc(eid, 1);
    const manager = new NetSessionManager(world, new NullTransport(1), registry);

    manager.startStandalone(4242, 2);
    expect(manager.state.role).toBe(AuthorityRole.Standalone);
    expect(manager.state.roomSeed).toBe(4242);
    expect(manager.state.hostNetId).toBe(netId);

    manager.becomeClient(9);
    expect(manager.state.role).toBe(AuthorityRole.Client);
    expect(manager.electNewHost([9, 4, 7])).toBe(4);
    expect(manager.state.hostNetId).toBe(4);
    expect(manager.state.role).toBe(AuthorityRole.Client);

    manager.promoteToHost();
    ControlSource.kind[eid] = 2;
    ControlSource.ref[eid] = 1;
    manager.onPeerLost(netId);
    expect(ControlSource.kind[eid]).toBe(1);
    expect(ControlSource.ref[eid]).toBe(1);
    manager.dispose();
  });

  it('FSM 变更写回 B1 持有的普通会话对象，并保留其派生字段', () => {
    const world = createBattleWorld('session-plain');
    const registry = new EntityRegistry(world);
    const eid = makePlayer(world, true);
    registry.alloc(eid, 0);
    const plain = {
      role: 0,
      localNetId: 1,
      hostNetId: 1,
      localPlayerId: 0,
      roomSeed: 0,
      simTick: 0,
      lastAckedTick: 0,
      tickRate: 60,
      playerCount: 1,
      elapsed: 12.5,
      spawnAcc: 3,
      nextNetId: 9,
    };
    const manager = new NetSessionManager(world, new NullTransport(1), registry);
    manager.bindStateSession(plain);
    manager.becomeClient(7);
    expect(plain.role).toBe(AuthorityRole.Client);
    expect(plain.hostNetId).toBe(7);
    expect(plain.elapsed).toBe(12.5);
    expect(plain.nextNetId).toBe(9);
    manager.state.lastAckedTick = 33;
    manager.syncNow();
    expect(plain.lastAckedTick).toBe(33);
    manager.dispose();
  });
});

describe('FullSnapshotStrategy 与系统注册', () => {
  it('InputReport 经 Host 运行时进入 NetInputBuffer', () => {
    resetNetSystems();
    const hostWorld = createBattleWorld('netsys-host');
    const registry = new EntityRegistry(hostWorld);
    const eid = makePlayer(hostWorld, true);
    const netId = registry.alloc(eid, 0);
    const hostTransport = new LoopbackTransport(1, { seed: 3 });
    const clientTransport = new LoopbackTransport(2, { seed: 3 });
    hostTransport.link(clientTransport);

    const session = new NetSessionManager(hostWorld, new NullTransport(1), registry);
    session.promoteToHost();
    const inputBuffer = new NetInputBuffer();
    const strategy = new FullSnapshotStrategy({
      world: hostWorld,
      registry,
      transport: hostTransport,
      session,
      inputBuffer,
      prediction: new PredictionBuffer(),
      events: new GameEventBus(64),
    });
    configureNetRuntime({ transport: hostTransport, strategy, session, inputBuffer });

    const frame = createInputFrame();
    frame.moveX = 0.25;
    frame.tick = 12;
    clientTransport.send(strategy.reportInput(12, frame));
    clientTransport.tick(1);

    const out = createInputFrame();
    expect(inputBuffer.read(12, netId, out)).toBe(true);
    expect(out.moveX).toBe(0.25);

    const registered: Array<{ order: number; id: string }> = [];
    const app = {
      registerSimSystem: (order: number, _fn: unknown, id: string): void => {
        registered.push({ order, id });
      },
    } as unknown as App;
    installNetSystems(app, strategy);
    expect(registered.map((entry) => entry.order)).toEqual([-2, -1, 18]);
    resetNetSystems();
  });

  it('Delta 基础实现可往返应用', () => {
    const world = createBattleWorld('delta-world');
    const registry = new EntityRegistry(world);
    const eid = makePlayer(world, true);
    registry.alloc(eid, 0);
    const strategy = new FullSnapshotStrategy({ world, registry });
    const delta = strategy.buildDelta(4, 8);
    expect(delta.type).toBe(NetMsgType.Delta);
    const clientWorld = createBattleWorld('delta-client');
    const clientRegistry = new EntityRegistry(clientWorld);
    const clientStrategy = new FullSnapshotStrategy({
      world: clientWorld, registry: clientRegistry,
    });
    clientStrategy.applyDelta(delta);
    expect(clientRegistry.size).toBe(1);
  });
});

describe('侧载注册入口 registration/net.ts', () => {
  it('world 未就绪时不注入依赖；standalone 下 order 18 不消费事件', () => {
    resetNetSystems();
    const events = new GameEventBus(64);
    const session = {
      role: 0,
      localNetId: 1,
      hostNetId: 1,
      localPlayerId: 0,
      roomSeed: 12345,
      simTick: 0,
      lastAckedTick: 0,
      tickRate: 60,
      playerCount: 1,
    };
    const state = {
      world: null as ReturnType<typeof createBattleWorld> | null,
      session,
      buses: { events },
    };
    const systems: Array<{
      order: number;
      id: string;
      fn: (s: SimState, tick: number) => void;
    }> = [];
    const app = {
      state,
      registerSimSystem: (order: number, fn: (s: SimState, tick: number) => void, id: string): void => {
        systems.push({ order, id, fn });
      },
    } as unknown as App;

    registerNetSideLoad(app);
    expect(systems.map((entry) => entry.order)).toEqual([-2, -1, 18, -3]);

    const stateRef = state as unknown as SimState;
    events.emit(GameEventType.NetEvent, 1, 2, 3);
    systems.find((entry) => entry.id === 'NetBootstrap')!.fn(stateRef, 1);
    systems.find((entry) => entry.id === 'NetInputReportBroadcast')!.fn(stateRef, 1);
    expect(events.size).toBe(1); // world 为 null 且 standalone，不构建快照、不 drain 事件

    const world = createBattleWorld('bootstrap-world');
    const eid = makePlayer(world, true);
    NetId.value[eid] = 1;
    PlayerId.value[eid] = 0;
    state.world = world;
    systems.find((entry) => entry.id === 'NetBootstrap')!.fn(stateRef, 2);
    systems.find((entry) => entry.id === 'NetInputReportBroadcast')!.fn(stateRef, 2);
    expect(events.size).toBe(1);

    resetNetSystems();
  });
});
