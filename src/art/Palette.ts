/**
 * 程序化美术参数中心（DESIGN §9 / ARCHITECTURE §5.12）。
 *
 * 40 将的正式配色来自 data/generals.ts 的 GeneralArtParams；本文件提供阵营基调、
 * 敌人配色、确定性缺省参数与颜色工具。所有随机性来自 hash32/Rng，禁用 Math.random。
 */
import { hash32 } from '../core/Rng';
import type { EnemyKind, FactionId, GeneralArtParams } from '../data/types';

export interface FactionPalette {
  readonly primary: number;
  readonly secondary: number;
  readonly accent: number;
  readonly banner: number;
}

/** 三国阵营主色，未配置 art 的实体按此生成基线配色。 */
export const FACTION_PALETTES: Readonly<Record<FactionId, FactionPalette>> = {
  shu: { primary: 0x2e8b57, secondary: 0xf5d76e, accent: 0x8b0000, banner: 0x1e7a46 },
  wei: { primary: 0x24558a, secondary: 0xd8e4f0, accent: 0x1a2a4a, banner: 0x163a6b },
  wu: { primary: 0xb3352b, secondary: 0xf0c419, accent: 0x1d6a72, banner: 0x8f241d },
  qun: { primary: 0x6a3d9a, secondary: 0xd9c6f0, accent: 0x20202a, banner: 0x4b2970 },
};

/** 敌人兵种主色（与 data/combat.ts 的 color 字段互补，供纹理工厂兜底）。 */
export const ENEMY_COLORS: Readonly<Record<EnemyKind, number>> = {
  melee: 0x8c6b4f,
  ranged: 0x6f8b4f,
  cavalry: 0x8a4b3c,
  elite: 0xc08a2e,
  bossMinion: 0x7a3f6d,
  boss: 0xb02f2f,
};

export const HAIR_STYLE_COUNT = 7;
export const BEARD_STYLE_COUNT = 7;
export const ORNAMENT_COUNT = 5;
export const PATTERN_COUNT = 16;

/** 颜色 → CSS，供 DOM UI 直接使用。 */
export function colorToCss(color: number, alpha: number = 1): string {
  const r = (color >>> 16) & 0xff;
  const g = (color >>> 8) & 0xff;
  const b = color & 0xff;
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0;
}

/** 提亮（amount>0）/ 压暗（amount<0），范围 -1..1。 */
export function shade(color: number, amount: number): number {
  const a = amount < -1 ? -1 : amount > 1 ? 1 : amount;
  const r = (color >>> 16) & 0xff;
  const g = (color >>> 8) & 0xff;
  const b = color & 0xff;
  const target = a >= 0 ? 255 : 0;
  const t = a >= 0 ? a : -a;
  return (
    (clampByte(r + (target - r) * t) << 16) |
    (clampByte(g + (target - g) * t) << 8) |
    clampByte(b + (target - b) * t)
  );
}

/** 线性混色，t∈[0,1]。 */
export function mixColor(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >>> 16) & 0xff;
  const ag = (a >>> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >>> 16) & 0xff;
  const bg = (b >>> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (clampByte(ar + (br - ar) * k) << 16) |
    (clampByte(ag + (bg - ag) * k) << 8) |
    clampByte(ab + (bb - ab) * k)
  );
}

/** 取阵营配色；未知 id 回退群雄。 */
export function paletteForFaction(faction: FactionId): FactionPalette {
  return FACTION_PALETTES[faction] ?? FACTION_PALETTES.qun;
}

/** 为没有显式 art 配置的 id 生成稳定的美术参数（武将/敌人共用）。 */
export function fallbackArt(id: string, faction: FactionId = 'qun'): GeneralArtParams {
  const h = hash32(id.length, id.charCodeAt(0) | 0, id.charCodeAt(id.length - 1) | 0);
  const palette = paletteForFaction(faction);
  const weapons = ['sword', 'blade', 'spear', 'bow', 'fan', 'saber'];
  return {
    colors: {
      primary: mixColor(palette.primary, h & 0xffffff, 0.12),
      secondary: palette.secondary,
      accent: palette.accent,
      skin: 0xffd8b1,
    },
    hair: {
      style: h % HAIR_STYLE_COUNT,
      ornament: (h >>> 5) % ORNAMENT_COUNT,
      color: 0x1b1b1b,
    },
    beard: { style: (h >>> 9) % BEARD_STYLE_COUNT, color: 0x242424 },
    weapon: { type: weapons[(h >>> 13) % weapons.length], style: (h >>> 17) % 4 },
    pattern: { id: (h >>> 21) % PATTERN_COUNT, scale: 1, rotation: 0 },
  };
}

/** 为敌人生成美术参数：复用武将参数结构，兵种决定主色与武器。 */
export function enemyArt(kind: EnemyKind, variant: number = 0): GeneralArtParams {
  const base = fallbackArt(`enemy:${kind}:${variant}`, 'qun');
  const color = ENEMY_COLORS[kind] ?? ENEMY_COLORS.melee;
  const weaponByKind: Record<EnemyKind, string> = {
    melee: 'blade',
    ranged: 'bow',
    cavalry: 'spear',
    elite: 'blade',
    bossMinion: 'saber',
    boss: 'blade',
  };
  base.colors.primary = color;
  base.colors.accent = shade(color, -0.35);
  base.weapon.type = weaponByKind[kind] ?? 'blade';
  return base;
}
