/**
 * 局内成长闭环回归：掉落 → 自动装备 → 属性即时生效 → 宝石镶嵌 → 技能升级。
 * 只使用全局 describe / it / expect（vite.config.ts globals:true）。
 */
import { EXP_CURVE } from '../../core/Constants';
import { add, query } from '../../ecs/bit/adapter';
import { Dead, Health, Pickup, PlayerTag, Position, StatBlock } from '../../ecs/bit/components';
import { getSimTick, registerSimSystem, resetScheduler, stepTick } from '../../ecs/scheduler';
import { createBattleState, createBattleSystems } from '../../registration/systems';
import { findRarity, SLOT_DEFS } from '../../data/equipment';
import { AFFIX_POOL } from '../../data/stats';
import type { EquipmentItem, GemItem } from '../SaveData';
import {
  affixValueOf,
  collectRunLoot,
  getBag,
  getEquipped,
  getGemBag,
  getSkillLevel,
  grantLoot,
  levelUpSkill,
  makeDroppedEquipment,
  makeDroppedGem,
  resetRunLoot,
} from '../RunLoot';
import {
  getLevelChoices,
  getPlayerLevel,
  PICKUP_EQUIPMENT,
  PICKUP_EXP,
} from '../../ecs/systems/ProgressionSystems';
import { levelSkillSlotDamage } from '../../ecs/systems/EffectSystems';
import { battleSession, spawnCombatEntity, spawnPickup } from '../../ecs/systems/LifecycleSystems';
import type { SimState } from '../../ecs/scheduler';

function makeRig(): { state: SimState; player: number } {
  resetScheduler();
  const state = createBattleState({ seed: 0x1234abcd });
  const systems = createBattleSystems(state);
  for (let i = 0; i < systems.length; i++) {
    registerSimSystem(systems[i].order, systems[i].fn, systems[i].id);
  }
  stepTick(state, 1);
  const players = query(state.world, [PlayerTag]);
  return { state, player: players[0] as number };
}

function blockValue(state: SimState, eid: number, id: string): number {
  const arr = (StatBlock as unknown as Record<string, Float32Array | undefined>)[id];
  return arr === undefined ? 0 : arr[eid];
}

