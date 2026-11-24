/**
 * 权威角色 FSM 与掉线降级（ARCHITECTURE §5.8 / §6.2 / §6.3）。
 *
 * - 四态：Standalone(0) / Host(1) / Client(2) / Electing(3)；
 * - Host 选举取存活 NetId 的最小值时，结果由集合本身决定，不依赖消息到达顺序；
 * - onPeerLost 只改 ECS 组件数组（ControlSource.kind/ref、ControlMode、NetControlled），
 *   不去改动批次 A 的任何源文件；掉线玩家立即由本地确定性 AI 影子接管。
 *
 * SimState.session 采用 A 的 NetSession SoA 组件（槽 0 为会话单例），
 * 本模块同时维护一个普通对象视角 NetSession，二者通过 syncSessionToWorld 保持一致。
 */
import { assert, MAX_PLAYERS, TICK_RATE } from '../core/Constants';
import { add, has, query, remove, type BattleWorld } from '../ecs/bit/adapter';
import {
  ControlMode,
  ControlSource,
  NetControlled,
  NetId,
  NetSession as NetSessionComponent,
  PlayerId,
} from '../ecs/bit/components';
import type { Eid } from '../ecs/bit/types';
import type { EntityRegistry } from './EntityRegistry';
import { decodeControlMessage, encodeControlMessage, type NetMessage } from './messages';
import { NetMsgType, type ITransport } from './transport';

const ERR_SESSION = 4004;
/** 影子 AI 的 ControlSource.kind（§6.2：0 Local / 1 AI / 2 Remote）。 */
const SHADOW_KIND = 1;
/** ControlMode：0 人工 / 1 AI 托管。 */
const SHADOW_CONTROL_MODE = 1;

export enum AuthorityRole {
  Standalone = 0,
  Host = 1,
  Client = 2,
  Electing = 3,
}

/** 会话状态（与架构 §5.8 冻结接口一致）。 */
export interface NetSession {
  role: AuthorityRole;
  localNetId: number;
  hostNetId: number;
  localPlayerId: number;
  roomSeed: number;
  simTick: number;
  lastAckedTick: number;
  readonly tickRate: 60;
  playerCount: number;
}

/** 创建一个初始 Standalone 会话对象。 */
export function createNetSession(): NetSession {
  return {
    role: AuthorityRole.Standalone,
    localNetId: 0,
    hostNetId: 0,
    localPlayerId: 0,
    roomSeed: 0,
    simTick: 0,
    lastAckedTick: 0,
    tickRate: TICK_RATE,
    playerCount: 1,
  };
}

/** 把普通会话对象同步到 NetSession SoA 组件槽 0（若世界注册了该组件）。 */
export function syncSessionToWorld(session: NetSession, world: BattleWorld): void {
  if (world.components.indexOf(NetSessionComponent) < 0) return;
  NetSessionComponent.role[0] = session.role;
  NetSessionComponent.localNetId[0] = session.localNetId >>> 0;
  NetSessionComponent.hostNetId[0] = session.hostNetId >>> 0;
  NetSessionComponent.localPlayerId[0] = session.localPlayerId >>> 0;
  NetSessionComponent.roomSeed[0] = session.roomSeed >>> 0;
  NetSessionComponent.simTick[0] = session.simTick >>> 0;
  NetSessionComponent.lastAckedTick[0] = session.lastAckedTick >>> 0;
  NetSessionComponent.playerCount[0] = session.playerCount >>> 0;
  NetSessionComponent.tickRate[0] = TICK_RATE;
}

/** 判断会话对象是否为 SoA 组件形状（字段是 typed array）。 */
function isSoASession(value: unknown): value is Record<string, Uint32Array | Uint8Array> {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate['role'] instanceof Uint8Array && candidate['simTick'] instanceof Uint32Array;
}

/**
 * 从 SimState.session（SoA）或普通会话对象读出统一视角。
 * 返回的是新对象，调用方可安全修改；写回请使用 syncSessionToWorld。
 */
export function sessionFromState(value: unknown): NetSession {
  if (isSoASession(value)) {
    return {
      role: value.role[0] as AuthorityRole,
      localNetId: value.localNetId[0],
      hostNetId: value.hostNetId[0],
      localPlayerId: value.localPlayerId[0],
      roomSeed: value.roomSeed[0],
      simTick: value.simTick[0],
      lastAckedTick: value.lastAckedTick[0],
      tickRate: TICK_RATE,
      playerCount: value.playerCount[0],
    };
  }
  if (value !== null && typeof value === 'object' && 'role' in value) {
    const candidate = value as NetSession;
    return {
      role: candidate.role,
      localNetId: candidate.localNetId,
      hostNetId: candidate.hostNetId,
      localPlayerId: candidate.localPlayerId,
      roomSeed: candidate.roomSeed,
      simTick: candidate.simTick,
      lastAckedTick: candidate.lastAckedTick,
      tickRate: TICK_RATE,
      playerCount: candidate.playerCount,
    };
  }
  return createNetSession();
}

