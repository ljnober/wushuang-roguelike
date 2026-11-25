/**
 * 程序化装备图标工厂（PRD_UI_REFACTOR §3.2 纸娃娃槽位 / §3.3 槽位解剖映射 / §5.2 稀有度色 /
 * §8.2 A-14 确定性验收）。
 *
 * 本工程没有位图美术资源，图标与 `PortraitFactory` 走同一条路线：纯代码生成 SVG → data URL，
 * 直接作为 `<img src>` 使用。13 个装备槽位各有一款几何化形态，4 档稀有度通过
 * 「边框 + 辉光 + 角标符文」表达，装备本体保持中性金属色，稀有度色不侵入主体。
 *
 * 确定性：完全禁用 Math.random / 墙钟，形状细节由 `hash32(slot, rarity)` 确定性派生，
 * 保证同一 (slot, rarity) 永远产出逐字节相同的字符串（PRD A-14）。
 */
import { hash32 } from '../core/Rng';
import type { RarityId } from '../data/types';
import { colorToCss, shade } from './Palette';

/** 装备槽位 id（与 SLOT_DEFS 一致）。 */
export type EquipmentSlotId = string;

/** 13 个槽位 id，供调用方枚举（与 data/equipment.ts 的 SLOT_DEFS 对齐）。 */
export const EQUIPMENT_SLOT_IDS: readonly EquipmentSlotId[] = [
  'head',
  'shoulders',
  'chest',
  'bracers',
  'gloves',
  'belt',
  'legs',
  'boots',
  'amulet',
  'ring1',
  'ring2',
  'mainHand',
  'offHand',
];

// ---------------------------------------------------------------------------
// 配色
// ---------------------------------------------------------------------------

/** 中性金属色系（装备本体），稀有度色不参与本体。 */
const METAL = 0x9aa2ac;
const METAL_LIGHT = 0xcbd2da;
const METAL_DARK = 0x5f666f;
const TRIM = 0xd8a53c;
const TRIM_DARK = 0x8a6520;
const INK = 0x23262b;

interface RarityStyle {
  /** 稀有度中文名（写入 <title>）。 */
  readonly name: string;
  /** 边框 / 角标 / 光晕颜色。 */
  readonly frame: string;
  /** 外发光半径（0 = 无辉光）。 */
  readonly glow: number;
  /** 是否附加传奇符文角标。 */
  readonly runes: boolean;
}

/**
 * 稀有度 6 档（DESIGN §8.4）。图标以 data URL 内联渲染，无法读取页面 CSS 变量，
 * 因此使用与主题无关的基准色（灰 → 蓝 → 金 → 橙 → 翠 → 紫），保证任何主题下都可辨识。
 */
const RARITY_STYLES: Readonly<Record<RarityId, RarityStyle>> = {
  common: {
    name: '普通',
    frame: '#b9bec4',
    glow: 0,
    runes: false,
  },
  blue: {
    name: '精良',
    frame: '#8dc6ff',
    glow: 1.2,
    runes: false,
  },
  gold: {
    name: '稀有',
    frame: '#f3c744',
    glow: 1.9,
    runes: false,
  },
  legendary: {
    name: '传奇',
    frame: '#ff9d3f',
    glow: 2.6,
    runes: true,
  },
  ancient: {
    name: '远古传说',
    frame: '#54d6a0',
    glow: 3.2,
    runes: true,
  },
  primal: {
    name: '太古传说',
    frame: '#c77dff',
    glow: 3.8,
    runes: true,
  },
};

const RARITY_ORDER: Readonly<Record<RarityId, number>> = {
  common: 0,
  blue: 1,
  gold: 2,
  legendary: 3,
  ancient: 4,
  primal: 5,
};

