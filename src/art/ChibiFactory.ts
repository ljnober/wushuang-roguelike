/**
 * 战场小人 / 弹幕 / 掉落 / 特效纹理（DESIGN §9）。
 *
 * 复用 Palette 与 GeneralArtParams，Graphics v8 绘制 → generateTexture 缓存；
 * 所有纹理程序化生成，不读取任何外部图片资源。
 */
import { Container, Graphics, Texture } from 'pixi.js';
import type { GameConfig, GeneralArtParams, GeneralDef } from '../data/types';
import type { PixiPools } from '../engine/PixiPools';
import type { Renderer } from '../engine/Renderer';
import type { TextureFactory } from '../engine/TextureFactory';
import { enemyArt, shade } from './Palette';

export const BULLET_KEY = 'bullet:generic';
export const PICKUP_KEYS = {
  exp: 'pickup:exp',
  hp: 'pickup:hp',
  gold: 'pickup:gold',
  equip: 'pickup:equip',
} as const;
export const EFFECT_KEYS = {
  slash: 'effect:slash',
  hit: 'effect:hit',
  warn: 'effect:warn',
  levelup: 'effect:levelup',
} as const;

export class ChibiFactory {
  constructor(
    private readonly renderer: Renderer,
    private readonly textures: TextureFactory,
    private readonly pools: PixiPools | null = null,
  ) {}

  private register(key: string, texture: Texture): Texture {
    if (this.pools !== null) this.pools.registerTexture(key, texture);
    return texture;
  }

  /** 40 将 + 兵种 + 弹幕/掉落/特效纹理一次性生成并注册。 */
  ensureAll(config: GameConfig): number {
    let count = 0;
    const generals = config.generals.all();
    for (let i = 0; i < generals.length; i++) {
      this.general(generals[i]);
      count++;
    }
    this.player();
    count++;
    const kinds = ['melee', 'ranged', 'cavalry', 'elite', 'bossMinion', 'boss'] as const;
    for (let i = 0; i < kinds.length; i++) {
      this.enemy(kinds[i]);
      count++;
    }
    this.bullet();
    this.pickups();
    this.effects();
    count += 1 + 4 + 4;
    return count;
  }

  player(): Texture {
    const key = 'chibi:player';
    if (this.textures.has(key)) return this.register(key, this.textures.peek(key)!);
    const art: GeneralArtParams = {
      colors: { primary: 0x2e8b57, secondary: 0xf5d76e, accent: 0xb3352b, skin: 0xffd8b1 },
      hair: { style: 2, ornament: 1, color: 0x151515 },
      beard: { style: 0, color: 0x151515 },
      weapon: { type: 'sword', style: 1 },
      pattern: { id: 1, scale: 1, rotation: 0 },
    };
    const texture = this.textures.get(key, (g) => this.drawChibi(g, art));
    return this.register(key, texture);
  }

  general(def: GeneralDef): Texture {
    const key = `chibi:${def.id}`;
    if (this.textures.has(key)) return this.register(key, this.textures.peek(key)!);
    const texture = this.textures.get(key, (g) => this.drawChibi(g, def.art));
    return this.register(key, texture);
  }

  enemy(kind: 'melee' | 'ranged' | 'cavalry' | 'elite' | 'bossMinion' | 'boss'): Texture {
    const key = `chibi:${kind}`;
    if (this.textures.has(key)) return this.register(key, this.textures.peek(key)!);
    const art = enemyArt(kind);
    const texture = this.textures.get(key, (g) => this.drawChibi(g, art));
    return this.register(key, texture);
  }

  bullet(): Texture {
    if (this.textures.has(BULLET_KEY)) return this.register(BULLET_KEY, this.textures.peek(BULLET_KEY)!);
    const texture = this.textures.get(BULLET_KEY, (g) => {
      g.circle(8, 8, 7).fill({ color: 0xffe9a8, alpha: 0.95 });
      g.circle(8, 8, 4).fill(0xffb52e);
    });
    return this.register(BULLET_KEY, texture);
  }

  pickups(): void {
    const defs: Array<[string, number, string]> = [
      [PICKUP_KEYS.exp, 0x49c1ff, 'circle'],
      [PICKUP_KEYS.hp, 0xe25046, 'cross'],
      [PICKUP_KEYS.gold, 0xf3c744, 'diamond'],
      [PICKUP_KEYS.equip, 0xb98cff, 'square'],
    ];
    for (let i = 0; i < defs.length; i++) {
      const [key, color, shape] = defs[i];
      if (this.textures.has(key)) {
        this.register(key, this.textures.peek(key)!);
        continue;
      }
      const texture = this.textures.get(key, (g) => {
        if (shape === 'cross') {
          g.rect(6, 2, 4, 12).fill(color);
          g.rect(2, 6, 12, 4).fill(color);
        } else if (shape === 'diamond') {
          g.poly([8, 1, 15, 8, 8, 15, 1, 8]).fill(color);
        } else if (shape === 'square') {
          g.roundRect(2, 2, 12, 12, 3).fill(color);
        } else {
          g.circle(8, 8, 7).fill(color);
          g.circle(6, 6, 2).fill({ color: 0xffffff, alpha: 0.8 });
        }
      });
      this.register(key, texture);
    }
  }