/**
 * 普通对象视角的可变视图：批次 B1 的 app.state.session 是可变普通对象，
 * 若走 sessionFromState 的拷贝视图，lastAckedTick/roomSeed 的更新会丢失。
 * SoA 组件没有可变普通对象视角，返回 null 由调用方回退到 manager.state。
 */
export function asMutableSession(value: unknown): NetSession | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as { role?: unknown };
  return typeof candidate.role === 'number' ? (value as NetSession) : null;
}

/** 把会话字段写回外部持有的普通对象（B1 的 session 附带派生字段，必须原样保留）。 */
export function writeSessionFields(target: unknown, session: NetSession): void {
  const mutable = asMutableSession(target);
  if (mutable === null) return;
  mutable.role = session.role;
  mutable.localNetId = session.localNetId;
  mutable.hostNetId = session.hostNetId;
  mutable.localPlayerId = session.localPlayerId;
  mutable.roomSeed = session.roomSeed;
  mutable.simTick = session.simTick;
  mutable.lastAckedTick = session.lastAckedTick;
  mutable.playerCount = session.playerCount;
}

/** 写 tick 到任意会话视角（SoA 写槽 0，普通对象写字段）。 */
export function writeSessionTick(value: unknown, tick: number): void {
  if (isSoASession(value)) {
    value.simTick[0] = tick >>> 0;
  } else if (value !== null && typeof value === 'object' && 'simTick' in value) {
    const candidate = value as { simTick: number };
    if (typeof candidate.simTick === 'number') candidate.simTick = tick;
  }
}

/** 当前端是否为权威（Host 或单机）。 */
export function isAuthoritative(role: AuthorityRole): boolean {
  return role === AuthorityRole.Host || role === AuthorityRole.Standalone;
}

/** 会话管理器：FSM 转换、确定性选举、掉线影子降级与 Control 消息收发。 */
export class NetSessionManager {
  readonly state: NetSession = createNetSession();
  private unsubscribe: (() => void) | null = null;
  private stateSession: unknown = null;

  constructor(
    private readonly world: BattleWorld,
    private readonly transport: ITransport,
    private readonly registry: EntityRegistry,
  ) {
    this.unsubscribe = transport.onMessage((msg) => this.onTransportMessage(msg));
    this.sync();
  }

  /** 单机开局：本地即权威，同时为本地玩家补齐 NetId 映射。 */
  startStandalone(roomSeed: number, playerCount: number): void {
    assert(playerCount >= 1 && playerCount <= MAX_PLAYERS, ERR_SESSION, '玩家数超出席位范围');
    this.state.role = AuthorityRole.Standalone;
    this.state.roomSeed = roomSeed >>> 0;
    this.state.playerCount = playerCount;
    this.state.localNetId = this.ensureLocalNetId();
    this.state.hostNetId = this.state.localNetId;
    this.registry.setAuthority(true);
    this.sync();
  }

  /** 提升为 Host：接管 NetId 分配权。 */
  promoteToHost(): void {
    this.state.role = AuthorityRole.Host;
    this.state.localNetId = this.ensureLocalNetId();
    this.state.hostNetId = this.state.localNetId;
    this.registry.setAuthority(true);
    this.sync();
  }

  /** 降级为 Client：NetId 只从快照重建。 */
  becomeClient(hostNetId: number): void {
    assert(hostNetId > 0, ERR_SESSION, 'hostNetId 必须为正');
    this.state.role = AuthorityRole.Client;
    this.state.hostNetId = hostNetId;
    this.registry.setAuthority(false);
    this.sync();
  }

  /**
   * 确定性 Host 选举：取存活 NetId 的最小值。
   * 先将角色置 Electing，再根据结果与本地 NetId 比较落到 Host/Client。
   */
  electNewHost(aliveNetIds: readonly number[]): number {
    this.state.role = AuthorityRole.Electing;
    let minimum = 0;
    for (let i = 0; i < aliveNetIds.length; i++) {
      const netId = aliveNetIds[i];
      if (!Number.isInteger(netId) || netId <= 0) continue;
      if (minimum === 0 || netId < minimum) minimum = netId;
    }
    if (minimum === 0) {
      this.sync();
      return 0;
    }
    if (minimum === this.state.localNetId) {
      this.promoteToHost();
    } else {
      this.becomeClient(minimum);
    }
    return minimum;
  }