/** 槽位中文名（写入 <title>，兼作无障碍标签）。 */
const SLOT_NAMES: Readonly<Record<EquipmentSlotId, string>> = {
  head: '头盔',
  shoulders: '肩甲',
  chest: '胸甲',
  bracers: '护腕',
  gloves: '手套',
  belt: '腰带',
  legs: '护腿',
  boots: '靴子',
  amulet: '项链',
  ring1: '戒指一',
  ring2: '戒指二',
  mainHand: '主手武器',
  offHand: '副手武器',
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** XML 文本转义（与 PortraitFactory 同风格，本文件私有实现）。 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 槽位 id → 可安全嵌入 SVG id 属性的短 slug（确定性，非字母数字一律转下划线）。 */
function slug(slot: string): string {
  let out = '';
  for (let i = 0; i < slot.length; i++) {
    const ch = slot.charAt(i);
    const code = slot.charCodeAt(i);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      out += ch;
    } else {
      out += '_';
    }
  }
  return out.length > 0 ? out : 'slot';
}

/** 灰度化（占位图专用）。 */
function toGrey(color: number): number {
  const r = (color >>> 16) & 0xff;
  const g = (color >>> 8) & 0xff;
  const b = color & 0xff;
  const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return (l << 16) | (l << 8) | l;
}

/**
 * 形状绘制上下文。
 * - `fill/light/dark/stroke/trim` 为本体各部位颜色；
 * - `dash` 非空时叠加虚线轮廓（空槽占位）；
 * - `seed` 为确定性派生值，用于细节差异（铆钉数量、纹样等）。
 */
interface ShapeStyle {
  readonly fill: string;
  readonly light: string;
  readonly dark: string;
  readonly stroke: string;
  readonly trim: string;
  readonly trimDark: string;
  readonly ink: string;
  readonly dash: string;
  readonly seed: number;
}

function normalStyle(seed: number): ShapeStyle {
  return {
    fill: colorToCss(METAL),
    light: colorToCss(METAL_LIGHT),
    dark: colorToCss(METAL_DARK),
    stroke: colorToCss(shade(METAL_DARK, -0.25)),
    trim: colorToCss(TRIM),
    trimDark: colorToCss(TRIM_DARK),
    ink: colorToCss(INK),
    dash: '',
    seed,
  };
}

function placeholderStyle(seed: number): ShapeStyle {
  return {
    fill: colorToCss(toGrey(METAL)),
    light: colorToCss(toGrey(METAL_LIGHT)),
    dark: colorToCss(toGrey(METAL_DARK)),
    stroke: colorToCss(toGrey(METAL_DARK)),
    trim: colorToCss(toGrey(TRIM)),
    trimDark: colorToCss(toGrey(TRIM_DARK)),
    ink: colorToCss(toGrey(INK)),
    dash: ' stroke-dasharray="3 2.4"',
    seed,
  };
}

/** 由槽位 id 与稀有度派生确定性种子（hash32，禁用随机）。 */
function seedFor(slot: string, rarity: RarityId): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slot.length; i++) {
    h = hash32(h, slot.charCodeAt(i), i);
  }
  return hash32(h, RARITY_ORDER[rarity] ?? 0);
}

// ---------------------------------------------------------------------------
// 13 槽位几何形态
// ---------------------------------------------------------------------------

/** 头盔：半球盔面 + 护鼻 + 盔缨 + 额檐。 */
function drawHead(s: ShapeStyle): string {
  const plumeUp = s.seed % 2 === 0;
  return (
    `<path d="M18 45 L18 33 A14 14 0 0 1 46 33 L46 45 Z" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.6"${s.dash}/>` +
    `<path d="M18 39 Q32 33 46 39 L46 45 L18 45 Z" fill="${s.light}" opacity="0.75"/>` +
    `<rect x="29" y="30" width="6" height="18" rx="2.5" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1"${s.dash}/>` +
    `<rect x="21" y="32" width="7" height="4" rx="1.5" fill="${s.ink}" opacity="0.85"/>` +
    `<rect x="36" y="32" width="7" height="4" rx="1.5" fill="${s.ink}" opacity="0.85"/>` +
    `<rect x="14" y="43" width="36" height="6" rx="3" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1"${s.dash}/>` +
    (plumeUp
      ? `<path d="M32 12 L38 19 L32 24 L26 19 Z" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="0.8"/>`
      : `<path d="M26 20 L32 13 L38 20 L32 25 Z" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="0.8"/>`)
  );
}

