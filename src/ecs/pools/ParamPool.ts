/**
 * 效果参数池（架构 §5.6）：一维 Float32Array，paramRef 是池内偏移。
 * 只在 EffectCompile 阶段 reset，运行期只读，热路径零分配。
 */
import { assert, PARAM_POOL_SIZE } from '../../core/Constants';

const ERR_PARAM_RANGE = 2008;

export class ParamPool {
  readonly data: Float32Array;
  private offset = 0;

  constructor(capacity: number = PARAM_POOL_SIZE) {
    assert(capacity > 0, ERR_PARAM_RANGE, 'ParamPool 容量必须为正');
    this.data = new Float32Array(capacity);
  }

  /** 线性 bump 分配 count 个槽；空间不足返回 -1，不改变 offset */
  alloc(count: number): number {
    if (count < 0 || count > this.data.length - this.offset) {
      return -1;
    }
    const start = this.offset;
    this.offset += count;
    return start;
  }

  /** 把 values 写入 offset 起始的连续区间，返回结束偏移 */
  write(offset: number, values: ArrayLike<number>): number {
    const end = offset + values.length;
    assert(
      Number.isInteger(offset) && offset >= 0 && end <= this.data.length,
      ERR_PARAM_RANGE,
      `ParamPool 写入越界: offset=${offset}, count=${values.length}`,
    );
    for (let i = 0; i < values.length; i++) {
      this.data[offset + i] = values[i];
    }
    return end;
  }

  /** 仅编译阶段调用：把 bump 指针归零（数据本身不清除） */
  reset(): void {
    this.offset = 0;
  }

  /** 当前 bump 指针，便于调试与占用观测 */
  get cursor(): number {
    return this.offset;
  }
}
