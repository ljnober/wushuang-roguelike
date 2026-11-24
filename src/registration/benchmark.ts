/**
 * E2 FPS 压测压力场景（ARCHITECTURE_INCREMENTAL_2 §1.2 / §2.2 / §3.3 / §6.2）。
 *
 * 由 main.ts 的 import.meta.glob('./registration/*.ts', { eager: true }) 自动侧载。
 * 仅在 URL 含 ?bench=1 时生效；正常访问时 register() 第一行立即返回，零副作用。
 *
 * 静态审查约束（hardConstraints.test.ts §6）：
 *  - 本文件不调用任何墙钟 API（帧时间由驱动侧 rAF timestamp 参数采集）；
 *  - 不使用随机数发生器（位置分布为确定性网格）；
 *  - 不直接 import 'bitecs'（只用 ecs/bit/adapter 封装）；
 *  - quality 只从渲染器读取用于探针标注，绝不写入 SimState 或参与系统判断。
 *
 * 初始化时机：glob 按文件名字母序加载（benchmark < net < presentation < systems），
 * 本文件的 register 先于 systems.ts 执行，彼时 app.state 尚无 world / startBattle。
 * 因此用 order=999 的 render system 延迟到 app.start() 之后完成装配：
 * 此时 systems.ts 已挂载 startBattle，且渲染器异步初始化已完成。
 */
import type { App } from '../app/App';
import { query } from '../ecs/bit/adapter';
import {
  Faction,
  Invulnerable,
  PlayerTag,
  Position,
  Projectile,
  RenderRef,
} from '../ecs/bit/components';
import { FactionValue } from '../ecs/components/core';
import { getSimTick, type SimState } from '../ecs/scheduler';
import { fireProjectile } from '../ecs/systems/CombatSystems';
import { spawnCombatEntity } from '../ecs/systems/LifecycleSystems';

/** 冻结目标：300 敌 / 500 弹幕，与 Constants.CAP / MAX_PROJECTILES 无关，绝不修改后者。 */
const TARGET_ENEMIES = 300;
const TARGET_BULLETS = 500;
/** 与 systems.ts 的 DEFAULT_ROOM_SEED 一致；startBattle 使用默认种子，此处仅作标注与校验。 */
const BENCH_SEED = 0x9e3779b9;
/** 压测实体用超长生命与无敌，保证采样期数量不因击杀/过期下滑（禁止削减实体达标）。 */
const BENCH_HP = 1e9;
const BENCH_LIFETIME = 1e9;
/** 确定性网格分布：敌 30×10，弹幕 25×20，全部落在 1280×720 视口附近。 */
const ENEMY_COLS = 30;
const ENEMY_ROWS = 10;
const BULLET_COLS = 25;
const BULLET_ROWS = 20;

/** 只读探针快照：返回新对象，调用方无法写回任何运行态。 */
export interface BenchSnapshot {
  sceneReady: boolean;
  enemies: number;
  bullets: number;
  tick: number;
  quality: number;
  headless: boolean;
  slots: number;
  seenReady: boolean;
}

declare global {
  interface Window {
    __WS_BENCH__?: {
      getSnapshot(): BenchSnapshot;
    };
  }
}

/** 渲染器结构替身：只需要 headless / quality / setQuality 三个渲染层字段。 */
interface BenchRendererLike {
  readonly headless?: boolean;
  readonly quality?: string;
  setQuality?(quality: string): void;
}

/** 会话结构替身：startBattle 由 systems.ts 挂载，签名冻结为 (mode, generalId)。 */
interface BenchSessionLike {
  startBattle?(mode: string, generalId: string): void;
  roomSeed?: number;
}

/** 模块级探针状态；仅在 bench 模式下被刷新，正常游戏不触碰。 */
let snapshot: BenchSnapshot = {
  sceneReady: false,
  enemies: 0,
  bullets: 0,
  tick: 0,
  quality: 0,
  headless: true,
  slots: 0,
  seenReady: false,
};
let installed = false;

/** 统计敌对单位（Faction===Enemy），与 hardConstraints 的口径一致。 */
function countEnemies(state: SimState): number {
  const entities = query(state.world, [Faction]);
  let count = 0;
  for (let i = 0; i < entities.length; i++) {
    if (Faction.value[entities[i]] === FactionValue.Enemy) {
      count++;
    }
  }
  return count;
}

/** 统计弹幕实体（Projectile 组件数量）。 */
function countBullets(state: SimState): number {
  return query(state.world, [Projectile]).length;
}

/**
 * 补足到 300 敌 / 500 弹幕。每帧调用，抵消击杀与回收造成的下滑；
 * 新增实体全部无敌且超长寿命，因此稳态数量恒等于目标值。
 */
