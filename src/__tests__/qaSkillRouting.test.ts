/**
 * QA 独立复核 — E1 武将技能路由（严过关）。
 *
 * 本文件由 QA 独立编写，只用全局 describe / it / expect / beforeEach
 * （vite.config.ts 已 globals:true），不 import vitest。
 * 独立证明：
 *   1) 刘备 / 关羽 / 赵云技 1 映射到三个不同的 effectId；
 *   2) 按技 2 只激活技 2 槽位，技 1 / 技 3 槽位保持未触发（槽位互斥）；
 *   3) 赵云技 1（声明层为 onHit 的 spear_thrust）按键可触发并造成真实伤害；
 *   4) 闪避（a=3）由通用普攻兜底仍造成伤害，且不误触任何武将槽位；
 *   5) 重开换将后编译表整体替换，旧将效果不残留。
 */
import type { App } from '../app/App';
import {
  CAST_BUTTON_MASK,
  SKILL_SLOT_COUNT,
  SKILL_SLOT_FLAG_BASE,
  SKILL_SLOT_MASK,
} from '../core/Constants';
import { buildGameConfig } from '../data/index';
import { resolveSkillSlots, validateGeneralSkills } from '../data/skillSlots';
import { CommandType, GameEventType } from '../ecs/bridge/enums';
import { createEventSlot, type GameEvent } from '../ecs/bridge/GameEventBus';
import { query } from '../ecs/bit/adapter';
import {
  ActiveEffect,
  EffectContext,
  EffectTag,
  effectMask,
  EnemyTag,
  Health,
  PlayerId,
  PlayerTag,
  Position,
} from '../ecs/bit/components';
import { TriggerBit } from '../ecs/components/effect';
import { skillSlotOfMask } from '../ecs/systems/EffectSystems';
import {
  getSimTick,
  registerSimSystem,
  resetScheduler,
  stepTick,
  type SimState,
} from '../ecs/scheduler';
import { register } from '../registration/systems';

interface QaRig {
  readonly state: SimState;
  readonly counts: Record<number, number>;
  readonly seq: { value: number };
  readonly startBattle: (mode: string, generalId: string) => void;
}

interface QaCompiled {
  readonly eid: number;
  readonly effectId: string;
  readonly slot: -1 | 0 | 1 | 2;
  readonly mask: number;
}

/** 造一个可独立 stepTick 的战斗宿主，并立刻开局到指定武将。 */
function makeQaRig(generalId: string): QaRig {
  resetScheduler();
  const state = {} as SimState;
  const app = {
    state,
    registerSimSystem(order: number, fn: (s: SimState, t: number) => void, id: string): void {
      registerSimSystem(order, fn, id);
    },
  } as unknown as App;
  register(app);
  const controls = state.session as unknown as { startBattle(mode: string, id: string): void };
  controls.startBattle('campaign_8min', generalId);

  const counts: Record<number, number> = {};
  const sink: GameEvent[] = [];
  for (let i = 0; i < 256; i++) sink.push(createEventSlot());
  const drain = (): void => {
    const n = state.buses.events.drain(sink);
    for (let i = 0; i < n; i++) {
      const t = sink[i].type;
      counts[t] = (counts[t] ?? 0) + 1;
    }
  };
  // 记录 drain 供 runTicks 使用（闭包）
  rigDrain.set(state, drain);
  return {
    state,
    counts,
    seq: { value: 0 },
    startBattle: (mode: string, id: string) => controls.startBattle(mode, id),
  };
}

const rigDrain = new WeakMap<SimState, () => void>();

function issueSkill(rig: QaRig, commandA: number): void {
  rig.state.buses.commands.push({
    type: CommandType.Skill,
    playerId: 0,
    a: commandA,
    b: 0,
    c: 0,
    seq: ++rig.seq.value,
  });
}

function advance(rig: QaRig, ticks: number): void {
  const drain = rigDrain.get(rig.state);
  const base = getSimTick();
  for (let i = 1; i <= ticks; i++) {
    stepTick(rig.state, base + i);
    if (drain !== undefined) drain();
  }
}

