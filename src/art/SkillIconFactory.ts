/**
 * 技能矢量图标工厂（DESIGN §8.2 / §8.4）。
 *
 * 不再用「技1/技2/技3」文字标号：每个技能按标签映射到一套线性 SVG 图形，
 * 随技能绑定刷新到触控按钮。图标只依赖配置与 skillId，完全确定性，
 * 不读墙钟 / Math.random；颜色统一走 currentColor，由主题 CSS 决定。
 */
import { resolveSkillSlots } from '../data/skillSlots';
import type { GameConfig, SkillDef } from '../data/types';

export interface SkillIconSpec {
  /** 无障碍标签与 title；不再包含「技1/技2/技3」编号。 */
  readonly name: string;
  /** 完整 <svg> 字符串，插入按钮即可。 */
  readonly svg: string;
}

/** 图形原型：统一 48×48 视窗、currentColor 线性描边。 */
const ARCHETYPES: Readonly<Record<string, string>> = {
  slash: `
    <path d="M10 38 35 11" />
    <path d="M27 10h11v11" />
    <path d="M12 24l12 12" />
    <path d="M9 28l11 11" />
  `,
  spear: `
    <path d="M11 39 34 16" />
    <path d="M30 9h10v10" />
    <path d="m30 9 7 7" />
    <path d="m16 31 5 5" />
  `,
  horn: `
    <path d="M12 20v8h7l11 7V13l-11 7h-7Z" />
    <path d="M36 17c3 4 3 10 0 14" />
    <path d="M40 13c5 6 5 16 0 22" />
  `,
  lightning: `
    <path d="M27 5 13 27h9l-3 16 16-23h-9l1-15Z" />
  `,
  flame: `
    <path d="M24 5c2 8-6 10-6 18 0 3 1 5 3 7-4-1-7-5-7-10C9 26 9 36 16 41c9 6 22 0 22-12 0-8-5-12-8-16-1 5-4 6-6 7 1-6-3-10-8-15Z" />
  `,
  ice: `
    <path d="M24 6v36M7 15l34 18M41 15 7 33" />
    <path d="m19 10 5 5 5-5M19 38l5-5 5 5" />
    <path d="m9 21 7 1-2-7M39 27l-7-1 2 7M9 27l7-1-2 7M39 21l-7 1 2-7" />
  `,
  wind: `
    <path d="M8 18h22c5 0 7-3 6-6-1-3-5-4-7-2" />
    <path d="M6 26h29c5 0 8 3 7 7-1 3-5 4-7 2" />
    <path d="M12 34h12" />
  `,
  arrow: `
    <path d="M10 38 34 14" />
    <path d="M25 12h11v11" />
    <path d="M8 24 21 37" />
    <path d="M14 13h11v11" />
  `,
  shield: `
    <path d="M24 5 39 11v11c0 9-6 15-15 20C15 37 9 31 9 22V11L24 5Z" />
    <path d="M24 16v14M17 23h14" />
  `,
  dark: `
    <path d="M29 7a17 17 0 1 0 12 28A18 18 0 0 1 29 7Z" />
    <path d="M14 14v6M11 17h6M36 30v5M33.5 32.5h5" />
  `,
  earth: `
    <path d="M6 37 19 17l8 12 5-7 10 15H6Z" />
    <path d="m25 24-3 5 5 3-3 5" />
  `,
  charge: `
    <path d="m8 12 14 12L8 36" />
    <path d="m20 12 14 12-14 12" />
    <path d="M34 19h7v10h-7" />
  `,
  trap: `
    <path d="M9 9h30v30H9z" />
    <path d="M19 9v30M29 9v30M9 19h30M9 29h30" />
  `,
  mobility: `
    <path d="M8 34h22c5 0 8-3 8-7" />
    <path d="m31 20 7 7-7 7" />
    <path d="M12 26c4-1 6-5 6-9 0-3 5-3 5 1 0 5-2 9-7 11" />
  `,
  dodge: `
    <path d="M24 5v16" />
    <path d="M17 12l7-7 7 7" />
    <path d="M9 31h22c5 0 8 3 8 7" />
    <path d="m34 32 5 6-5 6" />
  `,
  default: `
    <path d="m24 6 5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1 5-11Z" />
  `,
};

/** SVG 根节点属性保持统一，便于 CSS 用 currentColor 控制颜色。 */
function wrap(paths: string): string {
  return `<svg class="skill-button__icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

/** 按技能标签挑图形原型；顺序即优先级，元素系技能先于通用 melee/buff。 */
export function skillArchetypeOf(skill: SkillDef | undefined): keyof typeof ARCHETYPES {
  if (skill === undefined) return 'default';
  const tags = skill.tags;
  if (tags.includes('charge')) return 'charge';
  if (tags.includes('spear')) return 'spear';
  if (tags.includes('lightning')) return 'lightning';
  if (tags.includes('fire') || tags.includes('summon')) return 'flame';
  if (tags.includes('ice')) return 'ice';
  if (tags.includes('wind') || tags.includes('fan')) return 'wind';
  if (tags.includes('shield') || tags.includes('heal')) return 'shield';
  if (tags.includes('dark') || tags.includes('lifeSteal') || tags.includes('poison')) return 'dark';
  if (tags.includes('trap') || tags.includes('control')) return 'trap';
  if (tags.includes('earth') || tags.includes('stun')) return 'earth';
  if (tags.includes('mobility')) return 'mobility';
  if (tags.includes('shout') || tags.includes('buff')) return 'horn';
  if (tags.includes('arrow') || tags.includes('projectile')) return 'arrow';
  if (tags.includes('slash') || tags.includes('melee')) return 'slash';
  return 'default';
}

/** 闪避键图标（独立动作，不属于武将技能槽）。 */
export function dodgeIcon(): SkillIconSpec {
  return { name: '闪避', svg: wrap(ARCHETYPES.dodge) };
}

/** 单个技能 → 矢量图标。 */
export function skillIconFor(skill: SkillDef | undefined): SkillIconSpec {
  return {
    name: skill?.name ?? '未知技能',
    svg: wrap(ARCHETYPES[skillArchetypeOf(skill)]),
  };
}

/** 未选将时的兜底图标：仍是矢量图，不退回数字标号。 */
export function fallbackSkillIcons(): SkillIconSpec[] {
  const archetypes: Array<keyof typeof ARCHETYPES> = ['slash', 'horn', 'charge'];
  return archetypes.map((key) => ({ name: '技能', svg: wrap(ARCHETYPES[key]) }));
}

/**
 * 按当前武将的三个技能槽生成图标；配置异常时回退到通用矢量图标，避免 UI 崩掉。
 */
export function skillIconsForGeneral(config: GameConfig, generalId: string): SkillIconSpec[] {
  try {
    const bindings = resolveSkillSlots(config, generalId);
    const icons: SkillIconSpec[] = [];
    for (let i = 0; i < bindings.length; i++) {
      icons.push(skillIconFor(config.skills.tryGet(bindings[i].skillId)));
    }
    return icons;
  } catch {
    return fallbackSkillIcons();
  }
}
