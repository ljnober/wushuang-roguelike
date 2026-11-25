/**
 * 成长与 BOSS 系统族（ARCHITECTURE §6.3 order 13–17 / DESIGN §8.1、§8.3）。
 *
 * Drop → Pickup → Exp → LevelUp → Boss：经验曲线统一用 EXP_CURVE，
 * 三选一数据通过 GameEventBus 上报 DOM；BOSS 阶段阈值与预警只由 tick 驱动。
 */
import { EXP_CURVE, MAX_PLAYERS } from '../../core/Constants';
import { hash32, Rng } from '../../core/Rng';
import { GameEventType } from '../bridge/enums';
import type { Eid } from '../bit/types';
import { add, has, query } from '../bit/adapter';
import {
  AIState,
  Behavior,
  Dead,
  DirtyStat,
  ExpValue,
  Health,
  Modifier,
  ModifierOwner,
  Pickup,
  PlayerId,
  PlayerTag,
  Position,
  StatBlock,
  Threat,
} from '../bit/components';
import { StatOpCode } from '../components/stat';
import { spawnCombatEntity, spawnPickup, battleSession } from './LifecycleSystems';
import { fireProjectile } from './CombatSystems';
import { cosLut, sinLut } from '../../engine/SweptCollision';
import type { SimState } from '../scheduler';
import {
  grantLoot,
  levelUpSkill,
  makeDroppedEquipment,
  makeDroppedGem,
} from '../../game/RunLoot';
import { levelSkillSlotDamage } from './EffectSystems';
import { createModifier, sourceKindOf } from './StatResolveSystem';

/** 拾取物种类（Pickup.kind）。 */
export const PICKUP_EXP = 0;
export const PICKUP_MATERIAL = 1;
export const PICKUP_EQUIPMENT = 2;
export const PICKUP_GEM = 3;

/** 运行状态：按玩家席位索引的固定 typed array，零运行期分配。 */
const expByPlayer = new Float32Array(MAX_PLAYERS);
const expNeedByPlayer = new Float32Array(MAX_PLAYERS);
const levelByPlayer = new Uint32Array(MAX_PLAYERS);
const choicesByPlayer = new Int32Array(MAX_PLAYERS * 3);
const selectedByPlayer = new Int32Array(MAX_PLAYERS);
/** BOSS 阶段缓存（eid → phase），与 AIState.timer 的预警倒计时彻底分离。 */
const bossPhase = new Int32Array(4096);

export function resetProgressionRuntime(): void {
  expByPlayer.fill(0);
  expNeedByPlayer.fill(0);
  levelByPlayer.fill(0);
  choicesByPlayer.fill(0);
  selectedByPlayer.fill(-1);
  bossPhase.fill(0);
  for (let i = 0; i < MAX_PLAYERS; i++) {
    expNeedByPlayer[i] = EXP_CURVE(1);
  }
}
resetProgressionRuntime();

/**
 * 把成长运行态写入会话，供 HUD 逐帧同步。只处理本地玩家席位，
 * 展示等级为 1-based（模块内 levelByPlayer 为 0-based）。
 */
function syncLocalProgress(state: SimState, playerId: number): void {
  const session = battleSession(state);
  if (playerId !== session.localPlayerId) {
    return;
  }
  session.level = levelByPlayer[playerId] + 1;
  session.exp = expByPlayer[playerId];
  session.expNext = expNeedByPlayer[playerId];
  session.score = session.kills * 10 + session.level * 100;
}

export function getPlayerLevel(playerId: number): number {
  return levelByPlayer[playerId] ?? 0;
}
export function getPlayerExp(playerId: number): number {
  return expByPlayer[playerId] ?? 0;
}
export function getLevelChoices(playerId: number, out: Int32Array): void {
  out[0] = choicesByPlayer[playerId * 3] ?? 0;
  out[1] = choicesByPlayer[playerId * 3 + 1] ?? 0;
  out[2] = choicesByPlayer[playerId * 3 + 2] ?? 0;
}
/** UI 手动三选一：在 LevelUpSystem 消费前调用。 */
export function selectLevelChoice(playerId: number, index: number): void {
  if (playerId >= 0 && playerId < MAX_PLAYERS && index >= 0 && index < 3) {
    selectedByPlayer[playerId] = index;
  }
}

/** order 13：击杀掉落（经验球 + 按掉落表的确定性材料）。 */
export class DropSystem {
  private readonly terms = [Dead, ExpValue, Position];
  private readonly rng = new Rng(1);

