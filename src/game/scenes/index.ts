/**
 * 场景层（ARCHITECTURE §5.11 / DESIGN §9）。
 *
 * Boot / Menu / Select / Result / Settings 均为 DOM 覆盖层场景；
 * 切场景统一走 App.sceneManager（先 onExit 再 onEnter）。
 * 战斗世界由批次 B 的注册槽持有，本层只发"开始战斗"请求，不直接触碰 ECS。
 */
import type { App, SceneContextLike, SceneId, SceneLike } from '../../app/App';
import type { Audio } from '../../engine/Audio';
import type { Viewport } from '../../engine/Viewport';
import type { PortraitFactory } from '../../art/PortraitFactory';
import type { HUD } from '../../ui/HUD';
import type { TouchControls } from '../../ui/TouchControls';
import type { CardsAndLevelUp } from '../../ui/CardsAndLevelUp';
import type { EquipmentUI } from '../../ui/EquipmentUI';
import type { ThemeManager } from '../../ui/theme/ThemeManager';
import type { ThemePicker } from '../../ui/theme/ThemePicker';
import { MetaUI } from '../../ui/MetaUI';
import type { GameConfig } from '../../data/types';
import { GENERAL_DEFS } from '../../data/generals';
import type { FactionId } from '../../data/types';
import { colorToCss, paletteForFaction } from '../../art/Palette';
import type { QualityLevel, SaveData } from '../SaveData';
import { SaveSystem } from '../SaveSystem';

export type { SceneId, SceneLike as Scene, SceneContextLike as SceneContext } from '../../app/App';
export { SceneManager } from '../../app/App';

/** 战斗启动请求：由 presentation 提供的桥接函数转交批次 B。 */
export interface BattleRequest {
  readonly mode: string;
  readonly generalId: string;
}

export type BattleLauncher = (request: BattleRequest) => void;

/** 结算负载。 */
export interface ResultPayload {
  readonly victory: boolean;
  readonly mode: string;
  readonly generalId: string;
  readonly score: number;
  readonly kills: number;
  readonly level: number;
  readonly elapsed: number;
  readonly damage: number;
  readonly lootEquipment?: number;
  readonly lootGems?: number;
}

/** 场景依赖，由 presentation.ts 在注册期一次性注入。 */
export interface SceneDeps {
  readonly save: SaveData;
  readonly saveSystem: SaveSystem;
  /** 由 presentation.ts 创建的唯一主题管理器（单例归属见 ARCH §3.5）。 */
  readonly theme: ThemeManager;
  /** 与配装页快捷入口共用的同一个主题卡组件实例。 */
  readonly themePicker: ThemePicker;
  readonly config: GameConfig;
  readonly audio: Audio;
  readonly portraits: PortraitFactory;
  readonly hud: HUD;
  readonly touch: TouchControls;
  readonly cards: CardsAndLevelUp;
  readonly equipment: EquipmentUI;
  readonly meta: MetaUI;
  readonly viewport: Viewport;
  readonly battleLauncher: BattleLauncher;
  setQuality(quality: QualityLevel): void;
  /** 切换本地席位的自动/手动控制（下发 AutoToggle 命令）。 */
  setControlMode(mode: 'auto' | 'manual'): void;
  resetBattle(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text.length > 0) node.textContent = text;
  return node;
}

function button(text: string, className: string = ''): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

/** 所有场景的公共基类：持有唯一覆盖层，切场景时自动移除。 */
abstract class OverlayScene implements SceneLike {
  abstract readonly id: SceneId;
  protected overlay: HTMLDivElement | null = null;
  protected context: SceneContextLike | null = null;

  onEnter(ctx: SceneContextLike): void {
    this.context = ctx;
  }

  protected mount(host: HTMLElement, content: HTMLElement): void {
    const overlay = el('div', `overlay scene scene--${this.id}`);
    overlay.append(content);
    host.append(overlay);
    this.overlay = overlay;
  }

  onExit(): void {
    if (this.overlay !== null) {
      this.overlay.remove();
      this.overlay = null;
    }
    this.context = null;
  }

  protected get host(): HTMLElement {
    return this.context?.app !== undefined
      ? ((globalThis.document?.getElementById('app') ?? document.body) as HTMLElement)
      : (document.body as HTMLElement);
  }
}

export class BootScene extends OverlayScene {
  readonly id: SceneId = 'boot';
  private timer = 0;

  onEnter(ctx: SceneContextLike): void {
    super.onEnter(ctx);
    const content = el('div', 'panel boot-panel');
    content.append(el('h1', 'boot-title', '无双'));
    content.append(el('p', 'boot-sub', '三国 Roguelike · 程序化美术 · 60 FPS 割草'));
    const enter = button('进入游戏', 'boot-enter');
    enter.addEventListener('click', () => ctx.app.sceneManager.switchTo('menu'));
    content.append(enter);
    this.mount(this.host, content);
    this.timer = window.setTimeout(() => {
      if (this.overlay !== null) ctx.app.sceneManager.switchTo('menu');
    }, 900);
  }

