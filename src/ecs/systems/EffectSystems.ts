/**
 * 效果管线（ARCHITECTURE §6.3 order 10/11，DESIGN §6.1）。
 *
 * 编译层 EffectCompileSystem 只在开局 / 换装 / 升级时运行：从 EffectEntityPool
 * 预分配「主效果实体 + Condition/Action 子实体」，参数写入 ParamPool，宿主掩码置位。
 * 运行层 EffectTriggerSystem 只做掩码短路；ActionDispatchSystem 按 op 数字下标 O(1) 分派。
 * 运行期零 addEntity、零闭包创建、零字符串查找。
 */
import {
  CAST_BUTTON_MASK,
  CAP,
  SKILL_SLOT_COUNT,
  SKILL_SLOT_FLAG_BASE,
  SKILL_SLOT_MASK,
  TICK_DT,
  assert,
} from '../../core/Constants';
import type { ActionOp, EffectDef, TriggerType } from '../../data/types';
import type { Eid } from '../bit/types';
import { add, has, query, queryNoCommit } from '../bit/adapter';
import {
  Action,
  ActiveEffect,
  AIState,
  Attack,
  ChildOf,
  Condition,
  DirtyStat,
  EffectContext,
  EffectOwner,
  EffectTag,
  effectMask,
  Faction,
  Health,
  InputCmd,
  Modifier,
  ModifierOwner,
  Position,
  TriggerReg,
} from '../bit/components';
import { CompareCode } from '../components/effect';
import { TriggerBit } from '../components/effect';
import { FactionValue } from '../components/core';
import { SourceKind, StatOpCode } from '../components/stat';
import { applyDamage, fireProjectile } from './CombatSystems';
import { spawnCombatEntity, spawnPickup } from './LifecycleSystems';
import { markStatDirty } from './StatResolveSystem';
import type { SimState } from '../scheduler';

/** 编译期顺序即数值编码；冻结表，运行期只按数字索引访问。 */
const TRIGGER_NAMES: readonly TriggerType[] = [
  'onHit', 'onKill', 'onCast', 'onDamaged', 'onMove', 'onTimer', 'onDeath', 'onPickup', 'onCritical',
];
const ACTION_NAMES: readonly ActionOp[] = [
  'damage', 'heal', 'buffStat', 'summon', 'spawnProjectile', 'area', 'status', 'cdReduce', 'dropItem',
];
const CONDITION_NAMES: readonly string[] = ['stat', 'health', 'target', 'flags', 'tick'];

/** Action.op 数值编码（与 ACTION_NAMES 下标完全一致）。 */
export const ActionOpCode = {
  damage: 0,
  heal: 1,
  buffStat: 2,
  summon: 3,
  spawnProjectile: 4,
  area: 5,
  status: 6,
  cdReduce: 7,
  dropItem: 8,
} as const;

/** 触发位数值表（与 TriggerBit 对齐，供掩码查表用，避免字符串比较）。 */
const TRIGGER_BITS: readonly number[] = [
  TriggerBit.onHit, TriggerBit.onKill, TriggerBit.onCast, TriggerBit.onDamaged,
  TriggerBit.onMove, TriggerBit.onTimer, TriggerBit.onDeath, TriggerBit.onPickup,
  TriggerBit.onCritical,
];

function triggerBitOf(name: TriggerType): number {
  for (let i = 0; i < TRIGGER_NAMES.length; i++) {
    if (TRIGGER_NAMES[i] === name) {
      return TRIGGER_BITS[i];
    }
  }
  return 0;
}

function actionCodeOf(name: ActionOp): number {
  for (let i = 0; i < ACTION_NAMES.length; i++) {
    if (ACTION_NAMES[i] === name) {
      return i;
    }
  }
  return -1;
}

function conditionCodeOf(name: string): number {
  for (let i = 0; i < CONDITION_NAMES.length; i++) {
    if (CONDITION_NAMES[i] === name) {
      return i;
    }
  }
  return 0;
}

function compareCodeOf(name: string): number {
  const table: Record<string, number> = {
    EQ: CompareCode.EQ, NE: CompareCode.NE, GT: CompareCode.GT,
    GE: CompareCode.GE, LT: CompareCode.LT, LE: CompareCode.LE, HAS: CompareCode.HAS,
  };
  return table[name] ?? CompareCode.EQ;
}

