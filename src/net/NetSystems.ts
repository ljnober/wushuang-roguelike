/**
 * 网络系统调度与同步策略（ARCHITECTURE §5.8 / §6.3）。
 *
 * installNetSystems 只注册负数 order 的客户端前置系统与 order 18 的输入上报/快照广播；
 * 1..17 与 19 由 B1 的 registration/systems.ts 负责，本文件绝不触碰。
 *
 * FullSnapshotStrategy 提供完整的 Full 快照实现；buildDelta/applyDelta 按 P6 采用
 * "Delta 信封 + 内嵌 Full 快照字节" 的基础可用实现，接口保持不变。
 */
import type { App } from '../app/App';
import { has, query, type BattleWorld } from '../ecs/bit/adapter';
import { InputCmd, PlayerId, PlayerTag } from '../ecs/bit/components';
import { GameEventType } from '../ecs/bridge/enums';
import { GameEventBus, createEventSlot, type GameEvent } from '../ecs/bridge/GameEventBus';
import type { SimState } from '../ecs/scheduler';
import {
  createInputFrame,
  type InputFrame,
} from '../ecs/systems/control/IControlSource';
import { EntityRegistry } from './EntityRegistry';
import {
  NetInputBuffer,
  NetMsgType,
  decodeControlMessage,
  decodeEvents,
  decodeInputPayload,
  encodeEvents,
  encodeInputPayload,
  type NetMessage,
} from './messages';
import {
  applySnapshot as applyWorldSnapshot,
  buildSnapshot as buildWorldSnapshot,
  createEmptySnapshot,
  decodeSnapshot,
  type Snapshot,
} from './Snapshot';
import {
  AuthorityRole,
  NetSessionManager,
  asMutableSession,
  createNetSession,
  isAuthoritative,
  sessionFromState,
  writeSessionFields,
  type NetSession,
} from './session';
import { ITransport } from './transport';
import { PredictionBuffer } from './PredictionBuffer';

/** collectEvents 的预分配槽位数；超出部分由 GameEventBus 自行丢弃并计数。 */
const EVENT_SLOT_COUNT = 256;
/** Delta 信封头：fromTick u32 + toTick u32。 */
const DELTA_HEADER_BYTES = 8;

/** 冻结的同步策略接口。 */
export interface ISyncStrategy {
  reportInput(tick: number, frame: InputFrame): NetMessage;
  buildSnapshot(tick: number): Snapshot;
  applySnapshot(snap: Snapshot): void;
  collectEvents(tick: number): NetMessage;
  replayEvents(msg: NetMessage): void;
  buildDelta(fromTick: number, toTick: number): NetMessage;
  applyDelta(msg: NetMessage): void;
}

/** FullSnapshotStrategy 所需依赖（全部可选，便于分阶段装配）。 */
export interface FullSnapshotDeps {
  world: BattleWorld;
  registry: EntityRegistry;
  transport: ITransport;
  session: NetSessionManager | NetSession;
  inputBuffer: NetInputBuffer;
  prediction: PredictionBuffer;
  events: GameEventBus;
}

function idsOf(session: NetSessionManager | NetSession | undefined): { local: number; host: number } {
  if (session instanceof NetSessionManager) {
    return { local: session.state.localNetId, host: session.state.hostNetId };
  }
  if (session !== undefined) {
    const plain = sessionFromState(session);
    return { local: plain.localNetId, host: plain.hostNetId };
  }
  return { local: 1, host: 1 };
}

/** Full 快照同步策略（P6 delta 采用内嵌 Full 的基础实现）。 */
export class FullSnapshotStrategy implements ISyncStrategy {
  private readonly deps: Partial<FullSnapshotDeps> = {};
  private readonly frame: InputFrame = createInputFrame();
  private readonly eventSlots: GameEvent[] = [];

  constructor(deps: Partial<FullSnapshotDeps> = {}) {
    this.attach(deps);
    for (let i = 0; i < EVENT_SLOT_COUNT; i++) this.eventSlots.push(createEventSlot());
  }

