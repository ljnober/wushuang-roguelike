/**
 * 选将卡片 Q 版矢量头像（DESIGN §9）。
 *
 * 纯程序化 SVG（无外部图片），依据 GeneralArtParams 组合发型/胡须/武器/纹样。
 * 相同武将只生成一次并缓存 data URL；DOM 侧直接作为 <img src> 使用。
 */
import type { GeneralArtParams, GeneralDef } from '../data/types';
import { colorToCss, fallbackArt, paletteForFaction, shade } from './Palette';

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** XML 文本转义（名称仅作为 aria/title，避免异常字符破坏 SVG）。 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class PortraitFactory {
  private readonly cache = new Map<string, string>();

  /** 按武将配置取头像 data URL。 */
  dataUrlFor(general: GeneralDef): string {
    const cached = this.cache.get(general.id);
    if (cached !== undefined) return cached;
    const url = this.build(general.name, general.faction, general.art);
    this.cache.set(general.id, url);
    return url;
  }

  /** 未知 id 的稳定兜底头像。 */
  dataUrlById(id: string, faction: GeneralDef['faction'] = 'qun'): string {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const url = this.build(id, faction, fallbackArt(id, faction));
    this.cache.set(id, url);
    return url;
  }

  svgFor(general: GeneralDef): string {
    return this.build(general.name, general.faction, general.art);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private build(name: string, faction: GeneralDef['faction'], art: GeneralArtParams): string {
    const { colors, hair, beard, weapon, pattern } = art;
    const banner = paletteForFaction(faction);
    const parts: string[] = [];

    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">');
    parts.push(`<title>${escapeXml(name)}</title>`);
    parts.push(
      `<defs><radialGradient id="bg" cx="50%" cy="35%" r="70%">` +
        `<stop offset="0%" stop-color="${colorToCss(shade(banner.primary, 0.28))}"/>` +
        `<stop offset="100%" stop-color="${colorToCss(shade(banner.primary, -0.45))}"/>` +
        `</radialGradient></defs>`,
    );
    parts.push('<rect x="0" y="0" width="100" height="100" rx="16" fill="url(#bg)"/>');
    parts.push(
      `<circle cx="50" cy="47" r="39" fill="none" stroke="${colorToCss(banner.secondary, 0.8)}" stroke-width="2"/>`,
    );

    // 身体纹样：图案编号决定斜纹/点阵/波纹，均为确定性几何。
    parts.push(this.drawPattern(pattern.id, pattern.scale, pattern.rotation, banner.secondary));

    // 肩甲与衣领
    parts.push(
      `<path d="M14 100 Q18 74 36 68 L64 68 Q82 74 86 100 Z" fill="${colorToCss(colors.primary)}" stroke="${colorToCss(shade(colors.primary, -0.4))}" stroke-width="1.5"/>`,
    );
    parts.push(
      `<path d="M36 69 L50 84 L64 69 L60 66 L50 76 L40 66 Z" fill="${colorToCss(colors.secondary)}"/>`,
    );
    parts.push(
      `<rect x="20" y="82" width="60" height="5" rx="2" fill="${colorToCss(colors.accent)}" opacity="0.85"/>`,
    );

    // 头颈与脸
    parts.push(`<rect x="45" y="60" width="10" height="12" rx="4" fill="${colorToCss(shade(colors.skin, -0.12))}"/>`);
    parts.push(
      `<ellipse cx="50" cy="46" rx="20" ry="22" fill="${colorToCss(colors.skin)}" stroke="${colorToCss(shade(colors.skin, -0.28))}" stroke-width="1"/>`,
    );

    parts.push(this.drawHair(hair.style, hair.color, colors.accent));
    parts.push(this.drawEyes());

    if (beard.style > 0) parts.push(this.drawBeard(beard.style, beard.color));
    if (hair.ornament > 0) parts.push(this.drawOrnament(hair.ornament, colors.secondary, colors.accent));

    parts.push(this.drawWeapon(weapon.type, weapon.style, colors.accent, colors.secondary));
    parts.push('</svg>');
    return parts.join('');
  }

  private drawPattern(id: number, scale: number, rotation: number, color: number): string {
    const parts: string[] = ['<g opacity="0.2">'];
    const rot = Math.round(rotation);
    const step = Math.max(8, Math.round(14 / Math.max(0.5, scale)));
    if (id % 3 === 0) {
      for (let x = -20; x < 120; x += step) {
        parts.push(
          `<path d="M${num(x)} 100 L${num(x + 40)} 20" stroke="${colorToCss(color)}" stroke-width="2"/>`,
        );
      }
    } else if (id % 3 === 1) {
      for (let x = 10; x < 100; x += step) {
        for (let y = 10; y < 100; y += step) {
          parts.push(`<circle cx="${num(x)}" cy="${num(y)}" r="1.6" fill="${colorToCss(color)}"/>`);
        }
      }
    } else {
      for (let y = 12; y < 100; y += step) {
        parts.push(
          `<path d="M4 ${num(y)} Q26 ${num(y - 6)} 50 ${num(y)} T96 ${num(y)}" fill="none" stroke="${colorToCss(color)}" stroke-width="1.6" transform="rotate(${rot} 50 50)"/>`,
        );
      }
    }
    parts.push('</g>');
    return parts.join('');
  }

  private drawHair(style: number, color: number, accent: number): string {
    const c = colorToCss(color);
    const dark = colorToCss(shade(color, -0.25));
    const band = colorToCss(accent);
    const parts: string[] = [];
    switch (style % 7) {
      case 0: // 短发
        parts.push(`<path d="M30 42 Q31 20 50 21 Q69 20 70 42 Q62 30 50 31 Q38 30 30 42 Z" fill="${c}"/>`);
        break;
      case 1: // 发髻
        parts.push(`<circle cx="50" cy="17" r="8" fill="${dark}"/>`);
        parts.push(`<path d="M29 44 Q30 21 50 22 Q70 21 71 44 Q61 31 50 32 Q39 31 29 44 Z" fill="${c}"/>`);
        break;
      case 2: // 长发垂肩
        parts.push(`<path d="M28 40 Q30 18 50 20 Q70 18 72 40 L74 72 L64 70 L64 42 L36 42 L36 70 L26 72 Z" fill="${c}"/>`);
        parts.push(`<rect x="26" y="62" width="8" height="4" rx="2" fill="${band}"/>`);
        break;
      case 3: // 偏分
        parts.push(`<path d="M28 44 Q28 22 52 21 Q70 22 72 44 L66 39 Q56 32 42 35 L34 45 Z" fill="${c}"/>`);
        parts.push(`<path d="M52 22 Q62 26 68 36" fill="none" stroke="${dark}" stroke-width="2"/>`);
        break;
      case 4: // 束发飘带
        parts.push(`<path d="M29 42 Q31 22 50 22 Q69 22 71 42 L64 33 L56 38 L50 30 L42 38 L34 33 Z" fill="${c}"/>`);
        parts.push(`<path d="M68 24 Q80 18 84 28" fill="none" stroke="${band}" stroke-width="3"/>`);
        break;
      case 5: // 白发老将
        parts.push(`<path d="M31 43 Q33 25 50 26 Q67 25 69 43 L63 36 L50 34 L37 36 Z" fill="${c}"/>`);
        parts.push(`<path d="M34 40 L28 62 M66 40 L72 62" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`);
        break;
      default: // 谋士巾
        parts.push(`<path d="M28 42 L31 24 Q50 16 69 24 L72 42 L64 36 L36 36 Z" fill="${c}"/>`);
        parts.push(`<rect x="27" y="20" width="46" height="7" rx="3" fill="${band}"/>`);
        break;
    }
    return parts.join('');
  }

  private drawEyes(): string {
    return (
      '<g fill="#1b1b1b">' +
      '<ellipse cx="42" cy="47" rx="2.6" ry="3.2"/>' +
      '<ellipse cx="58" cy="47" rx="2.6" ry="3.2"/>' +
      '</g>' +
      '<path d="M37 42 L46 43 M54 43 L63 42" fill="none" stroke="#1b1b1b" stroke-width="1.6" stroke-linecap="round"/>'
    );
  }

  private drawBeard(style: number, color: number): string {
    const c = colorToCss(color);
    const parts: string[] = [];
    switch (style % 7) {
      case 1:
        parts.push(`<path d="M40 59 Q50 64 60 59 L58 67 Q50 70 42 67 Z" fill="${c}"/>`);
        break;
      case 2:
        parts.push(`<path d="M42 58 Q50 62 58 58 L56 76 Q50 80 44 76 Z" fill="${c}"/>`);
        break;
      case 3:
        parts.push(`<path d="M38 57 Q50 63 62 57 L60 72 Q50 78 40 72 Z" fill="${c}"/>`);
        parts.push(`<path d="M44 60 L42 74 M56 60 L58 74" stroke="${colorToCss(shade(color, 0.2))}" stroke-width="1.5"/>`);
        break;
      case 4:
        parts.push(`<path d="M39 57 Q50 63 61 57 L57 82 Q50 88 43 82 Z" fill="${c}"/>`);
        break;
      case 5:
        parts.push(`<path d="M36 55 Q50 64 64 55 L62 88 Q50 95 38 88 Z" fill="${c}"/>`);
        break;
      case 6:
        parts.push(`<path d="M34 54 Q50 64 66 54 L68 90 L50 98 L32 90 Z" fill="${c}"/>`);
        break;
      default:
        break;
    }
    return parts.join('');
  }

  private drawOrnament(style: number, secondary: number, accent: number): string {
    const gold = colorToCss(secondary);
    const gem = colorToCss(accent);
    switch (style % 5) {
      case 1:
        return `<rect x="30" y="36" width="40" height="4" rx="2" fill="${gold}"/><circle cx="50" cy="38" r="3" fill="${gem}"/>`;
      case 2:
        return `<path d="M38 24 L44 14 L50 22 L56 14 L62 24 Z" fill="${gold}" stroke="${gem}" stroke-width="1"/>`;
      case 3:
        return `<path d="M70 30 Q82 26 86 40 Q78 36 70 40 Z" fill="${gold}"/><circle cx="76" cy="32" r="2" fill="${gem}"/>`;
      case 4:
        return `<path d="M26 22 L74 22 L70 18 L30 18 Z" fill="${gold}"/><rect x="44" y="14" width="12" height="6" rx="2" fill="${gem}"/>`;
      default:
        return '';
    }
  }

  private drawWeapon(type: string, style: number, accent: number, secondary: number): string {
    const metal = colorToCss(shade(secondary, -0.12));
    const grip = colorToCss(accent);
    const s = style % 4;
    if (type === 'bow') {
      return (
        `<path d="M83 28 Q95 50 83 76" fill="none" stroke="${grip}" stroke-width="3"/>` +
        `<path d="M83 28 L83 76" stroke="${metal}" stroke-width="1" opacity="0.8"/>`
      );
    }
    if (type === 'fan') {
      return (
        `<path d="M78 58 L88 34 Q96 48 88 62 Z" fill="${metal}" stroke="${grip}" stroke-width="1.5"/>` +
        `<path d="M78 58 L88 40 M82 58 L90 44" stroke="${grip}" stroke-width="1"/>`
      );
    }
    if (type === 'spear') {
      return (
        `<path d="M84 86 L84 26" stroke="${grip}" stroke-width="3"/>` +
        `<path d="M84 16 L88 28 L84 33 L80 28 Z" fill="${metal}"/>`
      );
    }
    if (type === 'blade' || type === 'saber') {
      const wide = type === 'blade' ? 6 + s : 4 + s;
      return (
        `<path d="M82 84 L82 52" stroke="${grip}" stroke-width="4"/>` +
        `<path d="M82 52 Q${82 + wide} 34 ${82 + wide} 20 L82 12 Q${82 - wide} 30 ${82 - wide} 48 Z" fill="${metal}" stroke="${grip}" stroke-width="1"/>`
      );
    }
    // sword 默认
    return (
      `<path d="M82 84 L82 54" stroke="${grip}" stroke-width="4"/>` +
      `<path d="M76 54 L88 54 M82 52 L82 18" stroke="${metal}" stroke-width="${3 + s}" stroke-linecap="round"/>` +
      `<circle cx="82" cy="56" r="2" fill="${grip}"/>`
    );
  }
}