/** buffStat 动作预分配的 Modifier 载体：actionEid → modifierEid，零运行时分配。 */
const buffCarrier = new Int32Array(CAP);
/** 已编译的 (owner, slot, effectId) 集合，仅编译期使用；同效果不同槽位视为不同实体。 */
const compiledEffects = new Set<string>();

/** 清空编译期映射（新建世界 / 测试隔离时调用）。 */
export function resetEffectRuntime(): void {
  buffCarrier.fill(0);
  compiledEffects.clear();
}

/**
 * 只读解析效果掩码中的槽位绑定（调试 / 测试用）。
 * 编码统一为 SKILL_SLOT_FLAG_BASE << slot（one-hot，bits16..18）；
 * 同时兼容架构表按「值 = slot+1」书写的 3<<16，便于人工构造掩码复核。
 * @returns -1 表示通用效果（无槽位），0..2 表示武将技能槽。
 */
export function skillSlotOfMask(mask: number): -1 | 0 | 1 | 2 {
  const encoded = (mask & SKILL_SLOT_MASK) >>> 16;
  if (encoded === 0) return -1;
  if (encoded === 1) return 0;
  if (encoded === 2) return 1;
  if (encoded === 3 || encoded === 4) return 2;
  return -1;
}

/** 槽位参数非法必须断言（1xxx 配置错误），不静默降级成通用效果。 */
function slotFlagOf(slot: number | undefined): number {
  if (slot === undefined) return 0;
  assert(
    Number.isInteger(slot) && slot >= 0 && slot < SKILL_SLOT_COUNT,
    1011,
    `非法技能槽位: ${slot}`,
  );
  return SKILL_SLOT_FLAG_BASE << slot;
}

export type ActionHandler = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array) => void;

/**
 * 效果动作注册表：op 数字下标 → handler。内建处理器在构造期注册一次，
 * 复杂效果可用 register() 覆盖对应 op，无需改动战斗循环。
 */
export class EffectRegistry {
  private readonly handlers: Array<ActionHandler | undefined> = new Array<ActionHandler | undefined>(ACTION_NAMES.length);

  constructor() {
    this.handlers[ActionOpCode.damage] = this.handleDamage;
    this.handlers[ActionOpCode.heal] = this.handleHeal;
    this.handlers[ActionOpCode.buffStat] = this.handleBuffStat;
    this.handlers[ActionOpCode.summon] = this.handleSummon;
    this.handlers[ActionOpCode.spawnProjectile] = this.handleProjectile;
    this.handlers[ActionOpCode.area] = this.handleArea;
    this.handlers[ActionOpCode.status] = this.handleStatus;
    this.handlers[ActionOpCode.cdReduce] = this.handleCdReduce;
    this.handlers[ActionOpCode.dropItem] = this.handleDropItem;
  }

  register(op: number, handler: ActionHandler): void {
    this.handlers[op] = handler;
  }

