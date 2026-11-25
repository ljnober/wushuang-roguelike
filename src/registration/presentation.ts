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
import { skillIconsForGeneral } from '../art/SkillIconFactory';
import { ChibiFactory } from '../art/ChibiFactory';
import { HUDSystem, RenderSyncSystem, ViewportSystem } from '../ecs/systems/RenderSystems';
import type { HUDLike } from '../ecs/systems/RenderSystems';
import type { GameEvent } from '../ecs/bridge/GameEventBus';
import { HUD } from '../ui/HUD';
import { TouchControls } from '../ui/TouchControls';
import { CardsAndLevelUp, type LevelUpChoice } from '../ui/CardsAndLevelUp';
import { RunStatusPanel, type RunStatusTab } from '../ui/RunStatusPanel';
import { formatLevelUpDescription } from '../data/skillDescription';
import { buildHUDInitial, buildRunStatusVM } from './runStatusVM';
import { resolveSkillSlots } from '../data/skillSlots';
import { getLevelChoices, selectLevelChoice } from '../ecs/systems/ProgressionSystems';
import { collectRunLoot, getSkillLevel, setPendingLoadout } from '../game/RunLoot';
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

/** Tab 辅助键的切页顺序；升级弹窗优先，避免面板抢焦点。 */
const STATUS_TAB_ORDER: readonly RunStatusTab[] = ['overview', 'equipment', 'skills', 'stats'];

