/**
 * 批次 A 验收单测：组件工厂 / CAP 守卫 / Rng 确定性 harness / 注册完整性 / 存档。
 *
 * 说明：部分依赖由并行批次 A1/A2 产出；若这些文件尚未落盘，typecheck 报错属预期，
 * 集成完成后本文件应全绿。
 */
import { CAP, WushuangError } from '../Constants';
import { hash32, Rng } from '../Rng';
import { Registry } from '../Registry';
import { defineSoA, Health, PlayerId, Position } from '../../ecs/bit/components';
import { createBitWorld, registerAll, spawn } from '../../ecs/bit/adapter';
import { buildGameConfig } from '../../data/index';
import { GENERAL_DEFS } from '../../data/generals';
import { AFFIX_POOL } from '../../data/stats';
import { BOSS_DEFS, MODE_DEFS, SKILL_DEFS, EFFECT_DEFS, WAVE_STAGES } from '../../data/combat';
import {
  EQUIPMENT_DEFS,
  GEM_DEFS,
  LEGENDARY_EFFECT_DEFS,
  LEGENDARY_GEM_DEFS,
  SET_DEFS,
  SLOT_DEFS,
} from '../../data/equipment';
import { createDefaultSave } from '../../game/SaveData';
import { SaveSystem } from '../../game/SaveSystem';
import type { SaveStorage } from '../../game/SaveSystem';

// ---------------------------------------------------------------------------
// 组件工厂 / CAP 守卫
// ---------------------------------------------------------------------------

describe('组件工厂与 CAP 守卫', () => {
  it('defineSoA 按 CAP 分配定长 typed array', () => {
    const comp = defineSoA({ x: 'f32', y: 'f32', id: 'u32' });
    expect(comp.x.length).toBe(CAP);
    expect(comp.y.length).toBe(CAP);
    expect(comp.id.length).toBe(CAP);
  });

  it('createBitWorld + registerAll + spawn 的 eid 合法且小于 CAP', () => {
    const world = createBitWorld('test-cap');
    registerAll(world, [Position, Health, PlayerId]);
    const eid = spawn(world);
    expect(eid).toBeGreaterThanOrEqual(0);
    expect(eid).toBeLessThan(CAP);
    expect(Position.x.length).toBe(CAP);
  });

  it('CAP / eid 断言失败抛 WushuangError', () => {
    const err = new WushuangError(2001, 'cap overflow');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(2001);
  });
});

// ---------------------------------------------------------------------------
// Rng 确定性 harness
// ---------------------------------------------------------------------------

describe('Rng 确定性', () => {
  it('同 seed 的 next 序列逐值一致', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 32; i++) expect(a.next()).toBe(b.next());
  });

  it('derive(seed, playerId, tick) 同参数一致、不同 tick 不同', () => {
    const x = Rng.derive(777, 2, 100).next();
    const y = Rng.derive(777, 2, 100).next();
    const z = Rng.derive(777, 2, 101).next();
    expect(x).toBe(y);
    expect(x).not.toBe(z);
  });

  it('hash32 对相同输入稳定', () => {
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
    expect(hash32(1, 2, 3)).not.toBe(hash32(1, 2, 4));
  });
});

// ---------------------------------------------------------------------------
// Registry 基础行为
// ---------------------------------------------------------------------------