  onExit(): void {
    if (this.timer !== 0) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    super.onExit();
  }
}

export class MenuScene extends OverlayScene {
  readonly id: SceneId = 'menu';

  constructor(private readonly deps: SceneDeps) {
    super();
  }

  onEnter(ctx: SceneContextLike): void {
    super.onEnter(ctx);
    const save = this.deps.save;
    const content = el('div', 'panel menu-panel');
    content.append(el('h1', 'menu-title', '无双'));
    content.append(
      el('p', 'menu-sub', `${save.meta.settings.localPlayerName} · ${save.meta.unlockedGenerals.length} 将可用`),
    );

    const actions = el('div', 'menu-actions');
    const start = button('开始征战', 'primary');
    start.addEventListener('click', () => {
      this.deps.audio.unlock();
      ctx.app.sceneManager.switchTo('select');
    });
    const equip = button('装备');
    equip.addEventListener('click', () => this.deps.equipment.open(save, save.meta.selectedGeneral));
    const cube = button('魔盒 / 宝石 / 排行');
    cube.addEventListener('click', () => this.deps.meta.open(save, 'cube'));
    const settings = button('设置');
    settings.addEventListener('click', () => ctx.app.sceneManager.switchTo('settings'));
    actions.append(start, equip, cube, settings);
    content.append(actions);
    this.mount(this.host, content);
  }
}

export class SelectScene extends OverlayScene {
  readonly id: SceneId = 'select';
  private filter: FactionId | 'all' = 'all';
  private selected = '';

  constructor(private readonly deps: SceneDeps) {
    super();
  }

  onEnter(ctx: SceneContextLike): void {
    super.onEnter(ctx);
    this.selected = this.deps.save.meta.selectedGeneral;
    this.render();
  }

  private render(): void {
    const ctx = this.context;
    if (ctx === null) return;
    if (this.overlay !== null) this.overlay.remove();

    const content = el('div', 'panel panel--wide select-panel');
    const header = el('header', 'panel__header');
    header.append(el('h2', 'panel__title', '选择武将'));
    const back = button('返回');
    back.addEventListener('click', () => ctx.app.sceneManager.switchTo('menu'));
    header.append(back);
    content.append(header);

    const filters = el('div', 'faction-filters');
    const factions: Array<FactionId | 'all'> = ['all', 'shu', 'wei', 'wu', 'qun'];
    const names: Record<FactionId | 'all', string> = {
      all: '全部',
      shu: '蜀',
      wei: '魏',
      wu: '吴',
      qun: '群雄',
    };
    for (let i = 0; i < factions.length; i++) {
      const faction = factions[i];
      const node = button(names[faction], `faction-chip ${this.filter === faction ? 'is-active' : ''}`);
      if (faction !== 'all') {
        node.style.borderColor = colorToCss(paletteForFaction(faction).secondary);
      }
      node.addEventListener('click', () => {
        this.filter = faction;
        this.render();
      });
      filters.append(node);
    }
    content.append(filters);

    const grid = el('div', 'general-grid');
    for (let i = 0; i < GENERAL_DEFS.length; i++) {
      const def = GENERAL_DEFS[i];
      if (this.filter !== 'all' && def.faction !== this.filter) continue;
      const unlocked = this.deps.save.meta.unlockedGenerals.indexOf(def.id) >= 0;
      const card = button('', `general-card ${this.selected === def.id ? 'is-selected' : ''}`);
      card.disabled = !unlocked;
      const img = document.createElement('img');
      img.className = 'general-portrait';
      img.src = this.deps.portraits.dataUrlFor(def);
      img.alt = def.name;
      const name = el('span', 'general-name', def.name);
      const title = el('span', 'general-title', unlocked ? def.title : '未解锁');
      card.append(img, name, title);
      card.addEventListener('click', () => {
        this.selected = def.id;
        this.render();
      });
      grid.append(card);
    }
    content.append(grid);

    const footer = el('div', 'panel__row');
    const selectedDef = this.deps.config.generals.tryGet(this.selected);
    footer.append(el('span', 'hint', `已选：${selectedDef?.name ?? (this.selected || '无')}`));
    const confirm = button('出征', 'primary');
    confirm.addEventListener('click', () => {
      if (this.selected.length === 0) return;
      const generalId = this.selected;
      this.deps.save.meta.selectedGeneral = generalId;
      this.deps.saveSystem.save(this.deps.save);
      this.deps.audio.unlock();
      this.deps.battleLauncher({ mode: 'campaign_8min', generalId });
      ctx.app.sceneManager.switchTo('battle');
    });
    footer.append(confirm);
    content.append(footer);
    this.mount(this.host, content);
  }
}

