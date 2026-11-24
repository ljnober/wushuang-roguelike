/**
 * 战斗闭环回归（BugFix：无法击杀怪物）。
 *
 * 验证「施法 → 效果触发/冷却恢复 → 伤害 → 击杀 → 掉落 → 经验」整条链：
 *  - 手动：普攻按钮在攻击范围内真实扣血；
 *  - 自动：默认 auto 控制真正接管玩家席位，持续产生 Damage/Kill/Pickup 与经验。
 *
 * 使用全局 describe/it/expect（vite.config.ts globals:true），不加载第二份 runner。
 */
import type { App } from '../app/App';
import { CommandType, GameEventType } from '../ecs/bridge/enums';
import { createEventSlot, type GameEvent } from '../ecs/bridge/GameEventBus';
import { query } from '../ecs/bit/adapter';
import { EnemyTag, Health, PlayerTag, Position } from '../ecs/bit/components';
import { battleSession } from '../ecs/systems/LifecycleSystems';
import {
  getSimTick,
  registerSimSystem as schedulerRegisterSimSystem,
  resetScheduler,
  stepTick,
  type SimState,
} from '../ecs/scheduler';
import { getPlayerExp } from '../ecs/systems/ProgressionSystems';
import { register } from '../registration/systems';

function makeApp(): { app: App; state: SimState } {
  const state = {} as SimState;
  const app = {
    state,
    registerSimSystem(order: number, fn: (s: SimState, t: number) => void, id: string): void {
      schedulerRegisterSimSystem(order, fn, id);
    },
  } as unknown as App;
  return { app, state };
}

/** 预分配事件槽：GameEventBus.drain 只写入 out.length 个元素，空数组会清空总线。 */
function makeEventDrain(state: SimState, counts: Record<number, number>): () => void {
  const out: GameEvent[] = [];
  for (let i = 0; i < 128; i++) {
    out.push(createEventSlot());
  }
  return () => {
    const count = state.buses.events.drain(out);
    for (let i = 0; i < count; i++) {
      const type = out[i].type;
      counts[type] = (counts[type] ?? 0) + 1;
    }
  };
}

function startBattle(auto: boolean): { state: SimState; counts: Record<number, number>; drain: () => void } {
  resetScheduler();
  const { app, state } = makeApp();
  register(app);
  const session = state.session as unknown as { startBattle(mode: string, generalId: string): void };
  session.startBattle('campaign_8min', 'liubei');
  if (auto) {
    state.buses.commands.push({ type: CommandType.AutoToggle, playerId: 0, a: 1, b: 0, c: 0, seq: 1 });
  }
  const counts: Record<number, number> = {};
  return { state, counts, drain: makeEventDrain(state, counts) };
}

function runTicks(state: SimState, count: number, drain: () => void): void {
  const base = getSimTick();
  for (let i = 1; i <= count; i++) {
    stepTick(state, base + i);
    drain();
  }
}

describe('战斗闭环：施法到击杀掉落', () => {
  it('手动施法在攻击范围内对敌人造成伤害', () => {
    const { state, counts, drain } = startBattle(false);
    runTicks(state, 120, drain);

    const player = query(state.world, [PlayerTag])[0];
    const enemies = query(state.world, [EnemyTag]);
    expect(enemies.length).toBeGreaterThan(0);
    const target = enemies[0];
    // 把玩家放到普攻范围（90px）内，排除距离造成的假阴性。
    Position.x[player] = Position.x[target] - 40;
    Position.y[player] = Position.y[target];
    const hpBefore = Health.cur[target];

    state.buses.commands.push({ type: CommandType.Skill, playerId: 0, a: 0, b: 0, c: 0, seq: 100 });
    runTicks(state, 12, drain);

    expect(Health.cur[target]).toBeLessThan(hpBefore);
    expect(counts[GameEventType.Damage] ?? 0).toBeGreaterThan(0);
  });

  it('自动模式持续产生伤害、击杀、掉落与经验', () => {
    const { state, counts, drain } = startBattle(true);
    runTicks(state, 900, drain);

    expect(counts[GameEventType.Damage] ?? 0).toBeGreaterThan(0);
    expect(counts[GameEventType.Kill] ?? 0).toBeGreaterThan(0);
    expect(counts[GameEventType.Pickup] ?? 0).toBeGreaterThan(0);
    expect(getPlayerExp(0)).toBeGreaterThan(0);

    // HUD 成长数值：会话必须逐 tick 回写击杀/经验/等级/积分。
    const session = battleSession(state);
    expect(session.kills).toBeGreaterThan(0);
    expect(session.exp > 0 || session.level > 1).toBe(true);
    expect(session.score).toBeGreaterThan(0);
  });
});
