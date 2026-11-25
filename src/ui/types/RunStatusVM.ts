/**
 * 局内角色状态面板唯一数据契约，零 ECS。
 *
 * 本文件只描述 VM 数据形状：全部字段 readonly，面板侧只读渲染、不得回写；
 * 不 import 任何 ECS 依赖或底层模块，不读墙钟，不做随机。ECS 访问统一收敛到
 * presentation 层组装器（src/registration/runStatusVM.ts）。签名冻结见 docs/ARCH_RUN_STATUS.md §3.1。
 */

/** 局内角色状态面板的唯一数据契约。全部 readonly；面板侧零 ECS、零写入。 */
export interface RunStatusVM {
  readonly overview: OverviewVM;
  readonly equipment: readonly EquipmentSlotVM[]; // 固定 13 项，顺序 = SLOT_DEFS
  readonly skills: readonly SkillVM[];             // 固定 3 项，slot 0/1/2
  readonly stats: readonly StatVM[];               // 14 项，顺序 = STAT_DEFS
  readonly controlMode: 'auto' | 'manual';
  readonly localPlayerId: number;
  readonly generalId: string;
}

export interface OverviewVM {
  readonly playerId: number;
  readonly generalName: string;
  readonly level: number;      // 1-based（session.level）
  readonly exp: number;
  readonly expNext: number;
  readonly hp: number;         // StatBlock.hp[eid]
  readonly maxHp: number;      // StatBlock.maxHp[eid]
  readonly atk: number;        // 核心属性速览
  readonly armor: number;
  readonly crit: number;
  readonly elapsedSec: number;
  readonly kills: number;
  readonly score: number;
}

/** 13 槽之一；空槽 occupied=false，其余字段为空串/空数组。 */
export interface EquipmentSlotVM {
  readonly slotId: string;              // SLOT_DEFS[i].id，如 'mainHand'
  readonly slotName: string;            // 中文名，如 '主手武器'
  readonly occupied: boolean;
  readonly name: string;                // equipmentName(def, uid)；空槽为 ''
  readonly rarity: string | null;       // RarityId；空槽为 null
  readonly affixes: readonly AffixVM[];
  readonly sockets: number;             // def.sockets；空槽为 0
  readonly gems: readonly GemVM[];      // 已镶嵌（按 item.gems 的 defId 查表）
}

export interface AffixVM {
  readonly statId: string;
  readonly label: string;               // 例 '攻击力 +5.2'，由 AFFIX_POOL + 实例 roll 渲染
  readonly value: number;               // 已 roll 的真实值（hashUid 口径，见 §3.4 注）
  readonly isPercent: boolean;
}

export interface GemVM {
  readonly defId: string;
  readonly name: string;                // `${kind 中文}${tier}级 ${stat.name}`
  readonly kind: 'red' | 'blue' | 'yellow' | 'green';
  readonly tier: number;
  readonly statLabel: string;           // 例 '攻击力 +3'
}

export interface SkillVM {
  readonly slot: 0 | 1 | 2;
  readonly skillId: string;
  readonly name: string;
  readonly level: number;               // 1-based = getSkillLevel(pid, slot) + 1
  readonly description: string;         // formatter.description
  readonly nextLevelGain: string;       // formatter.nextLevelGain；不可再升为 '—'
  readonly tags: readonly string[];
  readonly cooldown: number;
  readonly range: number;
}

export interface StatVM {
  readonly statId: string;
  readonly name: string;
  readonly current: number;             // StatBlock[statId][eid] 真值
  readonly isPercent: boolean;
  /** P0 仅核心 4 项非 null；其余为 null。buckets 预留，P0 不渲染。 */
  readonly breakdown: StatBreakdownVM | null;
}

export interface StatBreakdownVM {
  readonly final: number;               // = StatVM.current
  readonly bySource: readonly SourceContributionVM[]; // 过滤掉 0 贡献，按 sourceKind 升序
  readonly buckets?: readonly number[]; // 预留（RS-08），下标 = BUCKETS 顺序
}

export interface SourceContributionVM {
  readonly sourceKind: number;          // SOURCE_PRIORITY 下标（0=base..8=buff）
  readonly sourceName: string;          // 中文名：基础/词缀/宝石/套装/传奇/魔盒/技能/传说宝石/Buff
  readonly value: number;
}

/** HUD.reset 初始值（presentation 在 startBattle 后按真值构造）。 */
export interface HUDInitialSnapshot {
  readonly hp: number;
  readonly maxHp: number;
  readonly level: number;
  readonly exp: number;
  readonly expNext: number;
  readonly score: number;
  readonly kills: number;
  readonly elapsedSec: number;
}