  /** 对端掉线：该玩家实体改为 AI 影子控制，保留 NetId 映射与快照复制。 */
  onPeerLost(netId: number): void {
    const eid = this.registry.byNetId(netId);
    if (eid === 0) return;
    const playerId = this.registry.playerOf(netId);
    if (this.world.components.indexOf(ControlSource) >= 0) {
      if (!has(this.world, eid, ControlSource)) add(this.world, eid, ControlSource);
      ControlSource.kind[eid] = SHADOW_KIND;
      ControlSource.ref[eid] = playerId >= 0 ? playerId >>> 0 : 0;
    }
    if (this.world.components.indexOf(ControlMode) >= 0) {
      if (!has(this.world, eid, ControlMode)) add(this.world, eid, ControlMode);
      ControlMode.value[eid] = SHADOW_CONTROL_MODE;
    }
    if (this.world.components.indexOf(NetControlled) >= 0 && has(this.world, eid, NetControlled)) {
      remove(this.world, eid, NetControlled);
    }
    this.state.playerCount = Math.max(1, this.state.playerCount - 1);
    this.sync();
  }

  /** 主动广播一条控制消息（join/leave/promote/roomSeed 按字段填）。 */
  sendControl(control: {
    join?: number; leave?: number; promote?: number; roomSeed?: number;
  }): void {
    this.transport.send({
      type: NetMsgType.Control,
      from: this.state.localNetId,
      to: this.state.hostNetId,
      tick: this.state.simTick,
      payload: encodeControlMessage(control),
    });
  }

  /** 绑定 B1 的 app.state.session（普通对象）：FSM 变更会同步写回，供战斗系统读取 role。 */
  bindStateSession(target: unknown): void {
    this.stateSession = target;
    this.sync();
  }

  /** 把当前会话状态立即同步到 SoA 组件与外部普通对象。 */
  syncNow(): void {
    this.sync();
  }

  /** 退订传输层，避免重复安装时残留 handler。 */
  dispose(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** 从世界中的 PlayerId/NetId 组件寻找本地玩家并分配 NetId。 */
  private ensureLocalNetId(): number {
    if (this.state.localNetId > 0 && this.registry.byNetId(this.state.localNetId) !== 0) {
      return this.state.localNetId;
    }
    let localEid: Eid = 0;
    if (this.world.components.indexOf(PlayerId) >= 0) {
      const entities = query(this.world, [PlayerId]);
      for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        if (PlayerId.value[eid] === this.state.localPlayerId) {
          localEid = eid;
          break;
        }
        if (localEid === 0) localEid = eid;
      }
    }
    if (localEid === 0) return this.state.localNetId > 0 ? this.state.localNetId : 1;
    const existing = this.registry.byEid(localEid);
    if (existing > 0) return existing;
    if (this.world.components.indexOf(NetId) >= 0 && has(this.world, localEid, NetId)) {
      const raw = NetId.value[localEid];
      if (raw > 0) {
        this.registry.bind(localEid, raw, this.state.localPlayerId);
        return raw;
      }
    }
    const allocated = this.registry.alloc(localEid, this.state.localPlayerId);
    return allocated > 0 ? allocated : 1;
  }

  /** 处理控制消息；未知字段为 0，保持幂等。 */
  private onTransportMessage(msg: NetMessage): void {
    if (msg.type !== NetMsgType.Control) return;
    const control = decodeControlMessage(msg.payload);
    if (control.roomSeed !== undefined && control.roomSeed > 0) {
      this.state.roomSeed = control.roomSeed;
    }
    if (control.join !== undefined && control.join > 0) {
      this.state.playerCount = Math.min(MAX_PLAYERS, this.state.playerCount + 1);
    }
    if (control.leave !== undefined && control.leave > 0) {
      this.onPeerLost(control.leave);
    }
    if (control.promote !== undefined && control.promote > 0) {
      this.electNewHost([control.promote, this.state.localNetId]);
    }
    this.state.lastAckedTick = Math.max(this.state.lastAckedTick, msg.tick);
    this.sync();
  }

  private sync(): void {
    syncSessionToWorld(this.state, this.world);
    writeSessionFields(this.stateSession, this.state);
  }
}