/** 肩甲：横跨双肩的护肩轭 + 两端圆肩吞 + 中央领扣。 */
function drawShoulders(s: ShapeStyle): string {
  const studs = 2 + (s.seed % 2);
  const stud = (x: number, y: number): string =>
    `<circle cx="${num(x)}" cy="${num(y)}" r="2.2" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="0.7"/>`;
  const studsMarkup =
    studs === 2
      ? stud(12, 30) + stud(52, 30)
      : stud(12, 30) + stud(32, 24) + stud(52, 30);
  return (
    // 肩轭（横跨双肩的弧形甲带）
    `<path d="M14 24 Q32 15 50 24 L50 36 Q32 27 14 36 Z" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.6"${s.dash}/>` +
    `<path d="M16 26 Q32 18 48 26 L48 30 Q32 22 16 30 Z" fill="${s.light}" opacity="0.7"/>` +
    // 左圆肩吞
    `<circle cx="13" cy="31" r="10" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.6"${s.dash}/>` +
    `<circle cx="13" cy="31" r="5.4" fill="${s.light}" opacity="0.6"/>` +
    `<path d="M13 25.5 A5.4 5.4 0 0 0 7.6 31" fill="none" stroke="${s.dark}" stroke-width="1.4" opacity="0.7"/>` +
    // 右圆肩吞
    `<circle cx="51" cy="31" r="10" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.6"${s.dash}/>` +
    `<circle cx="51" cy="31" r="5.4" fill="${s.light}" opacity="0.6"/>` +
    `<path d="M51 25.5 A5.4 5.4 0 0 0 45.6 31" fill="none" stroke="${s.dark}" stroke-width="1.4" opacity="0.7"/>` +
    // 中央领扣
    `<path d="M27 41 L37 41 L35 55 L29 55 Z" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1"${s.dash}/>` +
    `<path d="M26 43 L38 43" stroke="${s.trim}" stroke-width="1.8" stroke-linecap="round"/>` +
    studsMarkup
  );
}

/** 胸甲：护胸主体 + 领口 + 中脊 + 侧甲片。 */
function drawChest(s: ShapeStyle): string {
  const bands = 2 + (s.seed % 2);
  let bandMarkup = '';
  for (let i = 0; i < bands; i++) {
    const y = 34 + i * 7;
    bandMarkup += `<path d="M${20 + i} ${y} Q32 ${y + 3} ${44 - i} ${y}" fill="none" stroke="${s.trim}" stroke-width="1.4" opacity="0.8"/>`;
  }
  return (
    `<path d="M20 19 L32 23 L44 19 L48 29 L46 51 L18 51 L16 29 Z" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.6"${s.dash}/>` +
    `<path d="M26 20 L32 29 L38 20 L34 24 L32 26 L30 24 Z" fill="${s.dark}" stroke="${s.stroke}" stroke-width="0.8"${s.dash}/>` +
    `<path d="M32 29 L32 51" stroke="${s.dark}" stroke-width="1.4" opacity="0.9"/>` +
    `<path d="M18 30 L24 32 L22 50 L18 51 Z" fill="${s.light}" opacity="0.6"/>` +
    `<path d="M46 30 L40 32 L42 50 L46 51 Z" fill="${s.light}" opacity="0.6"/>` +
    bandMarkup
  );
}

/** 护腕：套在手腕上的护腕筒（上宽下窄 + 两道皮带 + 铆钉）。 */
function drawBracers(s: ShapeStyle): string {
  const strapCount = 2 + (s.seed % 2);
  let straps = '';
  for (let i = 0; i < strapCount; i++) {
    const y = 25 + i * 13;
    straps += `<rect x="17" y="${y}" width="30" height="5" rx="2.5" fill="${s.trimDark}" stroke="${s.stroke}" stroke-width="0.8"${s.dash}/>`;
  }
  return (
    // 护腕主体：上宽下窄的锥台
    `<path d="M16 16 L48 16 L42 50 L22 50 Z" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.6"${s.dash}/>` +
    // 袖口（上方开口）与下缘
    `<path d="M16 16 L48 16 L46 21 L18 21 Z" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1.1"${s.dash}/>` +
    `<path d="M22 50 L42 50 L41 55 L23 55 Z" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1.1"${s.dash}/>` +
    // 甲片高光
    `<path d="M21 22 L27 22 L28 48 L24 48 Z" fill="${s.light}" opacity="0.65"/>` +
    `<path d="M43 22 L37 22 L36 48 L40 48 Z" fill="${s.light}" opacity="0.4"/>` +
    straps +
    `<circle cx="32" cy="32" r="4.6" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="1"/>` +
    `<circle cx="32" cy="32" r="1.6" fill="${s.trimDark}"/>`
  );
}

