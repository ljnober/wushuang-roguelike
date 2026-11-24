/**
 * 传输层（ARCHITECTURE §5.8 / §6.2）。
 *
 * NetMsgType / NetMessage 的规范定义在 messages.ts，本文件按契约重新导出，
 * 避免两处实现漂移。NullTransport 丢弃一切消息；LoopbackTransport 提供完整的
 * 本地 Host↔Client 闭环，并通过种子 Rng 注入延迟/抖动/丢包/重复，保证 chaos 可复现。
 *
 * 时间语义：send() 只把消息排入本地队列，具体投递时刻由 tick(nowMs) 驱动；
 * 逻辑层不读取墙钟，nowMs 完全由调用方（测试 / App 帧循环）提供。
 */
import { Rng } from '../core/Rng';
import {
  NetMsgType,
  type NetMessage,
  type ControlMessage,
  decodeControlMessage,
  encodeControlMessage,
} from './messages';

export { NetMsgType } from './messages';
export type { NetMessage, ControlMessage } from './messages';

/** 传输层统一接口。 */
export interface ITransport {
  readonly peerId: number;
  connect(peerId: number): void;
  send(msg: NetMessage): void;
  onMessage(handler: (msg: NetMessage) => void): () => void;
  close(): void;
}

/** 空传输：用于 Standalone 与测试替身，onMessage 仍保持订阅语义。 */
export class NullTransport implements ITransport {
  private readonly handlers = new Set<(msg: NetMessage) => void>();
  private connectedTo = 0;
  private closed = false;

  constructor(readonly peerId: number = 0) {}

  connect(peerId: number): void {
    this.connectedTo = peerId;
  }

  send(_msg: NetMessage): void {
    // 明确丢弃：不投递、不缓存、不计数到任何逻辑状态。
    void _msg;
  }