function localSeat(state: SimState): number {
  const seats = query(state.world, [PlayerTag, PlayerId]);
  for (let i = 0; i < seats.length; i++) {
    if (PlayerId.value[seats[i]] === 0) return seats[i];
  }
  throw new Error('未找到 PlayerId=0 的本地席位');
}

/** 读取本地席位编译出的全部效果主实体及其槽位掩码。 */
function compiledOfLocal(state: SimState): QaCompiled[] {
  const seat = localSeat(state);
  const defs = state.config.effects.all();
  const entities = query(state.world, [EffectTag, ActiveEffect, effectMask]);
  const out: QaCompiled[] = [];
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i];
    if ((EffectContext.source[eid] >>> 0) !== seat) continue;
    const def = defs[ActiveEffect.defId[eid] - 1];
    if (def === undefined) continue;
    out.push({ eid, effectId: def.id, slot: skillSlotOfMask(effectMask.value[eid]), mask: effectMask.value[eid] });
  }
  return out;
}

function cdOf(compiled: readonly QaCompiled[], effectId: string): number {
  const view = compiled.find((v) => v.effectId === effectId);
  if (view === undefined) throw new Error(`本地席位未编译效果 ${effectId}`);
  return ActiveEffect.cd[view.eid];
}

function firstLivingEnemy(state: SimState): number {
  const enemies = query(state.world, [EnemyTag]);
  for (let i = 0; i < enemies.length; i++) {
    if (Health.cur[enemies[i]] > 0) return enemies[i];
  }
  throw new Error('没有存活敌人');
}

function seatBeside(state: SimState, target: number): void {
  const seat = localSeat(state);
  Position.x[seat] = Position.x[target] - 40;
  Position.y[seat] = Position.y[target];
}

beforeEach(() => {
  resetScheduler();
});