/** 手套：五指 + 手掌 + 袖口。 */
function drawGloves(s: ShapeStyle): string {
  const spread = s.seed % 2 === 0;
  const f4x = spread ? 41 : 40;
  return (
    `<rect x="22" y="18" width="5" height="17" rx="2.5" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.2"${s.dash}/>` +
    `<rect x="28" y="14" width="5" height="20" rx="2.5" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.2"${s.dash}/>` +
    `<rect x="34" y="16" width="5" height="18" rx="2.5" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.2"${s.dash}/>` +
    `<rect x="${f4x}" y="20" width="5" height="14" rx="2.5" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.2"${s.dash}/>` +
    `<rect x="20" y="31" width="26" height="18" rx="4.5" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.4"${s.dash}/>` +
    `<rect x="22" y="33" width="22" height="8" rx="3" fill="${s.light}" opacity="0.6"/>` +
    `<rect x="16" y="30" width="6" height="12" rx="3" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.2"${s.dash} transform="rotate(-18 19 36)"/>` +
    `<rect x="19" y="47" width="28" height="7" rx="3" fill="${s.trimDark}" stroke="${s.stroke}" stroke-width="1"${s.dash}/>` +
    `<circle cx="33" cy="41" r="2.4" fill="${s.trim}"/>`
  );
}

/** 腰带：带身 + 方扣 + 带孔 + 尾端。 */
function drawBelt(s: ShapeStyle): string {
  const holes = 2 + (s.seed % 3);
  let holeMarkup = '';
  for (let i = 0; i < holes; i++) {
    holeMarkup += `<circle cx="${num(41 + i * 5)}" cy="33" r="1.4" fill="${s.ink}" opacity="0.75"/>`;
  }
  return (
    `<rect x="7" y="26" width="50" height="14" rx="3.5" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1.4"${s.dash}/>` +
    `<rect x="7" y="28" width="50" height="4" rx="2" fill="${s.light}" opacity="0.35"/>` +
    `<rect x="25" y="21" width="14" height="24" rx="3" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="1.1"${s.dash}/>` +
    `<rect x="29" y="25" width="6" height="16" rx="1.5" fill="${s.trimDark}" opacity="0.55"/>` +
    holeMarkup
  );
}

/** 护腿：左右两片胫甲 + 膝甲。 */
function drawLegs(s: ShapeStyle): string {
  const knee = s.seed % 2 === 0;
  return (
    `<path d="M17 14 L29 14 L28 51 L19 51 Z" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.5"${s.dash}/>` +
    `<path d="M47 14 L35 14 L36 51 L45 51 Z" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.5"${s.dash}/>` +
    `<path d="M19 16 L26 16 L26 48 L21 48 Z" fill="${s.light}" opacity="0.6"/>` +
    `<path d="M38 16 L45 16 L44 48 L39 48 Z" fill="${s.light}" opacity="0.6"/>` +
    (knee
      ? `<path d="M16 28 L30 28 L30 36 L16 36 Z" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1"${s.dash}/>` +
        `<path d="M34 28 L48 28 L48 36 L34 36 Z" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1"${s.dash}/>` +
        `<circle cx="23" cy="32" r="2.2" fill="${s.trim}"/><circle cx="41" cy="32" r="2.2" fill="${s.trim}"/>`
      : `<path d="M17 26 Q23 22 29 26 L29 33 Q23 36 17 33 Z" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1"${s.dash}/>` +
        `<path d="M47 26 Q41 22 35 26 L35 33 Q41 36 47 33 Z" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1"${s.dash}/>`)
  );
}