  run(state: SimState, tick: number): void {
    const world = state.world;
    const session = battleSession(state);
    const dead = query(world, this.terms);
    for (let i = 0; i < dead.length; i++) {
      const eid = dead[i];
      // Pickup 分量既是拾取物数据，也是「本次掉落已处理」的标记。
      if (has(world, eid, Pickup)) {
        continue;
      }
      add(world, eid, Pickup);
      Pickup.kind[eid] = -1;
      const x = Position.x[eid];
      const y = Position.y[eid];
      const exp = ExpValue.value[eid];
      if (exp > 0) {
        spawnPickup(state, x + 8, y, PICKUP_EXP, exp, 0);
      }
      this.rng.setState(hash32(session.roomSeed, eid, tick, 0xd20e));
      const isBoss = has(world, eid, Behavior) && Behavior.p2[eid] > 0;
      const isElite = has(world, eid, Threat) && Threat.value[eid] >= 2;
      const tableId = isBoss ? 'drop_boss' : isElite ? 'drop_elite' : 'drop_common';
      const table = state.config.drops.tryGet(tableId);
      if (table !== undefined && table.entries.length > 0 && this.rng.next() < 0.4) {
        const entry = table.entries[this.rng.int(table.entries.length)];
        const qty = entry.minQty + this.rng.int(Math.max(1, entry.maxQty - entry.minQty + 1));
        if (entry.itemId.startsWith('equipment_')) {
          // 装备条目：按稀有度筛出具体配置，cfgId = 1-based 注册表下标。
          const rarity = entry.itemId.slice('equipment_'.length);
          const defs = state.config.equipment.all();
          let count = 0;
          for (let k = 0; k < defs.length; k++) if (defs[k].rarity === rarity) count++;
          if (count > 0) {
            let nth = this.rng.int(count);
            for (let k = 0; k < defs.length; k++) {
              if (defs[k].rarity !== rarity) continue;
              if (nth-- === 0) {
                spawnPickup(state, x - 8, y, PICKUP_EQUIPMENT, hash32(session.roomSeed, eid, tick, 0x9711), k + 1);
                break;
              }
            }
          }
        } else if (entry.itemId.startsWith('gem_')) {
          const gems = state.config.gems.all();
          for (let k = 0; k < gems.length; k++) {
            if (gems[k].id !== entry.itemId) continue;
            spawnPickup(state, x - 8, y, PICKUP_GEM, gems[k].tier, k + 1);
            break;
          }
        } else {
          spawnPickup(state, x - 8, y, PICKUP_MATERIAL, qty, entry.itemId.length);
        }
      }
    }
  }
}

/** order 14：拾取（含经验球吸附半径），命中后打 Dead，下一系统即可消费。 */
export class PickupSystem {
  private readonly pickupTerms = [Pickup, Position];
  private readonly playerTerms = [PlayerTag, Position, PlayerId];

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;
    const players = query(world, this.playerTerms);
    const pickups = query(world, this.pickupTerms);
    const block = StatBlock as unknown as Record<string, Float32Array | undefined>;
    const radiusArr = block['pickup'];
    for (let i = 0; i < pickups.length; i++) {
      const item = pickups[i];
      if (has(world, item, Dead) || Pickup.kind[item] < 0) {
        continue;
      }
      for (let j = 0; j < players.length; j++) {
        const player = players[j];
        if (has(world, player, Dead)) {
          continue;
        }
        const radius = has(world, player, StatBlock) && radiusArr !== undefined
          ? radiusArr[player]
          : 60;
        const dx = Position.x[player] - Position.x[item];
        const dy = Position.y[player] - Position.y[item];
        if (dx * dx + dy * dy > radius * radius) {
          continue;
        }
        const playerId = PlayerId.value[player];
        if (Pickup.kind[item] === PICKUP_EXP) {
          expByPlayer[playerId] += Pickup.amount[item];
          state.buses.events.emit(GameEventType.Pickup, playerId, PICKUP_EXP, Pickup.amount[item]);
        } else if (Pickup.kind[item] === PICKUP_EQUIPMENT) {
          const drop = makeDroppedEquipment(
            state, Pickup.cfgId[item], Pickup.amount[item], item, battleSession(state).roomSeed,
          );
          if (drop === null) continue;
          grantLoot(state, playerId, player, drop, false);
          state.buses.events.emit(GameEventType.Pickup, playerId, PICKUP_EQUIPMENT, Pickup.cfgId[item]);
        } else if (Pickup.kind[item] === PICKUP_GEM) {
          const drop = makeDroppedGem(state, Pickup.cfgId[item], item, battleSession(state).roomSeed);
          if (drop === null) continue;
          grantLoot(state, playerId, player, drop, true);
          state.buses.events.emit(GameEventType.Pickup, playerId, PICKUP_GEM, Pickup.cfgId[item]);
        } else {
          state.buses.events.emit(GameEventType.Pickup, playerId, Pickup.kind[item], Pickup.cfgId[item]);
        }
        syncLocalProgress(state, playerId);
        if (!has(world, item, Dead)) {
          add(world, item, Dead);
        }
        break;
      }
    }
  }
}

