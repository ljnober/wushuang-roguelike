/**
 * QA1 内容完整性独立验证（DESIGN.md §8 / §12 P2/P6、PRD 验收 P2/P6）。
 *
 * 覆盖：40 将、13 槽、4 套装、≥12 传奇特效、6 传说宝石、8 BOSS、6 阶段波次、
 * 普通宝石 4×5、双模式与 Registry 引用完整性。
 *
 * 本环境使用 vite.config.ts 的 globals:true，直接用全局 describe / it / expect。
 */
import { buildGameConfig } from '../index';
import { BOSS_DEFS, MODE_DEFS, WAVE_STAGES } from '../combat';
import {
  CUBE_RECIPE_DEFS,
  LEGENDARY_EFFECT_DEFS,
  LEGENDARY_GEM_DEFS,
  MATERIAL_DEFS,
  SET_DEFS,
  SLOT_DEFS,
} from '../equipment';
import { GENERAL_DEFS } from '../generals';
import { AFFIX_POOL, SOURCE_PRIORITY } from '../stats';
import type { GameConfig } from '../types';

function config(): GameConfig {
  return buildGameConfig();
}

describe('内容完整性：注册表与武将', () => {
  it('40 位武将全部可选，字段完整且技能引用有效', () => {
    const cfg = config();
    expect(GENERAL_DEFS).toHaveLength(40);
    expect(cfg.generals.all()).toHaveLength(40);
    expect(new Set(GENERAL_DEFS.map((g) => g.id)).size).toBe(40);
    expect(new Set(GENERAL_DEFS.map((g) => g.name)).size).toBe(40);

    for (const general of GENERAL_DEFS) {
      expect(general.title.length).toBeGreaterThan(0);
      expect(['shu', 'wei', 'wu', 'qun']).toContain(general.faction);
      expect(general.art.colors.primary).toBeGreaterThanOrEqual(0);
      expect(general.art.hair.style).toBeGreaterThanOrEqual(0);
      expect(general.baseStats.hp).toBeGreaterThan(0);
      expect(general.baseStats.atk).toBeGreaterThan(0);
      expect(general.skills.length).toBeGreaterThan(0);
      for (const skillId of general.skills) {
        expect(cfg.skills.has(skillId)).toBe(true);
      }
    }
    expect(cfg.generals.validate()).toEqual([]);
  });

  it('所有 Registry 通过 validate() 且 id 无重复', () => {
    const cfg = config();
    const registries = [
      cfg.generals, cfg.enemies, cfg.skills, cfg.effects, cfg.equipment,
      cfg.bosses, cfg.gems, cfg.legendaryGems, cfg.cube, cfg.stats,
      cfg.modes, cfg.drops,
    ];
    for (const registry of registries) {
      expect(registry.all().length).toBeGreaterThan(0);
      expect(registry.validate()).toEqual([]);
      expect(new Set(registry.ids()).size).toBe(registry.all().length);
    }
    expect(SOURCE_PRIORITY.length).toBeGreaterThanOrEqual(9);
  });
});

describe('内容完整性：装备 13 槽 / 4 套 / 传奇特效', () => {
  it('13 槽恰好为 8 防具 + 3 首饰 + 2 武器', () => {
    expect(SLOT_DEFS).toHaveLength(13);
    const armor = SLOT_DEFS.filter((s) => s.category === 'armor').map((s) => s.id);
    const jewelry = SLOT_DEFS.filter((s) => s.category === 'jewelry').map((s) => s.id);
    const weapon = SLOT_DEFS.filter((s) => s.category === 'weapon').map((s) => s.id);
    expect(armor).toEqual([
      'head', 'shoulders', 'chest', 'bracers', 'gloves', 'belt', 'legs', 'boots',
    ]);
    expect(jewelry).toEqual(['amulet', 'ring1', 'ring2']);
    expect(weapon).toEqual(['mainHand', 'offHand']);
    expect(SLOT_DEFS.filter((s) => s.legendaryGemAllowed).map((s) => s.id)).toEqual(jewelry);
  });

  it('4 套装备各含 2 件与 4 件效果，且引用已注册属性', () => {
    const cfg = config();
    expect(SET_DEFS).toHaveLength(4);
    for (const set of SET_DEFS) {
      expect(set.twoPiece.length).toBeGreaterThan(0);
      expect(set.fourPiece.length).toBeGreaterThan(0);
      for (const slot of set.slots) {
        expect(SLOT_DEFS.some((def) => def.id === slot)).toBe(true);
      }
      for (const mod of [...set.twoPiece, ...set.fourPiece]) {
        expect(cfg.stats.has(mod.stat)).toBe(true);
      }
    }
  });

  it('传奇特效 ≥12 个，每个含 modifiers、slotType 与技能标签', () => {
    const cfg = config();
    expect(LEGENDARY_EFFECT_DEFS.length).toBeGreaterThanOrEqual(12);
    const ids = new Set<string>();
    for (const effect of LEGENDARY_EFFECT_DEFS) {
      expect(ids.has(effect.id)).toBe(false);
      ids.add(effect.id);
      expect(effect.name.length).toBeGreaterThan(0);
      expect(['weapon', 'armor', 'jewelry', 'any']).toContain(effect.slotType);
      expect(effect.modifiers.length).toBeGreaterThan(0);
      for (const mod of effect.modifiers) {
        expect(cfg.stats.has(mod.stat)).toBe(true);
      }
    }
    expect(AFFIX_POOL.length).toBe(10);
  });
});

