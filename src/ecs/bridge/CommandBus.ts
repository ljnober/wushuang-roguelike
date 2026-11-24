/**
 * 零分配命令总线：DOM → ECS（架构 §2.4 / §5.4）。
 * Int32Array 环形队列，每条命令 6 个 i32：type / playerId / a / b / c / seq。
 */
import { assert, COMMAND_QUEUE_SIZE } from '../../core/Constants';
import { COMMAND_STRIDE, CommandType } from './enums';

const ERR_BUS_CAPACITY = 2011;

export interface Command {
  type: CommandType;
  playerId: number;
  a: number;
  b: number;
  c: number;
  seq: number;
}

/** 创建一个空的 Command 对象，供调用方预填充 out 数组 */
export function createCommandSlot(): Command {
  return { type: 0 as CommandType, playerId: 0, a: 0, b: 0, c: 0, seq: 0 };
}

export class CommandBus {
  private readonly ring: Int32Array;
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(readonly capacity: number = COMMAND_QUEUE_SIZE) {
    assert(capacity > 0, ERR_BUS_CAPACITY, 'CommandBus 容量必须为正');
    this.ring = new Int32Array(capacity * COMMAND_STRIDE);
  }

  /** 满时返回 false，不阻塞 */
  push(cmd: Command): boolean {
    if (this.count >= this.capacity) {
      return false;
    }
    const base = this.tail * COMMAND_STRIDE;
    this.ring[base] = cmd.type;
    this.ring[base + 1] = cmd.playerId;
    this.ring[base + 2] = cmd.a;
    this.ring[base + 3] = cmd.b;
    this.ring[base + 4] = cmd.c;
    this.ring[base + 5] = cmd.seq;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    return true;
  }

  /**
   * 写入调用方预分配的 out 数组并清空队列。
   * 返回实际写入数量；out 容量不足时多余命令被丢弃（仍会被清空）。
   */
  drain(out: Command[]): number {
    const written = Math.min(this.count, out.length);
    for (let i = 0; i < written; i++) {
      const base = this.head * COMMAND_STRIDE;
      let slot = out[i];
      if (slot === undefined) {
        slot = createCommandSlot();
        out[i] = slot;
      }
      slot.type = this.ring[base] as CommandType;
      slot.playerId = this.ring[base + 1];
      slot.a = this.ring[base + 2];
      slot.b = this.ring[base + 3];
      slot.c = this.ring[base + 4];
      slot.seq = this.ring[base + 5];
      this.head = (this.head + 1) % this.capacity;
    }
    this.clear();
    return written;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}
