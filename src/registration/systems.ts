/**
 * 批次 B1 侧载注册入口（ARCHITECTURE §5.5 / §6.3 / §6.5）。
 *
 * main.ts 通过 import.meta.glob 自动调用 register(app)；本文件只依赖批次 A
 * 的冻结导出与 B1 自身系统，绝不 import net/* 或 engine/Renderer（由 B2/C 并行落盘）。
 * 运行态对象在此一次性初始化，B2 的 NetSessionManager / EntityRegistry 可随后接管。
 */
import type { App } from '../app/App';
import { EFFECT_ENTITY_BASE, SNAPSHOT_POOL_SIZE, TICK_RATE } from '../core/Constants';
import { loadConfig } from '../core/Config';
import { Rng } from '../core/Rng';
import type { GameConfig } from '../data/types';
import { ALL_COMPONENTS } from '../ecs/bit/components';
import type { Eid } from '../ecs/bit/types';
import { add, has, type BattleWorld } from '../ecs/bit/adapter';
import { CommandBus } from '../ecs/bridge/CommandBus';
import { GameEventBus } from '../ecs/bridge/GameEventBus';
import { EntityPool, EffectEntityPool } from '../ecs/pools/EntityPool';
import { ParamPool } from '../ecs/pools/ParamPool';
import { SnapshotPool } from '../ecs/pools/SnapshotPool';
import { createBattleWorld } from '../ecs/world';
import { getSimTick, type SimState } from '../ecs/scheduler';
import { InputSystem } from '../ecs/systems/InputSystem';
import {
  ControlSourceRegistry,
  spawnLocalPlayers,
} from '../ecs/systems/control/IControlSource';
import {
  DeadRecycleSystem,
  LifetimeSystem,
  SpawnSystem,
  TimeSystem,
  battleSession,
  resetNetIdAllocator,
  setControlSink,
  setEntityRegistry,
  type EntityRegistryLike,
} from '../ecs/systems/LifecycleSystems';
import { AISystem } from '../ecs/systems/AISystem';
import { MovementSystem } from '../ecs/systems/MovementSystem';
import { BulletSystem, CollisionSystem, DamageSystem } from '../ecs/systems/CombatSystems';
import {
  ActionDispatchSystem,
  EffectCompileSystem,
  EffectRegistry,
  EffectTriggerSystem,
  resetEffectRuntime,
} from '../ecs/systems/EffectSystems';
import { StatResolveSystem } from '../ecs/systems/StatResolveSystem';
import {
  BossSystem,
  DropSystem,
  ExpSystem,
  LevelUpSystem,
  PickupSystem,
  resetProgressionRuntime,
} from '../ecs/systems/ProgressionSystems';
import {
  DirtyStat,
  EffectContext,
  Invulnerable,
  NetId,
  Owner,
  PlayerId,
  PlayerTag,
  Replicated,
  effectMask,
} from '../ecs/bit/components';

/** 与 A 的 App 默认 seed 一致；房间种子由 B2 的会话层可覆盖。 */
export const DEFAULT_ROOM_SEED = 0x9e3779b9;
const DEFAULT_SHADOW_COUNT = 2;

/** 组件是模块级单例 SoA：重建世界时清值，避免上一局的残留数据污染哈希。 */
function clearComponentData(): void {
  for (let i = 0; i < ALL_COMPONENTS.length; i++) {
    const comp = ALL_COMPONENTS[i];
    const fields = Object.keys(comp);
    for (let f = 0; f < fields.length; f++) {
      const array = comp[fields[f]];
      if (array !== undefined && typeof (array as Float32Array).fill === 'function') {
        (array as Float32Array).fill(0);
      }
    }
  }
}

export interface CreateStateOptions {
  seed?: number;
  shadowCount?: number;
  config?: GameConfig;
  registry?: EntityRegistryLike | null;
}

let activeControlRegistry: ControlSourceRegistry | null = null;
let activeEffectCompiler: EffectCompileSystem | null = null;
/**
 * 当前生效的战斗系统链。重开时替换为新 state 对应的系统实例；
 * 已注册的 wrapper 每次调用都从这里取，确保不持有旧世界/旧控制源。
 */
let currentSystems: BattleSystemEntry[] = [];

/** 供 B2 绑定 / 替换控制源（远端玩家、掉线降级影子）。 */
export function getControlRegistry(): ControlSourceRegistry | null {
  return activeControlRegistry;
}

/** 供 UI / 场景在换装升级时按需重新编译效果。 */
export function getEffectCompiler(): EffectCompileSystem | null {
  return activeEffectCompiler;
}

