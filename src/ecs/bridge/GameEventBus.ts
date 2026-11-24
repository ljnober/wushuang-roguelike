/**
 * 零分配事件总线：ECS → DOM（架构 §2.4 / §5.4）。
 * 类型环 Int32Array + 数据环 Float32Array（a/b/c 三个槽），emit 无分配。
 */
import { assert, EVENT_QUEUE_SIZE } from '../../core/Constants';
import { EVENT_DATA_STRIDE, GameEventType } from './enums';

const ERR_BUS_CAPACITY = 2011;

export interface GameEvent {
  type: GameEventType;
  a: number;
  b: number;
  c: number;
}

/** 创建一个空的事件对象，供调用方预填充 out 数组 */
export function createEventSlot(): GameEvent {
  return { type: 0 as GameEventType, a: 0, b: 0, c: 0 };
}

export class GameEventBus {
  private readonly typeRing: Int32Array;
  private readonly dataRing: Float32Array;
  private head = 0;
  private tail = 0;
  private count = 0;
  /** 队列满而被丢弃的事件数（供调试面板观测） */
  private dropped = 0;

  constructor(readonly capacity: number = EVENT_QUEUE_SIZE) {
    assert(capacity > 0, ERR_BUS_CAPACITY, 'GameEventBus 容量必须为正');
    this.typeRing = new Int32Array(capacity);
    this.dataRing = new Float32Array(capacity * EVENT_DATA_STRIDE);
  }

  /** 无分配写入；队列满则丢弃并计数 */
  emit(type: GameEventType, a = 0, b = 0, c = 0): void {
    if (this.count >= this.capacity) {
      this.dropped++;
      return;
    }
    this.typeRing[this.tail] = type;
    const base = this.tail * EVENT_DATA_STRIDE;
    this.dataRing[base] = a;
    this.dataRing[base + 1] = b;
    this.dataRing[base + 2] = c;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
  }

  /**
   * 写入调用方预分配的 out 数组并清空队列。
   * 返回实际写入数量；out 容量不足时多余事件被丢弃（仍会被清空）。
   */
  drain(out: GameEvent[]): number {
    const written = Math.min(this.count, out.length);
    for (let i = 0; i < written; i++) {
      let slot = out[i];
      if (slot === undefined) {
        slot = createEventSlot();
        out[i] = slot;
      }
      slot.type = this.typeRing[this.head] as GameEventType;
      const base = this.head * EVENT_DATA_STRIDE;
      slot.a = this.dataRing[base];
      slot.b = this.dataRing[base + 1];
      slot.c = this.dataRing[base + 2];
      this.head = (this.head + 1) % this.capacity;
    }
    this.clear();
    return written;
  }

  get size(): number {
    return this.count;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}
