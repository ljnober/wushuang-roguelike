/**
 * 应用外壳：RAF 驱动 + 渲染器/场景管理（ARCHITECTURE §5.11 / §6.5）。
 *
 * 调度权威：src/ecs/scheduler.ts 是唯一的系统注册表与固定 tick 时钟。
 * App 只负责从 RAF 求 rawDt、管理渲染器与场景，并把注册与帧推进委托给 scheduler，
 * 保证 B/C 经 app.register* 注册的系统与 DeterministicSim 走同一份权威注册表。
 *
 * 本文件刻意不静态 import 批次 B/C 才存在的模块（net/*、engine/*、game/scenes/*），
 * 以便批次 A 单独构建。跨批次对象通过下列结构性接口接入：B/C 传入的真实对象
 * 按 TypeScript 结构化类型匹配即可，字段使用 any 以保证与真实类型双向可赋值。
 *
 * 时间规则：只在帧驱动入口读取 RAF 时间求 rawDt；逻辑系统永不读墙钟。
 * accumulator 循环、不丢 tick、alpha 计算全部由 scheduler 承担。
 */
import { WushuangError, assert } from '../core/Constants';
import { loadConfig } from '../core/Config';
import { Rng } from '../core/Rng';
import {
  getAlpha,
  getSimTick,
  registerRenderSystem as schedulerRegisterRenderSystem,
  registerSimSystem as schedulerRegisterSimSystem,
  renderFrame,
  simulateTick,
} from '../ecs/scheduler';

const STATE_SEED = 0x9e3779b9;
const ERR_SYSTEM = 1004;
const ERR_SCENE_MISSING = 1005;
const ERR_SCENE_FACTORY = 1006;
const ERR_RENDERER_FACTORY = 1007;

export type SceneId = 'boot' | 'menu' | 'select' | 'battle' | 'result' | 'settings';

/** 冻结契约 §5.11 `SimState` 的结构性替身。 */
export interface SimStateLike {
  world: any;
  config: any;
  session: any;
  pool: any;
  buses: any;
  rng: any;
}

/** 冻结契约 §5.10 `Renderer` 的结构性替身。 */
export interface RendererLike {
  readonly canvas: any;
  setQuality(quality: any): void;
  generateTexture(target: any, resolution?: number): any;
  destroy(): void;
}

/** 冻结契约 §5.11 `SceneContext` 的结构性替身。 */
export interface SceneContextLike {
  app: App;
  save: any;
  config: any;
  payload?: unknown;
}

/** 冻结契约 §5.11 `Scene` 的结构性替身。 */
export interface SceneLike {
  readonly id: SceneId;
  onEnter(ctx: SceneContextLike): void;
  onExit(): void;
  onFrame?(dt: number): void;
}

/** 冻结契约 §5.11 `SceneManager` 的本地实现（批次 A 不能依赖 game/scenes）。 */
export class SceneManager {
  private readonly factories = new Map<SceneId, () => SceneLike>();
  private currentScene: SceneLike | null = null;
  private owner: App | null = null;
  private saveProvider: (() => any) | null = null;

  attach(app: App): void {
    this.owner = app;
  }

  setSaveProvider(provider: () => any): void {
    this.saveProvider = provider;
  }

  register(id: SceneId, factory: () => SceneLike): void {
    assert(typeof factory === 'function', ERR_SCENE_FACTORY, `SceneManager: 场景 ${id} 的 factory 非法`);
    this.factories.set(id, factory);
  }

  switchTo(id: SceneId, payload?: unknown): void {
    if (this.currentScene) {
      this.currentScene.onExit();
    }
    const factory = this.factories.get(id);
    if (!factory) {
      throw new WushuangError(ERR_SCENE_MISSING, `SceneManager: 未注册场景 ${id}`);
    }
    const scene = factory();
    this.currentScene = scene;
    const ctx: SceneContextLike = {
      app: this.owner as App,
      save: this.saveProvider ? this.saveProvider() : null,
      config: this.owner ? this.owner.state.config : null,
      payload,
    };
    scene.onEnter(ctx);
  }