describe('局内战利品：掉落、装备、宝石', () => {
  it('同 seed/eid 掉落逐字段一致，且 cfgId 指向正确配置', () => {
    resetRunLoot();
    const { state } = makeRig();
    const defs = state.config.equipment.all();
    const idx = defs.findIndex((d) => d.rarity === 'gold');
    expect(idx).toBeGreaterThanOrEqual(0);
    const a = makeDroppedEquipment(state, idx + 1, 0x55, 42, battleSession(state).roomSeed);
    const b = makeDroppedEquipment(state, idx + 1, 0x55, 42, battleSession(state).roomSeed);
    expect(a).toEqual(b);
    expect(a?.defId).toBe(defs[idx].id);
    expect(makeDroppedEquipment(state, 0, 1, 1, 1)).toBeNull();
  });

  it('精英死亡按掉落表产出装备拾取物', () => {
    resetRunLoot();
    const { state } = makeRig();
    let equipmentDrops = 0;
    for (let i = 0; i < 80; i++) {
      const elite = spawnCombatEntity(state, {
        enemyId: 'huangjin', x: 0, y: 0, faction: 1, elite: true,
      });
      Health.cur[elite] = 0;
      add(state.world, elite, Dead);
      stepTick(state, getSimTick() + 1);
      const pickups = query(state.world, [Pickup]);
      for (let k = 0; k < pickups.length; k++) {
        if (Pickup.kind[pickups[k]] === PICKUP_EQUIPMENT) equipmentDrops++;
      }
      // 拾取物生成在玩家身边，可能当 tick 就被 PickupSystem 收走，战利品袋同样算数。
      equipmentDrops += collectRunLoot(0).equipment.length;
      for (let k = 0; k < pickups.length; k++) state.pool.entities.release(pickups[k]);
    }
    expect(equipmentDrops).toBeGreaterThan(0);
  });

  it('拾取装备自动穿戴，词缀与攻击加成在下一 tick 生效', () => {
    resetRunLoot();
    const { state, player } = makeRig();
    const defs = state.config.equipment.all();
    const idx = defs.findIndex((d) => d.rarity === 'legendary' && d.affixes.some((a) => a === 'affix_atk'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const beforeAtk = blockValue(state, player, 'atk');
    const beforeDmg = blockValue(state, player, 'damage');
    const item = makeDroppedEquipment(state, idx + 1, 0x77, 99, battleSession(state).roomSeed);
    expect(item).not.toBeNull();
    grantLoot(state, 0, player, item!, false);
    stepTick(state, getSimTick() + 1);
    expect(blockValue(state, player, 'atk')).toBeGreaterThan(beforeAtk);
    expect(blockValue(state, player, 'damage')).toBeGreaterThan(beforeDmg);
    expect(getEquipped(0)[defs[idx].slot]?.uid).toBe(item!.uid);
    expect(collectRunLoot(0).equipment).toHaveLength(1);
  });

  it('宝石自动镶入有孔装备并产出属性 Modifier', () => {
    resetRunLoot();
    const { state, player } = makeRig();
    const defs = state.config.equipment.all();
    const idx = defs.findIndex((d) => d.rarity === 'legendary');
    const item = makeDroppedEquipment(state, idx + 1, 0x33, 7, battleSession(state).roomSeed)!;
    grantLoot(state, 0, player, item, false);
    const gem = makeDroppedGem(state, 1, 8, battleSession(state).roomSeed)!;
    const statId = state.config.gems.all()[0].stat;
    const before = blockValue(state, player, statId);
    grantLoot(state, 0, player, gem, true);
    stepTick(state, getSimTick() + 1);
    expect(getEquipped(0)[defs[idx].slot]?.gems).toContain(gem.defId);
    expect(blockValue(state, player, statId)).toBeGreaterThan(before);
    expect(collectRunLoot(0).gems).toHaveLength(1);
  });
});

describe('局内技能成长', () => {
  it('经验升级写入等级并生成三选一编码', () => {
    resetRunLoot();
    const { state, player } = makeRig();
    expect(getPlayerLevel(0)).toBe(0);
    spawnPickup(state, Position.x[player], Position.y[player], PICKUP_EXP, EXP_CURVE(1), 0);
    for (let i = 0; i < 4; i++) stepTick(state, getSimTick() + 1);
    expect(getPlayerLevel(0)).toBe(1);
    const codes = new Int32Array(3);
    getLevelChoices(0, codes);
    for (let i = 0; i < 3; i++) expect(codes[i]).toBeGreaterThanOrEqual(0);
  });

  it('技能升级直接放大已编译的伤害参数', () => {
    resetRunLoot();
    const { state, player } = makeRig();
    const before = state.pool.params.data.slice();
    expect(levelUpSkill(0, 0)).toBe(1);
    levelSkillSlotDamage(state, player, 0);
    const changed = state.pool.params.data.some((value, i) => value !== before[i]);
    expect(changed).toBe(true);
    expect(getSkillLevel(0, 0)).toBe(1);
  });

  it('levelUpSkill 单调递增且拒绝非法槽位', () => {
    resetRunLoot();
    expect(levelUpSkill(0, 1)).toBe(1);
    expect(levelUpSkill(0, 1)).toBe(2);
    expect(getSkillLevel(0, 1)).toBe(2);
    expect(levelUpSkill(0, 9)).toBe(0);
  });
});

/** 面板只读访问器（ARCH_RUN_STATUS.md §3.6）：13 槽骨架 / 背包快照 / 词缀真值口径。 */
describe('局内战利品只读访问器', () => {
  it('getEquipped(0) 恰好 13 槽，键集合等于 SLOT_DEFS，空槽为 null', () => {
    resetRunLoot();
    makeRig();

    const equipped = getEquipped(0);

    const keys = Object.keys(equipped).sort();
    expect(keys).toEqual(SLOT_DEFS.map((s) => s.id).sort());
    expect(keys).toHaveLength(13);
    for (const slot of SLOT_DEFS) {
      expect(equipped[slot.id], `${slot.id} 空槽应为 null`).toBeNull();
    }
  });

  it('已穿戴槽仍返回实例，返回新 Record 不回写内部状态', () => {
    resetRunLoot();
    const { state, player } = makeRig();
    const defs = state.config.equipment.all();
    const idx = defs.findIndex((d) => d.rarity === 'legendary' && d.affixes.includes('affix_atk'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const item = makeDroppedEquipment(state, idx + 1, 0x77, 99, battleSession(state).roomSeed)!;
    grantLoot(state, 0, player, item, false);
    stepTick(state, getSimTick() + 1);

    const equipped = getEquipped(0);
    expect(equipped[defs[idx].slot]?.uid).toBe(item.uid);
    expect(SLOT_DEFS.filter((s) => equipped[s.id] !== null)).toHaveLength(1);
    for (const slot of SLOT_DEFS) {
      if (slot.id !== defs[idx].slot) expect(equipped[slot.id]).toBeNull();
    }
    delete equipped[defs[idx].slot];
    expect(getEquipped(0)[defs[idx].slot]?.uid).toBe(item.uid);
  });

  it('getBag / getGemBag 返回数组快照，越界 playerId 返回空数组', () => {
    resetRunLoot();
    const { state, player } = makeRig();
    const equipment = makeDroppedEquipment(state, 1, 0x11, 5, battleSession(state).roomSeed)!;
    grantLoot(state, 0, player, equipment, false);
    const gem = makeDroppedGem(state, 1, 6, battleSession(state).roomSeed)!;
    grantLoot(state, 0, player, gem, true);

    expect(Array.isArray(getBag(0))).toBe(true);
    expect(Array.isArray(getGemBag(0))).toBe(true);
    expect(getBag(0)).toHaveLength(1);
    expect(getGemBag(0)).toHaveLength(1);
    expect(getBag(999)).toEqual([]);
    expect(getGemBag(-1)).toEqual([]);
    (getBag(0) as EquipmentItem[]).length = 0;
    (getGemBag(0) as GemItem[]).length = 0;
    expect(getBag(0)).toHaveLength(1);
    expect(getGemBag(0)).toHaveLength(1);
  });

  it('affixValueOf 与编译进 StatBlock 的词缀真值一致（误差 1e-3）', () => {
    resetRunLoot();
    const { state, player } = makeRig();
    const defs = state.config.equipment.all();
    // 选无套装 / 无传奇特效的黄装，隔离出词缀对 atk 的净贡献。
    const idx = defs.findIndex(
      (d) => d.rarity === 'gold' && d.setId === undefined
        && d.legendaryEffectId === undefined && d.affixes.includes('affix_atk'),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const item = makeDroppedEquipment(state, idx + 1, 0x99, 77, battleSession(state).roomSeed)!;
    const coefficient = findRarity(defs[idx].rarity).coefficient;
    const before = blockValue(state, player, 'atk');

    grantLoot(state, 0, player, item, false);
    stepTick(state, getSimTick() + 1);

    let expected = 0;
    for (let i = 0; i < item.affixes.length; i++) {
      const affix = AFFIX_POOL[item.affixes[i] % AFFIX_POOL.length];
      if (affix.stat === 'atk') expected += affixValueOf(item, i, coefficient);
    }
    expect(expected).toBeGreaterThan(0);
    expect(blockValue(state, player, 'atk') - before).toBeCloseTo(expected, 3);
  });

  it('affixValueOf 非法词缀下标返回 0', () => {
    resetRunLoot();
    const { state } = makeRig();
    const item = makeDroppedEquipment(state, 1, 0x22, 3, battleSession(state).roomSeed)!;
    expect(affixValueOf(item, -1, 1)).toBe(0);
    expect(affixValueOf(item, item.affixes.length, 1)).toBe(0);
  });
});