  dispatch(op: number, state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void {
    const handler = this.handlers[op];
    if (handler !== undefined) {
      handler(state, actionEid, owner, params);
    }
  }

  private handleDamage = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void => {
    const ref = Action.paramRef[actionEid];
    const amount = params[ref];
    const radius = params[ref + 1];
    if (radius <= 0) {
      const target = EffectContext.target[0] >>> 0;
      if (target !== 0 && target < CAP) {
        applyDamage(state, target, amount, 0, owner);
      }
      return;
    }
    this.areaDamage(state, owner, params[ref], radius, params[ref + 2]);
  };

  private handleHeal = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void => {
    const world = state.world;
    if (!has(world, owner, Health)) {
      return;
    }
    const ref = Action.paramRef[actionEid];
    const value = Health.cur[owner] + params[ref];
    Health.cur[owner] = value > Health.max[owner] ? Health.max[owner] : value;
  };

  private handleBuffStat = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void => {
    const modEid = buffCarrier[actionEid];
    if (modEid === 0) {
      return;
    }
    const ref = Action.paramRef[actionEid];
    const names = state.config.stats.all();
    const statIndex = params[ref] | 0;
    Modifier.stat[modEid] = statIndex < names.length ? statIndex : 0;
    Modifier.op[modEid] = StatOpCode.ADD;
    Modifier.bucket[modEid] = 0;
    Modifier.priority[modEid] = 8;
    Modifier.sourceKind[modEid] = SourceKind.Buff;
    Modifier.sourceId[modEid] = actionEid;
    Modifier.group[modEid] = actionEid;
    Modifier.condMask[modEid] = 0;
    Modifier.duration[modEid] = params[ref + 2];
    Modifier.flags[modEid] = 0;
    Modifier.value[modEid] = params[ref + 1];
    markStatDirty(state.world, owner);
  };

  private handleSummon = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void => {
    const ref = Action.paramRef[actionEid];
    const world = state.world;
    const x = has(world, owner, Position) ? Position.x[owner] : 0;
    const y = has(world, owner, Position) ? Position.y[owner] : 0;
    for (let i = 0; i < params[ref]; i++) {
      const angle = (i * Math.PI * 2) / Math.max(1, params[ref]);
      spawnCombatEntity(state, {
        enemyId: 'huangjin',
        x: x + Math.cos(angle) * 40,
        y: y + Math.sin(angle) * 40,
        faction: FactionValue.Player,
        hpOverride: 45,
        damageOverride: 14,
        lifetime: params[ref + 1],
        ownerPlayerId: 0,
      });
    }
  };

  private handleProjectile = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void => {
    const ref = Action.paramRef[actionEid];
    const world = state.world;
    let dx = 1;
    let dy = 0;
    if (has(world, owner, Position)) {
      const tx = EffectContext.target[0] >>> 0;
      if (tx !== 0 && has(world, tx, Position)) {
        dx = Position.x[tx] - Position.x[owner];
        dy = Position.y[tx] - Position.y[owner];
      }
    }
    const count = Math.max(1, params[ref + 1] | 0);
    for (let i = 0; i < count; i++) {
      const angle = (i * Math.PI * 2) / count;
      fireProjectile(
        state, owner,
        dx * Math.cos(angle) - dy * Math.sin(angle),
        dx * Math.sin(angle) + dy * Math.cos(angle),
        params[ref],
        18 + params[ref + 2],
        2.5,
        FactionValue.Player,
        0,
      );
    }
  };

  private handleArea = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void => {
    const ref = Action.paramRef[actionEid];
    this.areaDamage(state, owner, 0, params[ref], params[ref + 2]);
  };

  private handleStatus = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void => {
    const ref = Action.paramRef[actionEid];
    const world = state.world;
    const units = query(world, [Faction, Position, Health]);
    const ox = has(world, owner, Position) ? Position.x[owner] : 0;
    const oy = has(world, owner, Position) ? Position.y[owner] : 0;
    const radius = params[ref];
    for (let i = 0; i < units.length; i++) {
      const eid = units[i];
      if (Faction.value[eid] !== FactionValue.Enemy || Health.cur[eid] <= 0) {
        continue;
      }
      const dx = Position.x[eid] - ox;
      const dy = Position.y[eid] - oy;
      if (dx * dx + dy * dy > radius * radius) {
        continue;
      }
      if (!has(world, eid, AIState)) {
        add(world, eid, AIState);
      }
      AIState.state[eid] = 5;
      AIState.timer[eid] = params[ref + 1];
    }
  };

  private handleCdReduce = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void => {
    const world = state.world;
    if (!has(world, owner, Attack)) {
      return;
    }
    const ref = Action.paramRef[actionEid];
    Attack.cd[owner] = Math.max(0, Attack.cd[owner] - params[ref]);
  };

  private handleDropItem = (state: SimState, actionEid: Eid, owner: Eid, params: Float32Array): void => {
    const ref = Action.paramRef[actionEid];
    const world = state.world;
    const x = has(world, owner, Position) ? Position.x[owner] : 0;
    const y = has(world, owner, Position) ? Position.y[owner] : 0;
    spawnPickup(state, x, y, params[ref], params[ref + 1], params[ref + 2]);
  };

  /** 范围伤害共用实现（owner 之外的敌人，距离平方判定）。 */
  private areaDamage(state: SimState, owner: Eid, base: number, radius: number, multiplier: number): void {
    const world = state.world;
    const units = query(world, [Faction, Position, Health]);
    const ox = has(world, owner, Position) ? Position.x[owner] : 0;
    const oy = has(world, owner, Position) ? Position.y[owner] : 0;
    const amount = base > 0 ? base : 24;
    for (let i = 0; i < units.length; i++) {
      const eid = units[i];
      if (Faction.value[eid] !== FactionValue.Enemy || Health.cur[eid] <= 0) {
        continue;
      }
      const dx = Position.x[eid] - ox;
      const dy = Position.y[eid] - oy;
      if (dx * dx + dy * dy > radius * radius) {
        continue;
      }
      applyDamage(state, eid, amount * (multiplier > 0 ? multiplier : 1), 0, owner);
    }
  }
}

/**
 * 按需编译：把声明层 EffectDef 展开为预分配实体。
 * 运行期绝不调用本类；宿主可从 GameEventBus 的 LevelUp/Equip 触发重新编译。
 */
export class EffectCompileSystem {
  constructor(private readonly registry: EffectRegistry) {}

