/**
 * 属性结算 8 阶段纯函数（设计 §6.2 / 架构 §5.12）。
 *
 * 调用顺序固定：stage0 → stage1 → stage2 → stage3 → stage4 → stage5 → stage6 → stage7。
 * 所有中间状态只写入调用方复用的 StatScratch，不在热路径分配对象。
 *
 * 关于冻结签名与实现细节的说明：
 *  - §5.12 的 StatScratch 只列出核心字段；为了支持「每个宿主一份 scratch」的完整流水线，
 *    createStatScratch 额外初始化 host/stat/sourceKind/sourceId/result/minBound/maxBound 等
 *    可选字段。冻结字段一个不少，签名完全不改。
 *  - EffectContext 是共享单例组件（设计 §6.1），stage2 读取槽 0 的 flags。
 */
import { assert, MAX_CONTRIB_PER_STAT } from '../../core/Constants';
import type { GameConfig } from '../../data/types';
import { add, has, queryNoCommit, targets, type BattleWorld } from '../bit/adapter';
import type { Eid, SoAComponent } from '../bit/types';
import {
  DirtyStat,
  EffectContext,
  Modifier,
  ModifierOwner,
  StatBlock,
  StatSnapshotRef,
} from '../bit/components';
import { StatOpCode, STAT_OP_REMOVED } from '../components/stat';
import type { SnapshotPool } from '../pools/SnapshotPool';

const ERR_STAT = 2012;

/** StatDef 中本模块实际用到的字段（A3 的完整定义可能包含更多字段） */
interface StatDefLike {
  id?: string;
  base?: number;
  default?: number;
  min?: number;
  max?: number;
}

/**
 * 结算暂存区。前 11 个字段为 §5.12 冻结字段；其后为可选扩展字段。
 */
export interface StatScratch {
  ids: Uint32Array;
  order: Uint32Array;
  condMask: Uint32Array;
  group: Uint32Array;
  priority: Uint32Array;
  op: Uint8Array;
  bucket: Uint8Array;
  value: Float32Array;
  flatSum: Float32Array;
  bucketSum: Float32Array;
  count: number;

  /** 当前结算的宿主 eid（由 stage0 写入） */
  host?: Eid;
  /** 每条 modifier 所属属性索引；缺省视为 0（单属性 scratch） */
  stat?: Uint8Array;
  sourceKind?: Uint8Array;
  sourceId?: Uint32Array;
  statCount?: number;
  bucketCount?: number;
  /** stage6 写出的最终值，供 stage7 写快照 */
  result?: Float32Array;
  minBound?: Float32Array;
  maxBound?: Float32Array;
}

/** 创建一个可复用的结算暂存区 */
export function createStatScratch(
  maxModifiers: number,
  statCount: number,
  bucketCount: number,
  host: Eid = 0,
): StatScratch {
  assert(
    maxModifiers > 0 && statCount > 0 && bucketCount >= 0,
    ERR_STAT,
    'StatScratch 尺寸非法',
  );
  return {
    ids: new Uint32Array(maxModifiers),
    order: new Uint32Array(maxModifiers),
    condMask: new Uint32Array(maxModifiers),
    group: new Uint32Array(maxModifiers),
    priority: new Uint32Array(maxModifiers),
    op: new Uint8Array(maxModifiers),
    bucket: new Uint8Array(maxModifiers),
    value: new Float32Array(maxModifiers),
    flatSum: new Float32Array(statCount),
    bucketSum: new Float32Array(statCount * Math.max(1, bucketCount)),
    count: 0,
    host,
    stat: new Uint8Array(maxModifiers),
    sourceKind: new Uint8Array(maxModifiers),
    sourceId: new Uint32Array(maxModifiers),
    statCount,
    bucketCount,
    result: new Float32Array(statCount),
    minBound: new Float32Array(statCount),
    maxBound: new Float32Array(statCount),
  };
}

/** 把无界钳制值写成「未设置」标记（Float32 的最大正值） */
function clearBounds(scratch: StatScratch): void {
  if (scratch.minBound) {
    scratch.minBound.fill(-Infinity);
  }
  if (scratch.maxBound) {
    scratch.maxBound.fill(Infinity);
  }
}

