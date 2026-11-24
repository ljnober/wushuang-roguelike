/**
 * 批次 C 侧载注册入口（ARCHITECTURE §6.5）。
 *
 * main.ts 用 import.meta.glob 自动调用本文件的 register(app)：
 * 安装渲染器工厂、三个渲染系统、五个 DOM 场景、DOM UI 与 ?debug=1 调试面板。
 * 注意：本文件不 import 批次 B 的具体实现文件，只读取 app.state 上的结构性对象。
 */
import type { App } from '../app/App';
import { GameEventType, CommandType } from '../ecs/bridge/enums';
import type { GameEventBus } from '../ecs/bridge/GameEventBus';
import type { CommandBus } from '../ecs/bridge/CommandBus';
import { getAccumulator, getAlpha, getSimTick, getSystemCounts } from '../ecs/scheduler';
import type { BattleWorld } from '../ecs/bit/adapter';
import type { QualityLevel } from '../game/SaveData';
import { SaveSystem } from '../game/SaveSystem';
import { Renderer } from '../engine/Renderer';
import { PixiPools } from '../engine/PixiPools';
import { Viewport } from '../engine/Viewport';
import { TextureFactory } from '../engine/TextureFactory';
import { BattleFxSystem } from '../engine/BattleFx';
import { Audio } from '../engine/Audio';
import { PortraitFactory } from '../art/PortraitFactory';
import { ChibiFactory } from '../art/ChibiFactory';
import { HUDSystem, RenderSyncSystem, ViewportSystem } from '../ecs/systems/RenderSystems';
import type { HUDLike } from '../ecs/systems/RenderSystems';
import type { GameEvent } from '../ecs/bridge/GameEventBus';
import { HUD } from '../ui/HUD';
import { TouchControls } from '../ui/TouchControls';
import { CardsAndLevelUp, pickChoices } from '../ui/CardsAndLevelUp';
import { EquipmentUI } from '../ui/EquipmentUI';
import { MetaUI } from '../ui/MetaUI';
import {
  registerScenes,
  type BattleLauncher,
  type ResultPayload,
  type SceneDeps,
} from '../game/scenes';

