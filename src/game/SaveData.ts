/**
 * 单机存档数据结构（ARCHITECTURE.md §5.9、DESIGN.md §10）。
 *
 * 只存玩家私有 profile 与本地玩家的运行数据；房间状态为临时会话，不写入存档。
 * Loadout / slots / leaderboards 用 Record，槽位与模式配置扩展后结构保持兼容。
 */
import { GENERAL_DEFS } from '../data/generals';

export type QualityLevel = 'low' | 'medium' | 'high';

/**
 * 界面主题 id（PRD_UI_REFACTOR.md §5.1 / §6.4）。
 *
 * T1 classic = 默认主题，与现有视觉基线等价；T5 wasteland 为 P2 预留（尚未实现）。
 * 主题只影响 DOM UI 层配色，不影响 Pixi 战场实体配色（PRD §3.7）。
 */
export type ThemeId = 'classic' | 'ink' | 'neon' | 'sakura';

/** 全部合法主题 id（顺序即设置页展示顺序）。 */
export const THEME_IDS: readonly ThemeId[] = ['classic', 'ink', 'neon', 'sakura'];

/** 默认主题：旧存档（无 theme 字段）与非法值一律回退到此。 */
export const DEFAULT_THEME: ThemeId = 'classic';

export interface EquipmentItem {
  uid: string;
  defId: string;
  affixes: number[];
  sockets: number;
  gems: string[];
  legendaryEffectId?: string;
}

export interface GemItem {
  uid: string;
  defId: string;
  kind: 'red' | 'blue' | 'yellow' | 'green';
  tier: number;
}

export interface LegendaryGemItem {
  uid: string;
  defId: string;
  level: number;
  pity: number;
}

export interface LeaderboardEntry {
  score: number;
  mode: string;
  generalId: string;
  at: number;
}

export interface RunStats {
  kills: number;
  damage: number;
  level: number;
  elapsed: number;
}

export interface SaveData {
  version: 1;
  meta: {
    currency: number;
    unlockedGenerals: string[];
    selectedGeneral: string;
    upgrades: Record<string, number>;
    stats: Record<string, number>;
    settings: {
      controlMode: 'auto' | 'manual';
      /** 仅渲染档位，不影响任何游戏性参数。 */
      quality: QualityLevel;
      sfx: boolean;
      netRolePreferred: 'auto' | 'host' | 'client';
      playerColor: number;
      localPlayerName: string;
      /** 界面主题；缺省或非法值视为 'classic'（旧存档兼容）。 */
      theme?: ThemeId;
    };
    unlockedModes: string[];
    firstBossClearAt: number | null;
    materials: Record<string, number>;
    warehouse: { items: EquipmentItem[]; capacity: number };
    /** [generalId][slotId] = uid | null */
    loadouts: Record<string, Record<string, string | null>>;
    gems: { inventory: GemItem[] };
    cube: { extracted: string[]; slots: Record<string, string | null> };
    legendaryGems: { inventory: LegendaryGemItem[]; equipped: Record<string, string | null> };
    multiplayer: {
      localSeatPreference: number;
      shadowCount: number;
      aiShadowDifficulty: number;
      knownPeers: string[];
    };
    leaderboards: Record<string, LeaderboardEntry[]>;
  };
  run?: {
    mode: string;
    generalId: string;
    elapsed: number;
    playerId: number;
    participants: string[];
    pickedEquipment: string[];
    pickedGems: string[];
    pity: Record<string, number>;
  };
  /** [roomSeed][playerId] */
  perPlayerRunStats: Record<string, Record<string, RunStats>>;
}

/** 创建一份完整可用的默认存档（40 将初始全部可选）。 */
export function createDefaultSave(): SaveData {
  const unlocked: string[] = [];
  for (let i = 0; i < GENERAL_DEFS.length; i++) unlocked.push(GENERAL_DEFS[i].id);

  return {
    version: 1,
    meta: {
      currency: 0,
      unlockedGenerals: unlocked,
      selectedGeneral: 'liubei',
      upgrades: {},
      stats: {},
      settings: {
        controlMode: 'auto',
        quality: 'high',
        sfx: true,
        netRolePreferred: 'auto',
        playerColor: 0,
        localPlayerName: '无名英雄',
        theme: 'classic',
      },
      unlockedModes: ['campaign_8min'],
      firstBossClearAt: null,
      materials: { essence: 0, soul: 0, bossToken: 0 },
      warehouse: { items: [], capacity: 200 },
      loadouts: {},
      gems: { inventory: [] },
      cube: {
        extracted: [],
        slots: { weapon: null, armor: null, jewelry: null },
      },
      legendaryGems: {
        inventory: [],
        equipped: { amulet: null, ring1: null, ring2: null },
      },
      multiplayer: {
        localSeatPreference: 0,
        shadowCount: 2,
        aiShadowDifficulty: 1,
        knownPeers: [],
      },
      leaderboards: {},
    },
    perPlayerRunStats: {},
  };
}
