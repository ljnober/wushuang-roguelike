/**
 * 程序化装备图标工厂回归（PRD_UI_REFACTOR §8.2 A-14 确定性 / US-04-6 脏数据容错）。
 *
 * 注意：本环境禁止 `import { describe } from 'vitest'`（第二份 runner 会破坏 runner.config），
 * vite.config.ts 已开启 globals:true，直接使用全局 describe / it / expect。
 */
import { SLOT_DEFS } from '../../data/equipment';
import type { RarityId } from '../../data/types';
import { EquipmentIconFactory, EQUIPMENT_SLOT_IDS } from '../EquipmentIconFactory';

const RARITIES: readonly RarityId[] = ['common', 'blue', 'gold', 'legendary'];

function newFactory(): EquipmentIconFactory {
  return new EquipmentIconFactory();
}

describe('装备图标工厂：13 槽 × 4 稀有度全覆盖', () => {
  it('槽位清单与 SLOT_DEFS 一致（13 个）', () => {
    expect(EQUIPMENT_SLOT_IDS).toHaveLength(13);
    expect([...EQUIPMENT_SLOT_IDS].sort()).toEqual(
      SLOT_DEFS.map((def) => def.id).sort(),
    );
  });

  it('52 种组合均产出格式正确的非空 data URL', () => {
    const factory = newFactory();
    let count = 0;
    for (const slot of EQUIPMENT_SLOT_IDS) {
      for (const rarity of RARITIES) {
        const url = factory.dataUrlFor(slot, rarity);
        expect(url.length).toBeGreaterThan(0);
        expect(url.startsWith('data:image/svg+xml')).toBe(true);
        expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
        // 解码后必须是完整 SVG 文档
        const decoded = decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length));
        expect(decoded.startsWith('<svg')).toBe(true);
        expect(decoded.endsWith('</svg>')).toBe(true);
        count += 1;
      }
    }
    expect(count).toBe(52);
  });
});

describe('A-14 确定性', () => {
  it('同一 (slot, rarity) 连续调用 3 次 dataUrlFor，结果逐字节相同', () => {
    const factory = newFactory();
    for (const slot of EQUIPMENT_SLOT_IDS) {
      for (const rarity of RARITIES) {
        const a = factory.dataUrlFor(slot, rarity);
        const b = factory.dataUrlFor(slot, rarity);
        const c = factory.dataUrlFor(slot, rarity);
        expect(b).toBe(a);
        expect(c).toBe(a);
      }
    }
  });

  it('清空缓存后再次调用，结果仍与之前逐字节相同', () => {
    const factory = newFactory();
    const before = new Map<string, string>();
    for (const slot of EQUIPMENT_SLOT_IDS) {
      for (const rarity of RARITIES) {
        before.set(`${slot}|${rarity}`, factory.dataUrlFor(slot, rarity));
      }
    }
    factory.clear();
    expect(factory.size).toBe(0);
    for (const slot of EQUIPMENT_SLOT_IDS) {
      for (const rarity of RARITIES) {
        expect(factory.dataUrlFor(slot, rarity)).toBe(before.get(`${slot}|${rarity}`));
      }
    }
  });

  it('独立实例之间同参结果一致（无隐藏全局状态）', () => {
    const a = newFactory();
    const b = newFactory();
    expect(b.dataUrlFor('head', 'legendary')).toBe(a.dataUrlFor('head', 'legendary'));
    expect(b.dataUrlFor('mainHand', 'gold')).toBe(a.dataUrlFor('mainHand', 'gold'));
  });

  it('svgFor 同样确定，且与 dataUrlFor 内容一致', () => {
    const factory = newFactory();
    const svg = factory.svgFor('chest', 'gold');
    expect(svg).toBe(factory.svgFor('chest', 'gold'));
    const url = factory.dataUrlFor('chest', 'gold');
    expect(url).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  });
});

describe('形态区分度', () => {
  it('13 个槽位的 SVG 互不相同', () => {
    const factory = newFactory();
    const svgs = EQUIPMENT_SLOT_IDS.map((slot) => factory.svgFor(slot, 'common'));
    expect(new Set(svgs).size).toBe(13);
  });

  it('同一槽位的 4 档稀有度 SVG 互不相同', () => {
    const factory = newFactory();
    for (const slot of EQUIPMENT_SLOT_IDS) {
      const svgs = RARITIES.map((rarity) => factory.svgFor(slot, rarity));
      expect(new Set(svgs).size).toBe(4);
    }
  });

  it('稀有度差异体现在边框/辉光/角标上，而非把本体整体染色', () => {
    const factory = newFactory();
    const common = factory.svgFor('head', 'common');
    const blue = factory.svgFor('head', 'blue');
    const gold = factory.svgFor('head', 'gold');
    const legendary = factory.svgFor('head', 'legendary');
    // common 无辉光滤镜，blue/gold/legendary 有
    expect(common).not.toContain('filter=');
    expect(blue).toContain('filter=');
    expect(gold).toContain('filter=');
    expect(legendary).toContain('filter=');
    // legendary 额外符文角标
    expect(legendary).toContain('Z" fill="#ff9d3f"');
    expect(gold).not.toContain('Z" fill="#ff9d3f"');
    // 本体金属色保持一致（稀有度不侵入主体）
    for (const svg of [common, blue, gold, legendary]) {
      expect(svg).toContain('rgb(154,162,172)');
    }
  });
});