/** 靴子：左右一对高筒战靴（靴筒 + 收窄脚踝 + 外撇靴头 + 鞋底）。 */
function drawBoots(s: ShapeStyle): string {
  const strap = s.seed % 2 === 0;
  /** 一只靴子：shaftL/shaftR 为靴筒左右缘，toe 为靴头外缘，soleX 为鞋底左缘。 */
  const boot = (
    shaftL: number,
    shaftR: number,
    ankleL: number,
    ankleR: number,
    toe: number,
    soleX: number,
    dir: 1 | -1,
  ): string => {
    const body =
      `M${shaftL} 11 L${shaftR} 11 L${ankleR} 37 L${toe} 40 L${toe} 47 L${ankleL} 47 L${ankleL} 40 L${shaftL} 37 Z`;
    const toeInner = dir > 0 ? ankleR : ankleL;
    return (
      `<path d="${body}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.5"${s.dash}/>` +
      `<path d="M${toeInner} 40 L${toe} 41 L${toe} 46 L${toeInner} 46 Z" fill="${s.light}" opacity="0.7"/>` +
      `<ellipse cx="${(shaftL + shaftR) / 2}" cy="11.5" rx="${(shaftR - shaftL) / 2}" ry="2.4" fill="${s.ink}" opacity="0.4"/>` +
      `<rect x="${soleX}" y="47" width="22" height="6" rx="3" fill="${s.dark}" stroke="${s.stroke}" stroke-width="1"${s.dash}/>` +
      (strap
        ? `<rect x="${shaftL}" y="19" width="${shaftR - shaftL}" height="4" rx="2" fill="${s.trimDark}"/>`
        : `<circle cx="${(shaftL + shaftR) / 2}" cy="21" r="2.3" fill="${s.trim}"/>`)
    );
  };
  // 右脚：靴头朝右；左脚：靴头朝左（左右镜像）
  const right = boot(5, 18, 8, 15, 26, 4, 1);
  const left = boot(46, 59, 49, 56, 38, 38, -1);
  return right + left;
}

/** 项链：链弧 + 吊坠宝石。 */
function drawAmulet(s: ShapeStyle): string {
  const beads = 5 + (s.seed % 3);
  let chain = '';
  for (let i = 0; i < beads; i++) {
    const t = i / (beads - 1);
    const x = 18 + t * 28;
    const y = 18 + Math.sin(Math.PI * t) * 16;
    chain += `<circle cx="${num(x)}" cy="${num(y)}" r="2" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="0.6"/>`;
  }
  return (
    chain +
    `<path d="M18 18 Q32 46 46 18" fill="none" stroke="${s.trimDark}" stroke-width="1.2" opacity="0.7"${s.dash}/>` +
    `<path d="M32 34 L39 42 L32 54 L25 42 Z" fill="${s.light}" stroke="${s.stroke}" stroke-width="1.3"${s.dash}/>` +
    `<path d="M32 39 L36 43 L32 49 L28 43 Z" fill="${s.trim}" opacity="0.9"/>`
  );
}

/** 戒指一：细环 + 顶部小宝石。 */
function drawRing1(s: ShapeStyle): string {
  const inner = s.seed % 2 === 0;
  return (
    `<circle cx="32" cy="38" r="12" fill="none" stroke="${s.fill}" stroke-width="4"${s.dash}/>` +
    `<circle cx="32" cy="38" r="12" fill="none" stroke="${s.dark}" stroke-width="1" opacity="0.6"/>` +
    `<path d="M32 12 L39 19 L32 26 L25 19 Z" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="1"/>` +
    (inner
      ? `<path d="M32 15 L36 19 L32 23 L28 19 Z" fill="${s.light}" opacity="0.85"/>`
      : `<circle cx="32" cy="19" r="2.4" fill="${s.light}" opacity="0.9"/>`)
  );
}

