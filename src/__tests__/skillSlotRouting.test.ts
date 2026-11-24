/**
 * E1 增量回归：键位 → 武将技能槽 → 效果编译 → 按宿主触发 → 真实伤害。
 *
 * 本文件只使用全局 describe / it / expect（vite.config.ts globals:true）。
 * 证明四件事：40 将 ×3 互异；槽位互斥；换将重开编译表改变；闪避仍由通用普攻兜底。
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

interface TestRig {
  readonly state: SimState;
  readonly counts: Record<number, number>;
  readonly drain: () => void;
  readonly seq: { value: number };
  readonly controls: { startBattle(mode: string, generalId: string): void };
}

interface CompiledView {
  readonly eid: number;
  readonly effectId: string;
  readonly slot: -1 | 0 | 1 | 2;
}

function makeRig(generalId: string = 'liubei'): TestRig {
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
  const out: GameEvent[] = [];
  for (let i = 0; i < 256; i++) out.push(createEventSlot());
  const drain = (): void => {
    const count = state.buses.events.drain(out);
    for (let i = 0; i < count; i++) {
      const type = out[i].type;
      counts[type] = (counts[type] ?? 0) + 1;
    }
  };
  return { state, counts, drain, seq: { value: 0 }, controls };
}

function pushSkill(rig: TestRig, commandA: number): void {
  rig.state.buses.commands.push({
    type: CommandType.Skill,
    playerId: 0,
    a: commandA,
    b: 0,
    c: 0,
    seq: ++rig.seq.value,
  });
}

function runTicks(rig: TestRig, count: number): void {
  const base = getSimTick();
  for (let i = 1; i <= count; i++) {
    stepTick(rig.state, base + i);
    rig.drain();
  }
}

function localPlayer(state: SimState): number {
  const players = query(state.world, [PlayerTag, PlayerId]);
  for (let i = 0; i < players.length; i++) {
    if (PlayerId.value[players[i]] === 0) return players[i];
  }
  throw new Error('找不到本地真人席位');
}

/** 读取本地席位编译出的主效果实体（configId → effectId，含槽位掩码）。 */
function compiledForLocal(state: SimState): CompiledView[] {
  const player = localPlayer(state);
  const defs = state.config.effects.all();
  const effects = query(state.world, [EffectTag, ActiveEffect, effectMask]);
  const result: CompiledView[] = [];
  for (let i = 0; i < effects.length; i++) {
    const eid = effects[i];
    if ((EffectContext.source[eid] >>> 0) !== player) continue;
    const def = defs[ActiveEffect.defId[eid] - 1];
    if (def === undefined) continue;
    result.push({ eid, effectId: def.id, slot: skillSlotOfMask(effectMask.value[eid]) });
  }
  return result;
}

function cdOf(compiled: readonly CompiledView[], effectId: string): number {
  const view = compiled.find((item) => item.effectId === effectId);
  if (view === undefined) throw new Error(`未编译效果 ${effectId}`);
  return ActiveEffect.cd[view.eid];
}

function livingEnemy(state: SimState): number {
  const enemies = query(state.world, [EnemyTag]);
  for (let i = 0; i < enemies.length; i++) {
    if (Health.cur[enemies[i]] > 0) return enemies[i];
  }
  throw new Error('没有存活敌人可供伤害断言');
}

function placePlayerNextTo(state: SimState, target: number): void {
  const player = localPlayer(state);
  Position.x[player] = Position.x[target] - 40;
  Position.y[player] = Position.y[target];
}

beforeEach(() => {
  resetScheduler();
});