  /** 增量装配依赖；未提供的字段保留原值。 */
  attach(deps: Partial<FullSnapshotDeps>): void {
    if (deps.world !== undefined) this.deps.world = deps.world;
    if (deps.registry !== undefined) this.deps.registry = deps.registry;
    if (deps.transport !== undefined) this.deps.transport = deps.transport;
    if (deps.session !== undefined) this.deps.session = deps.session;
    if (deps.inputBuffer !== undefined) this.deps.inputBuffer = deps.inputBuffer;
    if (deps.prediction !== undefined) this.deps.prediction = deps.prediction;
    if (deps.events !== undefined) this.deps.events = deps.events;
  }

  reportInput(tick: number, frame: InputFrame): NetMessage {
    const ids = idsOf(this.deps.session);
    return {
      type: NetMsgType.InputReport,
      from: ids.local,
      to: ids.host,
      tick,
      payload: encodeInputPayload(ids.local, frame),
    };
  }

  buildSnapshot(tick: number): Snapshot {
    const world = this.deps.world;
    const registry = this.deps.registry;
    if (world === undefined || registry === undefined) return createEmptySnapshot(tick);
    return buildWorldSnapshot(world, registry, tick);
  }

  applySnapshot(snap: Snapshot): void {
    const world = this.deps.world;
    const registry = this.deps.registry;
    if (world === undefined || registry === undefined) return;
    applyWorldSnapshot(snap, world, registry);
    registry.rebuild(snap);
  }

  collectEvents(tick: number): NetMessage {
    const ids = idsOf(this.deps.session);
    const bus = this.deps.events;
    const count = bus === undefined ? 0 : bus.drain(this.eventSlots);
    return {
      type: NetMsgType.EventBatch,
      from: ids.local,
      to: ids.host,
      tick,
      payload: encodeEvents(this.eventSlots.slice(0, count)),
    };
  }

  replayEvents(msg: NetMessage): void {
    const bus = this.deps.events;
    if (bus === undefined) return;
    decodeEvents(msg.payload, (type, a, b, c) => {
      bus.emit(type as GameEventType, a, b, c);
    });
  }

  /** P6 基础实现：Delta 信封携带 [fromTick,toTick] + 完整快照字节。 */
  buildDelta(fromTick: number, toTick: number): NetMessage {
    const snap = this.buildSnapshot(toTick);
    const payload = new ArrayBuffer(DELTA_HEADER_BYTES + snap.data.byteLength);
    const view = new DataView(payload);
    view.setUint32(0, fromTick >>> 0, true);
    view.setUint32(4, toTick >>> 0, true);
    new Uint8Array(payload).set(new Uint8Array(snap.data), DELTA_HEADER_BYTES);
    const ids = idsOf(this.deps.session);
    return {
      type: NetMsgType.Delta,
      from: ids.local,
      to: ids.host,
      tick: toTick,
      payload,
    };
  }

  applyDelta(msg: NetMessage): void {
    if (msg.payload.byteLength < DELTA_HEADER_BYTES) return;
    const snap = decodeSnapshot(msg.payload.slice(DELTA_HEADER_BYTES), msg.tick);
    this.applySnapshot(snap);
  }

  /** 接收输入报告：写入 NetInputBuffer 供 A3 RemoteInputSource 读取。 */
  ingestInputMessage(msg: NetMessage): void {
    const buffer = this.deps.inputBuffer;
    if (buffer === undefined) return;
    const netId = decodeInputPayload(msg.payload, this.frame);
    const tick = this.frame.tick > 0 ? this.frame.tick : msg.tick;
    buffer.push(tick, netId > 0 ? netId : msg.from, this.frame);
  }

  /** 把 StateSnapshot/Delta 消息还原为 Snapshot（不做应用）。 */
  ingestSnapshotMessage(msg: NetMessage): Snapshot | null {
    if (msg.type === NetMsgType.Delta) {
      if (msg.payload.byteLength < DELTA_HEADER_BYTES) return null;
      return decodeSnapshot(msg.payload.slice(DELTA_HEADER_BYTES), msg.tick);
    }
    return decodeSnapshot(msg.payload, msg.tick);
  }

  /** 依赖是否足够构建真实快照（order 18 系统据此跳过空装配）。 */
  canBuildSnapshots(): boolean {
    return this.deps.world !== undefined && this.deps.registry !== undefined;
  }
}