/** 戒指二：宽面印戒（与戒指一形态明显不同）。 */
function drawRing2(s: ShapeStyle): string {
  const rune = s.seed % 2 === 0;
  return (
    `<circle cx="32" cy="40" r="11" fill="none" stroke="${s.fill}" stroke-width="5"${s.dash}/>` +
    `<circle cx="32" cy="40" r="11" fill="none" stroke="${s.dark}" stroke-width="1" opacity="0.6"/>` +
    `<rect x="23" y="12" width="18" height="16" rx="3" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="1.1"${s.dash}/>` +
    (rune
      ? `<path d="M32 16 L35 20 L32 24 L29 20 Z" fill="${s.trimDark}" opacity="0.8"/>`
      : `<path d="M28 20 L32 16 L36 20 L32 24 Z" fill="none" stroke="${s.trimDark}" stroke-width="1.2"/>`)
  );
}

/** 主手武器：直刃刀（刀身 + 刀镡 + 刀柄 + 柄头）。 */
function drawMainHand(s: ShapeStyle): string {
  const fuller = s.seed % 2 === 0;
  return (
    `<path d="M13 7 L21 13 L21 33 L13 31 Z" fill="${s.light}" stroke="${s.stroke}" stroke-width="1.4"${s.dash}/>` +
    (fuller
      ? `<path d="M15 11 L18 14 L18 30 L15 29 Z" fill="${s.ink}" opacity="0.35"/>`
      : `<path d="M13 7 L21 13 L21 16 L13 12 Z" fill="${s.ink}" opacity="0.3"/>`) +
    `<rect x="8" y="32" width="18" height="5" rx="2.5" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="0.9"${s.dash}/>` +
    `<rect x="13" y="36" width="8" height="15" rx="2.5" fill="${s.trimDark}" stroke="${s.stroke}" stroke-width="0.9"${s.dash}/>` +
    `<path d="M14 39 L20 39 M14 43 L20 43 M14 47 L20 47" stroke="${s.fill}" stroke-width="0.9" opacity="0.8"/>` +
    `<circle cx="17" cy="53" r="3.2" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="0.8"/>`
  );
}

/** 副手武器：盾牌（盾体 + 内衬 + 盾心 + 竖脊）。 */
function drawOffHand(s: ShapeStyle): string {
  const boss = s.seed % 2 === 0;
  return (
    `<path d="M32 7 L51 15 L51 32 Q51 45 32 55 Q13 45 13 32 L13 15 Z" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.6"${s.dash}/>` +
    `<path d="M32 12 L46 18 L46 31 Q46 41 32 48 Q18 41 18 31 L18 18 Z" fill="${s.light}" opacity="0.6"/>` +
    `<path d="M32 12 L32 48" stroke="${s.dark}" stroke-width="1.4" opacity="0.85"/>` +
    `<path d="M18 18 Q32 22 46 18" fill="none" stroke="${s.trim}" stroke-width="1.3" opacity="0.85"/>` +
    (boss
      ? `<circle cx="32" cy="30" r="5.4" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="1"/>`
      : `<path d="M32 24 L37 30 L32 36 L27 30 Z" fill="${s.trim}" stroke="${s.trimDark}" stroke-width="0.8"/>`)
  );
}

/**
 * 未知槽位兜底：灰色问号方块（脏数据容错，PRD US-04-6）。
 * 内部细节由种子确定性派生，使不同脏槽位不共用同一张图。
 */
function drawUnknown(s: ShapeStyle): string {
  const variant = s.seed % 3;
  const glyph =
    variant === 0
      ? `<path d="M26 27 Q26 20 32 20 Q39 20 39 27 Q39 32 32 34 L32 37" fill="none" stroke="${s.ink}" stroke-width="2.6" stroke-linecap="round"/>` +
        `<circle cx="32" cy="42" r="2" fill="${s.ink}"/>`
      : variant === 1
        ? `<path d="M26 28 L32 22 L38 28 L32 34 Z" fill="none" stroke="${s.ink}" stroke-width="2.2" stroke-linejoin="round"/>` +
          `<path d="M26 39 L38 39" stroke="${s.ink}" stroke-width="2.2" stroke-linecap="round"/>`
        : `<circle cx="32" cy="29" r="7" fill="none" stroke="${s.ink}" stroke-width="2.2"/>` +
          `<path d="M32 34 L32 41" stroke="${s.ink}" stroke-width="2.2" stroke-linecap="round"/>`;
  const corner = `<path d="M13 13 L21 13 M13 13 L13 21" stroke="${s.ink}" stroke-width="1.6" opacity="0.5" fill="none"/>`;
  return (
    `<rect x="16" y="16" width="32" height="32" rx="7" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.6"${s.dash}/>` +
    corner +
    glyph
  );
}

