/**
 * 局内角色状态 VM 组装器（ARCH_RUN_STATUS.md §3.3）。
 *
 * 单向数据流：ECS / config / RunLoot / formatter → 只读 VM → RunStatusPanel。
 * 本文件只读，不写组件、不改 session、不读墙钟、不做随机；面板不持有任何 ECS 引用。
 */
import type { App } from '../app/App';
import { SLOT_DEFS, equipmentName, findRarity } from '../data/equipment';
import { formatSkillDescription, sourceKindLabel } from '../data/skillDescription';
import { resolveSkillSlots, type SkillSlotBinding } from '../data/skillSlots';
import { AFFIX_POOL, SOURCE_PRIORITY, STAT_DEFS, findStat } from '../data/stats';
import type { GameConfig } from '../data/types';
import { has, query } from '../ecs/bit/adapter';
import type { BattleWorld } from '../ecs/bit/adapter';
import { PlayerId, PlayerTag, StatBlock, StatSnapshotRef } from '../ecs/bit/components';
import type { Eid } from '../ecs/bit/types';
import type { SnapshotPool } from '../ecs/pools/SnapshotPool';
import { affixValueOf, getEquipped, getSkillLevel } from '../game/RunLoot';
import { sessionFromState } from '../net/session';
import type {
  AffixVM,
  EquipmentSlotVM,
  GemVM,
  HUDInitialSnapshot,
  OverviewVM,
  RunStatusVM,
  SkillVM,
  SourceContributionVM,
  StatBreakdownVM,
  StatVM,
} from '../ui/types/RunStatusVM';

export interface RunStatusVMDeps {
  readonly app: App;
  readonly config: GameConfig;
  readonly generalId: string;
  readonly controlMode: 'auto' | 'manual';
}

/** 需要展开来源分解的核心属性（P0 仅这 4 项）。 */
const CORE_STAT_IDS: ReadonlySet<string> = new Set(['atk', 'maxHp', 'crit', 'armor']);

/** 宝石颜色中文名。 */
const GEM_KIND_LABELS: Readonly<Record<string, string>> = {
  red: '红色',
  blue: '蓝色',
  yellow: '黄色',
  green: '绿色',
};