/** 构造一份完整可运行的世界状态；测试可直接驱动，无需 App / RAF。 */
export function createBattleState(options: CreateStateOptions = {}): SimState {
  const seed = options.seed ?? DEFAULT_ROOM_SEED;
  const shadowCount = options.shadowCount ?? DEFAULT_SHADOW_COUNT;
  const config = options.config ?? loadConfig();

  clearComponentData();
  resetNetIdAllocator();
  resetEffectRuntime();
  resetProgressionRuntime();

  const world: BattleWorld = createBattleWorld();
  const statCount = config.stats.all().length;
  const bucketCount = config.buckets.length;
  const state: SimState = {
    world,
    config,
    session: {
      role: 0,
      localNetId: 1,
      hostNetId: 1,
      localPlayerId: 0,
      roomSeed: seed,
      simTick: 0,
      lastAckedTick: 0,
      tickRate: TICK_RATE,
      playerCount: 1 + shadowCount,
      elapsed: 0,
      spawnAcc: 0,
      waveIndex: 0,
      nextNetId: 1 + shadowCount + 1,
      bossSpawned: 0,
      result: 0,
      // 直接驱动（测试 / DeterministicSim）默认处于战斗进行中。
      running: 1,
      startTick: 0,
    } as unknown as SimState['session'],
    pool: {
      entities: new EntityPool(world, 0, EFFECT_ENTITY_BASE),
      effects: new EffectEntityPool(world),
      params: new ParamPool(),
      snapshots: new SnapshotPool(SNAPSHOT_POOL_SIZE, statCount, bucketCount),
    },
    buses: {
      commands: new CommandBus(),
      events: new GameEventBus(),
    },
    rng: new Rng(seed),
  };

  setEntityRegistry(options.registry ?? null);
  const controlRegistry = new ControlSourceRegistry();
  activeControlRegistry = controlRegistry;
  setControlSink(controlRegistry);

  const players = spawnLocalPlayers(world, controlRegistry, state.buses.commands, shadowCount, seed);
  const registry = options.registry ?? null;
  for (let i = 0; i < players.length; i++) {
    const eid = players[i];
    add(world, eid, Replicated);
    add(world, eid, Invulnerable);
    add(world, eid, DirtyStat);
    add(world, eid, effectMask);
    EffectContext.source[eid] = eid >>> 0;
    DirtyStat.mask[eid] = 0xffffffff;
    if (registry !== null) {
      registry.bind(eid, NetId.value[eid], PlayerId.value[eid]);
    } else {
      Owner.netId[eid] = NetId.value[eid];
    }
  }
  battleSession(state).nextNetId = players.length + 1;

  // 效果只在开局编译一次：三名常用技能 + 全局击杀吸血。
  const registryEffects = config.effects.all();
  const effectIds: string[] = [];
  for (let i = 0; i < registryEffects.length && effectIds.length < 4; i++) {
    const id = registryEffects[i].id;
    if (registryEffects[i].trigger === 'onHit' || registryEffects[i].trigger === 'onCast' || id === 'eff_on_kill_lifesteal') {
      effectIds.push(id);
    }
  }
  const effectRegistry = new EffectRegistry();
  const compiler = new EffectCompileSystem(effectRegistry);
  activeEffectCompiler = compiler;
  for (let i = 0; i < players.length; i++) {
    compiler.compileAll(state, players[i], effectIds);
  }
  // 编译期创建 DirtyStat 后，属性系统会在首 tick 结算并写快照。
  return state;
}

export interface BattleSystemEntry {
  id: string;
  order: number;
  fn: (state: SimState, tick: number) => void;
}

/**
 * 创建 §6.3 冻结顺序的系统链。order 18 留空（B2 的 InputReport / BroadcastSnapshot），
 * DeadRecycleSystem 固定在最后；客户端负数 order 由 B2 自行注册。
 */
