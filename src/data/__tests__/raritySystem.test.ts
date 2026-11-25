/**
 * 六档稀有度 / 装备命名 / 词缀分层回归（DESIGN §8.4）。
 *
 * 覆盖：白 → 蓝 → 黄 → 传奇 → 远古传说 → 太古传说的档位配置、
 * 传说以上固定名与白蓝黄结构化随机名，以及词缀 tier 与稀有度的对应关系。
 * 使用全局 describe / it / expect（vite.config.ts globals:true）。
 */
import { DROP_TABLE_DEFS } from '../combat';
import {
  EQUIPMENT_DEFS,
  equipmentName,
  findRarity,
  LEGENDARY_EFFECT_DEFS,
  RARITY_DEFS,
  SLOT_DEFS,
} from '../equipment';
import { AFFIX_POOL } from '../stats';
import type { RarityId } from '../types';

describe('六档稀有度配置', () => {
  it('顺序与名称冻结：白 / 蓝 / 黄 / 传奇 / 远古传说 / 太古传说', () => {
    expect(RARITY_DEFS.map((r) => r.id)).toEqual([
      'common', 'blue', 'gold', 'legendary', 'ancient', 'primal',
    ]);
    expect(RARITY_DEFS.map((r) => r.name)).toEqual([
      '白', '蓝', '黄', '传奇', '远古传说', '太古传说',
    ]);
    expect(RARITY_DEFS.map((r) => r.affixCount)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(RARITY_DEFS.map((r) => r.maxAffixTier)).toEqual([1, 2, 3, 4, 4, 4]);
    for (let i = 1; i < RARITY_DEFS.length; i++) {
      expect(RARITY_DEFS[i].coefficient).toBeGreaterThan(RARITY_DEFS[i - 1].coefficient);
    }
  });

  it('只有传说及以上使用固定名；白蓝黄名字由 uid 确定性生成', () => {
    for (let i = 0; i < EQUIPMENT_DEFS.length; i++) {
      const def = EQUIPMENT_DEFS[i];
      const rarity = findRarity(def.rarity);
      if (rarity.fixedName) expect(def.name, `${def.id} 应有固定名`).toBeTruthy();
      else expect(def.name, `${def.id} 不应写死名称`).toBeUndefined();
    }
    const named = EQUIPMENT_DEFS.filter((d) => d.rarity === 'legendary');
    expect(named.length).toBeGreaterThanOrEqual(LEGENDARY_EFFECT_DEFS.length);
    for (const effect of LEGENDARY_EFFECT_DEFS) {
      const legendary = EQUIPMENT_DEFS.find(
        (d) => d.rarity === 'legendary' && d.legendaryEffectId === effect.id,
      );
      expect(legendary?.name).toBe(effect.name);
    }
  });

  it('结构化随机名是槽位 + 材质 + 词缀主题，不作无意义拼接', () => {
    const def = EQUIPMENT_DEFS.find((d) => d.rarity === 'gold' && d.slot === 'chest');
    expect(def).toBeDefined();
    const slotName = SLOT_DEFS.find((s) => s.id === 'chest')!.name;
    const nameA = equipmentName(def, 'loot_1_2_3');
    const nameB = equipmentName(def, 'loot_1_2_4');
    expect(nameA).toBe(equipmentName(def, 'loot_1_2_3'));
    for (const name of [nameA, nameB]) {
      expect(name).toContain(slotName);
      expect(name).toMatch(/^(玄铁|虎纹|龙鳞|赤霄|苍狼)胸甲(·.+)?$/);
    }
    // 不同 uid 可产生不同名称，但不是随机字符。
    const names = new Set<string>();
    for (let i = 0; i < 40; i++) names.add(equipmentName(def, `loot_${i}`));
    expect(names.size).toBeGreaterThan(1);
  });

  it('固定名在远古/太古档沿用同一个传奇特效名', () => {
    const effect = LEGENDARY_EFFECT_DEFS[0];
    for (const rarity of ['legendary', 'ancient', 'primal'] as RarityId[]) {
      const def = EQUIPMENT_DEFS.find(
        (d) => d.rarity === rarity && d.legendaryEffectId === effect.id,
      );
      expect(def).toBeDefined();
      expect(equipmentName(def, `uid_${rarity}`)).toBe(effect.name);
    }
  });
});

describe('词缀分层与掉落入口', () => {
  it('每件装备的词缀数量与层级都不越过稀有度上限，且互不重复', () => {
    for (let i = 0; i < EQUIPMENT_DEFS.length; i++) {
      const def = EQUIPMENT_DEFS[i];
      const rarity = findRarity(def.rarity);
      expect(def.affixes.length, `${def.id} 词缀数`).toBe(rarity.affixCount);
      expect(new Set(def.affixes).size, `${def.id} 词缀不应重复`).toBe(def.affixes.length);
      for (const id of def.affixes) {
        const affix = AFFIX_POOL.find((a) => a.id === id);
        expect(affix, `${def.id} 引用了未知词缀 ${id}`).toBeDefined();
        expect(affix!.tier, `${def.id} 词缀 ${id} 越级`).toBeLessThanOrEqual(rarity.maxAffixTier);
      }
    }
  });

  it('高阶专属词缀只出现在传奇及以上', () => {
    const highTierIds = AFFIX_POOL.filter((a) => a.tier === 4).map((a) => a.id);
    expect(highTierIds.length).toBeGreaterThan(0);
    for (const def of EQUIPMENT_DEFS) {
      if (findRarity(def.rarity).fixedName) continue;
      for (const id of def.affixes) expect(highTierIds).not.toContain(id);
    }
    expect(
      EQUIPMENT_DEFS.some((d) => d.rarity === 'primal' && d.affixes.some((a) => highTierIds.includes(a))),
    ).toBe(true);
  });

  it('精英与 BOSS 掉落表包含远古/太古条目且权重递减', () => {
    for (const tableId of ['drop_elite', 'drop_boss']) {
      const table = DROP_TABLE_DEFS.find((t) => t.id === tableId);
      expect(table).toBeDefined();
      const weights = new Map<string, number>();
      for (const entry of table!.entries) weights.set(entry.itemId, entry.weight);
      expect(weights.get('equipment_legendary')).toBeGreaterThan(0);
      expect(weights.get('equipment_ancient')).toBeGreaterThan(0);
      expect(weights.get('equipment_primal')).toBeGreaterThan(0);
      expect(weights.get('equipment_legendary')!).toBeGreaterThan(weights.get('equipment_ancient')!);
      expect(weights.get('equipment_ancient')!).toBeGreaterThan(weights.get('equipment_primal')!);
    }
  });
});
