/**
 * 确定性随机数（ARCHITECTURE §5.3）。
 *
 * 采用 mulberry32：32-bit 状态、无浮点状态累积、跨平台整数运算（Math.imul）。
 * 全工程禁止 Math.random；按 (seed, playerId, tick, salt) 派生独立子流。
 */
import { WushuangError } from './Constants';

/** FNV-1a 变体 + 最终混淆，逐字节混合，输入顺序敏感且完全确定性。 */
export function hash32(...values: number[]): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] | 0;
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed > 0 ? seed >>> 0 : 0x9e3779b9;
  }

  /** [0,1) */
  next(): number {
    let t = (this.state += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [0, maxExclusive) */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) {
      return 0;
    }
    return Math.floor(this.next() * maxExclusive);
  }

  /** [min, max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new WushuangError(1008, 'Rng.pick: 不能从空数组取值');
    }
    return items[this.int(items.length)];
  }

  /** 派生独立子流，不修改父状态。 */
  fork(salt: number): Rng {
    return new Rng(hash32(this.state, salt));
  }

  getState(): number {
    return this.state >>> 0;
  }

  setState(s: number): void {
    this.state = s >>> 0;
  }

  /** (roomSeed, playerId, tick, salt) → 独立确定性流。 */
  static derive(seed: number, playerId: number, tick: number, salt = 0): Rng {
    return new Rng(hash32(seed, playerId, tick, salt));
  }
}
