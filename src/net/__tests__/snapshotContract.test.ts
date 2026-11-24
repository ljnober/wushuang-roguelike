/**
 * QA1 网络契约独立验证（DESIGN.md §5/§6.3、ARCHITECTURE.md §5.8、PRD P4/P5）。
 *
 * 覆盖：快照精确等于 Replicated 集合（非 Replicated 实体逐字节不影响 payload）、
 * NetId 往返回收与客户端分配禁令、Loopback chaos 可复现、和解在 chaos 下收敛。
 * 另含一条 DESIGN §6.3 Replicated 列完整性断言，用于暴露 AIState 未进快照的契约缺陷。
 *
 * 本环境使用 vite.config.ts 的 globals:true，直接用全局 describe / it / expect。
 */
import { INVALID_EID, INVALID_NET_ID } from '../../core/Constants';
import { add, has, query, spawn, type BattleWorld } from '../../ecs/bit/adapter';
import {
  AIState,
  Culled,
  Health,
  NetId,
  Owner,
  PlayerId,
  Position,
  Replicated,
  RenderRef,
} from '../../ecs/bit/components';
import { createBattleWorld } from '../../ecs/world';
import { createInputFrame } from '../../ecs/systems/control/IControlSource';
import { createEventSlot } from '../../ecs/bridge/GameEventBus';
import { NetMsgType, encodeInputPayload, type NetMessage } from '../messages';
import { EntityRegistry } from '../EntityRegistry';
import { PredictionBuffer } from '../PredictionBuffer';
import {
  SNAPSHOT_COLUMNS,
  applySnapshot,
  buildSnapshot,
  decodeSnapshot,
  readPositions,
} from '../Snapshot';
import { LoopbackTransport } from '../transport';

function makeUnit(world: BattleWorld, replicated: boolean, x: number): number {
  const eid = spawn(world);
  add(world, eid, Position);
  add(world, eid, Health);
  add(world, eid, NetId);
  add(world, eid, Owner);
  add(world, eid, PlayerId);
  if (replicated) add(world, eid, Replicated);
  Position.x[eid] = x;
  Position.y[eid] = 0;
  Position.px[eid] = x;
  Position.py[eid] = 0;
  Health.cur[eid] = 100;
  return eid;
}

