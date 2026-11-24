/**
 * 系统调度骨架（设计 §7 / 架构 §6.3）：
 *  - simulateTick(state, rawDt)：accumulator 模式，逐 tick 执行，不丢弃任何 tick；
 *  - renderFrame(state)：满帧渲染，只做 alpha 插值，不参与模拟；
 *  - 系统按 order 升序稳定执行，同 order 按注册先后；
 *  - 提供当前 simTick / alpha 访问。
 *
 * 注：时间源由上层 App 的 requestAnimationFrame 提供 rawDt；逻辑层不读 Date.now/performance.now。
 * App 已委托本模块作为唯一权威系统注册表与 tick 时钟（App 只保留 RAF/渲染器/场景）；
 * 会话状态 session.simTick 由此处在每个 tick 的系统执行前统一写入。
 */
import { assert, TICK_DT } from '../core/Constants';
import type { GameConfig } from '../data/types';
import type { Rng } from '../core/Rng';
import type { BattleWorld } from './bit/adapter';
import type { SoAComponent } from './bit/types';
import type { EntityPool, EffectEntityPool } from './pools/EntityPool';
import type { ParamPool } from './pools/ParamPool';
import type { SnapshotPool } from './pools/SnapshotPool';
import type { CommandBus } from './bridge/CommandBus';
import type { GameEventBus } from './bridge/GameEventBus';

const ERR_SCHEDULER = 2013;

/** 世界运行所需的对象集合（与类图 SimState 对齐） */
export interface PoolBundle {
  entities: EntityPool;
  effects: EffectEntityPool;
  params: ParamPool;
  snapshots: SnapshotPool;
}

export interface BusBundle {
  commands: CommandBus;
  events: GameEventBus;
}

export interface SimState {
  world: BattleWorld;
  config: GameConfig;
  session: SoAComponent;
  pool: PoolBundle;
  buses: BusBundle;
  rng: Rng;
}

export type SimSystemFn = (state: SimState, tick: number) => void;
export type RenderSystemFn = (state: SimState, alpha: number) => void;

export interface SimSystem {
  id: string;
  order: number;
  run: SimSystemFn;
}

export interface RenderSystem {
  id: string;
  order: number;
  run: RenderSystemFn;
}

interface Registered<T> {
  id: string;
  order: number;
  seq: number;
  fn: T;
}

let simSystems: Registered<SimSystemFn>[] = [];
let renderSystems: Registered<RenderSystemFn>[] = [];
let registrationSeq = 0;
let simDirty = false;
let renderDirty = false;

let currentTick = 0;
let accumulator = 0;
let currentAlpha = 0;

/** 按 order 升序、同序按注册先后排序（稳定） */
function sortByOrder<T>(list: Registered<T>[]): void {
  list.sort((a, b) => a.order - b.order || a.seq - b.seq);
}

/** 注册逻辑系统（order 遵循 §6.3 冻结顺序表） */
export function registerSimSystem(order: number, fn: SimSystemFn, id: string): void {
  assert(Number.isFinite(order) && typeof fn === 'function', ERR_SCHEDULER, '非法 sim 系统注册');
  simSystems.push({ id, order, seq: registrationSeq++, fn });
  simDirty = true;
}

/** 注册渲染系统（Viewport → RenderSync → HUD，order 递增） */
export function registerRenderSystem(order: number, fn: RenderSystemFn, id: string): void {
  assert(Number.isFinite(order) && typeof fn === 'function', ERR_SCHEDULER, '非法 render 系统注册');
  renderSystems.push({ id, order, seq: registrationSeq++, fn });
  renderDirty = true;
}

/** 清空注册与时钟（仅测试 / 重建世界时调用） */
export function resetScheduler(): void {
  simSystems = [];
  renderSystems = [];
  registrationSeq = 0;
  simDirty = false;
  renderDirty = false;
  currentTick = 0;
  accumulator = 0;
  currentAlpha = 0;
}

/** 执行单个固定 tick（不读取真实时间，供 DeterministicSim / 测试直接驱动） */
export function stepTick(state: SimState, tick: number = currentTick + 1): void {
  if (simDirty) {
    sortByOrder(simSystems);
    simDirty = false;
  }
  // 权威时钟统一写入会话状态；null/undefined/非对象/无 simTick 字段均安全跳过。
  const session = state.session as unknown as { simTick?: number } | null | undefined;
  if (session !== null && session !== undefined && typeof session === 'object' && 'simTick' in session) {
    session.simTick = tick;
  }
  for (let i = 0; i < simSystems.length; i++) {
    simSystems[i].fn(state, tick);
  }
  currentTick = tick;
}

/**
 * accumulator 驱动：把 rawDt 转成若干完整 tick，一个都不跳过。
 * 返回本帧执行的 tick 数量；余量写入 alpha 供渲染插值。
 */
export function simulateTick(state: SimState, rawDt: number): number {
  assert(Number.isFinite(rawDt) && rawDt >= 0, ERR_SCHEDULER, 'rawDt 必须为非负有限数');
  accumulator += rawDt;
  let executed = 0;
  while (accumulator >= TICK_DT) {
    stepTick(state, currentTick + 1);
    accumulator -= TICK_DT;
    executed++;
  }
  currentAlpha = accumulator / TICK_DT;
  return executed;
}

/** 满帧渲染：只插值与绘制，不推进 simTick */
export function renderFrame(state: SimState, alphaOverride?: number): void {
  const alpha = alphaOverride === undefined ? currentAlpha : alphaOverride;
  if (renderDirty) {
    sortByOrder(renderSystems);
    renderDirty = false;
  }
  for (let i = 0; i < renderSystems.length; i++) {
    renderSystems[i].fn(state, alpha);
  }
}

/** 当前已执行的逻辑 tick 数 */
export function getSimTick(): number {
  return currentTick;
}

/** 当前插值系数 [0,1) */
export function getAlpha(): number {
  return currentAlpha;
}

/** 当前 accumulator 余量（秒），供调试面板观测 */
export function getAccumulator(): number {
  return accumulator;
}

/** 已注册系统数量，便于调试 / 断言注册完整性 */
export function getSystemCounts(): { sim: number; render: number } {
  return { sim: simSystems.length, render: renderSystems.length };
}