/** Stage 0：武将配置 + 局外养成 → StatBlock 初值，并重置 scratch 累加器。 */
export function stage0Base(
  scratch: StatScratch,
  host: Eid,
  cfg: GameConfig,
  world: BattleWorld,
): void {
  scratch.host = host;
  scratch.count = 0;
  for (let i = 0; i < scratch.order.length; i++) {
    scratch.order[i] = i;
  }
  scratch.flatSum.fill(0);
  scratch.bucketSum.fill(0);
  if (scratch.result) {
    scratch.result.fill(0);
  }
  clearBounds(scratch);

  if (!has(world, host, StatBlock)) {
    add(world, host, StatBlock);
  }

  const block = StatBlock as SoAComponent;
  const names = Object.keys(block);
  const defs = cfg.stats.all() as readonly StatDefLike[];
  for (let i = 0; i < names.length; i++) {
    const array = block[names[i]];
    if (array === undefined) {
      continue;
    }
    let def: StatDefLike | undefined;
    for (let d = 0; d < defs.length; d++) {
      if (defs[d].id === names[i]) {
        def = defs[d];
        break;
      }
    }
    const base = def?.base ?? def?.default ?? 0;
    if (host < array.length) {
      array[host] = base;
    }
    if (scratch.result && i < scratch.result.length) {
      scratch.result[i] = base;
    }
    if (scratch.minBound && i < scratch.minBound.length && def?.min !== undefined) {
      scratch.minBound[i] = def.min;
    }
    if (scratch.maxBound && i < scratch.maxBound.length && def?.max !== undefined) {
      scratch.maxBound[i] = def.max;
    }
  }
}

/** Stage 1：query(Modifier, ModifierOwner) 按 Owner 归入宿主 scratch，顺序稳定。 */
export function stage1Collect(scratch: StatScratch, world: BattleWorld, host: Eid): void {
  scratch.count = 0;
  // wildcard pair 项：bitECS 0.4.0 中裸关系函数不会匹配实体
  const entities = queryNoCommit(world, [Modifier, ModifierOwner('*')]);
  for (let i = 0; i < entities.length && scratch.count < scratch.ids.length; i++) {
    const eid = entities[i];
    const owners = targets(world, eid, ModifierOwner);
    let owned = false;
    for (let o = 0; o < owners.length; o++) {
      if (owners[o] === host) {
        owned = true;
        break;
      }
    }
    if (!owned) {
      continue;
    }
    const w = scratch.count++;
    scratch.ids[w] = eid;
    scratch.order[w] = w; // 收集顺序即 sourceOrder
    scratch.condMask[w] = Modifier.condMask[eid];
    scratch.group[w] = Modifier.group[eid];
    scratch.priority[w] = Modifier.priority[eid];
    scratch.op[w] = Modifier.op[eid];
    scratch.bucket[w] = Modifier.bucket[eid];
    scratch.value[w] = Modifier.value[eid];
    if (scratch.stat) {
      scratch.stat[w] = Modifier.stat[eid];
    }
    if (scratch.sourceKind) {
      scratch.sourceKind[w] = Modifier.sourceKind[eid];
    }
    if (scratch.sourceId) {
      scratch.sourceId[w] = Modifier.sourceId[eid];
    }
  }
}

/** Stage 2：condMask & EffectContext.flags，不成立剔除；就地压缩 order，保持顺序。 */
export function stage2Filter(scratch: StatScratch, ctx: typeof EffectContext): void {
  const flags = ctx.flags.length > 0 ? ctx.flags[0] : 0;
  let write = 0;
  for (let i = 0; i < scratch.count; i++) {
    const idx = scratch.order[i];
    const mask = scratch.condMask[idx];
    if (mask !== 0 && (mask & flags) !== mask) {
      continue;
    }
    scratch.order[write++] = idx;
  }
  scratch.count = write;
}