interface NetRuntime {
  transport: ITransport | null;
  strategy: ISyncStrategy | null;
  session: NetSessionManager | NetSession | null;
  inputBuffer: NetInputBuffer;
  prediction: PredictionBuffer;
  events: GameEventBus | null;
  pendingSnapshots: Snapshot[];
  activeSnapshot: Snapshot | null;
  localFrame: InputFrame;
  unsubscribe: (() => void) | null;
  installed: boolean;
}

export interface NetRuntimeOptions {
  transport?: ITransport;
  strategy?: ISyncStrategy;
  session?: NetSessionManager | NetSession;
  inputBuffer?: NetInputBuffer;
  prediction?: PredictionBuffer;
  events?: GameEventBus;
}

const runtime: NetRuntime = {
  transport: null,
  strategy: null,
  session: null,
  inputBuffer: new NetInputBuffer(),
  prediction: new PredictionBuffer(),
  events: null,
  pendingSnapshots: [],
  activeSnapshot: null,
  localFrame: createInputFrame(),
  unsubscribe: null,
  installed: false,
};

/** 装配传输/会话/预测等运行时依赖；重复调用会替换旧的传输订阅。 */
export function configureNetRuntime(options: NetRuntimeOptions): void {
  const transportChanged = options.transport !== undefined && options.transport !== runtime.transport;
  if (transportChanged && runtime.unsubscribe !== null) {
    runtime.unsubscribe();
    runtime.unsubscribe = null;
  }
  if (options.transport !== undefined) {
    runtime.transport = options.transport;
    if (transportChanged) {
      runtime.unsubscribe = options.transport.onMessage(handleIncoming);
    }
  }
  if (options.strategy !== undefined) runtime.strategy = options.strategy;
  if (options.session !== undefined) runtime.session = options.session;
  if (options.inputBuffer !== undefined) runtime.inputBuffer = options.inputBuffer;
  if (options.prediction !== undefined) runtime.prediction = options.prediction;
  if (options.events !== undefined) runtime.events = options.events;
}

/** 仅供测试/重建：清空运行时登记与订阅（不修改 A 的 scheduler）。 */
export function resetNetSystems(): void {
  if (runtime.unsubscribe !== null) {
    runtime.unsubscribe();
    runtime.unsubscribe = null;
  }
  runtime.transport = null;
  runtime.strategy = null;
  runtime.session = null;
  runtime.events = null;
  runtime.pendingSnapshots.length = 0;
  runtime.activeSnapshot = null;
  runtime.localFrame.moveX = 0;
  runtime.localFrame.moveY = 0;
  runtime.localFrame.aimX = 0;
  runtime.localFrame.aimY = 0;
  runtime.localFrame.buttons = 0;
  runtime.localFrame.tick = 0;
  runtime.localFrame.seq = 0;
  runtime.installed = false;
}

/** 当前运行时视角的会话（优先显式 NetSessionManager，其次 SimState.session）。 */
function resolveSession(state: SimState | null): NetSession {
  if (runtime.session instanceof NetSessionManager) return runtime.session.state;
  const mutable = asMutableSession(runtime.session)
    ?? (state === null ? null : asMutableSession(state.session));
  if (mutable !== null) return mutable;
  if (runtime.session !== null) return sessionFromState(runtime.session);
  if (state !== null) return sessionFromState(state.session);
  return createNetSession();
}

/** 把运行时对会话的修改写回真实持有者（普通对象或 NetSessionManager）。 */
function flushSession(state: SimState | null, session: NetSession): void {
  if (runtime.session instanceof NetSessionManager) {
    runtime.session.syncNow();
  } else if (asMutableSession(runtime.session) !== null) {
    writeSessionFields(runtime.session, session);
  } else if (state !== null) {
    writeSessionFields(state.session, session);
  }
}

