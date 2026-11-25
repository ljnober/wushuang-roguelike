/**
 * 技能文案 formatter（docs/ARCH_RUN_STATUS.md §3.4）。
 *
 * 单一事实来源：局内状态面板技能页、showLevelUp 升级卡、pickChoices 共用。
 * 纯函数：零墙钟、零随机、零 ECS import；不修改 SkillDef。
 * 伤害倍率口径 ×1.3^(level-1) 对齐 presentation.showLevelUp；
 * 每级基础增伤 +0.04 对齐 ecs/systems/ProgressionSystems.LevelUpSystem。
 */
import type { SkillDef } from './types';

/** formatter 输出：说明、当前等级、下一级增益三段。 */
export interface SkillDescription {
  readonly description: string;      // 说明文字（静态 description 优先，否则按 def 生成）
  readonly currentLevel: number;     // 1-based，= level 入参
  readonly nextLevelGain: string;    // 下一级增益文案；nextLevel===null 时为 '—'
}

/** SOURCE_PRIORITY 下标 → 中文名（顺序冻结：base/affix/gem/set/legendary/cube/skill/legendaryGem/buff）。 */
const SOURCE_LABELS: readonly string[] = [
  '基础', '词缀', '宝石', '套装', '传奇', '魔盒', '技能', '传说宝石', 'Buff',
];

/**
 * 技能标签中文映射。覆盖 SKILL_DEFS 全部标签，并兼容装备特效同名字段。
 * 未收录标签原样输出，绝不产生 undefined / NaN 文案。
 */
const TAG_LABELS: Readonly<Record<string, string>> = {
  melee: '近战',
  basic: '基础',
  slash: '斩击',
  aoe: '范围',
  buff: '增益',
  shout: '战吼',
  stun: '眩晕',
  lightning: '雷电',
  projectile: '投射物',
  spear: '长枪',
  charge: '冲锋',
  arrow: '箭矢',
  fire: '火焰',
  wind: '风',
  control: '控制',
  combo: '连击',
  mobility: '位移',
  dark: '暗影',
  lifeSteal: '吸血',
  shield: '护盾',
  heal: '治疗',
  ice: '冰霜',
  poison: '剧毒',
  dot: '持续伤害',
  earth: '大地',
  summon: '召唤',
  trap: '陷阱',
  halberd: '长戟',
  blade: '利刃',
  shieldBreak: '破盾',
  slow: '减速',
  curse: '诅咒',
};

/** 非法数值兜底，保证文案不出现 NaN / Infinity。 */
function safeNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** 数值展示：整数直接输出，小数保留至多 2 位。 */
function formatAmount(value: number): string {
  const n = safeNumber(value);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** 单个标签 → 中文；未知标签原样返回，空值返回 '未知'。 */
function tagLabel(tag: string): string {
  if (typeof tag !== 'string' || tag.length === 0) return '未知';
  return TAG_LABELS[tag] ?? tag;
}

/** 无静态说明时按 name/tags/cooldown/range/damage 生成中文可读文案。 */
function fallbackDescription(skill: SkillDef): string {
  const tags = Array.isArray(skill.tags) && skill.tags.length > 0
    ? skill.tags.map(tagLabel).join('、')
    : '通用';
  const damage = safeNumber(skill.damage);
  const attack = damage > 0 ? `造成 ${formatAmount(damage)} 点伤害` : '不造成直接伤害';
  const cooldown = safeNumber(skill.cooldown).toFixed(1);
  const range = safeNumber(skill.range);
  const reach = range > 0 ? `射程 ${formatAmount(range)}` : '作用于自身';
  const name = typeof skill.name === 'string' && skill.name.length > 0 ? skill.name : '未命名技能';
  return `${name}：${tags}，${attack}，冷却 ${cooldown} 秒，${reach}。`;
}

/**
 * 统一 formatter。level 为 1-based 当前等级；nextLevel 为下一级（null 表示不可再升）。
 * 伤害倍率固定 ×1.3^(level-1)；下一级增益额外含每级 damage +0.04（+4% 基础增伤）。
 * 本函数为纯函数：零墙钟、零随机、零 ECS。
 */
export function formatSkillDescription(
  skill: SkillDef,
  level: number,
  nextLevel: number | null,
): SkillDescription {
  const hasStatic = typeof skill.description === 'string' && skill.description.length > 0;
  const description = hasStatic ? (skill.description as string) : fallbackDescription(skill);

  let nextLevelGain = '—';
  if (nextLevel !== null && Number.isFinite(level) && Number.isFinite(nextLevel) && level >= 1 && nextLevel > level) {
    const currentMultiplier = Math.pow(1.3, level - 1);
    const nextMultiplier = Math.pow(1.3, nextLevel - 1);
    const gainPercent = Math.round((nextMultiplier / currentMultiplier - 1) * 1000) / 10;
    nextLevelGain =
      `伤害 ×${currentMultiplier.toFixed(2)}（下一级 ×${nextMultiplier.toFixed(2)}，+${formatAmount(gainPercent)}%）` +
      ' · 每级基础增伤 +0.04（+4%）';
  }

  return { description, currentLevel: level, nextLevelGain };
}

/**
 * 升级卡描述统一入口：showLevelUp 与 pickChoices 共用，消除双实现漂移。
 * 文案与 showLevelUp 现状逐字一致：技能等级 N · 伤害 ×倍率 · 原 tags 串。
 */
export function formatLevelUpDescription(skill: SkillDef, nextLevel: number): string {
  const level = Number.isFinite(nextLevel) && nextLevel >= 1 ? Math.floor(nextLevel) : 1;
  const multiplier = Math.pow(1.3, level - 1).toFixed(2);
  const tags = Array.isArray(skill.tags) && skill.tags.length > 0 ? skill.tags.join(' · ') : '通用';
  return `技能等级 ${level} · 伤害 ×${multiplier} · ${tags}`;
}

/** 来源优先级下标 → 中文名；越界与非法值返回 '未知'。 */
export function sourceKindLabel(kind: number): string {
  if (!Number.isInteger(kind) || kind < 0 || kind >= SOURCE_LABELS.length) return '未知';
  return SOURCE_LABELS[kind];
}