/**
 * Stage 3：稳定排序，键序 (sourceOrder → priority → id)。
 * sourceOrder 取 Modifier.sourceKind（与 data/stats.ts 的 SOURCE_PRIORITY 下标一致）；
 * 三键均升序，同键保持收集顺序。stage4 会显式比较 priority 选优，不依赖此处方向。
 */
export function stage3Sort(scratch: StatScratch): void {
  for (let i = 1; i < scratch.count; i++) {
    const key = scratch.order[i];
    const keySource = scratch.sourceKind ? scratch.sourceKind[key] : 0;
    const keyPriority = scratch.priority[key];
    const keyId = scratch.ids[key];
    let j = i - 1;
    while (j >= 0) {
      const current = scratch.order[j];
      const currentSource = scratch.sourceKind ? scratch.sourceKind[current] : 0;
      const currentPriority = scratch.priority[current];
      const comesFirst =
        keySource < currentSource ||
        (keySource === currentSource &&
          (keyPriority < currentPriority ||
            (keyPriority === currentPriority && keyId < scratch.ids[current])));
      if (!comesFirst) {
        break;
      }
      scratch.order[j + 1] = current;
      j--;
    }
    scratch.order[j + 1] = key;
  }
}

/** 冲突裁决时判断 candidate 是否优于 current */
function beats(scratch: StatScratch, candidate: number, current: number, op: number): boolean {
  if (op === StatOpCode.MAX) {
    if (scratch.value[candidate] !== scratch.value[current]) {
      return scratch.value[candidate] > scratch.value[current];
    }
  } else if (op === StatOpCode.MIN) {
    if (scratch.value[candidate] !== scratch.value[current]) {
      return scratch.value[candidate] < scratch.value[current];
    }
  }
  if (scratch.priority[candidate] !== scratch.priority[current]) {
    return scratch.priority[candidate] > scratch.priority[current];
  }
  return scratch.ids[candidate] < scratch.ids[current];
}

/**
 * Stage 4：OVERRIDE / MUTEX / MAX / MIN 按 group+priority 选唯一胜出者。
 * 落选者在 op 中写墓碑值 255，后续阶段统一跳过。
 */
export function stage4Resolve(scratch: StatScratch): void {
  for (let i = 0; i < scratch.count; i++) {
    const idx = scratch.order[i];
    const op = scratch.op[idx];
    if (
      op === STAT_OP_REMOVED ||
      (op !== StatOpCode.OVERRIDE &&
        op !== StatOpCode.MUTEX &&
        op !== StatOpCode.MAX &&
        op !== StatOpCode.MIN)
    ) {
      continue;
    }
    const group = scratch.group[idx];
    let winner = idx;
    for (let j = i + 1; j < scratch.count; j++) {
      const other = scratch.order[j];
      if (scratch.op[other] === STAT_OP_REMOVED || scratch.group[other] !== group) {
        continue;
      }
      if (beats(scratch, other, winner, op)) {
        winner = other;
      }
    }
    for (let j = 0; j < scratch.count; j++) {
      const other = scratch.order[j];
      if (
        other !== winner &&
        scratch.group[other] === group &&
        scratch.op[other] !== STAT_OP_REMOVED
      ) {
        scratch.op[other] = STAT_OP_REMOVED;
      }
    }
  }
}

/** 取 modifier 的属性索引，钳制到 [0, statCount-1] */
function statIndexOf(scratch: StatScratch, idx: number, statCount: number): number {
  if (!scratch.stat || scratch.stat.length <= idx) {
    return 0;
  }
  const raw = scratch.stat[idx];
  return raw < statCount ? raw : statCount - 1;
}