/** 从本地玩家 InputCmd 读取一帧输入到预分配 frame；无玩家时返回全零帧。 */
function readLocalFrame(world: BattleWorld | undefined, playerId: number, tick: number): InputFrame {
  const frame = runtime.localFrame;
  frame.moveX = 0;
  frame.moveY = 0;
  frame.aimX = 0;
  frame.aimY = 0;
  frame.buttons = 0;
  frame.tick = tick;
  frame.seq = 0;
  if (world === undefined || world.components.indexOf(InputCmd) < 0
    || world.components.indexOf(PlayerTag) < 0) return frame;
  const entities = query(world, [PlayerTag, InputCmd]);
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i];
    if (world.components.indexOf(PlayerId) >= 0 && has(world, eid, PlayerId)
      && PlayerId.value[eid] !== playerId) continue;
    frame.moveX = InputCmd.moveX[eid];
    frame.moveY = InputCmd.moveY[eid];
    frame.aimX = InputCmd.aimX[eid];
    frame.aimY = InputCmd.aimY[eid];
    frame.buttons = InputCmd.buttons[eid];
    frame.seq = InputCmd.seq[eid];
    break;
  }
  return frame;
}

/** 重放回调：写回本地玩家 InputCmd（真正的时间推进仍由 scheduler 的下一 tick 负责）。 */
function replayLocalInput(state: SimState | null, tick: number, frame: InputFrame): void {
  if (state === null) return;
  const world = state.world;
  if (world === undefined || world.components.indexOf(InputCmd) < 0
    || world.components.indexOf(PlayerTag) < 0) return;
  const session = resolveSession(state);
  const entities = query(world, [PlayerTag, InputCmd]);
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i];
    if (world.components.indexOf(PlayerId) >= 0 && has(world, eid, PlayerId)
      && PlayerId.value[eid] !== session.localPlayerId) continue;
    InputCmd.moveX[eid] = frame.moveX;
    InputCmd.moveY[eid] = frame.moveY;
    InputCmd.aimX[eid] = frame.aimX;
    InputCmd.aimY[eid] = frame.aimY;
    InputCmd.buttons[eid] = frame.buttons;
    InputCmd.tick[eid] = tick;
    InputCmd.seq[eid] = frame.seq;
    break;
  }
}

/** 传输层入口：按消息类型路由到输入缓冲、快照队列、事件总线与会话 FSM。 */
function handleIncoming(msg: NetMessage): void {
  const session = resolveSession(null);
  // 传输层不会把消息投递回发送者本人；同一房间内不同端点可能恰好占用相同 localNetId
  // （测试/影子场景），因此不能按 from === localNetId 过滤，否则会丢合法远端输入。
  switch (msg.type) {
    case NetMsgType.InputReport: {
      if (!isAuthoritative(session.role)) break;
      if (runtime.strategy instanceof FullSnapshotStrategy) {
        runtime.strategy.ingestInputMessage(msg);
      } else {
        const frame = runtime.localFrame;
        const netId = decodeInputPayload(msg.payload, frame);
        runtime.inputBuffer.push(frame.tick > 0 ? frame.tick : msg.tick,
          netId > 0 ? netId : msg.from, frame);
      }
      break;
    }
    case NetMsgType.StateSnapshot:
    case NetMsgType.Delta: {
      if (isAuthoritative(session.role)) break;
      let snap: Snapshot | null = null;
      try {
        snap = runtime.strategy instanceof FullSnapshotStrategy
          ? runtime.strategy.ingestSnapshotMessage(msg)
          : decodeSnapshot(msg.payload, msg.tick);
      } catch (_error) {
        // 协议损坏属于网络层输入，记录为 NetEvent 后丢弃，不打断 tick。
        runtime.events?.emit(GameEventType.NetEvent, msg.type, msg.tick, 0);
        break;
      }
      if (snap !== null) {
        runtime.pendingSnapshots.push(snap);
        session.lastAckedTick = Math.max(session.lastAckedTick, snap.tick);
      }
      break;
    }
    case NetMsgType.EventBatch:
      if (runtime.strategy !== null) runtime.strategy.replayEvents(msg);
      break;
    case NetMsgType.Control: {
      const control = decodeControlMessage(msg.payload);
      const roomSeed = control.roomSeed ?? 0;
      const leave = control.leave ?? 0;
      const promote = control.promote ?? 0;
      if (roomSeed > 0) session.roomSeed = roomSeed;
      if (leave > 0 && runtime.session instanceof NetSessionManager) {
        runtime.session.onPeerLost(leave);
      }
      if (promote > 0 && runtime.session instanceof NetSessionManager) {
        const alive: number[] = [promote];
        if (session.localNetId > 0) alive.push(session.localNetId);
        runtime.session.electNewHost(alive);
      }
      break;
    }
    default:
      runtime.events?.emit(GameEventType.NetEvent, -1, msg.type, 0);
      break;
  }
  flushSession(null, session);
}