  /** 给宿主编译一组效果 id；slot 省略时为通用效果，指定时强制按 onCast 语义编译。 */
  compileAll(state: SimState, owner: Eid, effectIds: readonly string[], slot?: number): void {
    for (let i = 0; i < effectIds.length; i++) {
      this.compile(state, owner, effectIds[i], slot);
    }
  }

  /** 编译单个效果；重复编译同一 (owner, slot, effectId) 会被编译表短路。 */
  compile(state: SimState, owner: Eid, effectId: string, slot?: number): void {
    const def = state.config.effects.tryGet(effectId);
    if (def === undefined) {
      return;
    }
    const slotFlag = slotFlagOf(slot);
    const slotKey = slot === undefined ? -1 : slot;
    const world = state.world;
    const key = owner + ':' + slotKey + ':' + effectId;
    if (compiledEffects.has(key)) {
      return;
    }
    compiledEffects.add(key);
    const all = state.config.effects.all();
    let cfgId = 0;
    for (let i = 0; i < all.length; i++) {
      if (all[i].id === effectId) {
        cfgId = i + 1;
        break;
      }
    }

    // 槽位效果强制 onCast：忽略 EffectDef.trigger，解决原 onHit 技能按键不生效的问题。
    const bit = slotFlag === 0 ? triggerBitOf(def.trigger) : TriggerBit.onCast;
    if (!has(world, owner, effectMask)) {
      add(world, owner, effectMask);
      effectMask.value[owner] = 0;
    }
    effectMask.value[owner] |= bit;

    const params = state.pool.params;
    const ref = params.alloc(def.params.length);
    if (ref < 0) {
      return;
    }
    params.write(ref, def.params);

    const main = state.pool.effects.compile(cfgId, owner);
    ActiveEffect.defId[main] = cfgId;
    ActiveEffect.state[main] = 0;
    effectMask.value[main] = (bit | slotFlag) >>> 0;
    EffectContext.source[main] = owner >>> 0;
    EffectContext.target[main] = 0;
    if (def.trigger === 'onTimer') {
      ActiveEffect.cd[main] = 1;
    }

    this.compileConditions(state, main, def);
    this.compileActions(state, main, owner, def, ref);
  }

  private compileConditions(state: SimState, main: Eid, def: EffectDef): void {
    const world = state.world;
    let condMask = 0;
    for (let i = 0; i < def.conditions.length && i < 32; i++) {
      const cond = def.conditions[i];
      const child = state.pool.effects.acquire();
      add(world, child, EffectTag);
      add(world, child, Condition);
      add(world, child, ChildOf(main));
      Condition.type[child] = conditionCodeOf(cond.type);
      Condition.cmp[child] = compareCodeOf(cond.cmp);
      Condition.threshold[child] = cond.threshold;
      Condition.arg[child] = cond.arg >>> 0;
      condMask |= 1 << i;
    }
    TriggerReg.condMask[main] = condMask >>> 0;
  }