const SHAPE_PAINTERS: Readonly<
  Record<
    string,
    (s: ShapeStyle) => string
  >
> = {
  head: drawHead,
  shoulders: drawShoulders,
  chest: drawChest,
  bracers: drawBracers,
  gloves: drawGloves,
  belt: drawBelt,
  legs: drawLegs,
  boots: drawBoots,
  amulet: drawAmulet,
  ring1: drawRing1,
  ring2: drawRing2,
  mainHand: drawMainHand,
  offHand: drawOffHand,
};

// ---------------------------------------------------------------------------
// 稀有度装饰
// ---------------------------------------------------------------------------

/** 稀有度边框（+ 辉光 + 传奇角标符文）。 */
function drawRarityFrame(style: RarityStyle, idSuffix: string): string {
  const parts: string[] = [];
  const frame = `<rect x="3.5" y="3.5" width="57" height="57" rx="9" fill="none" stroke="${style.frame}" stroke-width="2" stroke-linejoin="round"/>`;
  if (style.glow > 0) {
    parts.push(`<g filter="url(#glow-${idSuffix})" opacity="0.9">${frame}</g>`);
    parts.push(frame);
  } else {
    parts.push(`<rect x="3.5" y="3.5" width="57" height="57" rx="9" fill="none" stroke="${style.frame}" stroke-width="1.2" stroke-linejoin="round" opacity="0.55"/>`);
  }
  if (style.runes) {
    // 传奇角标：四角菱形符文 + 上下两点。
    const rune = (x: number, y: number): string =>
      `<path d="M${x} ${y - 5} L${x + 3.4} ${y} L${x} ${y + 5} L${x - 3.4} ${y} Z" fill="${style.frame}" stroke="${style.frame}" stroke-width="0.6" opacity="0.95"/>`;
    parts.push(rune(11, 11) + rune(53, 11) + rune(11, 53) + rune(53, 53));
    parts.push(`<circle cx="32" cy="7" r="1.6" fill="${style.frame}"/><circle cx="32" cy="57" r="1.6" fill="${style.frame}"/>`);
  }
  return parts.join('');
}