export class ResultScene extends OverlayScene {
  readonly id: SceneId = 'result';

  constructor(private readonly deps: SceneDeps) {
    super();
  }

  onEnter(ctx: SceneContextLike): void {
    super.onEnter(ctx);
    // P0：升级三选一是常驻 #app 的独立覆盖层，不属于任何场景 overlay。
    // 终局时若仍有未点选的弹窗，它会拦截结算按钮的真实点击；必须在进入结算页时真正隐藏。
    this.deps.cards.hide();
    const payload = ctx.payload as ResultPayload | undefined;
    const result: ResultPayload = payload ?? {
      victory: false,
      mode: 'campaign_8min',
      generalId: this.deps.save.meta.selectedGeneral,
      score: 0,
      kills: 0,
      level: 1,
      elapsed: 0,
      damage: 0,
    };
    MetaUI.recordScore(
      this.deps.save,
      result.mode,
      result.generalId,
      result.score,
      Date.now(),
    );
    if (result.victory) {
      const first = this.deps.save.meta.firstBossClearAt;
      if (first === null) this.deps.save.meta.firstBossClearAt = Date.now();
      if (this.deps.save.meta.unlockedModes.indexOf('endless') < 0) {
        this.deps.save.meta.unlockedModes.push('endless');
      }
    }
    this.deps.saveSystem.saveNow(this.deps.save);

    const content = el('div', 'panel result-panel');
    content.append(el('h1', 'result-title', result.victory ? '胜利' : '战败'));
    content.append(el('p', 'result-loot', `本局战利品：装备 ${result.lootEquipment ?? 0} · 宝石 ${result.lootGems ?? 0}（已存入仓库）`));
    content.append(
      el(
        'p',
        'result-lines',
        `积分 ${result.score} · 击杀 ${result.kills} · 等级 ${result.level} · 时长 ${Math.floor(result.elapsed)}s`,
      ),
    );
    const actions = el('div', 'menu-actions');
    const again = button('再来一局', 'primary');
    again.addEventListener('click', () => ctx.app.sceneManager.switchTo('select'));
    const ranking = button('查看排行');
    ranking.addEventListener('click', () => this.deps.meta.open(this.deps.save, 'leaderboard'));
    const menu = button('返回主菜单');
    menu.addEventListener('click', () => ctx.app.sceneManager.switchTo('menu'));
    actions.append(again, ranking, menu);
    content.append(actions);
    this.mount(this.host, content);
  }
}

export class SettingsScene extends OverlayScene {
  readonly id: SceneId = 'settings';
  private themeUnsubscribe: (() => void) | null = null;

  constructor(private readonly deps: SceneDeps) {
    super();
  }

  onEnter(ctx: SceneContextLike): void {
    super.onEnter(ctx);
    const settings = this.deps.save.meta.settings;
    const content = el('div', 'panel settings-panel');
    content.append(el('h2', 'panel__title', '设置'));

    // 主题区插在「画质」之前；复用 ThemePicker.render() 的同一个根节点，
    // 设置页不重建主题卡。外部（配装浮层）切主题时同步 is-active / aria-checked。
    const themeRow = el('div', 'setting-row setting-row--theme');
    themeRow.append(el('span', 'setting-label', '主题'));
    const pickerRoot = this.deps.themePicker.render();
    themeRow.append(pickerRoot);
    content.append(themeRow);
    this.themeUnsubscribe = this.deps.theme.subscribe((id) => {
      const cards = pickerRoot.querySelectorAll<HTMLElement>('.theme-picker__card[data-theme-id]');
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const active = card.dataset.themeId === id;
        card.classList.toggle('is-active', active);
        card.setAttribute('aria-checked', active ? 'true' : 'false');
      }
    });

    const qualityRow = el('div', 'setting-row');
    qualityRow.append(el('span', 'setting-label', '画质（仅渲染）'));
    const qualities: QualityLevel[] = ['low', 'medium', 'high'];
    const qualityNames: Record<QualityLevel, string> = { low: '低', medium: '中', high: '高' };
    for (let i = 0; i < qualities.length; i++) {
      const level = qualities[i];
      const node = button(qualityNames[level], `chip ${settings.quality === level ? 'is-active' : ''}`);
      node.addEventListener('click', () => {
        settings.quality = level;
        this.deps.setQuality(level);
        this.deps.saveSystem.save(this.deps.save);
        this.render();
      });
      qualityRow.append(node);
    }
    content.append(qualityRow);

