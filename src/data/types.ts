/**
 * 全量内容配置类型定义。
 *
 * 事实来源：ARCHITECTURE.md §5.12、DESIGN.md §6 / §8。
 * 本文件只描述"数据形状"，不含任何运行时逻辑；所有配置表在批次 A 中注册，
 * 战斗/效果/属性系统（批次 B）只读这些结构，新增内容主要靠加配置完成。
 */
import type { Registry } from '../core/Registry';

// ---------------------------------------------------------------------------
// 效果 / 属性基础枚举（§5.12，编号/字面量冻结）
// ---------------------------------------------------------------------------

/** 效果触发时机。可扩展，但已有字面量不得改名（存档/快照兼容）。 */
export type TriggerType =
  | 'onHit'
  | 'onKill'
  | 'onCast'
  | 'onDamaged'
  | 'onMove'
  | 'onTimer'
  | 'onDeath'
  | 'onPickup'
  | 'onCritical';

/** 效果动作操作码。 */
export type ActionOp =
  | 'damage'
  | 'heal'
  | 'buffStat'
  | 'summon'
  | 'spawnProjectile'
  | 'area'
  | 'status'
  | 'cdReduce'
  | 'dropItem';

/** 属性修正运算。 */
export type StatOp = 'ADD' | 'SUB' | 'MUL' | 'MAX' | 'MIN' | 'OVERRIDE' | 'MUTEX' | 'CONDITIONAL';

/** 条件比较运算。 */
export type CompareOp = 'EQ' | 'NE' | 'GT' | 'GE' | 'LT' | 'LE' | 'HAS';

export interface ConditionDef {
  type: string;
  cmp: CompareOp;
  threshold: number;
  arg: number;
}

export interface ActionDef {
  op: ActionOp;
  paramRef: number;
  paramCount: number;
}

/** 声明式效果定义。params 在 EffectCompile 阶段线性写入 ParamPool。 */
export interface EffectDef {
  id: string;
  trigger: TriggerType;
  conditions: ConditionDef[];
  actions: ActionDef[];
  params: number[];
}

/** 属性修正定义（编译后落到 Modifier 组件）。 */
export interface ModifierDef {
  stat: string;
  op: StatOp;
  value: number;
  bucket: string;
  priority: number;
  sourceKind: string;
  group: number;
  condMask: number;
  duration: number;
  flags: number;
}

// ---------------------------------------------------------------------------
// 波次 / BOSS / 装备（§5.12，字段冻结）
// ---------------------------------------------------------------------------

/** 8 分钟波次表中的单阶段。spawnRate 在 startSec..endSec 内线性插值。 */
export interface WaveStage {
  id: string;
  startSec: number;
  endSec: number;
  spawnRateStart: number;
  spawnRateEnd: number;
  cap: number;
  enemies: string[];
  elitesAt: number[];
}

/** 名将 BOSS：多阶段，每阶段挂若干带预警/模式/应对的技能。 */
export interface BossDef {
  id: string;
  phases: Array<{
    hpThreshold: number;
    skills: Array<{ id: string; telegraph: number; pattern: string; counter: string }>;
  }>;
}

export type RarityId = 'common' | 'blue' | 'gold' | 'legendary';

export interface EquipmentDef {
  id: string;
  slot: string;
  rarity: RarityId;
  affixes: string[];
  setId?: string;
  legendaryEffectId?: string;
  sockets: number;
}

// ---------------------------------------------------------------------------
// 武将 / 敌人 / 技能 / 宝石 / 魔盒 / 模式 / 掉落（DESIGN §8 补齐）
// ---------------------------------------------------------------------------

/** 三国阵营。art 层据此选择主色基调。 */
export type FactionId = 'shu' | 'wei' | 'wu' | 'qun';

