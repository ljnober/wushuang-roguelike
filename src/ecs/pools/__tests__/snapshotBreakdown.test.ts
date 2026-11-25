/**
 * SnapshotPool.readBreakdown 聚合单测（ARCH_RUN_STATUS.md §3.5 冻结契约）。
 *
 * 真实构造 SnapshotPool 并写入贡献槽：验证 bySource[k] / buckets[b] 分流、
 * 多条累加、零贡献无影响、越界守卫，以及 readContribution 口径调用前后不变。
 * 只用全局 describe / it / expect（vite.config.ts globals:true）。
 */
import { MAX_CONTRIB_PER_STAT } from '../../../core/Constants';
import { BUCKETS, SOURCE_PRIORITY } from '../../../data/stats';
import { SnapshotPool } from '../SnapshotPool';

const TEST_STAT = 2;

function newRig(): { pool: SnapshotPool; index: number } {
  const pool = new SnapshotPool(2, 3, BUCKETS.length);
  return { pool, index: pool.acquire() };
}

function newOut(): { bySource: Float32Array; buckets: Float32Array } {
  return {
    bySource: new Float32Array(SOURCE_PRIORITY.length),
    buckets: new Float32Array(BUCKETS.length),
  };
}

describe('SnapshotPool.readBreakdown：来源与乘区分桶聚合', () => {
  it('单条贡献按 sourceKind 落到 bySource[k]，按 bucket 落到 buckets[b]', () => {
    // Arrange
    const { pool, index } = newRig();
    pool.writeContribution(index, TEST_STAT, 0, 12.5, 1, 7, 3);
    const { bySource, buckets } = newOut();

    // Act
    pool.readBreakdown(index, TEST_STAT, bySource, buckets);

    // Assert
    expect(bySource[1]).toBeCloseTo(12.5, 3);
    expect(buckets[3]).toBeCloseTo(12.5, 3);
    for (let k = 0; k < bySource.length; k++) {
      if (k !== 1) expect(bySource[k]).toBe(0);
    }
    for (let b = 0; b < buckets.length; b++) {
      if (b !== 3) expect(buckets[b]).toBe(0);
    }
  });

  it('多条贡献累加，零贡献槽与未写槽不影响求和', () => {
    const { pool, index } = newRig();
    pool.writeContribution(index, TEST_STAT, 0, 5, 0, 1, 0);
    pool.writeContribution(index, TEST_STAT, 1, 7, 2, 2, 1);
    pool.writeContribution(index, TEST_STAT, 2, 0, 5, 3, 4);
    pool.writeContribution(index, TEST_STAT, 3, 2.5, 2, 4, 1);
    // 最后一个贡献槽也必须被遍历到。
    pool.writeContribution(index, TEST_STAT, MAX_CONTRIB_PER_STAT - 1, 1, 8, 5, 5);
    const { bySource, buckets } = newOut();

    pool.readBreakdown(index, TEST_STAT, bySource, buckets);

    expect(bySource[0]).toBeCloseTo(5, 3);
    expect(bySource[2]).toBeCloseTo(9.5, 3);
    expect(bySource[5]).toBe(0);
    expect(bySource[8]).toBeCloseTo(1, 3);
    expect(buckets[0]).toBeCloseTo(5, 3);
    expect(buckets[1]).toBeCloseTo(9.5, 3);
    expect(buckets[4]).toBe(0);
    expect(buckets[5]).toBeCloseTo(1, 3);
    for (let k = 0; k < bySource.length; k++) {
      if (k !== 0 && k !== 2 && k !== 8) expect(bySource[k]).toBe(0);
    }
    for (let b = 0; b < buckets.length; b++) {
      if (b !== 0 && b !== 1 && b !== 5) expect(buckets[b]).toBe(0);
    }
  });

  it('sourceKind / bucket 越界被守卫，不写入越界下标也不抛错', () => {
    const { pool, index } = newRig();
    pool.writeContribution(index, TEST_STAT, 0, 4, -3, 1, 99);
    pool.writeContribution(index, TEST_STAT, 1, 6, 999, 2, -2);
    pool.writeContribution(index, TEST_STAT, 2, 8, SOURCE_PRIORITY.length + 2, 3, BUCKETS.length + 3);
    const { bySource, buckets } = newOut();
    const sourceBefore = bySource.slice();
    const bucketsBefore = buckets.slice();

    expect(() => pool.readBreakdown(index, TEST_STAT, bySource, buckets)).not.toThrow();

    expect(bySource).toEqual(sourceBefore);
    expect(buckets).toEqual(bucketsBefore);
  });

  it('调用前后 readContribution 逐槽逐字段一致，且不改动 final / version', () => {
    const { pool, index } = newRig();
    const stat = TEST_STAT;
    pool.write(index, stat, 42);
    pool.writeContribution(index, stat, 0, 3.25, 1, 10, 2);
    pool.writeContribution(index, stat, 1, -1.5, 4, 11, 0);
    const before: Float32Array[] = [];
    for (let slot = 0; slot < MAX_CONTRIB_PER_STAT; slot++) {
      const out = new Float32Array(4);
      pool.readContribution(index, stat, slot, out);
      before.push(out);
    }
    const finalBefore = pool.read(index, stat);
    const versionBefore = pool.getVersion(index);
    const { bySource, buckets } = newOut();

    pool.readBreakdown(index, stat, bySource, buckets);

    for (let slot = 0; slot < MAX_CONTRIB_PER_STAT; slot++) {
      const after = new Float32Array(4);
      pool.readContribution(index, stat, slot, after);
      expect(after).toEqual(before[slot]);
    }
    expect(bySource[1]).toBeCloseTo(3.25, 3);
    expect(bySource[4]).toBeCloseTo(-1.5, 3);
    expect(buckets[2]).toBeCloseTo(3.25, 3);
    expect(buckets[0]).toBeCloseTo(-1.5, 3);
    expect(pool.read(index, stat)).toBe(finalBefore);
    expect(pool.getVersion(index)).toBe(versionBefore);
  });
});