const EXTRA_CSS = `
.hud__line{display:flex;gap:6px;align-items:center}.hud__label{opacity:.75;font-size:12px}
.hud__bar--exp{margin-top:5px;height:6px}.hud__bar-fill--exp{background:linear-gradient(90deg,#49c1ff,#8ce8ff)}
.hud__boss-warn{color:#ffb4a9;border-color:#ff5b4a;animation:pulse 1s infinite}
.hud__toasts{position:absolute;right:8px;bottom:92px;display:flex;flex-direction:column;gap:4px;align-items:flex-end}
.hud__toast{background:rgba(18,13,8,.85);border:1px solid #e8b84b55;border-radius:8px;padding:5px 9px;font-size:12px}
@keyframes pulse{50%{opacity:.55}}
.touch-controls{position:absolute;inset:0;pointer-events:none}
.touch-controls .joystick{position:absolute;left:calc(env(safe-area-inset-left,0px) + 18px);bottom:calc(env(safe-area-inset-bottom,0px) + 20px)}
.touch-controls .skill-cluster{position:absolute;right:calc(env(safe-area-inset-right,0px) + 18px);bottom:calc(env(safe-area-inset-bottom,0px) + 20px);max-width:44%}
.touch-control__auto{font-size:12px;min-width:56px}.aim-line{position:absolute;height:3px;background:linear-gradient(90deg,#e8b84b,#e8b84b00);pointer-events:none}
.card-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}
.card{min-height:132px;display:flex;flex-direction:column;gap:6px;text-align:left;padding:10px;border-color:#e8b84b88}
.card__level{font-size:11px;color:#e8b84b}.card__name{font-size:16px}.card__desc{font-size:11px;opacity:.8}.card__tags{font-size:10px;opacity:.6}
.panel--wide{width:min(920px,100%)}.panel__header,.panel__row{display:flex;justify-content:space-between;align-items:center;gap:10px}
.panel__title{margin:0 0 10px;font-size:20px;color:#e8b84b}.section-title{display:block;margin:8px 0;font-size:13px;color:#e8b84b}
.equip-columns{display:grid;grid-template-columns:minmax(240px,1fr) minmax(240px,1fr);gap:12px}
.slot-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.slot{min-height:44px;font-size:11px;padding:4px}.inventory-list{display:grid;grid-template-columns:1fr;gap:4px;max-height:230px;overflow-y:auto}
.inventory-item,.fold-button{text-align:left;min-height:40px;font-size:12px}.is-selected{border-color:#8ce8ff;background:#1b3340}
.rarity-common{color:#ddd}.rarity-blue{color:#8dc6ff}.rarity-gold{color:#f3c744}.rarity-legendary{color:#ff9d3f}
.item-detail{margin-top:12px;border-top:1px solid #e8b84b55;padding-top:10px;display:flex;flex-wrap:wrap;gap:8px}
.detail-title{width:100%;color:#e8b84b}.stat-row{min-width:120px;font-size:12px}.stat-row.up{color:#8ce8ff}.stat-row.down{color:#ff8a80}
.hint{font-size:12px;opacity:.65}.tab-bar,.action-row,.material-row,.cube-slots,.faction-filters,.setting-row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;align-items:center}
.tab{min-height:36px;font-size:12px}.tab.is-active,.faction-chip.is-active,.chip.is-active{border-color:#8ce8ff;background:#1b3340}
.chip,.faction-chip{min-height:36px;font-size:12px;padding:4px 10px}.meta-list{max-height:260px;overflow-y:auto;display:grid;gap:4px}
.meta-list button{text-align:left;min-height:40px;font-size:12px}.gem-row{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px}
.leaderboard{font-size:13px;line-height:1.8;padding-left:22px}.setting-label{min-width:96px;font-size:12px}
.general-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px;max-height:56vh;overflow-y:auto;padding:4px}
.general-card{min-height:146px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px;background:linear-gradient(160deg,rgba(58,42,25,.9),rgba(31,22,14,.94));border-color:rgba(232,184,75,.42);transition:transform 120ms ease,border-color 120ms ease,filter 120ms ease}
.general-card:hover{transform:translateY(-3px);border-color:#8ce8ff;filter:brightness(1.12)}
.general-portrait{width:82px;height:82px;border-radius:14px;box-shadow:0 5px 16px rgba(0,0,0,.55)}.general-name{font-size:14px;font-weight:700}.general-title{font-size:10px;opacity:.65}
.boot-title,.menu-title,.result-title{font-size:clamp(48px,8vw,76px);letter-spacing:.2em;text-align:center;line-height:1.15;background:linear-gradient(180deg,#ffe9a8,#e8b84b 55%,#9b6c1e);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 6px 18px rgba(232,184,75,.32))}.boot-sub,.menu-sub,.result-lines{text-align:center;opacity:.8;margin:12px 0;letter-spacing:.12em;font-size:14px}
.boot-enter,.primary{border-color:#f6dda0;background:linear-gradient(180deg,#e0b253,#a5741f);color:#1a1107;font-weight:800;letter-spacing:.12em;min-width:132px}.menu-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:22px}
.ws-debug{position:absolute;top:4px;left:4px;z-index:99;background:rgba(0,0,0,.8);color:#7dffb0;font:11px/1.5 monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre}
@media (max-width:640px){.equip-columns{grid-template-columns:1fr}.card-grid{grid-template-columns:1fr}.general-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
`;

interface Runtime {
  renderer: Renderer | null;
  pools: PixiPools | null;
  textures: TextureFactory | null;
  chibi: ChibiFactory | null;
  fx: BattleFxSystem | null;
  viewport: Viewport;
  viewportSystem: ViewportSystem | null;
  renderSync: RenderSyncSystem | null;
  hudSystem: HUDSystem | null;
  worldToken: BattleWorld | null;
  busToken: GameEventBus | null;
  debugPanel: HTMLDivElement | null;
  lastFxAt: number;
  frames: number;
  fps: number;
  lastFpsAt: number;
}