/** order -2：客户端应用最新权威快照（仅缓存，实际和解在 -1）。 */
function snapshotApplySystem(state: SimState | null): void {
  const session = resolveSession(state);
  if (isAuthoritative(session.role)) return;
  if (runtime.pendingSnapshots.length === 0) return;
  runtime.activeSnapshot = runtime.pendingSnapshots.shift() ?? null;
}

/** order -1：和解 + 输入重放。 */
function reconcileSystem(state: SimState | null): void {
  const snap = runtime.activeSnapshot;
  if (snap === null || runtime.strategy === null) return;
  runtime.activeSnapshot = null;
  runtime.prediction.reconcile(
    snap,
    (applied) => runtime.strategy?.applySnapshot(applied),
    (tick, frame) => replayLocalInput(state, tick, frame),
  );
  const session = resolveSession(state);
  session.lastAckedTick = Math.max(session.lastAckedTick, snap.tick);
  flushSession(state, session);
}

/** order 18：客户端上报输入 / Host 广播 Full 快照与事件批次。 */
function inputReportBroadcastSystem(state: SimState | null, tick: number): void {
  const strategy = runtime.strategy;
  if (strategy === null || runtime.transport === null) return;
  const session = resolveSession(state);
  // Standalone 没有对端：连快照构建与事件总线 drain 都不做，避免抢占 UI 的事件消费。
  if (session.role === AuthorityRole.Standalone) return;
  if (isAuthoritative(session.role)) {
    if (strategy instanceof FullSnapshotStrategy && !strategy.canBuildSnapshots()) return;
    const snap = strategy.buildSnapshot(tick);
    runtime.transport.send({
      type: NetMsgType.StateSnapshot,
      from: session.hostNetId > 0 ? session.hostNetId : session.localNetId,
      to: 0,
      tick,
      payload: snap.data,
    });
    const events = strategy.collectEvents(tick);
    if (events.payload.byteLength > 0) runtime.transport.send(events);
    return;
  }

  const frame = readLocalFrame(state === null ? undefined : state.world, session.localPlayerId, tick);
  runtime.prediction.recordInput(tick, frame);
  runtime.transport.send(strategy.reportInput(tick, frame));
}

/**
 * 按冻结 order 注册网络系统：
 *   -2 SnapshotApply → -1 Reconcile → 18 InputReport/BroadcastSnapshot。
 * 不注册 1..17 / 19（由 B1 的 registration/systems.ts 负责）。
 */
export function installNetSystems(app: App, strategy: ISyncStrategy): void {
  if (runtime.installed) return;
  runtime.strategy = strategy;
  // B1 的 app.state.session 是可变普通对象；FSM 变更必须写回它，战斗系统才能读到 role。
  const appState = (app as unknown as { state?: { session?: unknown } }).state;
  if (runtime.session instanceof NetSessionManager && appState !== undefined
    && appState !== null && 'session' in appState) {
    runtime.session.bindStateSession(appState.session ?? null);
  }
  app.registerSimSystem(-2, (state, tick) => {
    void tick;
    snapshotApplySystem(state as unknown as SimState | null);
  }, 'NetSnapshotApply');
  app.registerSimSystem(-1, (state, tick) => {
    void tick;
    reconcileSystem(state as unknown as SimState | null);
  }, 'NetReconcile');
  app.registerSimSystem(18, (state, tick) => {
    inputReportBroadcastSystem(state as unknown as SimState | null, tick);
  }, 'NetInputReportBroadcast');
  runtime.installed = true;
}

/** 运行时观测：待应用快照数（测试/调试用）。 */
export function pendingSnapshotCount(): number {
  return runtime.pendingSnapshots.length;
}
