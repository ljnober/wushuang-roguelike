/**
 * 属性组件分区再导出 + 结算用的数值枚举。
 * StatBlock 的字段由 createStatBlock(stats) 按配置动态生成。
 */
export {
  Modifier,
  ModifierOwner,
  DirtyStat,
  StatBlock,
  StatSnapshotRef,
  createStatBlock,
  DEFAULT_STAT_NAMES,
} from '../bit/components';

/** Modifier.op 的数值编码，与 StatOp 顺序一致（stage3~stage6 使用） */
export const StatOpCode = {
  ADD: 0,
  SUB: 1,
  MUL: 2,
  MAX: 3,
  MIN: 4,
  OVERRIDE: 5,
  MUTEX: 6,
  CONDITIONAL: 7,
} as const;

/** 冲突裁决完成后的墓碑值（stage4 写入 op，stage5/6/7 跳过） */
export const STAT_OP_REMOVED = 255;

/** Modifier.sourceKind 的数值编码，顺序 = sourcePriority 链（只追加不重排） */
export const SourceKind = {
  Base: 0,
  Affix: 1,
  Gem: 2,
  Set: 3,
  Legendary: 4,
  Cube: 5,
  Skill: 6,
  LegendaryGem: 7,
  Buff: 8,
} as const;