/** 背景光晕（仅蓝 / 金 / 传奇），绘制在图标下方且保持低透明度以免淹没本体。 */
function drawAura(style: RarityStyle, idSuffix: string): string {
  if (style.glow <= 0) return '';
  return `<circle cx="32" cy="32" r="29" fill="url(#aura-${idSuffix})"/>`;
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export class EquipmentIconFactory {
  private readonly cache = new Map<string, string>();
  private readonly placeholderCache = new Map<string, string>();

  /** 裸 SVG → 可作为 <img src> 的 data URL；不转换则浏览器会当成相对路径请求而 404。 */
  private toDataUrl(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  /** 取某槽位 + 某稀有度的图标 data URL（内部缓存，同参必同串）。 */
  dataUrlFor(slot: EquipmentSlotId, rarity: RarityId): string {
    const key = `${slot}|${rarity}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const url = this.toDataUrl(this.build(slot, rarity));
    this.cache.set(key, url);
    return url;
  }

  /** 取裸 SVG 字符串（不缓存），供需要内联的场景使用。 */
  svgFor(slot: EquipmentSlotId, rarity: RarityId): string {
    return this.build(slot, rarity);
  }

  /** 空槽占位图标（灰度、单色、虚线感轮廓）。 */
  placeholderDataUrlFor(slot: EquipmentSlotId): string {
    const cached = this.placeholderCache.get(slot);
    if (cached !== undefined) return cached;
    const url = this.toDataUrl(this.buildPlaceholder(slot));
    this.placeholderCache.set(slot, url);
    return url;
  }

  /** 空槽占位裸 SVG（不缓存）。 */
  placeholderSvgFor(slot: EquipmentSlotId): string {
    return this.buildPlaceholder(slot);
  }

  /** 清空缓存。 */
  clear(): void {
    this.cache.clear();
    this.placeholderCache.clear();
  }

  /** 已缓存的图标数量（装备图 + 占位图合计）。 */
  get size(): number {
    return this.cache.size + this.placeholderCache.size;
  }

  // -------------------------------------------------------------------------

  /** 归一化稀有度：非法值退化为 common，不抛异常。 */
  private normalizeRarity(rarity: RarityId): RarityId {
    return Object.prototype.hasOwnProperty.call(RARITY_ORDER, rarity) ? rarity : 'common';
  }

  /** 取槽位绘制函数；未知槽位返回兜底绘制。 */
  private painterFor(slot: EquipmentSlotId): (s: ShapeStyle) => string {
    if (Object.prototype.hasOwnProperty.call(SHAPE_PAINTERS, slot)) {
      return SHAPE_PAINTERS[slot];
    }
    return drawUnknown;
  }

  /** 槽位显示名；未知槽位回退到带原始 id 的通用名（便于定位脏数据且天然区分）。 */
  private nameFor(slot: EquipmentSlotId): string {
    if (Object.prototype.hasOwnProperty.call(SLOT_NAMES, slot)) {
      return SLOT_NAMES[slot];
    }
    return `装备(${String(slot)})`;
  }

  private build(slot: EquipmentSlotId, rawRarity: RarityId): string {
    const rarity = this.normalizeRarity(rawRarity);
    const style = RARITY_STYLES[rarity];
    const seed = seedFor(String(slot), rarity);
    const shape = this.painterFor(slot);
    const parts: string[] = [];

    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%">');
    parts.push(`<title>${escapeXml(`${this.nameFor(slot)}（${style.name}）`)}</title>`);

    // 内部 id 加槽位+稀有度后缀，避免同一页面内联多张 SVG 时 defs 互相污染。
    const idSuffix = `${slug(slot)}-${rarity}`;

    const defs: string[] = [];
    if (style.glow > 0) {
      defs.push(
        `<filter id="glow-${idSuffix}" x="-50%" y="-50%" width="200%" height="200%">` +
          `<feGaussianBlur stdDeviation="${num(style.glow)}" result="blur"/>` +
          `<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>` +
          `</filter>`,
      );
      defs.push(
        `<radialGradient id="aura-${idSuffix}" cx="50%" cy="50%" r="50%">` +
          `<stop offset="0%" stop-color="${style.frame}" stop-opacity="0.3"/>` +
          `<stop offset="70%" stop-color="${style.frame}" stop-opacity="0.12"/>` +
          `<stop offset="100%" stop-color="${style.frame}" stop-opacity="0"/>` +
          `</radialGradient>`,
      );
    }
    if (defs.length > 0) parts.push(`<defs>${defs.join('')}</defs>`);

    parts.push(drawAura(style, idSuffix));
    parts.push(`<g>${shape(normalStyle(seed))}</g>`);
    parts.push(drawRarityFrame(style, idSuffix));
    parts.push('</svg>');
    return parts.join('');
  }

  private buildPlaceholder(slot: EquipmentSlotId): string {
    const seed = seedFor(String(slot), 'common');
    const shape = this.painterFor(slot);
    const parts: string[] = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%">');
    parts.push(`<title>${escapeXml(`${this.nameFor(slot)}（未装备）`)}</title>`);
    parts.push(`<g opacity="0.85">${shape(placeholderStyle(seed))}</g>`);
    parts.push(
      `<rect x="3.5" y="3.5" width="57" height="57" rx="9" fill="none" stroke="${colorToCss(toGrey(METAL))}" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.7"/>`,
    );
    parts.push('</svg>');
    return parts.join('');
  }
}