export function createBattleSystems(state: SimState): BattleSystemEntry[] {
  const control = activeControlRegistry;
  if (control === null) {
    throw new Error('createBattleSystems 必须先调用 createBattleState');
  }
  const effectRegistry = new EffectRegistry();
  const input = new InputSystem(control);
  const time = new TimeSystem();
  const lifetime = new LifetimeSystem();
  const spawn = new SpawnSystem();
  const ai = new AISystem();
  const movement = new MovementSystem();
  const bullet = new BulletSystem();
  const collision = new CollisionSystem();
  const damage = new DamageSystem();
  const trigger = new EffectTriggerSystem();
  const dispatch = new ActionDispatchSystem(effectRegistry);
  const stats = new StatResolveSystem(state.config);
  const drop = new DropSystem();
  const pickup = new PickupSystem();
  const exp = new ExpSystem();
  const level = new LevelUpSystem();
  const boss = new BossSystem();
  const recycle = new DeadRecycleSystem();

  return [
    { id: 'TimeSystem', order: 1, fn: (s, t) => time.run(s, t) },
    { id: 'InputSystem', order: 2, fn: (s, t) => input.run(s, t) },
    { id: 'LifetimeSystem', order: 3, fn: (s, t) => lifetime.run(s, t) },
    { id: 'SpawnSystem', order: 4, fn: (s, t) => spawn.run(s, t) },
    { id: 'AISystem', order: 5, fn: (s, t) => ai.run(s, t) },
    { id: 'MovementSystem', order: 6, fn: (s, t) => movement.run(s, t) },
    { id: 'BulletSystem', order: 7, fn: (s, t) => bullet.run(s, t) },
    { id: 'CollisionSystem', order: 8, fn: (s, t) => collision.run(s, t) },
    { id: 'DamageSystem', order: 9, fn: (s, t) => damage.run(s, t) },
    { id: 'EffectTriggerSystem', order: 10, fn: (s, t) => trigger.run(s, t) },
    { id: 'ActionDispatchSystem', order: 11, fn: (s, t) => dispatch.run(s, t) },
    { id: 'StatResolveSystem', order: 12, fn: (s, t) => stats.run(s, t) },
    { id: 'DropSystem', order: 13, fn: (s, t) => drop.run(s, t) },
    { id: 'PickupSystem', order: 14, fn: (s, t) => pickup.run(s, t) },
    { id: 'ExpSystem', order: 15, fn: (s, t) => exp.run(s, t) },
    { id: 'LevelUpSystem', order: 16, fn: (s, t) => level.run(s, t) },
    { id: 'BossSystem', order: 17, fn: (s, t) => boss.run(s, t) },
    { id: 'DeadRecycleSystem', order: 19, fn: (s, t) => recycle.run(s, t) },
  ];
}

/** C 的场景层通过 app.state.session 调用的两个会话方法。 */
export interface BattleSessionControls {
  startBattle(mode: string, generalId: string): void;
  endBattle(): void;
}

/** 把会话方法挂到普通对象上；重开后新 session 也需要同样的入口。 */
function attachSessionControls(session: SimState['session'], controls: BattleSessionControls): void {
  const view = session as unknown as Record<string, unknown>;
  view.startBattle = controls.startBattle;
  view.endBattle = controls.endBattle;
}

/**
 * 供测试 / B2 用自定义宿主注册（宿主只需 registerSimSystem）。
 * wrapper 不缓存 state/session：每次 tick 从传入 state 读 running，
 * 并从可变 currentSystems 取当前系统链，因此重开后无需重复注册。
 */
export function registerBattleSystems(
  host: { registerSimSystem(order: number, fn: (state: SimState, tick: number) => void, id: string): void },
  state: SimState,
): void {
  currentSystems = createBattleSystems(state);
  for (let i = 0; i < currentSystems.length; i++) {
    const entry = currentSystems[i];
    host.registerSimSystem(entry.order, (s, tick) => {
      if (battleSession(s).running !== 1) {
        return;
      }
      const active = currentSystems[i];
      if (active !== undefined) {
        active.fn(s, tick);
      }
    }, entry.id);
  }
}

/** 侧载入：由 main.ts 的 import.meta.glob 自动调用。 */
export function register(app: App): void {
  const state = createBattleState();
  // 启动落在 Boot/Menu/Select：战斗未开始，18 个系统全部空转。
  const initialSession = battleSession(state);
  initialSession.running = 0;
  initialSession.startTick = 0;

  const target = app.state as unknown as SimState;
  target.world = state.world;
  target.config = state.config;
  target.session = state.session;
  target.pool = state.pool;
  target.buses = state.buses;
  target.rng = state.rng;
  registerBattleSystems(app, state);

  const controls: BattleSessionControls = {
    startBattle: (mode: string, generalId: string): void => {
      const fresh = createBattleState();
      const freshSession = battleSession(fresh);
      freshSession.startTick = getSimTick();
      freshSession.running = 1;
      freshSession.result = 0;
      const extras = freshSession as unknown as Record<string, unknown>;
      extras.mode = mode;
      extras.generalId = generalId;

      const live = app.state as unknown as SimState;
      live.world = fresh.world;
      live.config = fresh.config;
      live.session = fresh.session;
      live.pool = fresh.pool;
      live.buses = fresh.buses;
      live.rng = fresh.rng;
      // 新世界对应新的控制源/效果运行时，必须整体重建系统链。
      currentSystems = createBattleSystems(fresh);
      attachSessionControls(live.session, controls);
    },
    endBattle: (): void => {
      battleSession(app.state as unknown as SimState).running = 0;
    },
  };
  attachSessionControls(target.session, controls);
}

/** 供调试面板确认本批次系统数量（18 = 1..17 + 19，order 18 属于 B2）。 */
export const BATTLE_SYSTEM_COUNT = 18;

/** 供 B2 确认玩家实体是否完整（含属性块与快照引用）。 */
export function hasPlayerRuntime(world: BattleWorld, eid: Eid): boolean {
  return has(world, eid, PlayerTag) && has(world, eid, DirtyStat);
}