/** 程序化美术参数：颜色统一用 0xRRGGBB 整数。 */
export interface GeneralArtParams {
  /** primary/secondary/accent/skin 四个色板槽。 */
  colors: { primary: number; secondary: number; accent: number; skin: number };
  /** 发型样式编号、头饰编号、发色。 */
  hair: { style: number; ornament: number; color: number };
  /** 胡须样式编号（0 = 无须）、须色。 */
  beard: { style: number; color: number };
  /** 武器类型 + 造型编号。 */
  weapon: { type: string; style: number };
  /** 身体纹样编号 + 缩放/旋转，供 Chibi/Portrait 复用。 */
  pattern: { id: number; scale: number; rotation: number };
}

/** 武将初始战斗属性（局外养成前的基线）。 */
export interface GeneralBaseStats {
  hp: number;
  atk: number;
  speed: number;
  armor: number;
  crit: number;
}

export interface GeneralDef {
  id: string;
  name: string;
  faction: FactionId;
  /** 称号（选将卡片副标题）。 */
  title: string;
  art: GeneralArtParams;
  baseStats: GeneralBaseStats;
  /** 初始技能 id 列表，引用 skills Registry。 */
  skills: string[];
}

export type EnemyKind = 'melee' | 'ranged' | 'cavalry' | 'elite' | 'bossMinion' | 'boss';

/** 敌人/小兵配置（BOSS 本体另见 BossDef）。 */
export interface EnemyDef {
  id: string;
  name: string;
  kind: EnemyKind;
  hp: number;
  damage: number;
  speed: number;
  range: number;
  attackRate: number;
  radius: number;
  exp: number;
  color: number;
  /** 敌人 AI 行为类型（批次 B EnemyBrain 解释）。 */
  behavior: string;
}

/** 技能配置。tags 供传奇特效联动；cd/range 单位为秒/像素。 */
export interface SkillDef {
  id: string;
  name: string;
  cooldown: number;
  range: number;
  damage: number;
  /** 技能标签，如 'melee'|'fire'|'spear'，用于传奇特效的 tag 联动。 */
  tags: string[];
  /** 可选：技能触发的效果 id，引用 effects Registry。 */
  effectId?: string;
  /** 可选：弹幕配置 id（批次 B 弹幕系统解释）。 */
  projectile?: string;
  /** 技能等级成长（升级选牌时用）。 */
  level: number;
  /** 施法消耗（保留字段，默认 0）。 */
  cost: number;
}

/** 普通宝石：4 类（红/蓝/黄/绿）× T1–T5。 */
export interface GemDef {
  id: string;
  kind: 'red' | 'blue' | 'yellow' | 'green';
  tier: number;
  /** 镶嵌产出的属性 id，引用 stats Registry。 */
  stat: string;
  value: number;
}

/** 传说宝石：只镶首饰孔，等级无上限，成功率/保底参数化。 */
export interface LegendaryGemDef {
  id: string;
  name: string;
  /** 对应属性与每级成长。 */
  stat: string;
  baseValue: number;
  perLevel: number;
  /** 升级消耗材料 id 与基数（随等级递增，设软上限）。 */
  materialId: string;
  materialBase: number;
  materialSoftCap: number;
  /** rate = max(rateMin, rateBase - level * ratePerLevel)。 */
  rateBase: number;
  ratePerLevel: number;
  rateMin: number;
  /** 失败保底：下次成功率 += pityBonus，成功后重置。 */
  pityBonus: number;
}

export type CubeFunction = 'extract' | 'reroll' | 'upgrade';

/** 卡奈魔盒配方（三功能，配置化材料消耗）。 */
export interface CubeRecipeDef {
  id: string;
  function: CubeFunction;
  /** 材料消耗表：materialId -> 数量。 */
  cost: Record<string, number>;
  description: string;
}

/** 属性定义（StatBlock 动态字段的来源）。 */
export interface StatDef {
  id: string;
  name: string;
  /** 基础默认值。 */
  default: number;
  min: number;
  max: number;
  /** 是否为百分比属性（UI 显示用）。 */
  isPercent: boolean;
}