    const controlRow = el('div', 'setting-row');
    controlRow.append(el('span', 'setting-label', '操作模式'));
    const modes: Array<'auto' | 'manual'> = ['auto', 'manual'];
    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i];
      const node = button(mode === 'auto' ? '自动' : '手动', `chip ${settings.controlMode === mode ? 'is-active' : ''}`);
      node.addEventListener('click', () => {
        settings.controlMode = mode;
        this.deps.cards.setAutoMode(mode === 'auto');
        this.deps.touch.setAutoMode(mode === 'auto');
        this.deps.setControlMode(mode);
        this.deps.saveSystem.save(this.deps.save);
        this.render();
      });
      controlRow.append(node);
    }
    content.append(controlRow);

    const audioRow = el('div', 'setting-row');
    audioRow.append(el('span', 'setting-label', '音效'));
    const sfx = button(settings.sfx ? '开启' : '关闭', 'chip');
    sfx.addEventListener('click', () => {
      settings.sfx = !settings.sfx;
      this.deps.audio.setEnabled(settings.sfx);
      this.deps.saveSystem.save(this.deps.save);
      this.render();
    });
    audioRow.append(sfx);
    content.append(audioRow);

    const netRow = el('div', 'setting-row');
    netRow.append(el('span', 'setting-label', '网络角色'));
    const roles: Array<'auto' | 'host' | 'client'> = ['auto', 'host', 'client'];
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      const roleLabel = role === 'auto' ? '自动' : role === 'host' ? '主机' : '客户端';
      const node = button(roleLabel, `chip ${settings.netRolePreferred === role ? 'is-active' : ''}`);
      node.addEventListener('click', () => {
        settings.netRolePreferred = role;
        this.deps.saveSystem.save(this.deps.save);
        this.render();
      });
      netRow.append(node);
    }
    content.append(netRow);

    const back = button('返回主菜单', 'primary');
    back.addEventListener('click', () => ctx.app.sceneManager.switchTo('menu'));
    content.append(back);
    this.mount(this.host, content);
  }

  onExit(): void {
    if (this.themeUnsubscribe !== null) {
      this.themeUnsubscribe();
      this.themeUnsubscribe = null;
    }
    super.onExit();
  }

  private render(): void {
    const ctx = this.context;
    if (ctx === null) return;
    this.onExit();
    this.onEnter(ctx);
  }
}

/** 战斗场景兜底：B 未注册 battle 时用它，仅负责显示/隐藏 DOM 控件。 */
/** 战斗会话的渲染侧结构视图；由批次 B 在 app.state.session 上提供。 */
interface BattleSessionView {
  startBattle?: (mode: string, generalId: string, shadowCount?: number) => void;
  endBattle?: () => void;
  running?: number;
}

export class BattleScene extends OverlayScene {
  readonly id: SceneId = 'battle';
  private readonly defaultMode = 'campaign_8min';

  constructor(private readonly deps: SceneDeps) {
    super();
  }

  private get session(): BattleSessionView | null {
    const ctx = this.context;
    if (ctx === null) return null;
    const session = ctx.app.state.session as BattleSessionView | null | undefined;
    return session ?? null;
  }

  onEnter(ctx: SceneContextLike): void {
    super.onEnter(ctx);
    this.deps.resetBattle();
    this.deps.hud.reset();
    this.deps.hud.setVisible(true);
    this.deps.touch.setVisible(true);

    // SelectScene 已通过 battleLauncher 启动时会置 running=1，此处不重复启动；
    // 直接 switchTo('battle') 的入口则由场景兜底启动，避免模拟处于半开状态。
    // shadowCount=0：兜底路径同样保持单机只有一个英雄。
    const session = this.session;
    if (session !== null && typeof session.startBattle === 'function' && session.running !== 1) {
      session.startBattle(this.defaultMode, this.deps.save.meta.selectedGeneral, 0);
    }
  }

  onExit(): void {
    // 必须在 super.onExit() 清空 context 之前读取会话。
    const session = this.session;
    if (session !== null && typeof session.endBattle === 'function') {
      session.endBattle();
    }
    this.deps.hud.setVisible(false);
    this.deps.touch.setVisible(false);
    super.onExit();
  }
}

/** 把五个场景（及 battle 兜底）注册到 App.sceneManager。 */
export function registerScenes(app: App, deps: SceneDeps): void {
  app.setSaveProvider(() => deps.save);
  app.registerScene('boot', () => new BootScene());
  app.registerScene('menu', () => new MenuScene(deps));
  app.registerScene('select', () => new SelectScene(deps));
  app.registerScene('result', () => new ResultScene(deps));
  app.registerScene('settings', () => new SettingsScene(deps));

  const factories = (app.sceneManager as unknown as { factories?: Map<SceneId, unknown> }).factories;
  if (factories === undefined || !factories.has('battle')) {
    app.registerScene('battle', () => new BattleScene(deps));
  }
}