function nextStatusTab(tab: RunStatusTab): RunStatusTab {
  const index = STATUS_TAB_ORDER.indexOf(tab);
  return STATUS_TAB_ORDER[(index + 1) % STATUS_TAB_ORDER.length];
}

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
  // 技能键直接显示当前武将的矢量技能图标，不再用「技1/技2/技3」编号。
  touch?.setSkillIcons(skillIconsForGeneral(config, save.meta.selectedGeneral));
  // 状态面板先于升级弹窗挂载：同为 z-index 30 时弹窗 DOM 在后，天然置顶。
  let statusTrigger: HTMLButtonElement | null = null;
  const statusPanel = host !== null
    ? new RunStatusPanel({
        host,
        onClose: () => {
          if (statusTrigger !== null && !statusTrigger.hidden) statusTrigger.focus();
        },
      })
    : null;
  const cards = host !== null ? new CardsAndLevelUp(host) : null;
  const equipment = host !== null ? new EquipmentUI(host, config) : null;
  const meta = host !== null ? new MetaUI(host, config) : null;

  /** presentation 唯一的 VM 入口：只读组装，面板不持有 ECS 引用。 */
  const buildVM = (): ReturnType<typeof buildRunStatusVM> =>
    buildRunStatusVM({
      app,
      config,
      generalId: save.meta.selectedGeneral,
      controlMode: save.meta.settings.controlMode,
    });

  /** 装备/宝石/升级事件后立刻刷新可见面板；面板不可见时零开销。 */
  const refreshStatusPanel = (): void => {
    if (statusPanel?.visible === true) statusPanel.update(buildVM());
  };

  if (host !== null) {
    statusTrigger = document.createElement('button');
    statusTrigger.type = 'button';
    statusTrigger.className = 'ws-status-trigger';
    statusTrigger.textContent = '角色状态';
    statusTrigger.hidden = true;
    statusTrigger.addEventListener('click', () => {
      if (cards?.visible === true) return;
      if (statusPanel?.visible === true) statusPanel.close();
      else statusPanel?.open(buildVM());
    });
    host.append(statusTrigger);
  }

  /**
   * 升级弹窗暂停状态机：暂停只写 presentation 侧的 session.running，
   * 且仅在 manual + battle + running=1 三守卫全部通过时生效；幂等。
   */
  let levelUpPaused = false;
  const battleRunning = (): { get(): number; set(v: number): void } | null => {
    const s = app.state.session as unknown as { running?: number } | null;
    if (s === null || typeof s.running !== 'number') return null;
    return { get: () => s.running as number, set: (v) => { s.running = v; } };
  };
  const pauseForLevelUp = (): void => {
    if (save.meta.settings.controlMode === 'auto') return;
    if (app.sceneManager.current?.id !== 'battle') return;
    if (levelUpPaused) return;
    const running = battleRunning();
    if (running === null || running.get() !== 1) return;
    running.set(0);
    levelUpPaused = true;
  };
  const resumeFromLevelUp = (): void => {
    if (!levelUpPaused) return;
    levelUpPaused = false;
    const running = battleRunning();
    if (running !== null && app.sceneManager.current?.id === 'battle') running.set(1);
  };

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
    // Tab 打开/切页，Esc 关闭；仅 battle 场景生效，升级弹窗优先。
    window.addEventListener('keydown', (event: KeyboardEvent): void => {
      if (app.sceneManager.current?.id !== 'battle') return;
      if (event.key === 'Tab') {
        event.preventDefault();
        if (cards?.visible === true) return;
        if (statusPanel?.visible === true) statusPanel.setTab(nextStatusTab(statusPanel.tab));
        else statusPanel?.open(buildVM());
      } else if (event.key === 'Escape') {
        if (statusPanel?.visible === true) {
          event.preventDefault();
          statusPanel.close();
        }
      }
    });
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
      (app.state.session as unknown as { autoLevel?: number }).autoLevel = auto ? 1 : 0;
    };
    touch.setAutoMode(save.meta.settings.controlMode === 'auto');
  }
  cards?.setAutoMode(save.meta.settings.controlMode === 'auto');

  let resultShown = false;
  let vmRefreshTick = 0;
  const hudBridge: HUDLike = {
    onEvent(event: GameEvent): void {
      if (hud !== null) hud.onEvent(event);
      if (event.type === GameEventType.LevelUp) {
        if (app.sceneManager.current?.id === 'battle') showLevelUp();
        audio.play('levelup');
        refreshStatusPanel();
      } else if (event.type === GameEventType.Equip || event.type === GameEventType.GemSocket) {
        refreshStatusPanel();
      } else if (event.type === GameEventType.Kill || event.type === GameEventType.Damage) {
        audio.play(event.type === GameEventType.Kill ? 'pickup' : 'hit');
      } else if (event.type === GameEventType.BossWarn) {
        audio.play('bossWarn');
      } else if (event.type === GameEventType.Victory || event.type === GameEventType.Defeat) {
        audio.play('levelup');
        resumeFromLevelUp(); // 暂停态不得带入结算；endBattle 自行维持 running=0
        statusPanel?.close();
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
          localPlayerId?: number;
        } | null;
        // 仅当 session 与 HUD 都不可用时才用公式兜底，不参与正常结算，绝不二次叠加。
        const fallbackScore = (shown?.kills ?? 0) * 10 + (shown?.level ?? 1) * 100;
        // 局内战利品带回仓库（D3 秘境式长期成长）；本处已有 resultShown 去重，只写一次。
        const loot = collectRunLoot(sessionState?.localPlayerId ?? 0);
        let lootEquipment = 0;
        let lootGems = 0;
        const warehouse = save.meta.warehouse;
        for (let i = 0; i < loot.equipment.length; i++) {
          const item = loot.equipment[i];
          if (warehouse.capacity > 0 && warehouse.items.length >= warehouse.capacity) break;
          if (warehouse.items.some((owned) => owned.uid === item.uid)) continue;
          warehouse.items.push(item);
          lootEquipment++;
        }
        for (let i = 0; i < loot.gems.length; i++) {
          const gem = loot.gems[i];
          if (save.meta.gems.inventory.some((owned) => owned.uid === gem.uid)) continue;
          save.meta.gems.inventory.push(gem);
          lootGems++;
        }
        saveSystem.saveNow(save);
        const payload: ResultPayload = {
          victory: event.type === GameEventType.Victory,
          mode: 'campaign_8min',
          generalId: save.meta.selectedGeneral,
          score: Math.max(0, Math.round(sessionState?.score ?? shown?.score ?? fallbackScore)),
          kills: sessionState?.kills ?? shown?.kills ?? 0,
          level: sessionState?.level ?? shown?.level ?? 1,
          elapsed: sessionState?.elapsed ?? shown?.elapsed ?? 0,
          damage: 0,
          lootEquipment,
          lootGems,
        };
        app.sceneManager.switchTo('result', payload);
      }
    },
  };

  const showLevelUp = (): void => {
    if (cards === null) return;
    const codes = new Int32Array(3);
    getLevelChoices(0, codes);
    const bindings = resolveSkillSlots(config, save.meta.selectedGeneral);
    const stats = config.stats.all();
    const choices: LevelUpChoice[] = [];
    let pickCode = -1;
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code >= 0 && code < 3) {
        const skill = config.skills.tryGet(bindings[code].skillId);
        if (skill === undefined) continue;
        const level = getSkillLevel(0, code) + 1;
        choices.push({
          id: skill.id,
          name: skill.name,
          description: formatLevelUpDescription(skill, level),
          level,
          tags: skill.tags,
        });
      } else {
        const stat = stats[code - 3];
        if (stat === undefined) continue;
        choices.push({ id: stat.id, name: stat.name, description: '属性强化 +3', level: 1, tags: ['属性'] });
      }
      if (pickCode < 0) pickCode = code;
    }
    if (choices.length === 0) return;
    // auto 模式由 ECS 默认选第一项，弹窗会挡住战斗；手动模式才等待玩家点选。
    if (save.meta.settings.controlMode === 'auto') return;
    pauseForLevelUp();
    statusPanel?.close(); // 面板与升级弹窗互斥
    cards.show(choices, (choice) => {
      for (let i = 0; i < choices.length; i++) {
        if (choices[i].id === choice.id) selectLevelChoice(0, i);
      }
      const upgrades = save.meta.upgrades;
      upgrades[choice.id] = (upgrades[choice.id] ?? 0) + 1;
      saveSystem.save(save);
      audio.play('levelup');
      resumeFromLevelUp();
    });
  };

  const setQuality = (quality: QualityLevel): void => {
    save.meta.settings.quality = quality;
    runtime.renderer?.setQuality(quality);
    runtime.pools?.setQuality(quality);
  };

  const battleLauncher: BattleLauncher = (request) => {
    resultShown = false;
    resumeFromLevelUp(); // 清理上一局残留的升级暂停，再隐藏弹窗
    cards?.hide(); // P0：避免上一局的未点选弹窗带入新一局
    statusPanel?.close();
    runtime.pools?.releaseAll();
    runtime.viewport.reset();
    save.meta.selectedGeneral = request.generalId;
    touch?.setSkillIcons(skillIconsForGeneral(config, request.generalId));
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
    // 局外仓库中该武将已穿戴的装备，开局即编译为属性 Modifier。
    const loadout = save.meta.loadouts[request.generalId] ?? {};
    const equippedUids: string[] = [];
    for (const slotId in loadout) {
      const uid = loadout[slotId];
      if (uid !== null && uid !== undefined) equippedUids.push(uid);
    }
    const worn = equippedUids
      .map((uid) => save.meta.warehouse.items.find((item) => item.uid === uid))
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
    setPendingLoadout(request.generalId, worn);
    const session = app.state.session as unknown as {
      startBattle?: (mode: string, generalId: string, shadowCount?: number) => void;
    } | null;
    if (session !== null && typeof session.startBattle === 'function') {
      // 单机战役只要 1 个真人英雄；AI 影子会渲染成同款英雄并自动移动，
      // 造成"多个英雄 / 闪烁"的观感。headless 整局测试仍用默认 2 影子，不受影响。
      session.startBattle(request.mode, request.generalId, 0);
    }
    // session 尚未建立时（异常/未启动路径）跳过写入，避免空引用扩散。
    if (app.state.session !== null) {
      // 手动模式不要由 ECS 预选升级卡（否则玩家点选会二次升级）。
      (app.state.session as unknown as { autoLevel?: number }).autoLevel =
        save.meta.settings.controlMode === 'auto' ? 1 : 0;
      // startBattle 会替换命令总线，因此自动/Manual 状态必须在开战后重新下发，
      // 否则默认 auto 存档只在 UI 上显示"自动"，ECS 仍按手动空转。
      pushCommand(
        CommandType.AutoToggle,
        save.meta.settings.controlMode === 'auto' ? 1 : 0,
        0,
        0,
      );
    }
    // startBattle 已初始化 StatBlock / session：首帧即用真值重置 HUD，消除 120/120 与 100 分闪帧。
    hud?.reset(buildHUDInitial({
      app,
      config,
      generalId: request.generalId,
      controlMode: save.meta.settings.controlMode,
    }));
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
      (app.state.session as unknown as { autoLevel?: number }).autoLevel = mode === 'auto' ? 1 : 0;
    },
    resetBattle: () => {
      runtime.pools?.releaseAll();
      runtime.viewport.reset();
      resultShown = false;
      resumeFromLevelUp();
      cards?.hide(); // P0：场景重开路径同样清理常驻升级弹窗
      statusPanel?.close();
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
    const inBattle = app.sceneManager.current?.id === 'battle';
    if (statusTrigger !== null && statusTrigger.hidden === inBattle) {
      statusTrigger.hidden = !inBattle;
    }
    // 面板不暂停战斗：低频刷新真值 VM（约 5Hz），避免每帧重建 13 槽 DOM。
    if (statusPanel?.visible === true && ++vmRefreshTick % 12 === 0) {
      statusPanel.update(buildVM());
    }
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