  private compileActions(state: SimState, main: Eid, owner: Eid, def: EffectDef, paramRef: number): void {
    const world = state.world;
    for (let i = 0; i < def.actions.length; i++) {
      const action = def.actions[i];
      const code = actionCodeOf(action.op);
      if (code < 0) {
        continue;
      }
      const child = state.pool.effects.acquire();
      add(world, child, EffectTag);
      add(world, child, Action);
      add(world, child, ChildOf(main));
      add(world, child, TriggerReg);
      Action.op[child] = code;
      Action.paramRef[child] = (paramRef + action.paramRef) >>> 0;
      Action.paramCount[child] = action.paramCount >>> 0;
      TriggerReg.effectCfgId[child] = (paramRef + action.paramRef) >>> 0;
      TriggerReg.paramRef[child] = action.paramCount >>> 0;
      EffectContext.source[child] = owner >>> 0;
      EffectContext.target[child] = main >>> 0;

      if (code === ActionOpCode.buffStat) {
        const modEid = state.pool.entities.acquire();
        add(world, modEid, Modifier);
        add(world, modEid, ModifierOwner(owner));
        Modifier.stat[modEid] = 0;
        Modifier.op[modEid] = StatOpCode.ADD;
        Modifier.bucket[modEid] = 0;
        Modifier.priority[modEid] = 8;
        Modifier.sourceKind[modEid] = SourceKind.Buff;
        Modifier.sourceId[modEid] = child;
        Modifier.group[modEid] = child;
        Modifier.value[modEid] = 0;
        Modifier.duration[modEid] = 0;
        buffCarrier[child] = modEid;
      }
    }
  }
}

/** order 10：掩码短路，只有本 tick 被触发的效果进入 Active。 */
export class EffectTriggerSystem {
  private readonly terms = [EffectTag, ActiveEffect, effectMask];

  run(state: SimState, tick: number): void {
    void tick;
    const entities = queryNoCommit(state.world, this.terms);
    const flags = EffectContext.flags[0];
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      // 冷却必须逐 tick 递减：ActionDispatchSystem 只负责写入 0.1s 冷却，
      // 若这里不推进，效果在首次触发后会永久停在 Cooldown，后续施法全部空转。
      if (ActiveEffect.cd[eid] > 0) {
        ActiveEffect.cd[eid] = Math.max(0, ActiveEffect.cd[eid] - TICK_DT);
        continue;
      }
      const mask = effectMask.value[eid];
      let allowed = false;
      if ((mask & TriggerBit.onCast) !== 0) {
        // onCast 逐宿主判定：只读自己的 InputCmd.buttons，修掉多玩家全局串扰。
        const owner = EffectContext.source[eid] >>> 0;
        if (owner !== 0 && owner < CAP) {
          const buttons = InputCmd.buttons[owner] >>> 0;
          const slot = skillSlotOfMask(mask);
          const needed = slot < 0 ? CAST_BUTTON_MASK : (1 << slot);
          allowed = (buttons & needed) !== 0;
        }
      } else {
        // 非 onCast（onHit/onKill/onCritical/...）保持原全局 flags 语义，改动面最小。
        allowed = flags !== 0 && (mask & flags) !== 0;
      }
      if (!allowed) {
        continue;
      }
      ActiveEffect.state[eid] = 1;
      ActiveEffect.elapsed[eid] = 0;
    }
  }
}

/** order 11：数字下标 O(1) 分派，执行后立刻回到 Cooldown，保证单 tick 只触发一次。 */
export class ActionDispatchSystem {
  private readonly actionTerms = [EffectTag, Action];
  private readonly effectTerms = [EffectTag, ActiveEffect];

  constructor(private readonly registry: EffectRegistry) {}

  run(state: SimState, tick: number): void {
    void tick;
    const world = state.world;
    const actions = queryNoCommit(world, this.actionTerms);
    const params = state.pool.params.data;
    for (let i = 0; i < actions.length; i++) {
      const eid = actions[i];
      const main = EffectContext.target[eid] >>> 0;
      if (main === 0 || ActiveEffect.state[main] !== 1) {
        continue;
      }
      const owner = EffectContext.source[eid] >>> 0;
      this.registry.dispatch(Action.op[eid], state, eid, owner, params);
    }
    const effects = query(world, this.effectTerms);
    for (let i = 0; i < effects.length; i++) {
      const eid = effects[i];
      if (ActiveEffect.state[eid] === 1) {
        ActiveEffect.state[eid] = 2;
        ActiveEffect.cd[eid] = 0.1;
      }
    }
  }
}

/** 编译期只走一次的字符串映射，供 UI / 换装层调用。 */
export function triggerBitFor(name: TriggerType): number {
  return triggerBitOf(name);
}

/** 运行期读取 effectMask（供调试面板，不参与逻辑）。 */
export function effectMaskOf(world: import('../bit/adapter').BattleWorld, eid: Eid): number {
  return has(world, eid, effectMask) ? effectMask.value[eid] : 0;
}