  get current(): SceneLike | null {
    return this.currentScene;
  }

  frame(dt: number): void {
    const scene = this.currentScene;
    if (scene && scene.onFrame) {
      scene.onFrame(dt);
    }
  }

  clear(): void {
    if (this.currentScene) {
      this.currentScene.onExit();
    }
    this.currentScene = null;
  }
}

export class App {
  private readonly manager = new SceneManager();
  private readonly simState: SimStateLike;

  private rendererFactory: (() => Promise<RendererLike>) | null = null;
  private rendererInstance: RendererLike | null = null;
  private lastTime = 0;
  private rafId = 0;
  private started = false;

  constructor() {
    this.simState = this.createState();
    this.manager.attach(this);
  }

  private createState(): SimStateLike {
    const config = loadConfig();
    return {
      world: null,
      config,
      session: null,
      pool: { entities: null, params: null, snapshots: null },
      buses: { commands: null, events: null },
      rng: new Rng(STATE_SEED),
    };
  }

  registerSimSystem(order: number, fn: (state: SimStateLike, tick: number) => void, id: string): void {
    assert(Number.isFinite(order), ERR_SYSTEM, `sim 系统 ${id} 的 order 非法`);
    assert(typeof fn === 'function', ERR_SYSTEM, `sim 系统 ${id} 的 fn 非法`);
    // 适配闭包只在注册期创建，热路径零分配。
    schedulerRegisterSimSystem(order, (s, tick) => fn(s, tick), id);
  }

  registerRenderSystem(order: number, fn: (alpha: number) => void, id: string): void {
    assert(Number.isFinite(order), ERR_SYSTEM, `render 系统 ${id} 的 order 非法`);
    assert(typeof fn === 'function', ERR_SYSTEM, `render 系统 ${id} 的 fn 非法`);
    schedulerRegisterRenderSystem(order, (_s, alpha) => fn(alpha), id);
  }

  setRenderer(factory: () => Promise<RendererLike>): void {
    assert(typeof factory === 'function', ERR_RENDERER_FACTORY, 'renderer factory 非法');
    this.rendererFactory = factory;
  }

  registerScene(id: SceneId, factory: () => SceneLike): void {
    this.manager.register(id, factory);
  }

  /** 供批次 C 注入存档读取器，构造 SceneContext.save。 */
  setSaveProvider(provider: () => any): void {
    this.manager.setSaveProvider(provider);
  }

  get sceneManager(): SceneManager {
    return this.manager;
  }

  get state(): SimStateLike {
    return this.simState;
  }

  get renderer(): RendererLike | null {
    return this.rendererInstance;
  }

  get tick(): number {
    return getSimTick();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.rendererFactory) {
      const factory = this.rendererFactory;
      factory()
        .then((renderer) => {
          this.rendererInstance = renderer;
        })
        .catch((error: unknown) => {
          // 渲染失败降级为 headless，绝不阻断逻辑 tick。
          if (typeof console !== 'undefined') {
            console.warn('[App] renderer 初始化失败，降级为无渲染模式', error);
          }
        });
    }
    this.lastTime = this.now();
    const frame = (time: number): void => {
      this.frameStep(time);
      this.rafId = this.scheduleFrame(frame);
    };
    this.rafId = this.scheduleFrame(frame);
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (typeof cancelAnimationFrame === 'function' && this.rafId) {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = 0;
  }

  /** 供确定性 harness 注入合成时间；rawDt 之后的全部工作委托权威 scheduler。 */
  frameStep(time: number): void {
    const rawDt = Math.max(0, (time - this.lastTime) * 0.001);
    this.lastTime = time;
    simulateTick(this.simState as any, rawDt);
    renderFrame(this.simState as any, getAlpha());
    this.manager.frame(rawDt);
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : 0;
  }

  private scheduleFrame(cb: (time: number) => void): number {
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(cb);
    }
    return setTimeout(() => cb(this.now()), 16) as unknown as number;
  }
}

export function createApp(): App {
  return new App();
}
