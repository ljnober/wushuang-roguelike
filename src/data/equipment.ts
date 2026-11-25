/**
 * 装备 / 宝石 / 魔盒配置。
 *
 * 事实来源：DESIGN.md §8.4 / §8.5 / §8.6 / §8.7，ARCHITECTURE.md §5.12。
 * 槽位、稀有度、词缀池、套装、传奇特效、宝石、材料全部配置化；
 * 引擎只处理通用 Item / Modifier / Stat 结构。
 */
import { hash32 } from '../core/Rng';
import { AFFIX_POOL, affixIndicesForTier } from './stats';
import type {
  CubeRecipeDef,
  EquipmentDef,
  LegendaryEffectDef,
  LegendaryGemDef,
  MaterialDef,
  ModifierDef,
  RarityDef,
  RarityId,
  SetDef,
  SlotDef,
  GemDef,
} from './types';

// ---------------------------------------------------------------------------
// 13 槽 / 6 稀有度
// ---------------------------------------------------------------------------

export const SLOT_DEFS: readonly SlotDef[] = [
  { id: 'head', name: '头盔', category: 'armor', legendaryGemAllowed: false },
  { id: 'shoulders', name: '肩甲', category: 'armor', legendaryGemAllowed: false },
  { id: 'chest', name: '胸甲', category: 'armor', legendaryGemAllowed: false },
  { id: 'bracers', name: '护腕', category: 'armor', legendaryGemAllowed: false },
  { id: 'gloves', name: '手套', category: 'armor', legendaryGemAllowed: false },
  { id: 'belt', name: '腰带', category: 'armor', legendaryGemAllowed: false },
  { id: 'legs', name: '护腿', category: 'armor', legendaryGemAllowed: false },
  { id: 'boots', name: '靴子', category: 'armor', legendaryGemAllowed: false },
  { id: 'amulet', name: '项链', category: 'jewelry', legendaryGemAllowed: true },
  { id: 'ring1', name: '戒指一', category: 'jewelry', legendaryGemAllowed: true },
  { id: 'ring2', name: '戒指二', category: 'jewelry', legendaryGemAllowed: true },
  { id: 'mainHand', name: '主手武器', category: 'weapon', legendaryGemAllowed: false },
  { id: 'offHand', name: '副手武器', category: 'weapon', legendaryGemAllowed: false },
] as const;

/**
 * D3 式六档稀有度：白 / 蓝 / 黄 / 传奇 / 远古传说 / 太古传说。
 * 高档位在词缀条数、可用词缀 tier、数值系数上同时领先；传说以上才有固定名。
 */
export const RARITY_DEFS: readonly RarityDef[] = [
  { id: 'common', name: '白', affixCount: 1, maxAffixTier: 1, sockets: 0, coefficient: 1.0, silent: true, fixedName: false },
  { id: 'blue', name: '蓝', affixCount: 2, maxAffixTier: 2, sockets: 1, coefficient: 1.6, silent: true, fixedName: false },
  { id: 'gold', name: '黄', affixCount: 3, maxAffixTier: 3, sockets: 2, coefficient: 2.4, silent: false, fixedName: false },
  { id: 'legendary', name: '传奇', affixCount: 4, maxAffixTier: 4, sockets: 3, coefficient: 3.0, silent: false, fixedName: true },
  { id: 'ancient', name: '远古传说', affixCount: 5, maxAffixTier: 4, sockets: 3, coefficient: 4.2, silent: false, fixedName: true },
  { id: 'primal', name: '太古传说', affixCount: 6, maxAffixTier: 4, sockets: 3, coefficient: 5.6, silent: false, fixedName: true },
] as const;

/** 按 id 取稀有度配置。 */
export function findRarity(id: RarityId): RarityDef {
  for (let i = 0; i < RARITY_DEFS.length; i++) {
    if (RARITY_DEFS[i].id === id) return RARITY_DEFS[i];
  }
  return RARITY_DEFS[0];
}

// ---------------------------------------------------------------------------
// Modifier 构造辅助（编译期数据，无运行时查找）
// ---------------------------------------------------------------------------

function mkMod(
  stat: string,
  value: number,
  op: ModifierDef['op'] = 'ADD',
  bucket = 'normal',
  sourceKind = 'affix',
  group = 0,
): ModifierDef {
  return {
    stat, op, value, bucket,
    priority: 0,
    sourceKind,
    group,
    condMask: 0,
    duration: 0,
    flags: 0,
  };
}

