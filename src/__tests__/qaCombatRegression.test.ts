/**
 * QA 独立战斗回归（BugFix：无法击杀怪物）。
 *
 * 与工程师的 combatLoop.test.ts 相互独立，针对本次修复的四个改动点逐项设证：
 *  1. 五个主动技能位（Basic/Skill1/Skill2/Skill3/Dodge）都能进入 onCast 链路；
 *  2. 效果冷却逐 tick 递减，间隔 >0.1s 的第二次施法仍造成真实伤害；
 *  3. AutoToggle 双向切换：auto 代管能击杀，切回 manual 后不再代管，再开又能击杀；
 *  4. 重开闭环：第二次 startBattle 后击杀/经验/波次归零且仍能继续击杀。
 *
 * 只使用全局 describe/it/expect（vite.config.ts globals:true），不改任何源码。
 */
import type { App } from '../app/App';
import { EXP_CURVE } from '../core/Constants';
import { CommandType, GameEventType } from '../ecs/bridge/enums';
import { createEventSlot, type GameEvent } from '../ecs/bridge/GameEventBus';
import { query } from '../ecs/bit/adapter';
import { EnemyTag, Health, InputCmd, PlayerId, PlayerTag, Position } from '../ecs/bit/components';
import { battleSession } from '../ecs/systems/LifecycleSystems';
import { getPlayerExp } from '../ecs/systems/ProgressionSystems';
import {
  getSimTick,
  registerSimSystem as schedulerRegisterSimSystem,
  resetScheduler,
  stepTick,
  type SimState,
} from '../ecs/scheduler';
import { register } from '../registration/systems';

function makeState(): { app: App; state: SimState } {
  const state = {} as SimState;
  const app = {
    state,
    registerSimSystem(order: number, fn: (s: SimState, t: number) => void, id: string): void {
      schedulerRegisterSimSystem(order, fn, id);
    },
  } as unknown as App;
  return { app, state };
}

/** 预填充事件槽：GameEventBus.drain 只写 out.length 个元素。 */
function makeDrain(state: SimState, counts: Record<number, number>): () => void {
  const out: GameEvent[] = [];
  for (let i = 0; i < 256; i++) out.push(createEventSlot());
  return () => {
    const count = state.buses.events.drain(out);
    for (let i = 0; i < count; i++) {
      const type = out[i].type;
      counts[type] = (counts[type] ?? 0) + 1;
    }
  };
}

function push(
  state: SimState,
  type: CommandType,
  a: number,
  seq: number,
): void {
  state.buses.commands.push({ type, playerId: 0, a, b: 0, c: 0, seq });
}

function runTicks(state: SimState, count: number, drain: () => void): void {
  const base = getSimTick();
  for (let i = 1; i <= count; i++) {
    stepTick(state, base + i);
    drain();
  }
}

/** 新开一局并清空事件计数；返回可重复调用的 drain（随 startBattle 后总线更换而重建）。 */
function start(): {
  state: SimState;
  counts: Record<number, number>;
  drain: () => void;
  seq: { value: number };
} {
  resetScheduler();
  const { app, state } = makeState();
  register(app);
  (state.session as unknown as { startBattle(mode: string, id: string): void }).startBattle(
    'campaign_8min',
    'liubei',
  );
  const counts: Record<number, number> = {};
  return { state, counts, drain: makeDrain(state, counts), seq: { value: 0 } };
}

/** 把玩家贴到某敌人 40px 内，排除"距离太远"造成的假阴性。 */
function placePlayerNextTo(state: SimState, target: number): void {
  const player = query(state.world, [PlayerTag])[0];
  Position.x[player] = Position.x[target] - 40;
  Position.y[player] = Position.y[target];
}

/** 选一个仍有血的敌人；若目标已死则换一个，保证第二次施法可观测。 */
function livingEnemy(state: SimState): number {
  const enemies = query(state.world, [EnemyTag]);
  for (let i = 0; i < enemies.length; i++) {
    if (Health.cur[enemies[i]] > 0) return enemies[i];
  }
  throw new Error('没有存活敌人可供伤害断言');
}

/** 本地真人席位（playerId=0），区别于两个持续自动战斗的 AI 影子席位。 */
function localPlayer(state: SimState): number {
  const players = query(state.world, [PlayerTag, PlayerId]);
  for (let i = 0; i < players.length; i++) {
    if (PlayerId.value[players[i]] === 0) return players[i];
  }
  throw new Error('找不到本地真人席位');
}

/** 主动施法位掩码：Basic | Skill1 | Skill2 | Skill3 | Dodge（AutoToggle 位 1<<7 不计）。 */
const CAST_BUTTON_MASK = 0b11111;

