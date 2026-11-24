/**
 * QA1 存档契约独立验证（DESIGN.md §10、ARCHITECTURE.md §5.9、PRD 验收 P8/P7）。
 *
 * 覆盖：默认存档 <80KB（UTF-8 字节）、版本/损坏容错、只序列化本地玩家、
 * QuotaExceededError 返回 false 并上报 NetEvent、超容量拒绝、节流写入。
 *
 * 本环境使用 vite.config.ts 的 globals:true，直接用全局 describe / it / expect。
 */
import { SAVE_KEY, SAVE_MAX_BYTES, SAVE_THROTTLE_MS } from '../../core/Constants';
import { GameEventBus } from '../../ecs/bridge/GameEventBus';
import { GameEventType } from '../../ecs/bridge/enums';
import { createDefaultSave, type SaveData } from '../SaveData';
import { SaveSystem, type SaveStorage } from '../SaveSystem';

function makeStorage(): SaveStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem(key: string): string | null {
      return raw.has(key) ? (raw.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      raw.set(key, value);
    },
    removeItem(key: string): void {
      raw.delete(key);
    },
  };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function makeMultiplayerSave(): SaveData {
  const save = createDefaultSave();
  save.run = {
    mode: 'campaign_8min',
    generalId: 'liubei',
    elapsed: 123.5,
    playerId: 1,
    participants: ['p0', 'p1', 'p2'],
    pickedEquipment: ['e0', 'e1'],
    pickedGems: ['g0'],
    pity: { boss: 3 },
  };
  save.perPlayerRunStats = {
    'seed-A': {
      '0': { kills: 10, damage: 100, level: 2, elapsed: 10 },
      '1': { kills: 20, damage: 200, level: 3, elapsed: 20 },
      '2': { kills: 30, damage: 300, level: 4, elapsed: 30 },
    },
    'seed-B': {
      '1': { kills: 40, damage: 400, level: 5, elapsed: 40 },
      '2': { kills: 50, damage: 500, level: 6, elapsed: 50 },
    },
  };
  return save;
}

describe('存档契约：容量与结构', () => {
  it('默认存档及含完整局内数据的存档均小于 80KB（UTF-8 字节）', () => {
    const storage = makeStorage();
    const system = new SaveSystem(storage);
    const fresh = createDefaultSave();
    expect(utf8Bytes(JSON.stringify(fresh))).toBeLessThan(SAVE_MAX_BYTES);

    // 40 将 + 13 槽配装 + 仓库 + 排行 + 双人运行统计的典型满载 profile。
    const loaded = makeMultiplayerSave();
    for (const def of fresh.meta.unlockedGenerals) {
      loaded.meta.loadouts[def] = {
        head: 'uid_head', shoulders: 'uid_shoulders', chest: 'uid_chest',
        bracers: null, gloves: 'uid_gloves', belt: null, legs: null, boots: null,
        amulet: null, ring1: null, ring2: null, mainHand: 'uid_weapon', offHand: null,
      };
    }
    for (let i = 0; i < 60; i++) {
      loaded.meta.warehouse.items.push({
        uid: `item_${i}`,
        defId: `equip_${i % 13}`,
        affixes: [1, 2, 3],
        sockets: 3,
        gems: ['g1', 'g2', 'g3'],
        legendaryEffectId: 'leg_fangtian',
      });
    }
    loaded.meta.leaderboards = {
      campaign_8min: Array.from({ length: 10 }, (_, i) => ({
        score: 1000 - i, mode: 'campaign_8min', generalId: 'liubei', at: 1700000000000 + i,
      })),
    };

    expect(system.saveNow(loaded)).toBe(true);
    const raw = storage.raw.get(SAVE_KEY) as string;
    expect(utf8Bytes(raw)).toBeLessThan(SAVE_MAX_BYTES);
    expect(system.lastError).toBeNull();
  });

  it('超过 80KB 的存档拒绝写入并返回 false', () => {
    const storage = makeStorage();
    const system = new SaveSystem(storage);
    const data = createDefaultSave();
    for (let i = 0; i < 1200; i++) {
      data.meta.warehouse.items.push({
        uid: `x${i}_${'A'.repeat(80)}`,
        defId: 'equip_head',
        affixes: [1, 2, 3],
        sockets: 0,
        gems: [],
      });
    }
    expect(utf8Bytes(JSON.stringify(data))).toBeGreaterThan(SAVE_MAX_BYTES);
    expect(system.saveNow(data)).toBe(false);
    expect(system.lastError).toContain('容量上限');
    expect(storage.raw.has(SAVE_KEY)).toBe(false);
  });

  it('房间状态字段不会进入存档结构', () => {
    const storage = makeStorage();
    const system = new SaveSystem(storage);
    const data = makeMultiplayerSave();
    expect(system.saveNow(data)).toBe(true);
    const parsed = JSON.parse(storage.raw.get(SAVE_KEY) as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['meta', 'perPlayerRunStats', 'version']);
    expect(JSON.stringify(parsed)).not.toContain('world');
    expect(JSON.stringify(parsed)).not.toContain('entities');
    expect(JSON.stringify(parsed)).not.toContain('simTick');
  });
});

