/**
 * 属性系统配置：属性定义、乘区分桶、来源优先级链、10 类词缀池。
 *
 * 事实来源：DESIGN.md §6.2 / §8.4，ARCHITECTURE.md §5.12。
 * StatResolveSystem 的 8 阶段完全按本文件的桶顺序与优先级顺序工作；
 * 数组下标即组件中的数值枚举（bucket / sourceOrder），新增只能在末尾追加。
 */
import type { AffixDef, StatDef } from './types';

/** 属性定义表。id 即 StatBlock 的字段名，顺序稳定（快照列块依赖此顺序）。 */
export const STAT_DEFS: readonly StatDef[] = [
  { id: 'hp', name: '生命', default: 120, min: 1, max: 100000, isPercent: false },
  { id: 'maxHp', name: '最大生命', default: 120, min: 1, max: 100000, isPercent: false },
  { id: 'atk', name: '攻击力', default: 24, min: 0, max: 100000, isPercent: false },
  { id: 'armor', name: '护甲', default: 0, min: 0, max: 100000, isPercent: false },
  { id: 'crit', name: '暴击率', default: 0.05, min: 0, max: 1, isPercent: true },
  { id: 'critDmg', name: '暴击伤害', default: 0.5, min: 0, max: 20, isPercent: true },
  { id: 'atkSpeed', name: '攻击速度', default: 1, min: 0.1, max: 20, isPercent: true },
  { id: 'moveSpeed', name: '移动速度', default: 220, min: 0, max: 2000, isPercent: false },
  { id: 'lifeSteal', name: '生命偷取', default: 0, min: 0, max: 1, isPercent: true },
  { id: 'pickup', name: '拾取半径', default: 60, min: 0, max: 1000, isPercent: false },
  { id: 'skillLevel', name: '技能等级', default: 0, min: 0, max: 100, isPercent: false },
  { id: 'damage', name: '增伤', default: 0, min: 0, max: 100, isPercent: true },
  { id: 'regen', name: '生命回复', default: 0, min: 0, max: 10000, isPercent: false },
  { id: 'expBonus', name: '经验加成', default: 0, min: 0, max: 100, isPercent: true },
] as const;

/** 乘区分桶顺序：数组下标即 Modifier.bucket 数值，新增只在末尾追加。 */
export const BUCKETS: readonly string[] = [
  'normal',   // 常规增伤
  'crit',     // 暴击伤害区
  'elite',    // 对精英增伤
  'boss',     // 对 BOSS 增伤
  'skill',    // 技能增伤
  'element',  // 元素/状态增伤
] as const;

/**
 * 来源优先级链（低 → 高）。
 * 排序阶段用数组下标作为 sourceOrder；同桶同类增伤一律相加，唯一特效走 MAX 去重。
 */
export const SOURCE_PRIORITY: readonly string[] = [
  'base',          // 武将基础
  'affix',         // 装备词缀
  'gem',           // 普通宝石
  'set',           // 套装
  'legendary',     // 传奇特效
  'cube',          // 魔盒
  'skill',         // 技能
  'legendaryGem',  // 传说宝石
  'buff',          // 临时 buff
] as const;

/** 10 类词缀池。实际值 = 区间随机值 × 稀有度系数（见 equipment.ts RARITY_DEFS）。 */
export const AFFIX_POOL: readonly AffixDef[] = [
  { id: 'affix_atk', stat: 'atk', min: 3, max: 8, isPercent: false },
  { id: 'affix_crit', stat: 'crit', min: 0.01, max: 0.04, isPercent: true },
  { id: 'affix_critDmg', stat: 'critDmg', min: 0.05, max: 0.15, isPercent: true },
  { id: 'affix_atkSpeed', stat: 'atkSpeed', min: 0.02, max: 0.06, isPercent: true },
  { id: 'affix_moveSpeed', stat: 'moveSpeed', min: 4, max: 12, isPercent: false },
  { id: 'affix_maxHp', stat: 'maxHp', min: 10, max: 30, isPercent: false },
  { id: 'affix_armor', stat: 'armor', min: 2, max: 7, isPercent: false },
  { id: 'affix_lifeSteal', stat: 'lifeSteal', min: 0.005, max: 0.02, isPercent: true },
  { id: 'affix_pickup', stat: 'pickup', min: 3, max: 10, isPercent: false },
  { id: 'affix_skillLevel', stat: 'skillLevel', min: 1, max: 1, isPercent: false },
] as const;

/** 按 id 取属性定义；不存在返回 undefined（配置校验阶段使用）。 */
export function findStat(id: string): StatDef | undefined {
  for (let i = 0; i < STAT_DEFS.length; i++) {
    if (STAT_DEFS[i].id === id) return STAT_DEFS[i];
  }
  return undefined;
}