// ---------------------------------------------------------------------------
// 4 套装（各含 2 件 / 4 件效果）
// ---------------------------------------------------------------------------

export const SET_DEFS: readonly SetDef[] = [
  {
    id: 'set_taoyuan',
    name: '桃园结义',
    slots: ['head', 'chest', 'ring1', 'mainHand'],
    twoPiece: [mkMod('maxHp', 40, 'ADD', 'normal', 'set'), mkMod('armor', 8, 'ADD', 'normal', 'set')],
    fourPiece: [mkMod('lifeSteal', 0.06, 'ADD', 'normal', 'set'), mkMod('damage', 0.12, 'MUL', 'normal', 'set')],
  },
  {
    id: 'set_five_tigers',
    name: '五虎将',
    slots: ['shoulders', 'chest', 'gloves', 'boots', 'mainHand'],
    twoPiece: [mkMod('atk', 12, 'ADD', 'normal', 'set')],
    fourPiece: [mkMod('crit', 0.08, 'ADD', 'normal', 'set'), mkMod('atkSpeed', 0.15, 'MUL', 'normal', 'set')],
  },
  {
    id: 'set_chibi',
    name: '赤壁烽火',
    slots: ['head', 'bracers', 'belt', 'amulet', 'offHand'],
    twoPiece: [mkMod('critDmg', 0.2, 'ADD', 'crit', 'set')],
    fourPiece: [mkMod('damage', 0.25, 'MUL', 'element', 'set'), mkMod('moveSpeed', 18, 'ADD', 'normal', 'set')],
  },
  {
    id: 'set_qunxiong',
    name: '群雄逐鹿',
    slots: ['head', 'legs', 'ring1', 'ring2', 'mainHand'],
    twoPiece: [mkMod('pickup', 20, 'ADD', 'normal', 'set')],
    fourPiece: [mkMod('damage', 0.2, 'MUL', 'boss', 'set'), mkMod('expBonus', 0.25, 'MUL', 'normal', 'set')],
  },
] as const;

// ---------------------------------------------------------------------------
// 传奇特效（16 个，≥12；与技能 tag 联动，走 MAX 裁决去重）
// ---------------------------------------------------------------------------