describe('E1 技能槽：数据、编译与键位路由', () => {
  it('40 将 × 3 个互异 skill，effectId 可解析，键位冻结为 0/1/2', () => {
    const cfg = buildGameConfig();
    expect(validateGeneralSkills(cfg)).toEqual([]);
    expect(cfg.generals.all()).toHaveLength(40);
    expect(CAST_BUTTON_MASK & (1 << 3)).toBe(1 << 3);

    for (const general of cfg.generals.all()) {
      expect(general.skills).toHaveLength(SKILL_SLOT_COUNT);
      expect(new Set(general.skills).size).toBe(SKILL_SLOT_COUNT);
      expect(general.skills).not.toContain('basic_attack');
      const bindings = resolveSkillSlots(cfg, general.id);
      expect(bindings).toHaveLength(SKILL_SLOT_COUNT);
      for (let slot = 0; slot < SKILL_SLOT_COUNT; slot++) {
        const binding = bindings[slot];
        expect(binding.slot).toBe(slot);
        expect(binding.commandA).toBe(slot);
        expect(binding.buttonBit).toBe(1 << slot);
        expect(cfg.effects.has(binding.effectId)).toBe(true);
      }
    }
  });

  it('刘备技1 → eff_sweeping_slash，关羽技1 → eff_dragon_roar，赵云技1 → eff_spear_thrust', () => {
    const cfg = buildGameConfig();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['liubei', 'eff_sweeping_slash'],
      ['guanyu', 'eff_dragon_roar'],
      ['zhaoyun', 'eff_spear_thrust'],
    ];
    for (const entry of cases) {
      const [generalId, expectedEffectId] = entry;
      const binding = resolveSkillSlots(cfg, generalId)[0];
      expect(binding.effectId, `${generalId} 技1 效果`).toBe(expectedEffectId);
      const rig = makeRig(generalId);
      const compiled = compiledForLocal(rig.state);
      const view = compiled.find((item) => item.effectId === expectedEffectId);
      expect(view, `${generalId} 应编译 ${expectedEffectId}`).toBeDefined();
      expect(view!.slot).toBe(0);
      expect(effectMask.value[view!.eid] & TriggerBit.onCast).toBe(TriggerBit.onCast);
    }
    // 赵云的 spear_thrust 原本是 onHit，按槽位编译后触发语义被强制为 onCast。
    expect(cfg.effects.get('eff_spear_thrust').trigger).toBe('onHit');
  });

  it('每玩家恰好 4 组效果：通用普攻无槽位，3 个技能槽写入 mask 高位', () => {
    const rig = makeRig('liubei');
    const compiled = compiledForLocal(rig.state);
    expect(compiled).toHaveLength(4);
    expect(compiled.map((item) => item.effectId).sort()).toEqual([
      'eff_basic_attack', 'eff_sweeping_slash', 'eff_tiger_charge', 'eff_war_cry',
    ]);
    for (const view of compiled) {
      const mask = effectMask.value[view.eid];
      expect(mask & TriggerBit.onCast).toBe(TriggerBit.onCast);
      expect(skillSlotOfMask(mask)).toBe(view.slot);
      if (view.slot < 0) {
        expect(mask & SKILL_SLOT_MASK).toBe(0);
      } else {
        expect(mask & (SKILL_SLOT_FLAG_BASE << view.slot)).toBe(SKILL_SLOT_FLAG_BASE << view.slot);
      }
    }
  });

  it('按技2 只激活技2：技1 / 技3 效果不进入触发（槽位互斥）', () => {
    const rig = makeRig('liubei');
    runTicks(rig, 1);
    pushSkill(rig, 1);
    runTicks(rig, 2);

    const compiled = compiledForLocal(rig.state);
    expect(cdOf(compiled, 'eff_war_cry'), '技2 war_cry 应被触发').toBeGreaterThan(0);
    expect(cdOf(compiled, 'eff_sweeping_slash'), '技1 不应被技2 触发').toBe(0);
    expect(cdOf(compiled, 'eff_tiger_charge'), '技3 不应被技2 触发').toBe(0);
    expect(cdOf(compiled, 'eff_basic_attack'), '任意 cast 位都兜底通用普攻').toBeGreaterThan(0);
  });

  it('赵云技1（原 onHit 配置）按键即可触发并造成真实伤害', () => {
    const rig = makeRig('zhaoyun');
    runTicks(rig, 90);
    const target = livingEnemy(rig.state);
    placePlayerNextTo(rig.state, target);
    const hpBefore = Health.cur[target];

    pushSkill(rig, 0);
    runTicks(rig, 4);

    const compiled = compiledForLocal(rig.state);
    expect(cdOf(compiled, 'eff_spear_thrust'), '原 onHit 效果按槽位编译后应可按键触发').toBeGreaterThan(0);
    expect(Health.cur[target], '技1 应造成真实伤害').toBeLessThan(hpBefore);
  });

  it("startBattle('campaign_8min', 'guanyu') 后编译表改变且旧将效果不残留", () => {
    const rig = makeRig('liubei');
    const before = compiledForLocal(rig.state).map((item) => item.effectId);
    expect(before).toContain('eff_war_cry');
    expect(before).not.toContain('eff_dragon_roar');

    rig.controls.startBattle('campaign_8min', 'guanyu');
    const after = compiledForLocal(rig.state);
    expect(after).toHaveLength(4);
    const ids = after.map((item) => item.effectId);
    expect(ids).toContain('eff_dragon_roar');
    expect(ids).toContain('eff_sweeping_slash');
    expect(ids).toContain('eff_tiger_charge');
    expect(ids).not.toContain('eff_war_cry');
  });

  it('闪避（a=3）仍造成真实伤害，且不激活任何武将槽位效果', () => {
    const rig = makeRig('liubei');
    runTicks(rig, 90);
    const target = livingEnemy(rig.state);
    placePlayerNextTo(rig.state, target);
    const hpBefore = Health.cur[target];
    const damageBefore = rig.counts[GameEventType.Damage] ?? 0;

    pushSkill(rig, 3);
    runTicks(rig, 6);

    expect(Health.cur[target], '闪避按键应由通用普攻兜底扣血').toBeLessThan(hpBefore);
    expect(rig.counts[GameEventType.Damage] ?? damageBefore).toBeGreaterThan(damageBefore);
    const compiled = compiledForLocal(rig.state);
    expect(cdOf(compiled, 'eff_basic_attack')).toBeGreaterThan(0);
    for (const view of compiled) {
      if (view.slot >= 0) {
        expect(ActiveEffect.cd[view.eid], `闪避不应触发槽位 ${view.slot}`).toBe(0);
      }
    }
  });
});