/** 词缀池条目（10 类），按稀有度系数放大。 */
export interface AffixDef {
  id: string;
  stat: string;
  /** T1（最低）数值区间，实际值 = 区间值 × 稀有度系数。 */
  min: number;
  max: number;
  isPercent: boolean;
}

/** 套装（4 套，各含 2 件/4 件效果）。 */
export interface SetDef {
  id: string;
  name: string;
  /** 2 件效果描述的 Modifier 列表。 */
  twoPiece: ModifierDef[];
  /** 4 件效果描述的 Modifier 列表。 */
  fourPiece: ModifierDef[];
  /** 该套装覆盖的槽位。 */
  slots: string[];
}

/** 传奇特效（≥12），与技能 tag 联动，走 MAX 裁决去重。 */
export interface LegendaryEffectDef {
  id: string;
  name: string;
  description: string;
  /** 可出现的装备大类：weapon/armor/jewelry/any。 */
  slotType: 'weapon' | 'armor' | 'jewelry' | 'any';
  /** 联动的技能标签；空数组表示通用。 */
  tags: string[];
  /** 特效产出的 Modifier 列表。 */
  modifiers: ModifierDef[];
}

/** 稀有度档位配置：词缀条数、孔数、数值系数。 */
export interface RarityDef {
  id: RarityId;
  name: string;
  affixCount: number;
  sockets: number;
  coefficient: number;
  /** 是否静默入包（白/蓝静默，稀有以上弹提示）。 */
  silent: boolean;
}

/** 装备槽位定义（13 槽）。 */
export interface SlotDef {
  id: string;
  name: string;
  category: 'armor' | 'jewelry' | 'weapon';
  /** 是否可镶传说宝石（仅首饰）。 */
  legendaryGemAllowed: boolean;
}

/** 魔盒材料定义。 */
export interface MaterialDef {
  id: string;
  name: string;
  description: string;
}

/** 掉落表条目：权重 + 数量区间。 */
export interface DropEntryDef {
  itemId: string;
  weight: number;
  minQty: number;
  maxQty: number;
}

/** 掉落表：含保底与 smart-loot 开关。 */
export interface DropTableDef {
  id: string;
  entries: DropEntryDef[];
  /** 连续 N 次未出稀有以上则保底。 */
  pity: number;
  smartLoot: boolean;
}

/** 游戏模式（8 分钟 / 无尽）。无尽公式参数化，逻辑层不读墙钟。 */
export interface ModeDef {
  id: string;
  name: string;
  durationSec: number;
  /** 是否需首胜 BOSS 才解锁。 */
  unlockAfterFirstBoss: boolean;
  /** BOSS 登场秒数。 */
  bossAtSec: number;
  /** 无尽模式参数（常规模式为 undefined）。 */
  endless?: {
    hpBase: number;
    hpLinear: number;
    hpQuad: number;
    dmgBase: number;
    dmgLinear: number;
    spawnBase: number;
    spawnLinear: number;
    spawnCap: number;
    eliteEverySec: number;
    bossEverySec: number;
  };
  /** 计分公式标识（逻辑层按 id 取实现）。 */
  scoreFormula: string;
}

/** 全局注册表容器（GameConfig）。 */
export interface GameConfig {
  generals: Registry<GeneralDef>;
  enemies: Registry<EnemyDef>;
  skills: Registry<SkillDef>;
  effects: Registry<EffectDef>;
  equipment: Registry<EquipmentDef>;
  bosses: Registry<BossDef>;
  gems: Registry<GemDef>;
  legendaryGems: Registry<LegendaryGemDef>;
  cube: Registry<CubeRecipeDef>;
  stats: Registry<StatDef>;
  waves: WaveStage[];
  modes: Registry<ModeDef>;
  drops: Registry<DropTableDef>;
  /** 乘区分桶顺序（数组下标 = Modifier.bucket 的数值）。 */
  buckets: readonly string[];
  /** 来源优先级链：基础 < 词缀 < 普通宝石 < 套装 < 传奇 < 魔盒 < 技能 < 传说宝石 < buff。 */
  sourcePriority: readonly string[];
}