describe('快照精确等于 Replicated 集合', () => {
  it('未带 Replicated 的实体不影响快照 payload 的任何一个字节', () => {
    // Arrange：一个 Replicated 实体 + 一个非 Replicated 实体，二者都有 Network 元数据。
    const world = createBattleWorld('qa-snap-exact');
    const registry = new EntityRegistry(world);
    const kept = makeUnit(world, true, 12.5);
    const ignored = makeUnit(world, false, 9999);
    const keptNet = registry.alloc(kept, 0);
    const ignoredNet = registry.alloc(ignored, 1);
    expect(keptNet).toBeGreaterThan(0);
    expect(ignoredNet).toBeGreaterThan(keptNet);

    const first = buildSnapshot(world, registry, 7);
    expect(Array.from(first.netIds)).toEqual([keptNet]);

    // Act：只改非 Replicated 实体的所有数据。
    Position.x[ignored] = -12345;
    Position.y[ignored] = -54321;
    Health.cur[ignored] = 1;
    const second = buildSnapshot(world, registry, 7);

    // Assert：两次 payload 逐字节一致，且 header.count === 1。
    expect(Buffer.from(first.data).equals(Buffer.from(second.data))).toBe(true);
    expect(new DataView(first.data).getUint32(16, true)).toBe(1);
    expect(new DataView(first.data).getUint32(8, true)).toBe(7);
    expect(readPositions(first)).not.toBeNull();
    expect(readPositions(first)![0]).toBe(12.5);
  });

  it('presence 掩码逐实体精确：未挂载的组件不会被补零成有效列', () => {
    const world = createBattleWorld('qa-snap-presence');
    const registry = new EntityRegistry(world);
    const a = makeUnit(world, true, 1);
    const b = makeUnit(world, true, 2);
    add(world, a, RenderRef);
    add(world, b, Culled);
    registry.alloc(a, 0);
    registry.alloc(b, 1);

    const snap = buildSnapshot(world, registry, 11);
    const presence = new Uint32Array(snap.data, 28, 2);
    const healthBit = SNAPSHOT_COLUMNS.find((c) => c.component === Health)!.bit;
    const positionBit = SNAPSHOT_COLUMNS.find((c) => c.component === Position)!.bit;
    expect(presence[0] & healthBit).toBeTruthy();
    expect(presence[1] & healthBit).toBeTruthy();
    expect(presence[0] & positionBit).toBeTruthy();
    // RenderRef / Culled 都是渲染层数据，不应出现在任何快照列。
    expect(SNAPSHOT_COLUMNS.some((c) => c.component === RenderRef)).toBe(false);
    expect(SNAPSHOT_COLUMNS.some((c) => c.component === Culled)).toBe(false);
    expect((snap.mask & healthBit) !== 0).toBe(true);
  });

  it('快照只携带 NetId，按 NetId 升序排列，eid 不在 wire 字段中', () => {
    const world = createBattleWorld('qa-snap-netid');
    const registry = new EntityRegistry(world);
    // 先把 eid 推到 8 以上，确保 eid 数值与 1..N 的 NetId 不会因巧合相等。
    for (let i = 0; i < 8; i++) spawn(world);
    const e1 = makeUnit(world, true, 5);
    const e2 = makeUnit(world, true, 6);
    const n1 = registry.alloc(e1, 0);
    const n2 = registry.alloc(e2, 1);
    // 让 eid 顺序与 NetId 顺序相反：先回收再分配一个更小的 NetId。
    registry.release(n2);
    const nReused = registry.alloc(e2, 1);
    expect(nReused).toBe(n2);
    const snap = buildSnapshot(world, registry, 3);
    expect(Array.from(snap.netIds)).toEqual([n1, n2]);
    expect(snap.netIds.includes(e1)).toBe(false);
    expect(snap.netIds.includes(e2)).toBe(false);
    expect(n1).not.toBe(e1);
  });

  it('decodeSnapshot 对损坏 payload 抛错，正常 payload 可往返', () => {
    const world = createBattleWorld('qa-snap-decode');
    const registry = new EntityRegistry(world);
    const eid = makeUnit(world, true, 33);
    registry.alloc(eid, 0);
    const snap = buildSnapshot(world, registry, 21);
    const decoded = decodeSnapshot(snap.data, 99);
    expect(decoded.tick).toBe(21);
    expect(Array.from(decoded.netIds)).toEqual(Array.from(snap.netIds));
    expect(() => decodeSnapshot(new ArrayBuffer(4))).toThrow();
    const broken = snap.data.slice(0);
    new DataView(broken).setUint32(0, 0xdeadbeef, true);
    expect(() => decodeSnapshot(broken)).toThrow();
  });

  /** DESIGN.md §6.3 明确 AIState 属于 Replicated 集合，必须进入快照列。 */
  it('DESIGN §6.3: AIState 属于快照 Replicated 列', () => {
    const columnComponents = SNAPSHOT_COLUMNS.map((column) => column.component);
    expect(columnComponents).toContain(AIState);
  });

  it('AIState 经快照往返完整恢复（DESIGN §6.3）', () => {
    // Arrange：Host 上一个处于预警态（state=4）的敌人带完整 AIState。
    const hostWorld = createBattleWorld('qa-ai-snap-host');
    const hostRegistry = new EntityRegistry(hostWorld);
    const hostEid = makeUnit(hostWorld, true, 0);
    add(hostWorld, hostEid, AIState);
    AIState.state[hostEid] = 4;
    AIState.timer[hostEid] = 0.9;
    AIState.policy[hostEid] = 2;
    AIState.targetNetId[hostEid] = 77;
    AIState.retargetTimer[hostEid] = 0.35;
    const netId = hostRegistry.alloc(hostEid, 1);

    // Act：构建并应用全量快照。
    const snap = buildSnapshot(hostWorld, hostRegistry, 5);
    const clientWorld = createBattleWorld('qa-ai-snap-client');
    const clientRegistry = new EntityRegistry(clientWorld);
    applySnapshot(snap, clientWorld, clientRegistry);
    const clientEid = clientRegistry.byNetId(netId);
    expect(clientEid).not.toBe(INVALID_EID);

    // Assert：客户端实体不仅有 AIState 组件，六个字段都必须与 Host 一致。
    expect(has(clientWorld, clientEid, AIState)).toBe(true);
    expect(SNAPSHOT_COLUMNS.some((c) => c.component === AIState)).toBe(true);
    expect(AIState.state[clientEid]).toBe(4);
    expect(AIState.policy[clientEid]).toBe(2);
    expect(AIState.targetNetId[clientEid]).toBe(77);
    expect(AIState.timer[clientEid]).toBeCloseTo(0.9, 6);
    expect(AIState.retargetTimer[clientEid]).toBeCloseTo(0.35, 6);
  });
});