/** 会话任意数值字段：非法 / 缺失一律回退默认值。 */
function sessionNumber(session: unknown, key: string, fallback: number): number {
  if (session === null || typeof session !== 'object') return fallback;
  const value = (session as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 会话经过的秒数；优先 elapsedTicks/tickRate，与 HUD 同口径。 */
function sessionElapsed(session: unknown): number {
  const ticks = sessionNumber(session, 'elapsedTicks', 0);
  const tickRate = sessionNumber(session, 'tickRate', 60);
  if (ticks > 0 && tickRate > 0) return ticks / tickRate;
  return sessionNumber(session, 'elapsed', 0);
}

/** 按 PlayerId 精确匹配玩家实体；取不到返回 null，绝不回退 players[0]。 */
function findPlayerEid(world: BattleWorld | null, playerId: number): Eid | null {
  if (world === null) return null;
  const eids = query(world, [PlayerId, PlayerTag]);
  for (let i = 0; i < eids.length; i++) {
    if (PlayerId.value[eids[i]] === playerId) return eids[i];
  }
  return null;
}

/** 从 StatBlock 读属性真值；无实体 / 无字段时用配置默认值。 */
function readStat(world: BattleWorld | null, eid: Eid | null, statId: string, fallback: number): number {
  if (world === null || eid === null || !has(world, eid, StatBlock)) return fallback;
  const table = StatBlock as unknown as Record<string, Float32Array | undefined>;
  const values = table[statId];
  if (values === undefined) return fallback;
  const value = values[eid];
  return Number.isFinite(value) ? value : fallback;
}

/** 格式化单条属性为展示串（isPercent 用百分比，否则整数/一位小数）。 */
export function formatStatValue(value: number, isPercent: boolean): string {
  const n = Number.isFinite(value) ? value : 0;
  if (isPercent) return `${Math.round(n * 1000) / 10}%`;
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1);
}

/** 核心属性的来源分解；池 / 快照引用不可用时返回 null（只读降级，不抛错）。 */
function readStatBreakdown(
  app: App,
  config: GameConfig,
  world: BattleWorld | null,
  eid: Eid | null,
  statIndex: number,
  current: number,
): StatBreakdownVM | null {
  if (world === null || eid === null || !has(world, eid, StatSnapshotRef)) return null;
  const pool = app.state.pool?.snapshots as SnapshotPool | null | undefined;
  if (pool === null || pool === undefined) return null;
  const poolIndex = StatSnapshotRef.poolIndex[eid];
  if (!Number.isInteger(poolIndex) || poolIndex < 0 || poolIndex >= pool.slotCount) return null;

  const bySourceValues = new Float32Array(SOURCE_PRIORITY.length);
  const bucketValues = new Float32Array(config.buckets.length);
  pool.readBreakdown(poolIndex, statIndex, bySourceValues, bucketValues);

  const bySource: SourceContributionVM[] = [];
  for (let kind = 0; kind < bySourceValues.length; kind++) {
    const value = bySourceValues[kind];
    if (value === 0) continue;
    bySource.push({ sourceKind: kind, sourceName: sourceKindLabel(kind), value });
  }
  return { final: current, bySource, buckets: Array.from(bucketValues) };
}

/** 13 槽只读 VM；以 SLOT_DEFS 为骨架，空槽显式占位。 */
function buildEquipment(deps: RunStatusVMDeps, playerId: number): EquipmentSlotVM[] {
  const { config } = deps;
  const equipped = getEquipped(playerId);
  const slots: EquipmentSlotVM[] = [];
  for (let s = 0; s < SLOT_DEFS.length; s++) {
    const slotDef = SLOT_DEFS[s];
    const item = equipped[slotDef.id] ?? null;
    if (item === null) {
      slots.push({
        slotId: slotDef.id,
        slotName: slotDef.name,
        occupied: false,
        name: '',
        rarity: null,
        affixes: [],
        sockets: 0,
        gems: [],
      });
      continue;
    }
    const def = config.equipment.tryGet(item.defId);
    const rarity = def?.rarity ?? 'common';
    const coefficient = findRarity(rarity).coefficient;

    const affixes: AffixVM[] = [];
    for (let i = 0; i < item.affixes.length; i++) {
      const affix = AFFIX_POOL[item.affixes[i] % AFFIX_POOL.length];
      if (affix === undefined) continue;
      const statName = findStat(affix.stat)?.name ?? affix.stat;
      const value = affixValueOf(item, i, coefficient);
      affixes.push({
        statId: affix.stat,
        label: `${statName} +${formatStatValue(value, affix.isPercent)}`,
        value,
        isPercent: affix.isPercent,
      });
    }

    const gems: GemVM[] = [];
    for (let i = 0; i < item.gems.length; i++) {
      const gem = config.gems.tryGet(item.gems[i]);
      if (gem === undefined) continue;
      const statDef = findStat(gem.stat);
      const statName = statDef?.name ?? gem.stat;
      gems.push({
        defId: gem.id,
        name: `${GEM_KIND_LABELS[gem.kind] ?? gem.kind}${gem.tier}级 ${statName}`,
        kind: gem.kind,
        tier: gem.tier,
        statLabel: `${statName} +${formatStatValue(gem.value, statDef?.isPercent ?? false)}`,
      });
    }

    slots.push({
      slotId: slotDef.id,
      slotName: slotDef.name,
      occupied: true,
      name: equipmentName(def, item.uid),
      rarity,
      affixes,
      sockets: def?.sockets ?? item.sockets,
      gems,
    });
  }
  return slots;
}

/** 3 条技能槽 VM；绑定解析失败时按武将配置降级，保证固定 3 项。 */
function buildSkills(deps: RunStatusVMDeps, playerId: number): SkillVM[] {
  const { config, generalId } = deps;
  let bindings: SkillSlotBinding[] = [];
  try {
    bindings = resolveSkillSlots(config, generalId);
  } catch {
    bindings = [];
  }
  const configuredIds = config.generals.tryGet(generalId)?.skills ?? [];
  const out: SkillVM[] = [];
  for (let slot = 0; slot < 3; slot++) {
    const skillId = bindings[slot]?.skillId ?? configuredIds[slot] ?? '';
    const skill = config.skills.tryGet(skillId);
    const level = getSkillLevel(playerId, slot) + 1;
    const formatted = skill === undefined ? null : formatSkillDescription(skill, level, level + 1);
    out.push({
      slot: slot as 0 | 1 | 2,
      skillId,
      name: skill?.name ?? '未知技能',
      level,
      description: formatted?.description ?? '暂无技能说明',
      nextLevelGain: formatted?.nextLevelGain ?? '—',
      tags: skill === undefined ? [] : skill.tags.slice(),
      cooldown: skill?.cooldown ?? 0,
      range: skill?.range ?? 0,
    });
  }
  return out;
}

/** 组装只读 VM。playerId 缺省从 session.localPlayerId 取。 */
export function buildRunStatusVM(deps: RunStatusVMDeps, playerId?: number): RunStatusVM {
  const { app, config } = deps;
  const session = sessionFromState(app.state.session);
  const pid = playerId ?? session.localPlayerId;
  const world = app.state.world as BattleWorld | null;
  const eid = findPlayerEid(world, pid);
  const rawSession = app.state.session;

  const stats: StatVM[] = [];
  for (let i = 0; i < STAT_DEFS.length; i++) {
    const def = STAT_DEFS[i];
    const current = readStat(world, eid, def.id, def.default);
    stats.push({
      statId: def.id,
      name: def.name,
      current,
      isPercent: def.isPercent,
      breakdown: CORE_STAT_IDS.has(def.id)
        ? readStatBreakdown(app, config, world, eid, i, current)
        : null,
    });
  }

  const general = config.generals.tryGet(deps.generalId);
  const overview: OverviewVM = {
    playerId: pid,
    generalName: general?.name ?? deps.generalId,
    level: Math.floor(sessionNumber(rawSession, 'level', 1)),
    exp: sessionNumber(rawSession, 'exp', 0),
    expNext: sessionNumber(rawSession, 'expNext', 0),
    hp: readStat(world, eid, 'hp', STAT_DEFS[0].default),
    maxHp: readStat(world, eid, 'maxHp', STAT_DEFS[1].default),
    atk: readStat(world, eid, 'atk', STAT_DEFS[2].default),
    armor: readStat(world, eid, 'armor', STAT_DEFS[3].default),
    crit: readStat(world, eid, 'crit', STAT_DEFS[4].default),
    elapsedSec: sessionElapsed(rawSession),
    kills: Math.floor(sessionNumber(rawSession, 'kills', 0)),
    score: Math.floor(sessionNumber(rawSession, 'score', 0)),
  };

  return {
    overview,
    equipment: buildEquipment(deps, pid),
    skills: buildSkills(deps, pid),
    stats,
    controlMode: deps.controlMode,
    localPlayerId: pid,
    generalId: deps.generalId,
  };
}

/** startBattle 之后调用：从 session + StatBlock 取真值，供 HUD.reset(init) 消除闪帧。 */
export function buildHUDInitial(deps: RunStatusVMDeps): HUDInitialSnapshot {
  const { app } = deps;
  const session = sessionFromState(app.state.session);
  const world = app.state.world as BattleWorld | null;
  const eid = findPlayerEid(world, session.localPlayerId);
  const rawSession = app.state.session;
  return {
    hp: readStat(world, eid, 'hp', STAT_DEFS[0].default),
    maxHp: readStat(world, eid, 'maxHp', STAT_DEFS[1].default),
    level: Math.floor(sessionNumber(rawSession, 'level', 1)),
    exp: sessionNumber(rawSession, 'exp', 0),
    expNext: sessionNumber(rawSession, 'expNext', STAT_DEFS[0].default),
    score: Math.floor(sessionNumber(rawSession, 'score', 0)),
    kills: Math.floor(sessionNumber(rawSession, 'kills', 0)),
    elapsedSec: sessionElapsed(rawSession),
  };
}