  effects(): void {
    const defs: Array<[string, number]> = [
      [EFFECT_KEYS.slash, 0xfff1c0],
      [EFFECT_KEYS.hit, 0xff7b5c],
      [EFFECT_KEYS.warn, 0xff3b30],
      [EFFECT_KEYS.levelup, 0x8ce8ff],
    ];
    for (let i = 0; i < defs.length; i++) {
      const [key, color] = defs[i];
      if (this.textures.has(key)) {
        this.register(key, this.textures.peek(key)!);
        continue;
      }
      const texture = this.textures.get(key, (g) => {
        g.circle(16, 16, 15).fill({ color, alpha: 0.12 });
        g.circle(16, 16, 10).fill({ color, alpha: 0.28 });
        g.circle(16, 16, 5).fill({ color, alpha: 0.85 });
      });
      this.register(key, texture);
    }
  }

  /** 单个战场小人：头/身/武器/纹样均由参数驱动。 */
  private drawChibi(g: Graphics, art: GeneralArtParams): void {
    const { colors, hair, beard, weapon, pattern } = art;
    const outline = shade(colors.primary, -0.5);

    // 地面阴影
    g.ellipse(16, 39, 12, 3).fill({ color: 0x000000, alpha: 0.32 });

    // 腿 / 靴
    g.roundRect(9, 28, 6, 10, 2).fill(shade(colors.primary, -0.35));
    g.roundRect(18, 28, 6, 10, 2).fill(shade(colors.primary, -0.35));
    g.roundRect(8, 35, 7, 4, 2).fill(0x2a1d12);
    g.roundRect(18, 35, 7, 4, 2).fill(0x2a1d12);

    // 身体 / 铠甲
    g.roundRect(7, 17, 19, 14, 5).fill(colors.primary);
    g.roundRect(9, 18, 15, 6, 3).fill(colors.secondary);
    g.rect(15, 18, 3, 12).fill(colors.accent);
    // 纹样：斜纹 / 点阵 / 横纹
    if (pattern.id % 3 === 0) {
      for (let i = 0; i < 3; i++) {
        g.moveTo(9 + i * 5, 27).lineTo(13 + i * 5, 21).stroke({ width: 1.2, color: colors.secondary });
      }
    } else if (pattern.id % 3 === 1) {
      g.circle(12, 25, 1.2).fill(colors.secondary);
      g.circle(20, 25, 1.2).fill(colors.secondary);
    } else {
      g.moveTo(10, 27).lineTo(23, 27).stroke({ width: 1.2, color: colors.secondary });
    }

    // 手臂
    g.roundRect(4, 19, 5, 10, 2).fill(shade(colors.primary, -0.15));
    g.roundRect(25, 19, 5, 10, 2).fill(shade(colors.primary, -0.15));

    // 头
    g.circle(16, 11, 9).fill(colors.skin);
    g.circle(16, 11, 9).stroke({ width: 1, color: shade(colors.skin, -0.3) });
    g.circle(13, 11, 1).fill(0x181818);
    g.circle(19, 11, 1).fill(0x181818);

    // 发型
    const hairStyle = hair.style % 7;
    if (hairStyle === 1 || hairStyle === 4) {
      g.circle(16, 3, 3.5).fill(hair.color);
    }
    if (hairStyle === 5) {
      g.moveTo(9, 8).lineTo(7, 18).stroke({ width: 2.5, color: hair.color });
      g.moveTo(23, 8).lineTo(25, 18).stroke({ width: 2.5, color: hair.color });
    }
    g.moveTo(7, 9).quadraticCurveTo(16, -1, 25, 9).lineTo(22, 5).lineTo(10, 5).closePath().fill(hair.color);
    if (hair.ornament > 0) {
      g.rect(8, 6, 16, 2).fill(colors.secondary);
      if (hair.ornament === 2) g.circle(16, 6, 2).fill(colors.accent);
    }

    // 胡须
    if (beard.style > 0) {
      const length = 3 + Math.min(beard.style, 5);
      g.roundRect(12, 17, 8, length, 2).fill(beard.color);
    }

    // 武器（沿右侧）
    this.drawWeapon(g, weapon.type, weapon.style % 4, colors.accent, colors.secondary, outline);
  }

  private drawWeapon(
    g: Graphics,
    type: string,
    style: number,
    grip: number,
    metal: number,
    outline: number,
  ): void {
    if (type === 'bow') {
      g.moveTo(29, 8).quadraticCurveTo(36, 20, 29, 32).stroke({ width: 2, color: grip });
      g.moveTo(29, 8).lineTo(29, 32).stroke({ width: 1, color: metal });
      return;
    }
    if (type === 'fan') {
      g.poly([28, 20, 34, 12, 37, 22]).fill(metal);
      g.moveTo(28, 20).lineTo(34, 12).stroke({ width: 1, color: outline });
      return;
    }
    if (type === 'spear') {
      g.moveTo(31, 36).lineTo(31, 5).stroke({ width: 2.5, color: grip });
      g.poly([31, 1, 34, 7, 31, 10, 28, 7]).fill(metal);
      return;
    }
    const bladeWidth = type === 'blade' ? 4 + style : 2 + style;
    g.roundRect(29, 22, 3, 14, 1).fill(grip);
    g.moveTo(30, 22)
      .lineTo(30 + bladeWidth, 10)
      .lineTo(30, 4)
      .lineTo(30 - bladeWidth, 10)
      .closePath()
      .fill(metal);
    g.moveTo(30, 22).lineTo(30, 4).stroke({ width: 1, color: outline });
  }

  /** 供无 GPU 时使用的空操作容器，确保 PixiPools 仍能拿到 Texture.WHITE。 */
  static fallbackContainer(): Container {
    return new Container();
  }
}