describe('SVG 结构契约', () => {
  it('svgFor 返回以 <svg 开头、含统一 viewBox', () => {
    const factory = newFactory();
    for (const slot of EQUIPMENT_SLOT_IDS) {
      for (const rarity of RARITIES) {
        const svg = factory.svgFor(slot, rarity);
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg).toContain('viewBox="0 0 64 64"');
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      }
    }
  });

  it('不含 Math.random / 墙钟痕迹', () => {
    const factory = newFactory();
    for (const slot of EQUIPMENT_SLOT_IDS) {
      for (const rarity of RARITIES) {
        const svg = factory.svgFor(slot, rarity);
        expect(svg).not.toMatch(/Math\.random/);
        expect(svg).not.toMatch(/Date\.now/);
        expect(svg).not.toMatch(/performance\.now/);
      }
    }
  });

  it('内部 defs id 唯一（多张内联时不互相污染）', () => {
    const factory = newFactory();
    const ids = new Set<string>();
    for (const slot of EQUIPMENT_SLOT_IDS) {
      for (const rarity of RARITIES) {
        const svg = factory.svgFor(slot, rarity);
        const matches = svg.match(/id="([^"]+)"/g) ?? [];
        for (const raw of matches) {
          const id = raw.slice(4, -1);
          expect(ids.has(id)).toBe(false);
          ids.add(id);
        }
      }
    }
  });
});

describe('空槽占位图标', () => {
  it('产出灰度占位 data URL，且与该槽位已装备图不同', () => {
    const factory = newFactory();
    for (const slot of EQUIPMENT_SLOT_IDS) {
      const placeholder = factory.placeholderDataUrlFor(slot);
      expect(placeholder.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
      const decoded = decodeURIComponent(
        placeholder.slice('data:image/svg+xml;charset=utf-8,'.length),
      );
      expect(decoded.startsWith('<svg')).toBe(true);
      // 虚线感轮廓
      expect(decoded).toContain('stroke-dasharray');
      // 灰度：不含彩色金属 rgb(154,162,172)
      expect(decoded).not.toContain('rgb(154,162,172)');
      // 与已装备图不同
      expect(placeholder).not.toBe(factory.dataUrlFor(slot, 'common'));
      expect(placeholder).not.toBe(factory.dataUrlFor(slot, 'legendary'));
    }
  });

  it('占位图同样确定性且被缓存', () => {
    const factory = newFactory();
    const a = factory.placeholderDataUrlFor('ring1');
    const b = factory.placeholderDataUrlFor('ring1');
    expect(b).toBe(a);
    expect(factory.size).toBeGreaterThan(0);
  });
});

describe('缓存行为', () => {
  it('缓存生效：size 随唯一 (slot, rarity) 组合递增', () => {
    const factory = newFactory();
    expect(factory.size).toBe(0);
    factory.dataUrlFor('head', 'common');
    expect(factory.size).toBe(1);
    factory.dataUrlFor('head', 'common');
    expect(factory.size).toBe(1);
    factory.dataUrlFor('head', 'blue');
    expect(factory.size).toBe(2);
    factory.dataUrlFor('shoulders', 'common');
    expect(factory.size).toBe(3);
    factory.clear();
    expect(factory.size).toBe(0);
  });
});

describe('脏数据容错（PRD US-04-6）', () => {
  it('非法槽位 id 不抛异常，返回兜底图标', () => {
    const factory = newFactory();
    let url = '';
    expect(() => {
      url = factory.dataUrlFor('not-a-slot', 'common');
    }).not.toThrow();
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    expect(url.length).toBeGreaterThan(0);
  });

  it('非法槽位的 svgFor / placeholderDataUrlFor 同样不抛异常', () => {
    const factory = newFactory();
    expect(() => factory.svgFor('', 'gold')).not.toThrow();
    expect(() => factory.placeholderDataUrlFor('__nope__')).not.toThrow();
    expect(factory.svgFor('', 'gold').startsWith('<svg')).toBe(true);
    expect(factory.placeholderDataUrlFor('__nope__').startsWith('data:image/svg+xml')).toBe(true);
  });

  it('非法稀有度退化为 common 而不抛异常', () => {
    const factory = newFactory();
    let url = '';
    expect(() => {
      url = factory.dataUrlFor('head', 'mythic' as RarityId);
    }).not.toThrow();
    expect(url).toBe(factory.dataUrlFor('head', 'common'));
  });

  it('非法槽位得到的兜底图标彼此不同（不共用一张图）', () => {
    const factory = newFactory();
    const a = factory.dataUrlFor('bad-slot-a', 'common');
    const b = factory.dataUrlFor('bad-slot-b', 'common');
    expect(a).not.toBe(b);
  });
});