export const LEGENDARY_EFFECT_DEFS: readonly LegendaryEffectDef[] = [
  {
    id: 'leg_fangtian', name: '方天画戟', description: '挥戟斩击范围增大，对精英伤害提升。',
    slotType: 'weapon', tags: ['halberd', 'slash'],
    modifiers: [mkMod('damage', 0.25, 'MUL', 'elite', 'legendary', 1)],
  },
  {
    id: 'leg_qinglong', name: '青龙偃月刀', description: '青龙斩附带流血，暴击伤害提升。',
    slotType: 'weapon', tags: ['blade', 'slash'],
    modifiers: [mkMod('critDmg', 0.35, 'ADD', 'crit', 'legendary', 1)],
  },
  {
    id: 'leg_zhangba', name: '丈八蛇矛', description: '突刺贯穿一列敌人，攻击力提升。',
    slotType: 'weapon', tags: ['spear', 'melee'],
    modifiers: [mkMod('atk', 18, 'ADD', 'normal', 'legendary', 1)],
  },
  {
    id: 'leg_luoyue', name: '落月弓', description: '箭雨额外发射两箭，攻速提升。',
    slotType: 'weapon', tags: ['arrow', 'projectile'],
    modifiers: [mkMod('atkSpeed', 0.2, 'MUL', 'normal', 'legendary', 1)],
  },
  {
    id: 'leg_dilu', name: '的卢', description: '闪避后移速大幅提升。',
    slotType: 'armor', tags: ['mobility'],
    modifiers: [mkMod('moveSpeed', 40, 'ADD', 'normal', 'legendary', 2)],
  },
  {
    id: 'leg_chitu', name: '赤兔', description: '冲锋距离增加，冲锋伤害提升。',
    slotType: 'armor', tags: ['charge'],
    modifiers: [mkMod('damage', 0.2, 'MUL', 'normal', 'legendary', 2)],
  },
  {
    id: 'leg_bagua', name: '八卦阵图', description: '受击时概率反弹伤害，护甲提升。',
    slotType: 'armor', tags: ['control', 'shield'],
    modifiers: [mkMod('armor', 20, 'ADD', 'normal', 'legendary', 2)],
  },
  {
    id: 'leg_taiping', name: '太平要术', description: '雷系技能连锁目标增加。',
    slotType: 'armor', tags: ['lightning', 'projectile'],
    modifiers: [mkMod('damage', 0.18, 'MUL', 'skill', 'legendary', 2)],
  },
  {
    id: 'leg_qixing', name: '七星灯', description: '濒死时恢复生命，生命上限提升。',
    slotType: 'jewelry', tags: ['heal', 'buff'],
    modifiers: [mkMod('maxHp', 60, 'ADD', 'normal', 'legendary', 3)],
  },
  {
    id: 'leg_lianhuan', name: '连环计', description: '命中使敌人减速，控制效果增强。',
    slotType: 'jewelry', tags: ['control', 'trap'],
    modifiers: [mkMod('crit', 0.05, 'ADD', 'normal', 'legendary', 3)],
  },
  {
    id: 'leg_hulaoguan', name: '虎牢关甲', description: '受到 BOSS 伤害降低。',
    slotType: 'armor', tags: ['shield'],
    modifiers: [mkMod('armor', 30, 'ADD', 'normal', 'legendary', 2)],
  },
  {
    id: 'leg_tengjia', name: '藤甲', description: '免疫火焰地面，生命回复提升。',
    slotType: 'armor', tags: ['fire'],
    modifiers: [mkMod('regen', 5, 'ADD', 'normal', 'legendary', 2)],
  },
  {
    id: 'leg_yitian', name: '倚天剑', description: '斩击附带额外真实伤害。',
    slotType: 'weapon', tags: ['slash', 'melee'],
    modifiers: [mkMod('damage', 0.12, 'MUL', 'normal', 'legendary', 1)],
  },
  {
    id: 'leg_qinggang', name: '青釭剑', description: '无视护甲，暴击率提升。',
    slotType: 'weapon', tags: ['melee'],
    modifiers: [mkMod('crit', 0.07, 'ADD', 'normal', 'legendary', 1)],
  },
  {
    id: 'leg_yanjia', name: '飞燕甲', description: '连续移动叠加移速。',
    slotType: 'armor', tags: ['mobility'],
    modifiers: [mkMod('moveSpeed', 25, 'ADD', 'normal', 'legendary', 2)],
  },
  {
    id: 'leg_langya', name: '狼牙棒', description: '重击造成范围眩晕，攻击提升。',
    slotType: 'weapon', tags: ['aoe', 'stun'],
    modifiers: [mkMod('atk', 14, 'ADD', 'normal', 'legendary', 1)],
  },
] as const;

// ---------------------------------------------------------------------------
// 普通宝石：4 类 × T1–T5（20 颗配置）
// ---------------------------------------------------------------------------

const GEM_KINDS = [
  { kind: 'red' as const, stat: 'atk', base: 3, step: 4 },
  { kind: 'blue' as const, stat: 'maxHp', base: 12, step: 16 },
  { kind: 'yellow' as const, stat: 'crit', base: 0.01, step: 0.01 },
  { kind: 'green' as const, stat: 'atkSpeed', base: 0.02, step: 0.02 },
];

export const GEM_DEFS: readonly GemDef[] = (() => {
  const out: GemDef[] = [];
  for (let k = 0; k < GEM_KINDS.length; k++) {
    const spec = GEM_KINDS[k];
    for (let tier = 1; tier <= 5; tier++) {
      out.push({
        id: `gem_${spec.kind}_t${tier}`,
        kind: spec.kind,
        tier,
        stat: spec.stat,
        value: Math.round((spec.base + spec.step * (tier - 1)) * 1000) / 1000,
      });
    }
  }
  return out;
})();

// ---------------------------------------------------------------------------
// 传说宝石：6 颗，只镶首饰孔；rate = max(0.15, 0.9 - level*0.05)
// ---------------------------------------------------------------------------

function mkLegendaryGem(
  id: string,
  name: string,
  stat: string,
  baseValue: number,
  perLevel: number,
  materialId: string,
  materialBase: number,
  materialSoftCap: number,
): LegendaryGemDef {
  return {
    id, name, stat, baseValue, perLevel, materialId, materialBase, materialSoftCap,
    rateBase: 0.9,
    ratePerLevel: 0.05,
    rateMin: 0.15,
    pityBonus: 0.05,
  };
}