/** 逐 tick 采样本地席位的施法位，避免"最后一 tick 恰好不在 CD"造成假阴性。 */
function runTicksCountingLocalCasts(state: SimState, count: number, drain: () => void): number {
  const player = localPlayer(state);
  const base = getSimTick();
  let castTicks = 0;
  for (let i = 1; i <= count; i++) {
    stepTick(state, base + i);
    drain();
    if ((InputCmd.buttons[player] & CAST_BUTTON_MASK) !== 0) castTicks++;
  }
  return castTicks;
}

beforeEach(() => {
  resetScheduler();
});

describe('QA 战斗闭环独立回归', () => {
  // UI 映射：j/技1→Skill(0)，技2→Skill(1)，技3→Skill(2)，闪避→Skill(3)。
  const CAST_KEYS: ReadonlyArray<{ label: string; skillIndex: number }> = [
    { label: '普攻 j / 技1', skillIndex: 0 },
    { label: '技2', skillIndex: 1 },
    { label: '技3', skillIndex: 2 },
    { label: '闪避', skillIndex: 3 },
  ];

  for (const key of CAST_KEYS) {
    it(`${key.label}：按下后真实扣血并产生 Damage 事件`, () => {
      // Arrange：开战、等待刷怪、把玩家放到攻击范围内。
      const { state, counts, drain, seq } = start();
      runTicks(state, 90, drain);
      const target = livingEnemy(state);
      placePlayerNextTo(state, target);
      const hpBefore = Health.cur[target];
      const damageBefore = counts[GameEventType.Damage] ?? 0;

      // Act：模拟 UI 技能命令（走 CommandBus → LocalHumanSource → InputCmd.buttons）。
      push(state, CommandType.Skill, key.skillIndex, ++seq.value);
      runTicks(state, 10, drain);

      // Assert：不是"按钮有动画"，而是目标真的掉血。
      expect(Health.cur[target], `${key.label} 应造成真实伤害`).toBeLessThan(hpBefore);
      expect(counts[GameEventType.Damage] ?? damageBefore, `${key.label} 应产生 Damage`).toBeGreaterThan(
        damageBefore,
      );
    });
  }

  it('效果冷却逐 tick 递减：间隔 > 0.1s 的第二次施法仍生效', () => {
    const { state, counts, drain, seq } = start();
    runTicks(state, 90, drain);

    // 第一次施法。
    let target = livingEnemy(state);
    placePlayerNextTo(state, target);
    const hp1Before = Health.cur[target];
    push(state, CommandType.Skill, 0, ++seq.value);
    runTicks(state, 4, drain);
    expect(Health.cur[target], '第一次施法应扣血').toBeLessThan(hp1Before);
    const damageAfterFirst = counts[GameEventType.Damage] ?? 0;

    // 等待冷却（0.1s = 6 tick，浮点递减留余量取 14 tick）。
    runTicks(state, 14, drain);
    expect(counts[GameEventType.Damage] ?? 0, '等待期间玩家不施法，不应新增玩家伤害').toBe(
      damageAfterFirst,
    );

    // 第二次施法：同一链路必须还能触发。
    target = livingEnemy(state);
    placePlayerNextTo(state, target);
    const hp2Before = Health.cur[target];
    push(state, CommandType.Skill, 0, ++seq.value);
    runTicks(state, 6, drain);
    expect(Health.cur[target], '冷却结束后第二次施法应继续扣血').toBeLessThan(hp2Before);
    expect(counts[GameEventType.Damage] ?? 0, '应累计两次以上 Damage').toBeGreaterThan(damageAfterFirst);
  });

  it('AutoToggle 双向切换：auto 代管本地席位 → manual 停手 → 再 auto 恢复', () => {
    const { state, counts, drain, seq } = start();
    push(state, CommandType.AutoToggle, 1, ++seq.value);
    const castsAuto1 = runTicksCountingLocalCasts(state, 600, drain);
    expect(castsAuto1, 'auto 模式下本地席位应持续施法').toBeGreaterThan(0);
    expect(counts[GameEventType.Kill] ?? 0, 'auto 模式应产生击杀').toBeGreaterThan(0);

    // 切回手动：只断言本地席位不再被 AI 代管；两个影子 AI 仍会继续击杀，故不能看全局 Kill。
    push(state, CommandType.AutoToggle, 0, ++seq.value);
    const castsManual = runTicksCountingLocalCasts(state, 180, drain);
    expect(castsManual, 'manual 模式无玩家输入时本地席位不应自动施法').toBe(0);

    // 再开 auto：本地席位恢复自动施法（确认切换不是一次性失效）。
    push(state, CommandType.AutoToggle, 1, ++seq.value);
    const castsAuto2 = runTicksCountingLocalCasts(state, 600, drain);
    expect(castsAuto2, '再次开启 auto 应恢复本地席位自动施法').toBeGreaterThan(0);
  });

  it('重开闭环：第二次 startBattle 后击杀/经验/波次归零且仍能击杀', () => {
    const first = start();
    push(first.state, CommandType.AutoToggle, 1, ++first.seq.value);
    runTicks(first.state, 900, first.drain);
    const killsFirst = first.counts[GameEventType.Kill] ?? 0;
    expect(killsFirst, '首局应能击杀').toBeGreaterThan(0);
    expect(getPlayerExp(0), '首局应有经验').toBeGreaterThan(0);

    // Act：结束首局并立即重开（与结算页「再来一局」走同一 session 契约）。
    const controls = first.state.session as unknown as {
      endBattle(): void;
      startBattle(mode: string, id: string): void;
    };
    controls.endBattle();
    controls.startBattle('endless', 'guanyu');

    // Assert：局内状态确实归零。
    const session = battleSession(first.state);
    expect(session.elapsed, '重开后计时应归零').toBe(0);
    expect(session.waveIndex, '重开后波次应归零').toBe(0);
    expect(getPlayerExp(0), '重开后经验应归零').toBe(0);
    expect(session.kills, '重开后击杀应归零').toBe(0);
    expect(session.exp, '重开后 session 经验应归零').toBe(0);
    expect(session.level, '重开后展示等级应回到 1').toBe(1);
    expect(session.score, '刚重开尚未 tick 时积分为初始 0').toBe(0);
    expect(session.expNext, '重开后升级阈值应回到 EXP_CURVE(1)=19').toBe(EXP_CURVE(1));
    expect(session.result).toBe(0);

    // 新总线/新世界：重建事件 drain 后继续跑，证明第二局仍可玩。
    const counts2: Record<number, number> = {};
    const drain2 = makeDrain(first.state, counts2);
    let seq2 = 0;
    push(first.state, CommandType.AutoToggle, 1, ++seq2);
    runTicks(first.state, 1, drain2);
    expect(
      battleSession(first.state).score,
      '重开后首 tick 的 syncLocalProgress 应把积分补到 Lv.1 基线 100',
    ).toBe(100);
    runTicks(first.state, 899, drain2);
    expect(counts2[GameEventType.Damage] ?? 0, '第二局应继续造成伤害').toBeGreaterThan(0);
    expect(counts2[GameEventType.Kill] ?? 0, '第二局应继续击杀').toBeGreaterThan(0);
    expect(getPlayerExp(0), '第二局应继续获得经验').toBeGreaterThan(0);
  });

  it('DEFECT-A 关闭：session 成长字段逐 tick 同步，经验拾取发出 Pickup 事件', () => {
    // Arrange：开战、开启 auto；用带参数的 drain 捕获 Pickup 事件语义。
    const { state, seq } = start();
    const out: GameEvent[] = [];
    for (let i = 0; i < 256; i++) out.push(createEventSlot());
    const expPickups: GameEvent[] = [];
    const detailedDrain = (): void => {
      const count = state.buses.events.drain(out);
      for (let i = 0; i < count; i++) {
        if (out[i].type === GameEventType.Pickup && out[i].b === 0) {
          expPickups.push({ ...out[i] });
        }
      }
    };
    push(state, CommandType.AutoToggle, 1, ++seq.value);
    const base = getSimTick();
    for (let i = 1; i <= 900; i++) {
      stepTick(state, base + i);
      detailedDrain();
    }

    // Assert：HUD 的数据源（session 字段）与 ECS 运行态同值。
    const session = battleSession(state);
    expect(session.kills, 'session.kills 应随 Kill 累加').toBeGreaterThan(0);
    expect(session.score, 'session.score 应与 kills/level 同公式').toBe(
      session.kills * 10 + session.level * 100,
    );
    expect(session.level, '展示等级应为 1-based').toBeGreaterThanOrEqual(1);
    expect(session.exp, 'session.exp 应随拾取累加').toBeGreaterThan(0);
    expect(session.expNext, 'expNext 应与当前等级曲线同口径').toBe(EXP_CURVE(session.level));
    expect(expPickups.length, '经验球拾取应发出 Pickup 事件（kind=0）').toBeGreaterThan(0);
    // 影子席位也会拾取经验并上报，故只要求本地席位至少有一次正经验量事件。
    expect(
      expPickups.some((e) => e.a === 0 && e.c > 0),
      '本地席位应收到正经验量的 Pickup 事件',
    ).toBe(true);
    expect(expPickups.every((e) => e.a >= 0 && e.a <= 3 && e.c > 0), 'Pickup 参数应为合法席位与正经验量').toBe(true);
  });
});