function isDebug(): boolean {
  return typeof __DEBUG__ !== 'undefined' && __DEBUG__;
}

/** 仅注册期调用一次：安装全部批次 C 能力。 */
export function register(app: App): void {
  const saveSystem = new SaveSystem();
  const save = saveSystem.load();
  const config = app.state.config;
  const host: HTMLElement | null =
    typeof document !== 'undefined'
      ? (document.getElementById('app') ?? document.body)
      : null;

  const runtime: Runtime = {
    renderer: null,
    pools: null,
    textures: null,
    chibi: null,
    fx: null,
    viewport: new Viewport(host?.clientWidth ?? 1280, host?.clientHeight ?? 720),
    viewportSystem: null,
    renderSync: null,
    hudSystem: null,
    worldToken: null,
    busToken: null,
    debugPanel: null,
    lastFxAt: 0,
    frames: 0,
    fps: 0,
    lastFpsAt: 0,
  };

  // DOM UI 在浏览器环境初始化；node 测试环境保持 headless。
  const audio = new Audio();
  audio.setEnabled(save.meta.settings.sfx);
  const portraits = new PortraitFactory();
  const hud = host !== null ? new HUD(host) : null;
  const touch = host !== null ? new TouchControls(host) : null;
  const cards = host !== null ? new CardsAndLevelUp(host) : null;
  const equipment = host !== null ? new EquipmentUI(host, config) : null;
  const meta = host !== null ? new MetaUI(host, config) : null;

  if (host !== null) {
    const style = document.createElement('style');
    style.dataset.wsPresentation = 'true';
    style.textContent = EXTRA_CSS;
    document.head.append(style);
    if ('ontouchstart' in window) host.classList.add('ws-mobile');
    window.addEventListener('resize', () => {
      runtime.viewport.setSize(host.clientWidth, host.clientHeight);
      runtime.renderer?.resize(host.clientWidth, host.clientHeight);
    });
    window.addEventListener('pointerdown', () => audio.unlock(), { once: true });
  }

  // 渲染器工厂：App.start() 会异步调用；失败时在工厂内降级 headless。
  app.setRenderer(async () => {
    if (host === null) {
      const headless = Renderer.headless(save.meta.settings.quality);
      runtime.renderer = headless;
      return headless;
    }
    const renderer = await Renderer.create(host, save.meta.settings.quality);
    runtime.renderer = renderer;
    if (!renderer.headless) host.insertBefore(renderer.canvas, host.firstChild);
    return renderer;
  });

  /** 渲染运行时惰性初始化：GPU 就绪、世界存在时才创建池与系统。 */
  const ensureRuntime = (world: BattleWorld | null): void => {
    const renderer = runtime.renderer;
    if (renderer === null) return;
    if (runtime.pools === null) {
      const pools = new PixiPools(renderer);
      const textures = new TextureFactory(renderer);
      const chibi = new ChibiFactory(renderer, textures, pools);
      chibi.ensureAll(config);
      runtime.pools = pools;
      runtime.textures = textures;
      runtime.chibi = chibi;
      runtime.viewport.applyTo(pools.getRoot());
      runtime.fx = new BattleFxSystem(runtime.pools.getRoot());
    }
    if (world === null || world === runtime.worldToken) return;
    runtime.worldToken = world;
    runtime.fx?.reset();
    runtime.viewport.reset();
    runtime.viewportSystem = new ViewportSystem(world, runtime.viewport);
    runtime.renderSync = new RenderSyncSystem(runtime.pools, world);
    runtime.busToken = null;
  };

  let seq = 0;
  const pushCommand = (type: CommandType, a: number, b: number, c: number): void => {
    const bus = app.state.buses?.commands as CommandBus | undefined;
    if (bus === undefined || bus === null) return;
    bus.push({ type, playerId: 0, a, b, c, seq: ++seq });
  };

  if (touch !== null) {
    touch.onMove = (x, y) => pushCommand(CommandType.Move, Math.round(x * 1000), Math.round(y * 1000), 0);
    touch.onAim = (x, y) => pushCommand(CommandType.Aim, Math.round(x * 1000), Math.round(y * 1000), 0);
    touch.onSkill = (index, aimX, aimY) => {
      audio.play('attack');
      pushCommand(
        CommandType.Skill,
        index,
        Math.round(aimX * 1000),
        Math.round(aimY * 1000),
      );
    };
    touch.onDodge = (aimX, aimY) => {
      audio.play('attack');
      pushCommand(CommandType.Skill, 3, Math.round(aimX * 1000), Math.round(aimY * 1000));
    };
    touch.onAutoToggle = (auto) => {
      save.meta.settings.controlMode = auto ? 'auto' : 'manual';
      cards?.setAutoMode(auto);
      saveSystem.save(save);
      pushCommand(CommandType.AutoToggle, auto ? 1 : 0, 0, 0);
    };
    touch.setAutoMode(save.meta.settings.controlMode === 'auto');
  }
  cards?.setAutoMode(save.meta.settings.controlMode === 'auto');

  let resultShown = false;
  const hudBridge: HUDLike = {
    onEvent(event: GameEvent): void {
      if (hud !== null) hud.onEvent(event);
      if (event.type === GameEventType.LevelUp) {
        if (app.sceneManager.current?.id === 'battle') showLevelUp();
        audio.play('levelup');
      } else if (event.type === GameEventType.Kill || event.type === GameEventType.Damage) {
        audio.play(event.type === GameEventType.Kill ? 'pickup' : 'hit');
      } else if (event.type === GameEventType.BossWarn) {
        audio.play('bossWarn');
      } else if (event.type === GameEventType.Victory || event.type === GameEventType.Defeat) {
        audio.play('levelup');
        if (resultShown) return;
        resultShown = true;
        const shown = hud !== null ? hud.snapshot() : null;
        // HUD.score 已由 session.score 按同一公式逐 tick 回写；
        // 这里不再二次叠加，否则结算分会是局内显示的两倍。
        const fallbackScore = (shown?.kills ?? 0) * 10 + (shown?.level ?? 1) * 100;
        const payload: ResultPayload = {
          victory: event.type === GameEventType.Victory,
          mode: 'campaign_8min',
          generalId: save.meta.selectedGeneral,
          score: Math.max(0, Math.round(shown !== null ? shown.score : fallbackScore)),
          kills: shown?.kills ?? 0,
          level: shown?.level ?? 1,
          elapsed: shown?.elapsed ?? 0,
          damage: 0,
        };
        app.sceneManager.switchTo('result', payload);
      }
    },
  };

  const showLevelUp = (): void => {
    if (cards === null) return;
    const choices = pickChoices(config, 0x9e3779b9, getSimTick(), 3);
    if (choices.length === 0) return;
    cards.show(choices, (choice) => {
      const upgrades = save.meta.upgrades;
      upgrades[choice.id] = (upgrades[choice.id] ?? 0) + 1;
      saveSystem.save(save);
      audio.play('levelup');
    });
  };

  const setQuality = (quality: QualityLevel): void => {
    save.meta.settings.quality = quality;
    runtime.renderer?.setQuality(quality);
    runtime.pools?.setQuality(quality);
  };

  const battleLauncher: BattleLauncher = (request) => {
    resultShown = false;
    hud?.reset();
    runtime.pools?.releaseAll();
    runtime.viewport.reset();
    save.meta.selectedGeneral = request.generalId;
    save.run = {
      mode: request.mode,
      generalId: request.generalId,
      elapsed: 0,
      playerId: 0,
      participants: [request.generalId],
      pickedEquipment: [],
      pickedGems: [],
      pity: {},
    };
    const session = app.state.session as unknown as {
      startBattle?: (mode: string, generalId: string) => void;
    } | null;
    if (session !== null && typeof session.startBattle === 'function') {
      session.startBattle(request.mode, request.generalId);
    }
    // startBattle 会替换命令总线，因此自动/Manual 状态必须在开战后重新下发，
    // 否则默认 auto 存档只在 UI 上显示"自动"，ECS 仍按手动空转。
    pushCommand(
      CommandType.AutoToggle,
      save.meta.settings.controlMode === 'auto' ? 1 : 0,
      0,
      0,
    );
  };

  const deps: SceneDeps = {
    save,
    saveSystem,
    config,
    audio,
    portraits,
    hud: hud as HUD,
    touch: touch as TouchControls,
    cards: cards as CardsAndLevelUp,
    equipment: equipment as EquipmentUI,
    meta: meta as MetaUI,
    viewport: runtime.viewport,
    battleLauncher,
    setQuality,
    setControlMode: (mode: 'auto' | 'manual'): void => {
      pushCommand(CommandType.AutoToggle, mode === 'auto' ? 1 : 0, 0, 0);
    },
    resetBattle: () => {
      runtime.pools?.releaseAll();
      runtime.viewport.reset();
      resultShown = false;
    },
  };

  // 渲染系统顺序冻结：Viewport(10) → RenderSync(20) → HUD(30) → Present(40)。
  app.registerRenderSystem(10, () => {
    const world = app.state.world as BattleWorld | null;
    if (world === null) return;
    ensureRuntime(world);
    runtime.viewportSystem?.run();
  }, 'ViewportSystem');

  app.registerRenderSystem(20, (alpha) => {
    const world = app.state.world as BattleWorld | null;
    if (world === null || runtime.pools === null) return;
    runtime.renderSync?.run(alpha);
    runtime.viewport.applyTo(runtime.pools.getRoot());
  }, 'RenderSyncSystem');

  // 纯渲染反馈：敌人血条 / 伤害数字 / 命中碎片，不参与模拟。
  app.registerRenderSystem(25, () => {
    const world = app.state.world as BattleWorld | null;
    if (world === null) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = runtime.lastFxAt === 0 ? 0 : (now - runtime.lastFxAt) / 1000;
    runtime.lastFxAt = now;
    runtime.fx?.run(world, dt);
  }, 'BattleFxSystem');

  app.registerRenderSystem(30, () => {
    const world = app.state.world as BattleWorld | null;
    const bus = app.state.buses?.events as GameEventBus | undefined;
    if (bus !== undefined && bus !== null && bus !== runtime.busToken) {
      runtime.busToken = bus;
      runtime.hudSystem = new HUDSystem(bus, hudBridge);
    }
    runtime.hudSystem?.run();
    hud?.updateFromWorld(world, app.state.session);
  }, 'HUDSystem');

  app.registerRenderSystem(40, () => {
    runtime.renderer?.render();
    runtime.frames++;
    if (isDebug()) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - runtime.lastFpsAt >= 500) {
        runtime.fps = (runtime.frames * 1000) / Math.max(1, now - runtime.lastFpsAt);
        runtime.frames = 0;
        runtime.lastFpsAt = now;
        updateDebugPanel(runtime, app);
      }
    }
  }, 'Present');

  if (isDebug() && host !== null) {
    runtime.debugPanel = document.createElement('div');
    runtime.debugPanel.className = 'ws-debug';
    host.append(runtime.debugPanel);
  }

  registerScenes(app, deps);
  app.sceneManager.switchTo('boot');
}

function updateDebugPanel(runtime: Runtime, app: App): void {
  if (runtime.debugPanel === null) return;
  const counts = getSystemCounts();
  const world = app.state.world as BattleWorld | null;
  runtime.debugPanel.textContent = [
    `FPS ${runtime.fps.toFixed(1)}  tick ${getSimTick()}  alpha ${getAlpha().toFixed(3)}`,
    `acc ${getAccumulator().toFixed(4)}  systems sim/render ${counts.sim}/${counts.render}`,
    `world ${world === null ? 'null' : 'ready'}  slots ${runtime.pools?.activeCount ?? 0}`,
    `textures ${runtime.textures?.size ?? 0}  quality ${runtime.renderer?.quality ?? '-'}`,
    `headless ${runtime.renderer?.headless ?? true}`,
  ].join('\n');
}