describe('内容完整性：宝石 / 魔盒 / 传说宝石', () => {
  it('普通宝石 4 类 × T1..T5 共 20 项', () => {
    const cfg = config();
    expect(cfg.gems.all()).toHaveLength(20);
    const kinds = new Set(cfg.gems.all().map((g) => g.kind));
    expect([...kinds].sort()).toEqual(['blue', 'green', 'red', 'yellow']);
    for (const gem of cfg.gems.all()) {
      expect(gem.tier).toBeGreaterThanOrEqual(1);
      expect(gem.tier).toBeLessThanOrEqual(5);
      expect(cfg.stats.has(gem.stat)).toBe(true);
    }
  });

  it('6 颗传说宝石，成功率 / 保底 / 材料软上限符合设计公式', () => {
    const cfg = config();
    expect(LEGENDARY_GEM_DEFS).toHaveLength(6);
    expect(cfg.legendaryGems.all()).toHaveLength(6);
    for (const gem of LEGENDARY_GEM_DEFS) {
      expect(cfg.stats.has(gem.stat)).toBe(true);
      expect(gem.rateBase).toBeCloseTo(0.9, 6);
      expect(gem.ratePerLevel).toBeCloseTo(0.05, 6);
      expect(gem.rateMin).toBeCloseTo(0.15, 6);
      expect(gem.pityBonus).toBeCloseTo(0.05, 6);
      // level=0 → 0.9；level≥15 触底 0.15；失败 1 次 +5%。
      expect(gemUpgradeRate(0, 0, gem)).toBeCloseTo(0.9, 6);
      expect(gemUpgradeRate(20, 0, gem)).toBeCloseTo(0.15, 6);
      expect(gemUpgradeRate(20, 1, gem)).toBeCloseTo(0.2, 6);
      expect(gemUpgradeCost(1000, gem)).toBeLessThanOrEqual(gem.materialSoftCap);
    }
  });

  it('魔盒三功能配方与三种材料齐备', () => {
    expect(CUBE_RECIPE_DEFS.map((r) => r.function).sort()).toEqual(['extract', 'reroll', 'upgrade']);
    expect(MATERIAL_DEFS.map((m) => m.id).sort()).toEqual(['bossToken', 'essence', 'soul']);
    for (const recipe of CUBE_RECIPE_DEFS) {
      expect(Object.keys(recipe.cost).length).toBeGreaterThan(0);
      for (const material of Object.keys(recipe.cost)) {
        expect(MATERIAL_DEFS.some((m) => m.id === material)).toBe(true);
      }
    }
  });
});

/** 与 equipment.ts 的公式保持一致（测试侧独立重算，避免直接复用被测函数形成同义反复）。 */
function gemUpgradeRate(level: number, pity: number, gem: (typeof LEGENDARY_GEM_DEFS)[number]): number {
  const base = Math.max(gem.rateMin, gem.rateBase - level * gem.ratePerLevel);
  return Math.min(1, base + Math.max(0, pity) * gem.pityBonus);
}

function gemUpgradeCost(level: number, gem: (typeof LEGENDARY_GEM_DEFS)[number]): number {
  return Math.min(gem.materialSoftCap, gem.materialBase + level * Math.ceil(gem.materialBase / 2));
}

describe('内容完整性：BOSS / 波次 / 模式', () => {
  it('8 位名将 BOSS，每位 3 阶段且技能均带预警 / 模式 / 应对', () => {
    const cfg = config();
    expect(BOSS_DEFS).toHaveLength(8);
    expect(cfg.bosses.all()).toHaveLength(8);
    for (const boss of BOSS_DEFS) {
      expect(boss.phases).toHaveLength(3);
      const thresholds: number[] = [];
      for (const phase of boss.phases) {
        thresholds.push(phase.hpThreshold);
        expect(phase.skills.length).toBeGreaterThan(0);
        for (const skill of phase.skills) {
          expect(skill.telegraph).toBeGreaterThan(0);
          expect(skill.pattern.length).toBeGreaterThan(0);
          expect(skill.counter.length).toBeGreaterThan(0);
        }
      }
      expect(thresholds[0]).toBe(1);
      expect(thresholds[1]).toBeGreaterThan(thresholds[2]);
    }
  });

  it('6 阶段波次时间轴连续、cap 固定且不超过设计上限', () => {
    expect(WAVE_STAGES).toHaveLength(6);
    let previousEnd = 0;
    let maxCap = 0;
    for (const wave of WAVE_STAGES) {
      expect(wave.startSec).toBe(previousEnd);
      expect(wave.endSec).toBeGreaterThan(wave.startSec);
      expect(wave.spawnRateEnd).toBeGreaterThanOrEqual(wave.spawnRateStart);
      expect(wave.enemies.length).toBeGreaterThan(0);
      for (const at of wave.elitesAt) {
        expect(at).toBeGreaterThanOrEqual(wave.startSec);
        expect(at).toBeLessThanOrEqual(wave.endSec);
      }
      maxCap = Math.max(maxCap, wave.cap);
      previousEnd = wave.endSec;
    }
    expect(previousEnd).toBe(480);
    expect(maxCap).toBe(300);
  });

  it('双模式齐备，无尽模式参数与首胜解锁标记正确', () => {
    expect(MODE_DEFS).toHaveLength(2);
    const campaign = MODE_DEFS.find((m) => m.id === 'campaign_8min');
    const endless = MODE_DEFS.find((m) => m.id === 'endless');
    expect(campaign).toBeDefined();
    expect(endless).toBeDefined();
    expect(campaign!.durationSec).toBe(480);
    expect(campaign!.bossAtSec).toBe(420);
    expect(campaign!.unlockAfterFirstBoss).toBe(false);
    expect(endless!.unlockAfterFirstBoss).toBe(true);
    expect(endless!.endless?.spawnCap).toBe(40);
    expect(endless!.endless?.bossEverySec).toBe(300);
  });
});
