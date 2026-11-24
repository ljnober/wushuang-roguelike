/**
 * 整局可玩性测试 · node headless harness。
 *
 * 设计依据：ARCHITECTURE_FULLRUN.md §3.2 / §4.1 / §7.1 / §13。
 * 时间口径：stepTick(state, getSimTick()+1) + TICK_DT=1/60，不读墙钟；
 * 浏览器侧的合成时间快进由 tests/e2e/helpers/fastForward.ts 负责，二者不可混用。
 * 零产品后门：App 替身只转发 registerSimSystem 到权威 scheduler，不改产品源码。
 */
import type { App } from '../../app/App';
import { query } from '../../ecs/bit/adapter';
import { EnemyTag } from '../../ecs/bit/components';
import { CommandType } from '../../ecs/bridge/enums';
import {
  battleSession,
  type BattleSessionLike,
} from '../../ecs/systems/LifecycleSystems';
import {
  getSimTick,
  registerSimSystem as schedulerRegisterSimSystem,
  resetScheduler,
  stepTick,
  type SimState,
} from '../../ecs/scheduler';
import { register } from '../../registration/systems';
import { createEventBuffer, drainAndTally } from './eventTally';

/** 默认整局参数（§7.1 冻结值）。 */
const DEFAULT_MODE = 'campaign_8min';
const DEFAULT_GENERAL_ID = 'liubei';
const DEFAULT_MAX_TICKS = 28980; // 480s*60 + 180 缓冲
const DEFAULT_DRAIN_EVERY_TICKS = 60;
const EVENT_BUFFER_SIZE = 8192;

export interface FullRunOptions {
  mode?: string;
  generalId?: string;
  auto?: boolean;
  maxTicks?: number;
  drainEveryTicks?: number;
  onSample?: (s: FullRunSample) => void;
}

export interface FullRunSample {
  tick: number;
  elapsed: number;
  result: number;
  kills: number;
  level: number;
  score: number;
  bossSpawned: number;
  waveIndex: number;
  enemies: number;
  dropped: number;
}

export interface FullRunResult {
  sample: FullRunSample;
  thrown: string | null;
  events: Readonly<Record<string, number>>;
}

/** 空样本：异常早退时仍返回结构完整的 FullRunResult。 */
function emptySample(): FullRunSample {
  return {
    tick: 0,
    elapsed: 0,
    result: 0,
    kills: 0,
    level: 1,
    score: 0,
    bossSpawned: 0,
    waveIndex: 0,
    enemies: 0,
    dropped: 0,
  };
}

/**
 * 构造 headless App：state 为空壳，register(app) 会把世界/总线/会话挂上来；
 * registerSimSystem 转发到 scheduler 的权威注册表（与真实 App 行为一致）。
 * 内部先 resetScheduler，保证两次独立调用互不污染。
 */
export function createHeadlessApp(): App {
  resetScheduler();
  const state = {} as SimState;
  const app = {
    state,
    registerSimSystem(order: number, fn: (s: SimState, t: number) => void, id: string): void {
      schedulerRegisterSimSystem(order, fn, id);
    },
  } as unknown as App;
  register(app);
  return app;
}

/** 通过 CommandBus 开启 auto（seq=1，a=1 表示开启）。 */
export function enableAuto(state: SimState): void {
  state.buses.commands.push({
    type: CommandType.AutoToggle,
    playerId: 0,
    a: 1,
    b: 0,
    c: 0,
    seq: 1,
  });
}

/** 只读采样：把 session / 事件总线 / 世界实体数收敛到一个扁平结构。 */
export function snapshot(state: SimState): FullRunSample {
  const session: BattleSessionLike = battleSession(state);
  return {
    tick: session.simTick,
    elapsed: session.elapsed,
    result: session.result,
    kills: session.kills,
    level: session.level,
    score: session.score,
    bossSpawned: session.bossSpawned,
    waveIndex: session.waveIndex,
    enemies: query(state.world, [EnemyTag]).length,
    dropped: state.buses.events.droppedCount,
  };
}

/**
 * 跑完整局：reset → register → startBattle → auto → 逐 tick 驱动 → 定期 drain → 终局采样。
 * 事件总线每 drainEveryTicks tick 消费一次，避免 8192 容量溢出（spike 实测 dropped=0）。
 */
export function runFullRun(opts: FullRunOptions = {}): FullRunResult {
  const mode = opts.mode ?? DEFAULT_MODE;
  const generalId = opts.generalId ?? DEFAULT_GENERAL_ID;
  const auto = opts.auto ?? true;
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS;
  const drainEveryTicks = opts.drainEveryTicks ?? DEFAULT_DRAIN_EVERY_TICKS;
  const tally: Record<string, number> = {};
  const out = createEventBuffer(EVENT_BUFFER_SIZE);

  let state: SimState | null = null;
  let thrown: string | null = null;

  try {
    const app = createHeadlessApp();
    state = app.state as unknown as SimState;
    const session = battleSession(state);
    const controls = session as unknown as {
      startBattle(mode: string, generalId: string): void;
    };
    controls.startBattle(mode, generalId);
    if (auto) {
      enableAuto(state);
    }

    // startBattle 会替换 state.session，必须重新取会话视图。
    const live = battleSession(state);
    for (let i = 1; i <= maxTicks; i++) {
      stepTick(state, getSimTick() + 1);
      if (i % drainEveryTicks === 0) {
        drainAndTally(state.buses.events, out, tally);
        if (opts.onSample !== undefined) {
          opts.onSample(snapshot(state));
        }
      }
      if (live.result !== 0) {
        break;
      }
    }
  } catch (error) {
    thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  let sample = emptySample();
  if (state !== null) {
    // 尾批：结算 tick 通常不在 drain 点上，必须收尾消费（含 Victory/Defeat）。
    drainAndTally(state.buses.events, out, tally);
    sample = snapshot(state);
    if (opts.onSample !== undefined) {
      opts.onSample(sample);
    }
  }

  return { sample, thrown, events: tally as Readonly<Record<string, number>> };
}
