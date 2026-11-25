/**
 * 局内战利品运行态（docs/ARCH_RUN_LOOT.md）。
 *
 * D3 秘境式闭环：掉落 → 拾取 → smart loot 自动装备 → Modifier 即时重算 →
 * 结算带回仓库。全部随机来自 Rng / hash32，不读墙钟，不进网络快照。
 */
import { MAX_PLAYERS } from '../core/Constants';
import { hash32, Rng } from '../core/Rng';
import { AFFIX_POOL, findStat } from '../data/stats';
import { findRarity, LEGENDARY_EFFECT_DEFS, SET_DEFS, SLOT_DEFS } from '../data/equipment';
import type { EquipmentDef, GemDef } from '../data/types';
import type { EquipmentItem, GemItem } from './SaveData';
import type { Eid } from '../ecs/bit/types';
import type { SimState } from '../ecs/scheduler';
import { GameEventType } from '../ecs/bridge/enums';
import { createModifier, sourceKindOf } from '../ecs/systems/StatResolveSystem';

/** 单席位的局内战利品与装备状态。 */
interface PlayerLoot {
  bag: EquipmentItem[];
  gems: GemItem[];
  equipped: Map<string, EquipmentItem>;
  /** 当前装备编译出的全部 Modifier 实体（换装时整体释放）。 */
  modEids: number[];
  /** 技能槽等级（0-based，初始 0 = 1 级）。 */
  skillLevels: [number, number, number];
}

function emptyLoot(): PlayerLoot {
  return { bag: [], gems: [], equipped: new Map(), modEids: [], skillLevels: [0, 0, 0] };
}

const lootByPlayer: PlayerLoot[] = Array.from({ length: MAX_PLAYERS }, emptyLoot);

/** 开战前注入的局外装备（避免改动冻结的 startBattle 签名）。 */
let pendingLoadout: { generalId: string; items: readonly EquipmentItem[] } | null = null;

export function resetRunLoot(): void {
  for (let i = 0; i < MAX_PLAYERS; i++) lootByPlayer[i] = emptyLoot();
  pendingLoadout = null;
}

export function setPendingLoadout(generalId: string, items: readonly EquipmentItem[]): void {
  pendingLoadout = { generalId, items };
}

/** 由 createBattleState 在玩家实体创建后调用；局外装备只编译，不重复进战利品袋。 */
export function applyPendingLoadout(state: SimState, playerId: number, owner: Eid): void {
  if (pendingLoadout === null || playerId !== 0) return;
  const items = pendingLoadout.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (state.config.equipment.tryGet(item.defId) === undefined) continue;
    equipCore(state, playerId, owner, item);
  }
  pendingLoadout = null;
}

/** 字符串 uid → 32 位种子（与 core/hash32 同一 FNV 乘数，仅供词缀 roll）。 */
function hashUid(uid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) h = Math.imul(h ^ uid.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * 按与 compileEquippedItem 完全一致的口径重算单条词缀真值。
 *
 * 口径：AFFIX_POOL[item.affixes[affixIndex] % AFFIX_POOL.length] 取词条定义；
 * 种子 hash32(hashUid(item.uid), affixIndex, 0xa771)；roll 后按稀有度系数放大，
 * 最后四舍五入到 3 位小数。非法下标返回 0，不改变任何 Rng 状态。
 */
export function affixValueOf(item: EquipmentItem, affixIndex: number, rarityCoefficient: number): number {
  if (affixIndex < 0 || affixIndex >= item.affixes.length) return 0;
  const affix = AFFIX_POOL[item.affixes[affixIndex] % AFFIX_POOL.length];
  if (affix === undefined) return 0;
  const rng = new Rng(hash32(hashUid(item.uid), affixIndex, 0xa771));
  return Math.round((affix.min + rng.next() * (affix.max - affix.min)) * rarityCoefficient * 1000) / 1000;
}

function statIndexOf(state: SimState, id: string): number {
  const all = state.config.stats.all();
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === id) return i;
  }
  return -1;
}