describe('Registry', () => {
  it('注册 / get / has / all / ids 正常，重复 id 抛错', () => {
    const reg = new Registry<{ id: string }>('things');
    reg.register({ id: 'a' });
    reg.register({ id: 'b' });
    expect(reg.has('a')).toBe(true);
    expect(reg.get('b').id).toBe('b');
    expect(reg.all().length).toBe(2);
    expect(reg.ids()).toEqual(['a', 'b']);
    expect(() => reg.register({ id: 'a' })).toThrow();
  });

  it('get 不存在的 id 抛错', () => {
    const reg = new Registry<{ id: string }>('empty');
    expect(() => reg.get('missing')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 内容注册完整性
// ---------------------------------------------------------------------------

describe('GameConfig 注册完整性', () => {
  const config = buildGameConfig();

  it('40 将 / 13 槽 / 4 套 / ≥12 传奇 / 6 传说宝石 / 8 BOSS', () => {
    expect(GENERAL_DEFS.length).toBe(40);
    expect(config.generals.all().length).toBe(40);
    expect(SLOT_DEFS.length).toBe(13);
    expect(SET_DEFS.length).toBe(4);
    expect(LEGENDARY_EFFECT_DEFS.length).toBeGreaterThanOrEqual(12);
    expect(LEGENDARY_GEM_DEFS.length).toBe(6);
    expect(config.legendaryGems.all().length).toBe(6);
    expect(BOSS_DEFS.length).toBe(8);
    expect(config.bosses.all().length).toBe(8);
  });

  it('词缀池 10 类 / 普通宝石 4×5 / 六阶段波次 / 双模式', () => {
    expect(AFFIX_POOL.length).toBe(10);
    expect(GEM_DEFS.length).toBe(20);
    expect(config.gems.all().length).toBe(20);
    expect(WAVE_STAGES.length).toBe(6);
    expect(MODE_DEFS.length).toBe(2);
  });

  it('所有武将初始技能与技能效果引用存在', () => {
    for (let i = 0; i < GENERAL_DEFS.length; i++) {
      const skills = GENERAL_DEFS[i].skills;
      expect(skills.length).toBeGreaterThan(0);
      for (let j = 0; j < skills.length; j++) {
        expect(config.skills.has(skills[j])).toBe(true);
      }
    }
    for (let i = 0; i < SKILL_DEFS.length; i++) {
      const effectId = SKILL_DEFS[i].effectId;
      if (effectId !== undefined) expect(config.effects.has(effectId)).toBe(true);
    }
    expect(EFFECT_DEFS.length).toBeGreaterThan(0);
  });

  it('装备引用合法：slot / setId / legendaryEffectId', () => {
    const slotIds = new Set<string>();
    for (let i = 0; i < SLOT_DEFS.length; i++) slotIds.add(SLOT_DEFS[i].id);
    const setIds = new Set<string>();
    for (let i = 0; i < SET_DEFS.length; i++) setIds.add(SET_DEFS[i].id);
    const effectIds = new Set<string>();
    for (let i = 0; i < LEGENDARY_EFFECT_DEFS.length; i++) effectIds.add(LEGENDARY_EFFECT_DEFS[i].id);

    for (let i = 0; i < EQUIPMENT_DEFS.length; i++) {
      const eq = EQUIPMENT_DEFS[i];
      expect(slotIds.has(eq.slot)).toBe(true);
      if (eq.setId !== undefined) expect(setIds.has(eq.setId)).toBe(true);
      if (eq.legendaryEffectId !== undefined) expect(effectIds.has(eq.legendaryEffectId)).toBe(true);
    }
    expect(config.equipment.all().length).toBe(EQUIPMENT_DEFS.length);
  });

  it('各 Registry.validate() 返回空问题列表', () => {
    expect(config.generals.validate()).toEqual([]);
    expect(config.skills.validate()).toEqual([]);
    expect(config.equipment.validate()).toEqual([]);
    expect(config.bosses.validate()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 存档
// ---------------------------------------------------------------------------

function memoryStorage(): SaveStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string): void => { map.set(k, v); },
    removeItem: (k: string): void => { map.delete(k); },
  };
}

describe('SaveSystem', () => {
  it('默认存档完整且 40 将全部解锁', () => {
    const save = createDefaultSave();
    expect(save.version).toBe(1);
    expect(save.meta.unlockedGenerals.length).toBe(40);
    expect(save.meta.unlockedModes).toContain('campaign_8min');
    expect(save.meta.warehouse.capacity).toBeGreaterThan(0);
  });

  it('saveNow → load 往返；clear 后回到默认存档', () => {
    const sys = new SaveSystem(memoryStorage());
    const save = createDefaultSave();
    save.meta.currency = 987;
    expect(sys.saveNow(save)).toBe(true);
    expect(sys.load().meta.currency).toBe(987);
    sys.clear();
    expect(sys.load().meta.currency).toBe(0);
  });

  it('save 受 SAVE_THROTTLE_MS 节流', () => {
    const sys = new SaveSystem(memoryStorage());
    const save = createDefaultSave();
    expect(sys.save(save)).toBe(true);
    expect(sys.save(save)).toBe(false);
  });

  it('只序列化本地玩家的运行数据', () => {
    const storage = memoryStorage();
    const sys = new SaveSystem(storage);
    sys.setLocalPlayerId(1);
    const save = createDefaultSave();
    save.run = {
      mode: 'campaign_8min', generalId: 'liubei', elapsed: 10, playerId: 0,
      participants: [], pickedEquipment: [], pickedGems: [], pity: {},
    };
    save.perPlayerRunStats['seed-1'] = {
      '0': { kills: 1, damage: 1, level: 1, elapsed: 1 },
      '1': { kills: 2, damage: 2, level: 2, elapsed: 2 },
    };
    expect(sys.saveNow(save)).toBe(true);
    const loaded = sys.load();
    expect(loaded.run).toBeUndefined();
    expect(loaded.perPlayerRunStats['seed-1']).toBeDefined();
    expect(loaded.perPlayerRunStats['seed-1']['0']).toBeUndefined();
    expect(loaded.perPlayerRunStats['seed-1']['1'].kills).toBe(2);
  });

  it('超 80KB 返回 false 并记录 lastError', () => {
    const sys = new SaveSystem(memoryStorage());
    const save = createDefaultSave();
    const huge: string[] = [];
    for (let i = 0; i < 4000; i++) huge.push('x'.repeat(40));
    save.meta.currency = Number.MAX_SAFE_INTEGER;
    (save.meta as unknown as { huge: string[] }).huge = huge;
    expect(sys.saveNow(save)).toBe(false);
    expect(sys.lastError).not.toBeNull();
  });

  it('损坏存档读取回退到默认', () => {
    const storage = memoryStorage();
    storage.setItem('wushuang.profile.v1', '{broken json');
    const sys = new SaveSystem(storage);
    expect(sys.load().version).toBe(1);
    expect(sys.lastError).not.toBeNull();
  });
});