function topUp(state: SimState): number[] {
  const players = query(state.world, [PlayerTag]);
  const source = players.length > 0 ? players[0] : 1;

  let enemies = countEnemies(state);
  let addedEnemies = 0;
  while (enemies < TARGET_ENEMIES) {
    const x = ((addedEnemies % ENEMY_COLS) - ENEMY_COLS / 2) * 48;
    const y = (Math.floor(addedEnemies / ENEMY_COLS) % ENEMY_ROWS - ENEMY_ROWS / 2) * 48;
    const eid = spawnCombatEntity(state, {
      enemyId: 'huangjin',
      x,
      y,
      faction: FactionValue.Enemy,
      hpOverride: BENCH_HP,
    });
    Invulnerable.remaining[eid] = BENCH_HP;
    enemies++;
    addedEnemies++;
  }

  let bullets = countBullets(state);
  let addedBullets = 0;
  while (bullets < TARGET_BULLETS) {
    // Neutral 阵营：不与玩家/敌人发生敌对碰撞，弹幕数量恒定；位置写回确定性网格。
    const eid = fireProjectile(state, source, 1, 0, 0, 0, BENCH_LIFETIME, FactionValue.Neutral, 0);
    const x = ((addedBullets % BULLET_COLS) - BULLET_COLS / 2) * 48;
    const y = (Math.floor(addedBullets / BULLET_COLS) % BULLET_ROWS - BULLET_ROWS / 2) * 32;
    Position.x[eid] = x;
    Position.y[eid] = y;
    Position.px[eid] = x;
    Position.py[eid] = y;
    bullets++;
    addedBullets++;
  }

  return [enemies, bullets];
}

/** 统计已分配绘制槽的实体数（RenderRef.slot >= 0），用于报告 Pixi 槽位压力。 */
function countSlots(state: SimState): number {
  const refs = query(state.world, [RenderRef]);
  let slots = 0;
  for (let i = 0; i < refs.length; i++) {
    if (RenderRef.slot[refs[i]] >= 0) {
      slots++;
    }
  }
  return slots;
}

/** 读取渲染层画质档位：low=0 / medium=1 / high=2，仅标注环境，不参与逻辑。 */
function qualityOf(renderer: BenchRendererLike | null): number {
  if (renderer === null || renderer.quality === undefined) {
    return 0;
  }
  if (renderer.quality === 'low') {
    return 0;
  }
  if (renderer.quality === 'medium') {
    return 1;
  }
  return 2;
}

/** 每帧刷新探针：先补位再采样，保证 getSnapshot 永远看到 >= 300/500。 */
function refresh(app: App): void {
  const state = app.state as unknown as SimState;
  const counts = topUp(state);
  const renderer = app.renderer as unknown as BenchRendererLike | null;
  const ready = snapshot.sceneReady || (counts[0] >= TARGET_ENEMIES && counts[1] >= TARGET_BULLETS);
  snapshot = {
    sceneReady: ready,
    enemies: counts[0],
    bullets: counts[1],
    tick: getSimTick(),
    quality: qualityOf(renderer),
    headless: renderer === null || renderer.headless === true,
    slots: countSlots(state),
    seenReady: snapshot.seenReady || ready,
  };
}

/**
 * 装配压力场景：开战 → 补足 300/500 → 标记就绪。
 * 只调用既有 startBattle / spawnCombatEntity / fireProjectile，不改 CAP、波次表、刷怪率、MAX_PROJECTILES。
 */
function installStressScene(app: App): void {
  const session = app.state.session as unknown as BenchSessionLike | null;
  if (session === null || typeof session.startBattle !== 'function') {
    return;
  }
  session.startBattle('campaign_8min', 'liubei');

  // startBattle 使用默认种子重建世界；把同一常量写回 session 仅供报告复核。
  const seededSession = app.state.session as unknown as BenchSessionLike;
  seededSession.roomSeed = BENCH_SEED;

  // ?q=0/1/2 仅设置渲染档位（分辨率/抗锯齿），从不写入 SimState。
  const rawQ = Number(new URLSearchParams(window.location.search).get('q'));
  if (rawQ === 0 || rawQ === 1 || rawQ === 2) {
    const renderer = app.renderer as unknown as BenchRendererLike | null;
    const level = rawQ === 0 ? 'low' : rawQ === 1 ? 'medium' : 'high';
    if (renderer !== null && typeof renderer.setQuality === 'function') {
      renderer.setQuality(level);
    }
  }

  installed = true;
  refresh(app);
}

/**
 * 侧载入口：第一行判定 bench 开关，非压测模式立即返回。
 */
export function register(app: App): void {
  if (typeof window === 'undefined' || new URLSearchParams(window.location.search).get('bench') !== '1') {
    return;
  }

  // 只读探针先安装，驱动侧可轮询直到 sceneReady=true。
  window.__WS_BENCH__ = {
    getSnapshot: (): BenchSnapshot => ({ ...snapshot }),
  };

  // order=999：晚于 presentation 的 Present(40)，在渲染完成后刷新探针。
  app.registerRenderSystem(999, (): void => {
    if (!installed) {
      // 等待异步 GPU 初始化与 systems.ts 的 startBattle 挂载。
      if (app.renderer !== null) {
        installStressScene(app);
      }
      return;
    }
    refresh(app);
  }, 'BenchStressScene');
}