function releaseModifiers(state: SimState, loot: PlayerLoot): void {
  for (let i = 0; i < loot.modEids.length; i++) {
    state.pool.entities.release(loot.modEids[i]);
  }
  loot.modEids.length = 0;
}

/** 重新编译该席位全部装备（词缀 / 宝石 / 套装 / 传奇），并重建 set 组修正。 */
function recompileAll(state: SimState, playerId: number, owner: Eid): void {
  const loot = lootByPlayer[playerId];
  releaseModifiers(state, loot);
  let iter = loot.equipped.values();
  for (let step = 0; step < loot.equipped.size; step++) {
    const item = iter.next().value as EquipmentItem;
    compileEquippedItem(state, owner, item, loot);
  }
  const setCounts = new Map<string, number>();
  iter = loot.equipped.values();
  for (let step = 0; step < loot.equipped.size; step++) {
    const item = iter.next().value as EquipmentItem;
    const def = state.config.equipment.tryGet(item.defId);
    if (def?.setId === undefined) continue;
    setCounts.set(def.setId, (setCounts.get(def.setId) ?? 0) + 1);
  }
  for (let s = 0; s < SET_DEFS.length; s++) {
    const set = SET_DEFS[s];
    const count = setCounts.get(set.id) ?? 0;
    if (count >= 2) applyModifierDefs(state, owner, set.twoPiece, loot, 'set', 100 + s);
    if (count >= 4) applyModifierDefs(state, owner, set.fourPiece, loot, 'set', 200 + s);
  }
}

function applyModifierDefs(
  state: SimState,
  owner: Eid,
  defs: readonly { stat: string; op: string; value: number; bucket: string; priority: number; sourceKind: string; group: number }[],
  loot: PlayerLoot,
  fallbackSource: string,
  groupBase: number,
): void {
  for (let i = 0; i < defs.length; i++) {
    const mod = defs[i];
    const stat = statIndexOf(state, mod.stat);
    if (stat < 0) continue;
    const bucket = state.config.buckets.indexOf(mod.bucket);
    const eid = createModifier(state, owner, {
      stat,
      op: mod.op as 'ADD' | 'MUL' | 'MAX' | 'MIN' | 'OVERRIDE' | 'MUTEX' | 'CONDITIONAL' | 'SUB',
      value: mod.value,
      bucket: bucket < 0 ? 0 : bucket,
      priority: mod.priority,
      sourceKind: sourceKindOf(mod.sourceKind || fallbackSource),
      group: groupBase + mod.group,
    });
    loot.modEids.push(eid);
  }
}

/** 编译单件已穿戴装备的词缀、宝石与传奇特效。 */
function compileEquippedItem(state: SimState, owner: Eid, item: EquipmentItem, loot: PlayerLoot): void {
  const def = state.config.equipment.tryGet(item.defId);
  if (def === undefined) return;
  const rarity = findRarity(def.rarity);
  for (let i = 0; i < item.affixes.length; i++) {
    const affixId = AFFIX_POOL[item.affixes[i] % AFFIX_POOL.length];
    if (affixId === undefined) continue;
    const stat = statIndexOf(state, affixId.stat);
    if (stat < 0) continue;
    // 单一来源：与面板展示共用的 affixValueOf，抽取前后编译结果逐位一致。
    const value = affixValueOf(item, i, rarity.coefficient);
    const mod = createModifier(state, owner, {
      stat, op: 'ADD', value, bucket: 0, priority: 1, sourceKind: sourceKindOf('affix'), group: 0,
    });
    loot.modEids.push(mod);
    // 攻击词缀同时提高技能伤害：基础 damage=0 时乘数恒为 1，旧基线不受影响。
    if (affixId.stat === 'atk') {
      const dmgStat = statIndexOf(state, 'damage');
      if (dmgStat >= 0) {
        const bonus = createModifier(state, owner, {
          stat: dmgStat, op: 'ADD', value: value / 24, bucket: 0, priority: 1,
          sourceKind: sourceKindOf('affix'), group: 0,
        });
        loot.modEids.push(bonus);
      }
    }
  }
  for (let i = 0; i < item.gems.length; i++) {
    const gem = state.config.gems.tryGet(item.gems[i]);
    if (gem === undefined) continue;
    const stat = statIndexOf(state, gem.stat);
    if (stat < 0) continue;
    const mod = createModifier(state, owner, {
      stat, op: 'ADD', value: gem.value, bucket: 0, priority: 2,
      sourceKind: sourceKindOf('gem'), group: 0,
    });
    loot.modEids.push(mod);
  }
  if (def.legendaryEffectId !== undefined) {
    for (let i = 0; i < LEGENDARY_EFFECT_DEFS.length; i++) {
      const effect = LEGENDARY_EFFECT_DEFS[i];
      if (effect.id !== def.legendaryEffectId) continue;
      applyModifierDefs(state, owner, effect.modifiers, loot, 'legendary', 300 + i * 10);
      break;
    }
  }
}