/** order 15：经验升级，写三选一事件；默认自动应用第 0 项（auto 模式）。 */
export class ExpSystem {
  private readonly terms = [PlayerTag, PlayerId, Health];
  private readonly rng = new Rng(1);

  run(state: SimState, tick: number): void {
    const world = state.world;
    const session = battleSession(state);
    const players = query(world, this.terms);
    for (let i = 0; i < players.length; i++) {
      const eid = players[i];
      const playerId = PlayerId.value[eid];
      if (playerId >= MAX_PLAYERS || Health.cur[eid] <= 0) {
        continue;
      }
      let leveled = false;
      while (expByPlayer[playerId] >= expNeedByPlayer[playerId]) {
        expByPlayer[playerId] -= expNeedByPlayer[playerId];
        levelByPlayer[playerId] += 1;
        expNeedByPlayer[playerId] = EXP_CURVE(levelByPlayer[playerId] + 1);
        leveled = true;
      }
      if (!leveled) {
        continue;
      }
      this.rng.setState(hash32(session.roomSeed, playerId, tick, 0xe1e1));
      // 0..2 = 本武将技能槽等级 +1；3.. = STAT_DEFS 下标属性强化。
      const choiceCount = 3 + state.config.stats.all().length;
      for (let c = 0; c < 3; c++) {
        choicesByPlayer[playerId * 3 + c] = this.rng.int(choiceCount);
      }
      // auto 模式优先强化技能（割草输出成长）；manual 模式等待玩家点选真实卡片。
      const autoLevel = battleSession(state).autoLevel;
      let autoPick = 0;
      for (let c = 0; c < 3; c++) {
        if (choicesByPlayer[playerId * 3 + c] < 3) {
          autoPick = c;
          break;
        }
      }
      selectedByPlayer[playerId] = autoLevel === 0 ? -1 : autoPick;
      // 三选一数据仍在 choicesByPlayer，事件槽改为 HUD 可直接消费的语义：
      // a=等级(1-based)、b=升级所需经验、c=当前经验。
      state.buses.events.emit(
        GameEventType.LevelUp,
        levelByPlayer[playerId] + 1,
        expNeedByPlayer[playerId],
        expByPlayer[playerId],
      );
      syncLocalProgress(state, playerId);
    }
    // 每 tick 末尾刷新积分，保证击杀后即使本 tick 无拾取/升级也与 HUD 同步。
    syncLocalProgress(state, session.localPlayerId);
  }
}

/** order 16：应用三选一结果（选择写 Modifier → 标脏 → 下 tick 生效）。 */
export class LevelUpSystem {
  private readonly terms = [PlayerTag, PlayerId, Health];
  private damageStat = -1;

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;
    const players = query(world, this.terms);
    for (let i = 0; i < players.length; i++) {
      const eid = players[i];
      const playerId = PlayerId.value[eid];
      if (playerId >= MAX_PLAYERS || selectedByPlayer[playerId] < 0) {
        continue;
      }
      const choice = choicesByPlayer[playerId * 3 + selectedByPlayer[playerId]];
      selectedByPlayer[playerId] = -1;
      // 每级同时获得 4% 基础增伤：保证升级一定带来可感知的割草输出成长。
      if (this.damageStat < 0) {
        const stats = state.config.stats.all();
        for (let k = 0; k < stats.length; k++) if (stats[k].id === 'damage') this.damageStat = k;
      }
      createModifier(state, eid, {
        stat: Math.max(0, this.damageStat),
        op: 'ADD',
        value: 0.04,
        bucket: 0,
        priority: 4,
        sourceKind: sourceKindOf('skill'),
        group: 0,
      });
      if (choice < 3) {
        // 技能强化：直接放大已编译效果参数，不改系统顺序、不重编译。
        levelUpSkill(playerId, choice);
        levelSkillSlotDamage(state, eid, choice);
        continue;
      }
      const stat = choice - 3;
      const mod = state.pool.entities.acquire();
      add(world, mod, Modifier);
      add(world, mod, ModifierOwner(eid));
      Modifier.stat[mod] = stat;
      Modifier.op[mod] = StatOpCode.ADD;
      Modifier.bucket[mod] = 0;
      Modifier.priority[mod] = 6;
      Modifier.sourceKind[mod] = 6;
      Modifier.sourceId[mod] = eid;
      Modifier.group[mod] = mod;
      Modifier.value[mod] = stat === 0 || stat === 1 ? 25 : 3;
      Modifier.duration[mod] = 0;
      Modifier.condMask[mod] = 0;
      Modifier.flags[mod] = 0;
      DirtyStat.mask[eid] = 0xffffffff;
      if (stat === 0 || stat === 1) {
        Health.max[eid] += 25;
        Health.cur[eid] = Math.min(Health.max[eid], Health.cur[eid] + 25);
      }
    }
  }
}

