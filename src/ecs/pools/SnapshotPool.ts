/**
 * 属性快照池（架构 §5.6 / 设计 §6.2）。
 *
 * 布局：
 *  final        : slotCount * statCount                      最终值
 *  contribution : slotCount * statCount * MAX_CONTRIB_PER_STAT * 4
 *                 每条贡献 4 个 f32：[value, sourceKind, sourceId, bucket]
 *  versions     : slotCount                                  每个槽的版本号
 */
import { assert, MAX_CONTRIB_PER_STAT } from '../../core/Constants';

const ERR_SNAPSHOT_RANGE = 2009;

/** 单条贡献在 contribution 中的字段步长与下标（冻结） */
export const CONTRIB_STRIDE = 4;
export const CONTRIB_VALUE = 0;
export const CONTRIB_SOURCE_KIND = 1;
export const CONTRIB_SOURCE_ID = 2;
export const CONTRIB_BUCKET = 3;

/** 属性详情面板读取用的 breakdown（架构 §5.6） */
export interface StatBreakdown {
  final: number;
  buckets: Float32Array;
  bySource: Float32Array;
}

export class SnapshotPool {
  readonly final: Float32Array;
  readonly contribution: Float32Array;
  readonly versions: Uint32Array;

  private readonly free: number[] = [];

  constructor(
    readonly slotCount: number,
    readonly statCount: number,
    readonly bucketCount: number,
  ) {
    assert(
      slotCount > 0 && statCount > 0 && bucketCount >= 0,
      ERR_SNAPSHOT_RANGE,
      'SnapshotPool 尺寸非法',
    );
    this.final = new Float32Array(slotCount * statCount);
    this.contribution = new Float32Array(
      slotCount * statCount * MAX_CONTRIB_PER_STAT * CONTRIB_STRIDE,
    );
    this.versions = new Uint32Array(slotCount);
    for (let i = slotCount - 1; i >= 0; i--) {
      this.free.push(i);
    }
  }

  /** 取一个快照槽；耗尽时断言失败（不静默复用正在被读取的槽） */
  acquire(): number {
    assert(this.free.length > 0, ERR_SNAPSHOT_RANGE, 'SnapshotPool 已耗尽');
    return this.free.pop() as number;
  }

  /** 归还槽（重复归还被忽略） */
  release(index: number): void {
    this.checkIndex(index);
    if (this.free.indexOf(index) < 0) {
      this.free.push(index);
    }
  }

  /** 写入某槽某属性的最终值 */
  write(index: number, stat: number, value: number): void {
    this.checkIndex(index);
    assert(stat >= 0 && stat < this.statCount, ERR_SNAPSHOT_RANGE, `stat 越界: ${stat}`);
    this.final[index * this.statCount + stat] = value;
  }

  /** 读取某槽某属性的最终值 */
  read(index: number, stat: number): number {
    this.checkIndex(index);
    assert(stat >= 0 && stat < this.statCount, ERR_SNAPSHOT_RANGE, `stat 越界: ${stat}`);
    return this.final[index * this.statCount + stat];
  }

  getVersion(index: number): number {
    this.checkIndex(index);
    return this.versions[index];
  }

  /** 版本号 ++，uint32 自然回绕 */
  bumpVersion(index: number): void {
    this.checkIndex(index);
    this.versions[index] = (this.versions[index] + 1) >>> 0;
  }

  /**
   * 写入一条贡献：value/sourceKind/sourceId/bucket。
   * slot 为 [0, MAX_CONTRIB_PER_STAT) 内的贡献槽序号。
   */
  writeContribution(
    index: number,
    stat: number,
    slot: number,
    value: number,
    sourceKind: number,
    sourceId: number,
    bucket: number,
  ): void {
    this.checkIndex(index);
    assert(
      stat >= 0 && stat < this.statCount && slot >= 0 && slot < MAX_CONTRIB_PER_STAT,
      ERR_SNAPSHOT_RANGE,
      '贡献槽越界',
    );
    const base =
      (index * this.statCount + stat) * MAX_CONTRIB_PER_STAT * CONTRIB_STRIDE +
      slot * CONTRIB_STRIDE;
    this.contribution[base + CONTRIB_VALUE] = value;
    this.contribution[base + CONTRIB_SOURCE_KIND] = sourceKind;
    this.contribution[base + CONTRIB_SOURCE_ID] = sourceId;
    this.contribution[base + CONTRIB_BUCKET] = bucket;
  }

  /** 把一条贡献的 4 个字段读出到调用方预分配的 out（至少 4 长度），零分配 */
  readContribution(index: number, stat: number, slot: number, out: Float32Array): void {
    this.checkIndex(index);
    assert(out.length >= CONTRIB_STRIDE, ERR_SNAPSHOT_RANGE, 'out 长度不足');
    const base =
      (index * this.statCount + stat) * MAX_CONTRIB_PER_STAT * CONTRIB_STRIDE +
      slot * CONTRIB_STRIDE;
    for (let i = 0; i < CONTRIB_STRIDE; i++) {
      out[i] = this.contribution[base + i];
    }
  }

  /** 当前可获取的快照槽数量 */
  get available(): number {
    return this.free.length;
  }

  private checkIndex(index: number): void {
    assert(
      Number.isInteger(index) && index >= 0 && index < this.slotCount,
      ERR_SNAPSHOT_RANGE,
      `快照槽越界: ${index}`,
    );
  }
}