export const LEGENDARY_GEM_DEFS: readonly LegendaryGemDef[] = [
  mkLegendaryGem('lgem_kunxian', '困仙绳', 'damage', 0.04, 0.015, 'soul', 2, 40),
  mkLegendaryGem('lgem_yuxi', '无双玉玺', 'critDmg', 0.06, 0.02, 'bossToken', 1, 30),
  mkLegendaryGem('lgem_hufu', '虎符', 'atk', 5, 2, 'soul', 2, 40),
  mkLegendaryGem('lgem_luofeng', '落凤冠', 'crit', 0.01, 0.004, 'soul', 3, 50),
  mkLegendaryGem('lgem_cangming', '沧溟珠', 'maxHp', 20, 8, 'essence', 10, 120),
  mkLegendaryGem('lgem_fentian', '焚天印', 'damage', 0.05, 0.018, 'bossToken', 1, 30),
] as const;

/**
 * 传说宝石升级成功率（DESIGN §8.7）。
 * 失败等级不变但消耗材料，下次 +5% 保底，成功后重置 pity。
 */
export function legendaryGemRate(level: number, pity: number, def: LegendaryGemDef): number {
  const base = Math.max(def.rateMin, def.rateBase - level * def.ratePerLevel);
  return Math.min(1, base + Math.max(0, pity) * def.pityBonus);
}

/** 传说宝石升级材料消耗（随等级递增，设软上限）。 */
export function legendaryGemCost(level: number, def: LegendaryGemDef): number {
  return Math.min(def.materialSoftCap, def.materialBase + level * Math.ceil(def.materialBase / 2));
}

// ---------------------------------------------------------------------------
// 魔盒三功能配方 + 三种材料
// ---------------------------------------------------------------------------

export const MATERIAL_DEFS: readonly MaterialDef[] = [
  { id: 'essence', name: '精魂', description: '拆解白/蓝装备获得。' },
  { id: 'soul', name: '魂', description: '拆解金/传奇装备、精英掉落获得。' },
  { id: 'bossToken', name: 'BOSS 令牌', description: '击杀名将 BOSS 掉落。' },
] as const;

export const CUBE_RECIPE_DEFS: readonly CubeRecipeDef[] = [
  {
    id: 'cube_extract', function: 'extract',
    cost: { essence: 20, soul: 5 },
    description: '消耗传奇装备与材料，永久提取其传奇特效入账号（3 魔盒槽各装一个）。',
  },
  {
    id: 'cube_reroll', function: 'reroll',
    cost: { soul: 10 },
    description: '重置单件装备词缀；锁定一条需额外消耗 5 soul。',
  },
  {
    id: 'cube_upgrade', function: 'upgrade',
    cost: { soul: 15, bossToken: 1 },
    description: '将金色装备升级为传奇，并随机获得一个传奇特效。',
  },
] as const;

/** 魔盒三槽（武器 / 护甲 / 饰品），与装备同类特效走 MAX 裁决。 */
export const CUBE_SLOTS: readonly string[] = ['weapon', 'armor', 'jewelry'] as const;

// ---------------------------------------------------------------------------
// 具体装备条目（注册进 equipment Registry）
// ---------------------------------------------------------------------------

/**
 * 按稀有度可词缀层级抽取词缀 id（不重复）。
 * 偏移让同槽不同稀有度、不同特效之间词缀组合自然错开；roll 只决定数值大小。
 */
function affixIdsFor(rarity: RarityId, offset: number): string[] {
  const def = findRarity(rarity);
  const indices = affixIndicesForTier(def.maxAffixTier);
  const out: string[] = [];
  for (let i = 0; i < def.affixCount; i++) {
    out.push(AFFIX_POOL[indices[(offset + i) % indices.length]].id);
  }
  return out;
}

const BASE_NAME_PREFIX: Readonly<Record<string, string>> = {
  legendary: '无双',
  ancient: '远古',
  primal: '太古',
};

/** 白/蓝/黄：按稀有度选材质前缀，再按槽位与词条主题拼出可读名称。 */
const RANDOM_NAME_PREFIX: Readonly<Record<string, readonly string[]>> = {
  common: ['粗皮', '布甲', '青铜', '硬木', '熟铜'],
  blue: ['精铁', '锦缎', '寒铁', '赤铜', '狼牙'],
  gold: ['玄铁', '虎纹', '龙鳞', '赤霄', '苍狼'],
};

