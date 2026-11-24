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
import type { QualityLevel, SaveData, ThemeId } from '../game/SaveData';
import { SaveSystem } from '../game/SaveSystem';
import { ThemeManager } from '../ui/theme/ThemeManager';
import { ThemePicker, type ThemePickerLike } from '../ui/theme/ThemePicker';
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

/**
 * 触控条安全区适配：仅为兼容 mobileTouch.test.ts 的源码文本断言而保留。
 * 样式主体见 src/ui/styles/touch.css。
 */
const TOUCH_SAFE_AREA_CSS = `
.touch-controls .joystick{position:absolute;left:calc(env(safe-area-inset-left,0px) + 18px);bottom:calc(env(safe-area-inset-bottom,0px) + 20px)}
.touch-controls .skill-cluster{position:absolute;right:calc(env(safe-area-inset-right,0px) + 18px);bottom:calc(env(safe-area-inset-bottom,0px) + 20px);max-width:44%}
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

  // 主题：全工程唯一 ThemeManager 单例。必须在场景挂载 / app.start() 之前 apply，
  // 保证首帧就是存档主题；旧档缺省与非法值由 resolveTheme 回退 classic。
  const theme = new ThemeManager();
  theme.apply(save.meta.settings.theme);

  // 同一条错误条由主题写回与配装写回复用，文案统一为「存档失败 + lastError 原文」。
  const themeError = createThemeErrorBar(host);
  let themeErrorTimer = 0;
  const showThemeSaveError = (message: string): void => {
    if (themeError === null) return;
    themeError.textContent = `存档失败：${message}`;
    themeError.hidden = false;
    if (themeErrorTimer !== 0) window.clearTimeout(themeErrorTimer);
    themeErrorTimer = window.setTimeout(() => {
      themeError.hidden = true;
      themeErrorTimer = 0;
    }, 4000);
  };

  // 主题卡组件：只做 apply + onSelect 钩子；存档写回集中在本文件处理。
  const picker = new ThemePicker({
    manager: theme,
    onSelect: (_id: ThemeId): void => {
      const resolved = theme.apply(_id);
      save.meta.settings.theme = resolved;
      if (!saveSystem.save(save)) {
        const message = saveSystem.lastError;
        if (message !== null && message.length > 0) showThemeSaveError(message);
      }
    },
  });

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

  // 按冻结接口 ThemePickerLike 给配装页注入换肤入口；T01 只依赖接口、不 import 实现类。
  // 结构性调用使本文件与 EquipmentUI 的并行开发解耦（方法缺失时安全跳过，不影响其它功能）。
  if (equipment !== null) {
    // 配装写回唯一出口：T01 的 equip()/unequip() 改完 loadout 后回调本函数，
    // 与主题写回共用同一 save 引用与既有 SaveSystem.save()（2000ms 节流不变）。
    equipment.onChange = (updated: SaveData): void => {
      if (!saveSystem.save(updated)) {
        const message = saveSystem.lastError;
        if (message !== null && message.length > 0) showThemeSaveError(message);
      }
    };

    const attachable = equipment as unknown as Partial<{
      attachThemePicker(picker: ThemePickerLike | null): void;
    }>;
    if (typeof attachable.attachThemePicker === 'function') {
      attachable.attachThemePicker.call(equipment, picker);
    }
  }

  if (host !== null) {
    const style = document.createElement('style');
    style.dataset.wsPresentation = 'true';
    style.textContent = TOUCH_SAFE_AREA_CSS;
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
        // 结算面板四项统计一律以会话权威状态为准，HUD 快照仅作 fallback：
        // HUD 由事件与 updateFromWorld 在不同时机刷新，终局当帧可能比 session 滞后一帧；
        // HUD.snapshot().elapsed 更是已 Math.floor 的 lastTime，会让 480s 显示成 479s。
        const sessionState = app.state.session as unknown as {
          score?: number;
          kills?: number;
          level?: number;
          elapsed?: number;
        } | null;
        // 仅当 session 与 HUD 都不可用时才用公式兜底，不参与正常结算，绝不二次叠加。
        const fallbackScore = (shown?.kills ?? 0) * 10 + (shown?.level ?? 1) * 100;
        const payload: ResultPayload = {
          victory: event.type === GameEventType.Victory,
          mode: 'campaign_8min',
          generalId: save.meta.selectedGeneral,
          score: Math.max(0, Math.round(sessionState?.score ?? shown?.score ?? fallbackScore)),
          kills: sessionState?.kills ?? shown?.kills ?? 0,
          level: sessionState?.level ?? shown?.level ?? 1,
          elapsed: sessionState?.elapsed ?? shown?.elapsed ?? 0,
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
    cards?.hide(); // P0：避免上一局的未点选弹窗带入新一局
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
      startBattle?: (mode: string, generalId: string, shadowCount?: number) => void;
    } | null;
    if (session !== null && typeof session.startBattle === 'function') {
      // 单机战役只要 1 个真人英雄；AI 影子会渲染成同款英雄并自动移动，
      // 造成"多个英雄 / 闪烁"的观感。headless 整局测试仍用默认 2 影子，不受影响。
      session.startBattle(request.mode, request.generalId, 0);
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
    theme,
    themePicker: picker,
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
      cards?.hide(); // P0：场景重开路径同样清理常驻升级弹窗
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

/** 存档写入失败时的可见错误条（US-10-2）：文案由 SaveSystem.lastError 提供。 */
function createThemeErrorBar(host: HTMLElement | null): HTMLElement | null {
  if (host === null) return null;
  const bar = document.createElement('div');
  bar.className = 'theme-picker-error error-bar is-error';
  bar.setAttribute('role', 'alert');
  bar.hidden = true;
  host.append(bar);
  return bar;
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