/** smart loot 评分：跨稀有度、孔数、套装、传奇统一可比。 */
export function scoreEquipment(state: SimState, item: EquipmentItem): number {
  const def = state.config.equipment.tryGet(item.defId);
  if (def === undefined) return -1;
  const rarity = findRarity(def.rarity);
  let score = 0;
  for (let i = 0; i < item.affixes.length; i++) {
    const affix = AFFIX_POOL[item.affixes[i] % AFFIX_POOL.length];
    if (affix !== undefined) score += (affix.min + affix.max) * 0.5;
  }
  score *= rarity.coefficient;
  score += item.sockets * 8 + item.gems.length * 6;
  if (def.setId !== undefined) score += 12;
  if (def.legendaryEffectId !== undefined) score += 30;
  return score;
}

/** 把装备真正穿上（不进背包），并触发全量属性重编译。 */
function equipCore(state: SimState, playerId: number, owner: Eid, item: EquipmentItem): void {
  const def = state.config.equipment.tryGet(item.defId);
  if (def === undefined) return;
  const loot = lootByPlayer[playerId];
  loot.equipped.set(def.slot, item);
  recompileAll(state, playerId, owner);
}

/** 补全 13 槽：以 SLOT_DEFS 为骨架，空槽为 null；返回新 Record，不改内部 Map。 */
export function getEquipped(playerId: number): Record<string, EquipmentItem | null> {
  const loot = lootByPlayer[playerId];
  const out: Record<string, EquipmentItem | null> = {};
  for (let i = 0; i < SLOT_DEFS.length; i++) out[SLOT_DEFS[i].id] = null; // 先铺 13 槽
  if (loot === undefined) return out;
  const iter = loot.equipped.entries();
  for (let i = 0; i < loot.equipped.size; i++) {
    const entry = iter.next().value as [string, EquipmentItem];
    if (entry[0] in out) out[entry[0]] = entry[1]; // 只覆盖已知槽，杜绝脏键
  }
  return out;
}

/** 只读背包快照（RS-09，P1 展示用；本轮先落接口）；返回 slice，调用方改不影响结算。 */
export function getBag(playerId: number): readonly EquipmentItem[] {
  const loot = lootByPlayer[playerId];
  return loot === undefined ? [] : loot.bag.slice();
}

/** 只读宝石背包快照；返回 slice，调用方改不影响结算。 */
export function getGemBag(playerId: number): readonly GemItem[] {
  const loot = lootByPlayer[playerId];
  return loot === undefined ? [] : loot.gems.slice();
}

export function getSkillLevel(playerId: number, slot: number): number {
  const loot = lootByPlayer[playerId];
  return loot === undefined || slot < 0 || slot > 2 ? 0 : loot.skillLevels[slot];
}

export function levelUpSkill(playerId: number, slot: number): number {
  const loot = lootByPlayer[playerId];
  if (loot === undefined || slot < 0 || slot > 2) return 0;
  loot.skillLevels[slot] += 1;
  return loot.skillLevels[slot];
}