/** order 17：BOSS 阶段阈值 + 地面预警 + 胜负判定。 */
export class BossSystem {
  private readonly terms = [AIState, Behavior, Health, Position];
  private readonly playerTerms = [PlayerTag, Health];
  private readonly rng = new Rng(1);

  run(state: SimState, tick: number): void {
    const world = state.world;
    const session = battleSession(state);
    const bosses = query(world, this.terms);
    const players = query(world, this.playerTerms);
    const allBosses = state.config.bosses.all();

    let bossAlive = false;
    for (let i = 0; i < bosses.length; i++) {
      const eid = bosses[i];
      const bossIndex = Behavior.p2[eid] | 0;
      if (bossIndex <= 0 || bossIndex > allBosses.length || Health.cur[eid] <= 0) {
        continue;
      }
      bossAlive = true;
      const def = allBosses[bossIndex - 1];
      const ratio = Health.cur[eid] / Math.max(1, Health.max[eid]);
      let phase = 0;
      for (let p = 0; p < def.phases.length; p++) {
        if (ratio <= def.phases[p].hpThreshold) {
          phase = p;
        }
      }
      if (bossPhase[eid] !== phase) {
        bossPhase[eid] = phase;
        state.buses.events.emit(GameEventType.BossPhase, eid, phase, bossIndex);
      }

      // 地面预警：预警期间 AI 读到 state=4 会停步，倒计时由 AISystem 推进。
      if (AIState.state[eid] !== 4 && (tick % 180) === 0) {
        const skills = def.phases[phase].skills;
        if (skills.length > 0) {
          const idx = this.rng.int(skills.length);
          AIState.state[eid] = 4;
          AIState.timer[eid] = skills[idx].telegraph;
          AIState.policy[eid] = idx >>> 0;
          state.buses.events.emit(GameEventType.BossWarn, eid, phase, idx);
        }
      }
    }

    // 到点登场：BOSS 选择由 roomSeed + tick 派生，跨设备一致。
    let spawnedThisTick = false;
    const mode = state.config.modes.all()[0];
    const atSec = mode?.bossAtSec ?? 420;
    if (session.bossSpawned === 0 && session.elapsed >= atSec && !bossAlive) {
      this.rng.setState(hash32(session.roomSeed, tick, 0xb055));
      const index = 1 + this.rng.int(allBosses.length);
      let px = 0;
      let py = 0;
      if (players.length > 0) {
        px = Position.x[players[0]];
        py = Position.y[players[0]];
      }
      const angle = this.rng.next() * Math.PI * 2;
      spawnBoss(state, index, px + cosLut(angle) * 240, py + sinLut(angle) * 240);
      session.bossSpawned = 1;
      spawnedThisTick = true;
      state.buses.events.emit(GameEventType.BossWarn, index, index, 0);
    }

    let anyAlive = false;
    for (let i = 0; i < players.length; i++) {
      if (Health.cur[players[i]] > 0) {
        anyAlive = true;
        break;
      }
    }
    if (session.role <= 1 && session.result === 0) {
      if (!anyAlive) {
        session.result = 2;
        state.buses.events.emit(GameEventType.Defeat, 0, 0, 0);
      } else if (session.elapsed >= 480) {
        session.result = 2;
        state.buses.events.emit(GameEventType.Defeat, 1, 0, 0);
      } else if (session.bossSpawned === 1 && !bossAlive && !spawnedThisTick) {
        session.result = 1;
        state.buses.events.emit(GameEventType.Victory, 0, 0, 0);
      }
    }
  }
}

/** 生成 BOSS（1-based 配置下标），供 BossSystem / 场景脚本调用。 */
export function spawnBoss(state: SimState, bossIndex: number, x: number, y: number): Eid {
  return spawnCombatEntity(state, {
    enemyId: 'boss_minion',
    x,
    y,
    faction: 1,
    bossIndex,
    ownerPlayerId: 0,
  });
}