/** 词缀主题词：让随机名与装备实际词条有关联，而不是乱拼字。 */
const AFFIX_THEME: Readonly<Record<string, string>> = {
  affix_atk: '破军',
  affix_crit: '穿云',
  affix_critDmg: '断岳',
  affix_atkSpeed: '疾风',
  affix_moveSpeed: '追风',
  affix_maxHp: '磐石',
  affix_armor: '坚壁',
  affix_lifeSteal: '饮血',
  affix_pickup: '聚宝',
  affix_skillLevel: '通玄',
  affix_damage: '无双',
  affix_regen: '回春',
  affix_expBonus: '修真',
};

function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * 装备显示名（DESIGN §8.4）。
 * 传说及以上返回 def.name 固定名；白/蓝/黄由 uid 确定性派生材质 + 槽位 + 词缀主题，
 * 同一件装备在仓库、纸娃娃、预览浮层中始终同名，也不会出现无意义字符组合。
 */
export function equipmentName(def: EquipmentDef | undefined, uid: string): string {
  if (def === undefined) return `未知装备（${uid}）`;
  const rarity = findRarity(def.rarity);
  if (rarity.fixedName) {
    return def.name ?? LEGENDARY_EFFECT_DEFS.find((e) => e.id === def.legendaryEffectId)?.name ?? def.id;
  }
  const slotName = SLOT_DEFS.find((s) => s.id === def.slot)?.name ?? def.slot;
  const prefixes = RANDOM_NAME_PREFIX[def.rarity] ?? RANDOM_NAME_PREFIX.common;
  const seed = hashText(uid);
  const prefix = prefixes[hash32(seed, 0x4e1a) % prefixes.length];
  const affixId = def.affixes.length > 0
    ? def.affixes[hash32(seed, 0x8f21) % def.affixes.length]
    : '';
  const theme = AFFIX_THEME[affixId] ?? '';
  return theme.length > 0 ? `${prefix}${slotName}·${theme}` : `${prefix}${slotName}`;
}

/** 生成 13 槽 × 6 稀有度基础装备 + 套装装备 + 传奇/远古/太古装备。 */
export const EQUIPMENT_DEFS: readonly EquipmentDef[] = (() => {
  const out: EquipmentDef[] = [];
  const rarities: RarityId[] = ['common', 'blue', 'gold', 'legendary', 'ancient', 'primal'];

  // 基础装备：每槽每稀有度一件。传说以上的无特效基础款也给固定名。
  for (let s = 0; s < SLOT_DEFS.length; s++) {
    const slot = SLOT_DEFS[s];
    for (let r = 0; r < rarities.length; r++) {
      const rarity = rarities[r];
      const prefix = BASE_NAME_PREFIX[rarity];
      out.push({
        id: `eq_${slot.id}_${rarity}`,
        slot: slot.id,
        rarity,
        affixes: affixIdsFor(rarity, s + r),
        sockets: findRarity(rarity).sockets,
        ...(prefix !== undefined ? { name: `${prefix}${slot.name}` } : {}),
      });
    }
  }

  // 套装装备：每套覆盖槽位各一件黄装（带 setId），名称按 uid 随机生成。
  for (let i = 0; i < SET_DEFS.length; i++) {
    const set = SET_DEFS[i];
    for (let j = 0; j < set.slots.length; j++) {
      out.push({
        id: `seteq_${set.id}_${set.slots[j]}`,
        slot: set.slots[j],
        rarity: 'gold',
        affixes: affixIdsFor('gold', i + j + 1),
        sockets: 2,
        setId: set.id,
      });
    }
  }

  // 传奇及以上：16 个特效 × 3 档，共用固定特效名；远古/太古用更深的词缀组合。
  const namedRarities: RarityId[] = ['legendary', 'ancient', 'primal'];
  for (let r = 0; r < namedRarities.length; r++) {
    const rarity = namedRarities[r];
    for (let i = 0; i < LEGENDARY_EFFECT_DEFS.length; i++) {
      const effect = LEGENDARY_EFFECT_DEFS[i];
      let slotId = 'mainHand';
      if (effect.slotType === 'armor') slotId = SLOT_DEFS[i % 8].id;
      else if (effect.slotType === 'jewelry') slotId = ['amulet', 'ring1', 'ring2'][i % 3];
      out.push({
        id: r === 0 ? `lege_${effect.id}` : `${rarity}_eq_${effect.id}`,
        slot: slotId,
        rarity,
        affixes: affixIdsFor(rarity, i + r * 3),
        sockets: findRarity(rarity).sockets,
        legendaryEffectId: effect.id,
        name: effect.name,
      });
    }
  }

  return out;
})();