  onMessage(handler: (msg: NetMessage) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  close(): void {
    this.handlers.clear();
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get peer(): number {
    return this.connectedTo;
  }
}

/** Loopback 网络条件（全部可选，缺省为 0；seed 决定 chaos 序列）。 */
export interface LoopbackOptions {
  latencyMs?: number;
  jitterMs?: number;
  dropRate?: number;
  duplicateRate?: number;
  seed?: number;
}

interface ScheduledDelivery {
  msg: NetMessage;
  atMs: number;
  seq: number;
}

/** 归一化后的网络条件，概率被钳制到 [0,1]。 */
interface Conditions {
  latencyMs: number;
  jitterMs: number;
  dropRate: number;
  duplicateRate: number;
  seed: number;
}

function normalize(opts: LoopbackOptions, base: Conditions): Conditions {
  const clamp01 = (v: number, fallback: number): number => {
    if (!Number.isFinite(v)) return fallback;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  };
  const nonNegative = (v: number, fallback: number): number => (
    Number.isFinite(v) && v >= 0 ? v : fallback
  );
  return {
    latencyMs: opts.latencyMs === undefined ? base.latencyMs : nonNegative(opts.latencyMs, 0),
    jitterMs: opts.jitterMs === undefined ? base.jitterMs : nonNegative(opts.jitterMs, 0),
    dropRate: opts.dropRate === undefined ? base.dropRate : clamp01(opts.dropRate, 0),
    duplicateRate: opts.duplicateRate === undefined
      ? base.duplicateRate : clamp01(opts.duplicateRate, 0),
    seed: opts.seed === undefined ? base.seed : (opts.seed | 0),
  };
}

/**
 * 本地回环传输：支持多 peer 组成房间，消息经注入条件后再投递。
 * 同一 seed + 同一 send/tick 调用序列必然得到同一份 chaos 结果。
 */
export class LoopbackTransport implements ITransport {
  private readonly handlers = new Set<(msg: NetMessage) => void>();
  private readonly peers: LoopbackTransport[] = [];
  private queue: ScheduledDelivery[] = [];
  private conditions: Conditions;
  private rng: Rng;
  private sequence = 0;
  private nowMs = 0;
  private closed = false;

  constructor(readonly peerId: number, opts: LoopbackOptions = {}) {
    this.conditions = normalize(opts, {
      latencyMs: 0, jitterMs: 0, dropRate: 0, duplicateRate: 0, seed: 1,
    });
    this.rng = new Rng(this.conditions.seed);
  }

  /** 双向连接两个回环端点；重复 link 不产生重复 peer。 */
  link(other: LoopbackTransport): void {
    if (other === this || this.closed || other.closed) return;
    if (this.peers.indexOf(other) < 0) this.peers.push(other);
    if (other.peers.indexOf(this) < 0) other.peers.push(this);
  }

  connect(peerId: number): void {
    // LoopbackTransport 的房间 topology 由 link() 显式建立，这里仅记录目标 peerId。
    void peerId;
  }

  send(msg: NetMessage): void {
    if (this.closed) return;
    if (this.rng.next() < this.conditions.dropRate) return;
    const jitter = this.conditions.jitterMs > 0
      ? this.rng.range(-this.conditions.jitterMs, this.conditions.jitterMs)
      : 0;
    const baseDelay = Math.max(0, this.conditions.latencyMs + jitter);
    const duplicated = this.conditions.duplicateRate > 0
      && this.rng.next() < this.conditions.duplicateRate;
    const copies = duplicated ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const extra = i === 0 ? 0 : (this.conditions.jitterMs > 0
        ? this.rng.range(0, this.conditions.jitterMs)
        : 0.5);
      this.queue.push({
        msg,
        atMs: this.nowMs + baseDelay + extra,
        seq: this.sequence++,
      });
    }
  }

  onMessage(handler: (msg: NetMessage) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /** 投递所有到期消息；排序键 (atMs, seq) 保证 chaos 下仍确定。 */
  tick(nowMs: number): void {
    if (this.closed) return;
    // flush() 传入 +Infinity：必须原样保留，否则会退化成 0 导致延迟/重复包无法投递。
    this.nowMs = Number.isNaN(nowMs) ? 0 : nowMs;
    if (this.queue.length === 0) return;
    this.queue.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
    let delivered = 0;
    while (delivered < this.queue.length && this.queue[delivered].atMs <= this.nowMs) {
      delivered++;
    }
    const due = this.queue.slice(0, delivered);
    this.queue = this.queue.slice(delivered);
    for (let i = 0; i < due.length; i++) {
      for (let p = 0; p < this.peers.length; p++) {
        this.peers[p].receive(due[i].msg);
      }
    }
  }

  /** 忽略时序、立即投递当前队列（测试与结算阶段使用）。 */
  flush(): void {
    this.tick(Number.POSITIVE_INFINITY);
  }

  /** 增量更新网络条件；指定 seed 时重置 chaos 随机流。 */
  setConditions(opts: LoopbackOptions): void {
    const seedChanged = opts.seed !== undefined && (opts.seed | 0) !== this.conditions.seed;
    this.conditions = normalize(opts, this.conditions);
    if (seedChanged) this.rng = new Rng(this.conditions.seed);
  }

  close(): void {
    this.closed = true;
    this.handlers.clear();
    this.peers.length = 0;
    this.queue = [];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 尚未投递的消息数（chaos 测试可据此观察丢包/排队）。 */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** 当前生效的网络条件只读副本。 */
  get conditionsSnapshot(): Readonly<LoopbackOptions> {
    return { ...this.conditions };
  }

  /** 接收端：为每条消息复制 payload，避免重复包之间共享可变缓冲区。 */
  private receive(msg: NetMessage): void {
    if (this.closed) return;
    const copy: NetMessage = {
      type: msg.type,
      from: msg.from,
      to: msg.to,
      tick: msg.tick,
      payload: msg.payload.slice(0),
    };
    this.handlers.forEach((handler) => handler(copy));
  }
}

/** 构造一条 Control 消息的便捷函数（避免调用方手拼 payload）。 */
export function makeControlMessage(
  from: number,
  to: number,
  tick: number,
  control: ControlMessage,
): NetMessage {
  return {
    type: NetMsgType.Control,
    from,
    to,
    tick,
    payload: encodeControlMessage(control),
  };
}

/** 解析 Control 消息（与 makeControlMessage 对称）。 */
export function readControlMessage(msg: NetMessage): ControlMessage {
  return decodeControlMessage(msg.payload);
}