/** Stage 5：ADD/SUB/MAX/MIN/CONDITIONAL → flatSum；MUL → bucketSum[bucket]。 */
export function stage5Aggregate(scratch: StatScratch): void {
  scratch.flatSum.fill(0);
  scratch.bucketSum.fill(0);
  const statCount = Math.max(1, scratch.flatSum.length);
  const bucketCount = Math.max(
    1,
    scratch.bucketCount ?? Math.floor(scratch.bucketSum.length / statCount),
  );
  for (let i = 0; i < scratch.count; i++) {
    const idx = scratch.order[i];
    const op = scratch.op[idx];
    if (op === STAT_OP_REMOVED) {
      continue;
    }
    const statIndex = statIndexOf(scratch, idx, statCount);
    const value = scratch.value[idx];
    if (op === StatOpCode.MUL) {
      const bucket = scratch.bucket[idx] % bucketCount;
      scratch.bucketSum[statIndex * bucketCount + bucket] += value;
    } else if (op === StatOpCode.SUB) {
      scratch.flatSum[statIndex] -= value;
    } else if (
      op === StatOpCode.ADD ||
      op === StatOpCode.MAX ||
      op === StatOpCode.MIN ||
      op === StatOpCode.CONDITIONAL ||
      op === StatOpCode.OVERRIDE ||
      op === StatOpCode.MUTEX
    ) {
      scratch.flatSum[statIndex] += value;
    }
  }
}

/**
 * Stage 6：StatBlock[stat] = (base + flatSum) × Π(1 + bucketSum[i])，再套 MIN/MAX 钳制。
 * block 的字段顺序即 stats 配置顺序（createStatBlock 保证）。
 */
export function stage6Apply(scratch: StatScratch, block: SoAComponent, statCount: number): void {
  const host = scratch.host ?? 0;
  const names = Object.keys(block);
  const bucketCount = Math.max(
    1,
    scratch.bucketCount ??
      Math.floor(scratch.bucketSum.length / Math.max(1, scratch.flatSum.length)),
  );
  const limit = Math.min(statCount, names.length, scratch.flatSum.length);
  for (let i = 0; i < limit; i++) {
    const array = block[names[i]];
    if (array === undefined || host >= array.length) {
      continue;
    }
    let value = array[host] + scratch.flatSum[i];
    for (let b = 0; b < bucketCount; b++) {
      value *= 1 + scratch.bucketSum[i * bucketCount + b];
    }
    if (scratch.minBound && i < scratch.minBound.length && value < scratch.minBound[i]) {
      value = scratch.minBound[i];
    }
    if (scratch.maxBound && i < scratch.maxBound.length && value > scratch.maxBound[i]) {
      value = scratch.maxBound[i];
    }
    array[host] = value;
    if (scratch.result && i < scratch.result.length) {
      scratch.result[i] = value;
    }
  }
}

/**
 * Stage 7：写 SnapshotPool（最终值 + 每条贡献 + 来源 + 乘区），version++，清 DirtyStat.mask。
 */
export function stage7Snapshot(
  scratch: StatScratch,
  pool: SnapshotPool,
  refRef: typeof StatSnapshotRef,
  stats: readonly string[],
): void {
  const host = scratch.host ?? 0;
  let index = refRef.poolIndex[host];
  if (index === 0 && refRef.version[host] === 0) {
    index = pool.acquire();
    refRef.poolIndex[host] = index;
  }
  const statCount = Math.min(stats.length, pool.statCount, scratch.flatSum.length);
  for (let s = 0; s < statCount; s++) {
    const finalValue = scratch.result && s < scratch.result.length ? scratch.result[s] : 0;
    pool.write(index, s, finalValue);
    let slot = 0;
    for (let i = 0; i < scratch.count && slot < MAX_CONTRIB_PER_STAT; i++) {
      const idx = scratch.order[i];
      if (scratch.op[idx] === STAT_OP_REMOVED) {
        continue;
      }
      const modifierStat = scratch.stat && scratch.stat.length > idx ? scratch.stat[idx] : 0;
      if (modifierStat !== s) {
        continue;
      }
      pool.writeContribution(
        index,
        s,
        slot++,
        scratch.value[idx],
        scratch.sourceKind && scratch.sourceKind.length > idx ? scratch.sourceKind[idx] : 0,
        scratch.sourceId && scratch.sourceId.length > idx ? scratch.sourceId[idx] : scratch.ids[idx],
        scratch.bucket[idx],
      );
    }
  }
  pool.bumpVersion(index);
  refRef.version[host] = pool.getVersion(index);
  if (host < DirtyStat.mask.length) {
    DirtyStat.mask[host] = 0;
  }
}