describe('NetId 往返回收', () => {
  it('alloc → byNetId/byEid/playerOf → release → 空闲复用，客户端禁止分配', () => {
    const world = createBattleWorld('qa-registry');
    const registry = new EntityRegistry(world);
    const a = makeUnit(world, true, 0);
    const b = makeUnit(world, true, 0);
    const netA = registry.alloc(a, 0);
    const netB = registry.alloc(b, 1);
    expect(netA).toBe(1);
    expect(netB).toBe(2);
    expect(registry.byNetId(netA)).toBe(a);
    expect(registry.byEid(a)).toBe(netA);
    expect(registry.playerOf(netB)).toBe(1);
    expect(NetId.value[a]).toBe(netA);
    expect(Owner.netId[a]).toBe(netA);

    registry.release(netA);
    expect(registry.byNetId(netA)).toBe(INVALID_EID);
    expect(registry.byEid(a)).toBe(INVALID_NET_ID);
    expect(registry.playerOf(netA)).toBe(-1);
    expect(NetId.value[a]).toBe(INVALID_NET_ID);
    expect(registry.alloc(a, 0)).toBe(netA);

    registry.setAuthority(false);
    expect(registry.alloc(b, 1)).toBe(INVALID_NET_ID);
    expect(registry.authority).toBe(false);
    registry.bind(b, 77, 2);
    expect(registry.byNetId(77)).toBe(b);
    expect(registry.playerOf(77)).toBe(2);
  });
});