/** 由掉落表条目创建具体装备实例；cfgId 为 config.equipment 的 1-based 下标。 */
export function makeDroppedEquipment(
  state: SimState,
  cfgId: number,
  roll: number,
  eid: number,
  roomSeed: number,
): EquipmentItem | null {
  const def = state.config.equipment.all()[cfgId - 1];
  if (def === undefined) return null;
  return {
    uid: `loot_${roomSeed}_${eid}_${cfgId}`,
    defId: def.id,
    // 词缀类型必须沿用配置表（AFFIX_POOL 下标），roll 只决定数值大小。
    affixes: def.affixes.map((affixId) => {
      for (let i = 0; i < AFFIX_POOL.length; i++) {
        if (AFFIX_POOL[i].id === affixId) return i;
      }
      return hash32(roll, affixId.length, 0xaff1) % AFFIX_POOL.length;
    }),
    sockets: def.sockets,
    gems: [],
    legendaryEffectId: def.legendaryEffectId,
  };
}

export function makeDroppedGem(state: SimState, cfgId: number, eid: number, roomSeed: number): GemItem | null {
  const def = state.config.gems.all()[cfgId - 1];
  if (def === undefined) return null;
  return {
    uid: `gem_${roomSeed}_${eid}_${cfgId}`,
    defId: def.id,
    kind: def.kind,
    tier: def.tier,
  };
}

/** 拾取一件战利品：进背包，装备自动比较替换，宝石自动镶入最优空孔。 */
export function grantLoot(
  state: SimState,
  playerId: number,
  owner: Eid,
  item: EquipmentItem | GemItem,
  isGem: boolean,
): void {
  const loot = lootByPlayer[playerId];
  if (loot === undefined) return;
  if (isGem) {
    const gem = item as GemItem;
    loot.gems.push(gem);
    if (findSocketTarget(state, loot, gem) !== null) {
      const target = findSocketTarget(state, loot, gem);
      if (target !== null) {
        // 约定：EquipmentItem.gems 存宝石 defId（与配装 UI / 存档一致），uid 在宝石背包中去重。
        target.gems.push(gem.defId);
        recompileAll(state, playerId, owner);
        state.buses.events.emit(GameEventType.GemSocket, playerId, gem.tier, 0);
      }
    }
    return;
  }
  const equipment = item as EquipmentItem;
  loot.bag.push(equipment);
  const def = state.config.equipment.tryGet(equipment.defId);
  if (def === undefined) return;
  const current = loot.equipped.get(def.slot);
  if (current === undefined || scoreEquipment(state, equipment) > scoreEquipment(state, current)) {
    equipCore(state, playerId, owner, equipment);
    state.buses.events.emit(GameEventType.Equip, playerId, def.slot.length, 0);
  }
}

/** 孔位未满的装备中稀有度最高者；同级取评分最高。 */
function findSocketTarget(state: SimState, loot: PlayerLoot, gem: GemItem): EquipmentItem | null {
  void gem;
  let best: EquipmentItem | null = null;
  let bestScore = -1;
  const iter = loot.equipped.values();
  for (let i = 0; i < loot.equipped.size; i++) {
    const item = iter.next().value as EquipmentItem;
    if (item.gems.length >= item.sockets) continue;
    const score = scoreEquipment(state, item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/** 结算带回：返回背包与宝石袋的快照（调用方负责写存档去重）。 */
export function collectRunLoot(playerId: number): { equipment: EquipmentItem[]; gems: GemItem[] } {
  const loot = lootByPlayer[playerId];
  if (loot === undefined) return { equipment: [], gems: [] };
  return { equipment: loot.bag.slice(), gems: loot.gems.slice() };
}

/** 调试 / 测试用：按 id 读取装备定义（编译掉落条目时也会用到）。 */
export function equipmentDefAt(state: SimState, index: number): EquipmentDef | undefined {
  return state.config.equipment.all()[index - 1];
}

export function gemDefAt(state: SimState, index: number): GemDef | undefined {
  return state.config.gems.all()[index - 1];
}

/** 供 smart loot 选择稀有度条目时判断定义是否存在。 */
export function rarityCoefficientOf(rarity: string): number {
  return findRarity(rarity as 'common').coefficient;
}

/** 供属性面板显示：某属性是否存在于配置（测试用）。 */
export function hasStat(state: SimState, id: string): boolean {
  return findStat(id) !== undefined;
}