describe('存档契约：版本容错与本地玩家归属', () => {
  it('版本不符 / JSON 损坏 / 结构缺失均回退默认存档并给出 lastError', () => {
    const storage = makeStorage();
    const system = new SaveSystem(storage);
    const baseline = createDefaultSave();

    storage.raw.set(SAVE_KEY, JSON.stringify({ ...baseline, version: 2 }));
    expect(system.load().version).toBe(1);
    expect(system.lastError).toContain('版本不匹配');

    storage.raw.set(SAVE_KEY, '{not-json');
    expect(system.load().meta.selectedGeneral).toBe(baseline.meta.selectedGeneral);
    expect(system.lastError).toContain('读取失败');

    storage.raw.set(SAVE_KEY, JSON.stringify({ version: 1, meta: null, perPlayerRunStats: {} }));
    expect(system.load().meta.currency).toBe(0);
    expect(system.lastError).toContain('结构损坏');

    system.clear();
    expect(storage.raw.has(SAVE_KEY)).toBe(false);
  });

  it('只保留本地席位的 run 与 perPlayerRunStats', () => {
    const storage = makeStorage();
    const system = new SaveSystem(storage);
    system.setLocalPlayerId(2);
    expect(system.saveNow(makeMultiplayerSave())).toBe(true);

    const parsed = JSON.parse(storage.raw.get(SAVE_KEY) as string) as SaveData;
    expect(parsed.run).toBeUndefined(); // run.playerId=1 与本地席位 2 不符
    expect(Object.keys(parsed.perPlayerRunStats).sort()).toEqual(['seed-A', 'seed-B']);
    expect(Object.keys(parsed.perPlayerRunStats['seed-A'])).toEqual(['2']);
    expect(Object.keys(parsed.perPlayerRunStats['seed-B'])).toEqual(['2']);
    expect(parsed.perPlayerRunStats['seed-A']['2'].kills).toBe(30);
    expect(JSON.stringify(parsed)).not.toContain('"kills":10');
    expect(JSON.stringify(parsed)).not.toContain('"kills":40');

    // 本地席位改为 1 后，run 与本席统计都应保留。
    system.setLocalPlayerId(1);
    expect(system.saveNow(makeMultiplayerSave())).toBe(true);
    const asOne = JSON.parse(storage.raw.get(SAVE_KEY) as string) as SaveData;
    expect(asOne.run?.playerId).toBe(1);
    expect(asOne.perPlayerRunStats['seed-A']['1'].kills).toBe(20);
    expect(asOne.perPlayerRunStats['seed-A']['2']).toBeUndefined();
  });
});

describe('存档契约：写入失败与节流', () => {
  it('QuotaExceededError 返回 false、记录错误并上报 NetEvent', () => {
    const storage = makeStorage();
    const quota: SaveStorage = {
      getItem: (key) => storage.getItem(key),
      removeItem: (key) => storage.removeItem(key),
      setItem(): void {
        const err = new Error('quota') as Error & { name: string };
        err.name = 'QuotaExceededError';
        throw err;
      },
    };
    const bus = new GameEventBus(16);
    const system = new SaveSystem(quota);
    system.setEventBus(bus);

    expect(system.saveNow(createDefaultSave())).toBe(false);
    expect(system.lastError).toContain('存储空间不足');
    const events = Array.from({ length: 8 }, () => ({
      type: 0 as GameEventType, a: 0, b: 0, c: 0,
    }));
    bus.drain(events);
    expect(events.some((e) => e.type === GameEventType.NetEvent && e.a === 2)).toBe(true);
  });

  it('save() 在 SAVE_THROTTLE_MS 内只写一次；saveNow() 不受节流影响', () => {
    const storage = makeStorage();
    const system = new SaveSystem(storage);
    expect(SAVE_THROTTLE_MS).toBe(2000);
    expect(system.save(createDefaultSave())).toBe(true);
    expect(system.save(createDefaultSave())).toBe(false);
    expect(system.saveNow(createDefaultSave())).toBe(true);
  });
});