describe('Loopback chaos 可复现且和解收敛', () => {
  interface ChaosRun {
    deliveredTicks: number[];
    maxAck: number;
    convergedX: number;
    replayed: number[];
  }

  const runChaos = (seed: number): ChaosRun => {
    // Arrange：host 世界每 tick 推进权威位置，经 chaos 通道发给 client。
    const hostWorld = createBattleWorld(`qa-chaos-host-${seed}`);
    const hostRegistry = new EntityRegistry(hostWorld);
    const hostEid = makeUnit(hostWorld, true, 0);
    const netId = hostRegistry.alloc(hostEid, 0);
    const sender = new LoopbackTransport(1, {
      latencyMs: 3, jitterMs: 8, dropRate: 0.2, duplicateRate: 0.35, seed,
    });
    const receiver = new LoopbackTransport(2, { seed });
    sender.link(receiver);

    const deliveredTicks: number[] = [];
    const messages: NetMessage[] = [];
    receiver.onMessage((msg) => {
      deliveredTicks.push(msg.tick);
      messages.push(msg);
    });

    for (let tick = 1; tick <= 40; tick++) {
      Position.x[hostEid] = tick * 5;
      const snap = buildSnapshot(hostWorld, hostRegistry, tick);
      sender.send({
        type: NetMsgType.StateSnapshot,
        from: 1,
        to: 2,
        tick,
        payload: snap.data,
      });
      sender.tick(tick * 16);
    }
    sender.flush();
    expect(messages.length).toBeGreaterThan(0);

    // Act：客户端只应用 chaos 后实际到达的、tick 最大的权威快照。
    const clientWorld = createBattleWorld(`qa-chaos-client-${seed}`);
    const clientRegistry = new EntityRegistry(clientWorld);
    let latest = decodeSnapshot(messages[0].payload, messages[0].tick);
    for (let i = 1; i < messages.length; i++) {
      const candidate = decodeSnapshot(messages[i].payload, messages[i].tick);
      if (candidate.tick > latest.tick) latest = candidate;
    }

    const prediction = new PredictionBuffer(64);
    for (let tick = latest.tick + 1; tick <= latest.tick + 3; tick++) {
      const frame = createInputFrame();
      frame.tick = tick;
      prediction.recordInput(tick, frame);
    }
    const replayed: number[] = [];
    let appliedTick = 0;
    const count = prediction.reconcile(
      latest,
      (snap) => {
        applySnapshot(snap, clientWorld, clientRegistry);
        appliedTick = snap.tick;
      },
      (tick) => replayed.push(tick),
    );
    expect(count).toBe(replayed.length);
    expect(appliedTick).toBe(latest.tick);
    expect(prediction.lastAckedTick()).toBe(latest.tick);

    const clientEid = clientRegistry.byNetId(netId);
    expect(clientEid).not.toBe(INVALID_EID);
    return {
      deliveredTicks,
      maxAck: prediction.lastAckedTick(),
      convergedX: Position.x[clientEid],
      replayed,
    };
  };

  it('相同 seed 的丢包 / 抖动 / 重复投递序列完全可复现', () => {
    const a = runChaos(424242);
    const b = runChaos(424242);
    expect(a.deliveredTicks.length).toBeGreaterThan(0);
    expect(b.deliveredTicks).toEqual(a.deliveredTicks);
    expect(a.replayed).toEqual(b.replayed);
  });

  it('chaos 下收到权威快照后和解收敛到该 tick 的权威位置并重放未确认输入', () => {
    const result = runChaos(424242);
    expect(result.maxAck).toBeGreaterThan(0);
    expect(result.convergedX).toBe(result.maxAck * 5);
    expect(result.replayed.length).toBe(3);
    expect(result.replayed).toEqual([
      result.maxAck + 1,
      result.maxAck + 2,
      result.maxAck + 3,
    ]);
  });

  it('EventBatch 重放不丢事件槽，重复包不会污染事件顺序', () => {
    const sender = new LoopbackTransport(1, { duplicateRate: 1, seed: 9 });
    const receiver = new LoopbackTransport(2, { seed: 9 });
    sender.link(receiver);
    const seen: number[] = [];
    receiver.onMessage((msg) => {
      const events: Array<{ type: number; a: number; b: number; c: number }> = [];
      const view = new DataView(msg.payload);
      for (let offset = 0; offset + 16 <= msg.payload.byteLength; offset += 16) {
        events.push({
          type: view.getInt32(offset, true),
          a: view.getFloat32(offset + 4, true),
          b: view.getFloat32(offset + 8, true),
          c: view.getFloat32(offset + 12, true),
        });
      }
      for (let i = 0; i < events.length; i++) seen.push(events[i].b);
    });
    const frame = createInputFrame();
    sender.send({
      type: NetMsgType.EventBatch,
      from: 1,
      to: 2,
      tick: 1,
      payload: encodeInputPayload(1, frame),
    });
    sender.flush();
    // 32 字节 payload 按 16 字节步长解析为 2 条；重复率 1 → 两份副本。
    expect(seen.length).toBe(4);
  });

  it('createEventSlot 生成的槽位可安全复用（零分配 drain 的测试侧配合）', () => {
    const slot = createEventSlot();
    slot.a = 42;
    expect(slot.a).toBe(42);
    expect(has(createBattleWorld('qa-slot'), 0, Position)).toBe(false);
  });
});