describe('QA 独立复核：E1 技能表与键位路由', () => {
  it('内容完整性：40 将各 3 个互异技能，effectId 可解析，普攻不入表', () => {
    const cfg = buildGameConfig();
    expect(validateGeneralSkills(cfg)).toEqual([]);
    expect(cfg.generals.all()).toHaveLength(40);
    for (const g of cfg.generals.all()) {
      expect(g.skills).toHaveLength(SKILL_SLOT_COUNT);
      expect(new Set(g.skills).size).toBe(SKILL_SLOT_COUNT);
      expect(g.skills).not.toContain('basic_attack');
      const slots = resolveSkillSlots(cfg, g.id);
      expect(slots).toHaveLength(SKILL_SLOT_COUNT);
      for (let s = 0; s < SKILL_SLOT_COUNT; s++) {
        expect(slots[s].slot).toBe(s);
        expect(slots[s].commandA).toBe(s);
        expect(slots[s].buttonBit).toBe(1 << s);
        expect(cfg.effects.has(slots[s].effectId)).toBe(true);
      }
    }
  });

  it('刘备/关羽/赵云技1 → 三个不同 effectId（含声明为 onHit 的 spear_thrust）', () => {
    const cfg = buildGameConfig();
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['liubei', 'eff_sweeping_slash'],
      ['guanyu', 'eff_dragon_roar'],
      ['zhaoyun', 'eff_spear_thrust'],
    ];
    const ids: string[] = [];
    for (const [generalId, want] of expected) {
      const resolved = resolveSkillSlots(cfg, generalId)[0].effectId;
      expect(resolved, `${generalId} 技1 解析结果`).toBe(want);
      ids.push(resolved);

      const rig = makeQaRig(generalId);
      const compiled = compiledOfLocal(rig.state);
      expect(compiled, `${generalId} 编译数量`).toHaveLength(4);
      const view = compiled.find((v) => v.effectId === want);
      expect(view, `${generalId} 应编译 ${want}`).toBeDefined();
      expect(view!.slot).toBe(0);
      expect(view!.mask & TriggerBit.onCast).toBe(TriggerBit.onCast);
      expect(view!.mask & SKILL_SLOT_FLAG_BASE).toBe(SKILL_SLOT_FLAG_BASE);
    }
    expect(new Set(ids).size).toBe(3);
    expect(cfg.effects.get('eff_spear_thrust').trigger).toBe('onHit');
  });

  it('槽位互斥：按技2 只触发技2，技1/技3 冷却保持 0；普攻兜底', () => {
    const rig = makeQaRig('liubei');
    advance(rig, 1);
    issueSkill(rig, 1); // 技2 = war_cry
    advance(rig, 2);

    const compiled = compiledOfLocal(rig.state);
    // 每个 slot 只写自己的高位，且共用 CAST_BUTTON_MASK 的普攻无高位。
    for (const v of compiled) {
      expect(skillSlotOfMask(v.mask)).toBe(v.slot);
      if (v.slot < 0) expect(v.mask & SKILL_SLOT_MASK).toBe(0);
    }
    expect(cdOf(compiled, 'eff_war_cry'), '技2 应触发').toBeGreaterThan(0);
    expect(cdOf(compiled, 'eff_sweeping_slash'), '技1 不应被技2 触发').toBe(0);
    expect(cdOf(compiled, 'eff_tiger_charge'), '技3 不应被技2 触发').toBe(0);
    expect(cdOf(compiled, 'eff_basic_attack'), '任意 cast 位兜底普攻').toBeGreaterThan(0);
  });

  it('赵云技1（原 onHit 配置）按键即触发并造成真实伤害', () => {
    const rig = makeQaRig('zhaoyun');
    advance(rig, 90);
    const target = firstLivingEnemy(rig.state);
    seatBeside(rig.state, target);
    const hpBefore = Health.cur[target];

    issueSkill(rig, 0);
    advance(rig, 4);

    const compiled = compiledOfLocal(rig.state);
    expect(cdOf(compiled, 'eff_spear_thrust'), '原 onHit 效果按槽位强制 onCast 后可触发').toBeGreaterThan(0);
    expect(Health.cur[target], '赵云技1 应造成真实伤害').toBeLessThan(hpBefore);
  });

  it('闪避（a=3）由通用普攻兜底扣血，且不激活任何武将槽位', () => {
    const rig = makeQaRig('liubei');
    advance(rig, 90);
    const target = firstLivingEnemy(rig.state);
    seatBeside(rig.state, target);
    const hpBefore = Health.cur[target];
    const dmgBefore = rig.counts[GameEventType.Damage] ?? 0;

    expect(CAST_BUTTON_MASK & (1 << 3)).toBe(1 << 3);
    issueSkill(rig, 3); // 闪避位
    advance(rig, 6);

    expect(Health.cur[target], '闪避按键仍由普攻兜底扣血').toBeLessThan(hpBefore);
    expect(rig.counts[GameEventType.Damage] ?? dmgBefore).toBeGreaterThan(dmgBefore);
    const compiled = compiledOfLocal(rig.state);
    expect(cdOf(compiled, 'eff_basic_attack')).toBeGreaterThan(0);
    for (const v of compiled) {
      if (v.slot >= 0) expect(ActiveEffect.cd[v.eid], `闪避不应触发槽位 ${v.slot}`).toBe(0);
    }
  });

  it('重开换将：编译表整体替换，旧将技能不残留', () => {
    const rig = makeQaRig('liubei');
    const before = compiledOfLocal(rig.state).map((v) => v.effectId);
    expect(before).toContain('eff_war_cry');
    expect(before).not.toContain('eff_dragon_roar');

    rig.startBattle('campaign_8min', 'guanyu');
    const after = compiledOfLocal(rig.state);
    const ids = after.map((v) => v.effectId);
    expect(after).toHaveLength(4);
    expect(ids).toContain('eff_dragon_roar');
    expect(ids).toContain('eff_sweeping_slash');
    expect(ids).toContain('eff_basic_attack');
    expect(ids).not.toContain('eff_war_cry');
  });
});
