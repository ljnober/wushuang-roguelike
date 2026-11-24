/**
 * QA2 战斗闭环单测（DESIGN §13 / 主理人确认的 session 契约）。
 *
 * 验证 `src/registration/systems.ts` 暴露的 startBattle/endBattle/running 契约：
 *  - 启动前 running=0 且菜单期间系统空转、不刷怪；
 *  - startBattle 后 running=1、elapsed 从 0 开始、startTick 对齐全局 tick；
 *  - endBattle 后 running=0，tick 继续推进但波次/刷怪不再推进；
 *  - 再次 startBattle 后世界重建，敌人数/经验/波次归零。
 *
 * 使用全局 describe/it/expect（vite.config.ts globals:true），不加载第二份 runner。
 */
import { register } from '../registration/systems';
import { battleSession } from '../ecs/systems/LifecycleSystems';
import { query } from '../ecs/bit/adapter';
import { EnemyTag } from '../ecs/bit/components';
import {
  getSimTick,
  registerSimSystem as schedulerRegisterSimSystem,
  resetScheduler,
  stepTick,
  type SimState,
} from '../ecs/scheduler';
import { getPlayerExp, getPlayerLevel } from '../ecs/systems/ProgressionSystems';
import type { App } from '../app/App';

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

function controlsOf(state: SimState): {
  startBattle(mode: string, generalId: string): void;
  endBattle(): void;
} {
  return state.session as unknown as {
    startBattle(mode: string, generalId: string): void;
    endBattle(): void;
  };
}

function enemyCount(state: SimState): number {
  return query(state.world, [EnemyTag]).length;
}

function runTicks(state: SimState, count: number): void {
  const base = getSimTick();
  for (let i = 1; i <= count; i++) stepTick(state, base + i);
}

beforeEach(() => {
  resetScheduler();
});

describe('战斗会话 running 契约', () => {
  it('启动前 running=0，菜单期间 tick 推进但不刷怪', () => {
    // Arrange：按真实侧载入口初始化（未开战）。
    const { app, state } = makeApp();
    register(app);
    const session = battleSession(state);

    // Assert：初始未运行、无敌人。
    expect(session.running).toBe(0);
    expect(session.elapsed).toBe(0);
    expect(enemyCount(state)).toBe(0);

    // Act：模拟停在菜单 2 秒。
    const tickBefore = getSimTick();
    runTicks(state, 120);

    // Assert：tick 推进，但会话与刷怪均不动。
    expect(getSimTick()).toBe(tickBefore + 120);
    expect(session.running).toBe(0);
    expect(session.elapsed).toBe(0);
    expect(session.waveIndex).toBe(0);
    expect(enemyCount(state)).toBe(0);
  });

  it('startBattle 后 running=1、elapsed 从 0 开始、startTick 对齐全局 tick', () => {
    const { app, state } = makeApp();
    register(app);

    // Act：菜单期间先空转 90 tick，再选将出征。
    runTicks(state, 90);
    const tickAtStart = getSimTick();
    controlsOf(state).startBattle('campaign_8min', 'liubei');

    // Assert：新会话处于运行态，时间从 0 起算。
    const session = battleSession(state);
    expect(session.running).toBe(1);
    expect(session.elapsed).toBe(0);
    expect(session.waveIndex).toBe(0);
    expect(session.spawnAcc).toBe(0);
    expect(session.startTick).toBe(tickAtStart);
    expect(session.result).toBe(0);

    // Act：推进 1 tick。
    stepTick(state, getSimTick() + 1);
    // Assert：时间开始增长（1 tick = 1/60 s），波次仍在熟悉期。
    expect(session.elapsed).toBeCloseTo(1 / 60, 6);
    expect(session.waveIndex).toBe(0);
  });

  it('running=1 时刷怪与时间推进；endBattle 后 tick 推进但波次不再推进', () => {
    const { app, state } = makeApp();
    register(app);
    controlsOf(state).startBattle('campaign_8min', 'liubei');

    // Act：战斗 5 秒（300 tick），确认确有刷怪与时间流逝。
    runTicks(state, 300);
    const session = battleSession(state);
    const enemiesDuring = enemyCount(state);
    const elapsedDuring = session.elapsed;
    const waveDuring = session.waveIndex;
    expect(elapsedDuring).toBeGreaterThan(4.9);
    expect(enemiesDuring).toBeGreaterThan(0);

    // Act：切离战斗（进入结算/菜单）。
    controlsOf(state).endBattle();
    expect(session.running).toBe(0);

    const tickAtEnd = getSimTick();
    runTicks(state, 120);

    // Assert：全局 tick 前进，但战斗状态冻结。
    expect(getSimTick()).toBe(tickAtEnd + 120);
    expect(session.elapsed).toBe(elapsedDuring);
    expect(session.waveIndex).toBe(waveDuring);
    expect(enemyCount(state)).toBe(enemiesDuring);
  });

  it('再次 startBattle 后世界重建，敌人数/经验/波次归零', () => {
    const { app, state } = makeApp();
    register(app);
    controlsOf(state).startBattle('campaign_8min', 'liubei');

    // Act：跑 10 秒让敌人与经验增长。
    runTicks(state, 600);
    const beforeWorld = state.world;
    expect(enemyCount(state)).toBeGreaterThan(0);
    expect(battleSession(state).elapsed).toBeGreaterThan(9);

    // Act：结束并重开。
    controlsOf(state).endBattle();
    controlsOf(state).startBattle('endless', 'guanyu');

    // Assert：世界整体替换；敌人/经验/等级/波次清零，时间重新从 0 起。
    expect(state.world).not.toBe(beforeWorld);
    const session = battleSession(state);
    expect(session.running).toBe(1);
    expect(session.elapsed).toBe(0);
    expect(session.waveIndex).toBe(0);
    expect(session.spawnAcc).toBe(0);
    expect(session.result).toBe(0);
    expect(enemyCount(state)).toBe(0);
    expect(getPlayerExp(0)).toBe(0);
    expect(getPlayerLevel(0)).toBe(0);
  });
});
