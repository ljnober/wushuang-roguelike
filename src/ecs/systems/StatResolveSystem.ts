/**
 * 属性结算调度器（ARCHITECTURE §6.3 order 12 / DESIGN §6.2）。
 *
 * 只调度 A 已冻结的 stage0..stage7 纯函数；scratch 全系统复用一份 typed array，
 * 只有 DirtyStat.mask 非 0 的宿主才重算。热路径只读 StatBlock 最终值。
 */
import { SourceKind, StatOpCode } from '../components/stat';
import type { StatOp } from '../../data/types';
import type { Eid } from '../bit/types';
import { add, commit, has, queryNoCommit } from '../bit/adapter';
import {
  DirtyStat,
  EffectContext,
  Modifier,
  ModifierOwner,
  StatBlock,
  StatSnapshotRef,
} from '../bit/components';
import {
  createStatScratch,
  stage0Base,
  stage1Collect,
  stage2Filter,
  stage3Sort,
  stage4Resolve,
  stage5Aggregate,
  stage6Apply,
  stage7Snapshot,
  type StatScratch,
} from '../stages/statResolveStages';
import type { SimState } from '../scheduler';

/** 单宿主可参与结算的 Modifier 上限（CAP 内充分冗余，固定不随画质变化）。 */
const MAX_MODIFIERS = 1024;

const STAT_OP_CODE: Readonly<Record<StatOp, number>> = {
  ADD: StatOpCode.ADD,
  SUB: StatOpCode.SUB,
  MUL: StatOpCode.MUL,
  MAX: StatOpCode.MAX,
  MIN: StatOpCode.MIN,
  OVERRIDE: StatOpCode.OVERRIDE,
  MUTEX: StatOpCode.MUTEX,
  CONDITIONAL: StatOpCode.CONDITIONAL,
};

const SOURCE_CODE: Readonly<Record<string, number>> = {
  base: SourceKind.Base,
  affix: SourceKind.Affix,
  gem: SourceKind.Gem,
  set: SourceKind.Set,
  legendary: SourceKind.Legendary,
  cube: SourceKind.Cube,
  skill: SourceKind.Skill,
  legendaryGem: SourceKind.LegendaryGem,
  buff: SourceKind.Buff,
};

/** 标记宿主属性脏（值按位或，调用方无需清 0）。 */
export function markStatDirty(world: import('../bit/adapter').BattleWorld, eid: Eid, mask = 1): void {
  if (!has(world, eid, DirtyStat)) {
    add(world, eid, DirtyStat);
    DirtyStat.mask[eid] = 0;
  }
  DirtyStat.mask[eid] |= mask >>> 0;
}

/**
 * 生成一个 Modifier 实体并挂到宿主。仅编译期（开局 / 换装 / 升级 / buff 起）调用；
 * 战斗热路径只改已有 Modifier 的 value/duration。
 */
export function createModifier(
  state: SimState,
  owner: Eid,
  opts: {
    stat: number;
    op: StatOp;
    value: number;
    bucket?: number;
    priority?: number;
    sourceKind?: number;
    sourceId?: number;
    group?: number;
    condMask?: number;
    duration?: number;
    flags?: number;
  },
): Eid {
  const world = state.world;
  const eid = state.pool.entities.acquire();
  add(world, eid, Modifier);
  add(world, eid, ModifierOwner(owner));
  Modifier.stat[eid] = opts.stat >>> 0;
  Modifier.op[eid] = STAT_OP_CODE[opts.op];
  Modifier.bucket[eid] = (opts.bucket ?? 0) >>> 0;
  Modifier.priority[eid] = (opts.priority ?? 1) >>> 0;
  Modifier.sourceKind[eid] = (opts.sourceKind ?? SourceKind.Base) >>> 0;
  Modifier.sourceId[eid] = (opts.sourceId ?? eid) >>> 0;
  Modifier.group[eid] = (opts.group ?? 0) >>> 0;
  Modifier.condMask[eid] = (opts.condMask ?? 0) >>> 0;
  Modifier.duration[eid] = opts.duration ?? 0;
  Modifier.flags[eid] = opts.flags ?? 0;
  Modifier.value[eid] = opts.value;
  markStatDirty(world, owner);
  return eid;
}

/** 来源名 → 数值编码（配置链顺序冻结）。 */
export function sourceKindOf(name: string): number {
  return SOURCE_CODE[name] ?? SourceKind.Base;
}

/** order 12：脏宿主 8 阶段结算。 */
export class StatResolveSystem {
  private readonly scratch: StatScratch;
  private readonly statNames: string[];
  private readonly terms = [DirtyStat];

  constructor(config: SimState['config']) {
    const stats = config.stats.all();
    this.statNames = new Array<string>(stats.length);
    for (let i = 0; i < stats.length; i++) {
      this.statNames[i] = stats[i].id;
    }
    this.scratch = createStatScratch(MAX_MODIFIERS, this.statNames.length, config.buckets.length);
  }

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;
    const dirty = queryNoCommit(world, this.terms);
    for (let i = 0; i < dirty.length; i++) {
      const eid = dirty[i];
      if (DirtyStat.mask[eid] === 0) {
        continue;
      }
      if (!has(world, eid, StatBlock)) {
        add(world, eid, StatBlock);
      }
      if (!has(world, eid, StatSnapshotRef)) {
        add(world, eid, StatSnapshotRef);
        StatSnapshotRef.poolIndex[eid] = 0;
        StatSnapshotRef.version[eid] = 0;
      }
      stage0Base(this.scratch, eid, state.config, world);
      stage1Collect(this.scratch, world, eid);
      stage2Filter(this.scratch, EffectContext);
      stage3Sort(this.scratch);
      stage4Resolve(this.scratch);
      stage5Aggregate(this.scratch);
      stage6Apply(this.scratch, StatBlock as unknown as import('../bit/types').SoAComponent, this.statNames.length);
      stage7Snapshot(this.scratch, state.pool.snapshots, StatSnapshotRef, this.statNames);
    }
    commit(world);
  }
}
