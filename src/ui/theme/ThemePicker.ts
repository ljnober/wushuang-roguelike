/**
 * 主题选择卡组件（PRD_UI_REFACTOR.md §3.7 / US-05-1..6、ARCH_UI_REFACTOR.md §3.5）。
 *
 * 设计约定：
 *  - **唯一 ThemeManager 实例由 presentation.ts 创建**；本组件只注入引用，绝不自行实例化管理器。
 *  - **不碰存档**：点击只调用 `manager.apply(id)` 即时换色 + `onSelect?.(id)` 持久化钩子。
 *  - **单一根节点**：`render()` 始终返回同一个 `.theme-picker`；设置页平铺与配装页浮层复用它，
 *    浮层打开时把根节点移入浮层、关闭时归位，因此不存在两套需要同步的主题卡。
 *  - 迷你预览块用 `var(--ws-*)` 现场渲染；各主题色板在 themes.css 末尾的
 *    `.theme-picker__preview[data-preview-theme='...']` 作用域中声明，切主题零 JS 颜色计算。
 *
 * 静态审查（FC-5）：零随机数调用、零墙钟读取、零 ECS 直连；
 * 浮层定位只用 `getBoundingClientRect()` 与同步尺寸计算，不引入定时器。
 */
import { THEME_IDS, type ThemeId } from '../../game/SaveData';
import type { ThemeManager } from './ThemeManager';

/** T01 `EquipmentUI.attachThemePicker` 依赖的冻结接口（ARCH §3.5）。 */
export interface ThemePickerLike {
  openAsPopover(anchor: HTMLElement): void;
  close(): void;
  readonly visible: boolean;
}

/** 构造参数：manager 为外部唯一单例，onSelect 为外部持久化钩子。 */
export interface ThemePickerOptions {
  readonly manager: ThemeManager;
  readonly onSelect?: (id: ThemeId) => void;
}

/** 主题卡的可见名称（对应 PRD §5.1 四套主题）。 */
const THEME_LABELS: Readonly<Record<ThemeId, string>> = {
  classic: '经典三国',
  ink: '墨韵水墨',
  neon: '暗夜霓虹',
  sakura: '春日和风',
};

/** 浮层与视口边缘的最小间距（布局像素，不涉及任何颜色令牌）。 */
const VIEWPORT_MARGIN = 8;

/**
 * 四主题选择组件：设置页平铺 + 配装页就地浮层两用。
 */
export class ThemePicker implements ThemePickerLike {
  private readonly manager: ThemeManager;
  private readonly onSelect: ((id: ThemeId) => void) | null;
  private readonly root: HTMLElement;
  private readonly cards = new Map<ThemeId, HTMLButtonElement>();
  private readonly unsubscribe: () => void;
  private popover: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private returnParent: HTMLElement | null = null;
  private returnNext: Node | null = null;
  private destroyed = false;

  constructor(opts: ThemePickerOptions) {
    this.manager = opts.manager;
    this.onSelect = opts.onSelect ?? null;
    this.root = this.buildRoot();
    this.root.addEventListener('keydown', this.onRootKeydown);
    this.unsubscribe = this.manager.subscribe((theme: ThemeId) => {
      this.sync(theme);
    });
    this.sync(this.manager.current);
  }

  /** 返回唯一的主题卡根节点；调用方负责把它挂到设置页面板中。 */
  render(): HTMLElement {
    if (this.destroyed) return this.root;
    if (this.visible) this.close();
    return this.root;
  }

  /** 浮层是否处于打开状态。 */
  get visible(): boolean {
    return this.popover !== null && !this.popover.hidden;
  }

  /**
   * 以 anchor 为基准就地弹出主题浮层（不跳场景、不重建卡片）。
   * 再次点击同一 anchor 时视为切换关闭。
   */
  openAsPopover(anchor: HTMLElement): void {
    if (this.destroyed) return;
    if (this.visible && this.anchor === anchor) {
      this.close();
      return;
    }
    if (this.visible) this.close();

    const popover = document.createElement('div');
    popover.className = 'theme-picker-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');
    popover.setAttribute('aria-label', '切换主题');

    const head = document.createElement('div');
    head.className = 'theme-picker-popover__head';
    const title = document.createElement('span');
    title.className = 'theme-picker__title';
    title.textContent = '切换主题';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'theme-picker__close';
    close.setAttribute('aria-label', '关闭主题选择');
    close.textContent = '×';
    close.addEventListener('click', () => this.close());
    head.append(title, close);
    popover.append(head);

    this.returnParent = this.root.parentElement;
    this.returnNext = this.root.nextSibling;
    popover.append(this.root);

    const container: HTMLElement = anchor.closest('#app') ?? document.body;
    container.append(popover);
    this.popover = popover;
    this.anchor = anchor;

    document.addEventListener('keydown', this.onDocumentKeydown);
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('scroll', this.onViewportChange, true);

    this.position(anchor);
  }

  /** 关闭浮层：还原卡片根节点并把焦点归还锚点。 */
  close(): void {
    if (this.popover === null) return;
    const popover = this.popover;
    this.popover = null;

    document.removeEventListener('keydown', this.onDocumentKeydown);
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);

    // 先把卡片移回原宿主，再移除浮层，避免中间态丢失选中态。
    if (this.returnParent !== null && this.returnParent.isConnected) {
      if (this.returnNext !== null && this.returnNext.parentNode === this.returnParent) {
        this.returnParent.insertBefore(this.root, this.returnNext);
      } else {
        this.returnParent.append(this.root);
      }
    } else {
      this.root.remove();
    }
    this.returnParent = null;
    this.returnNext = null;
    popover.remove();

    const anchor = this.anchor;
    this.anchor = null;
    if (anchor !== null && anchor.isConnected) anchor.focus();
  }

  /** 退订主题广播、移除根节点与浮层；调用后组件不可再用。 */
  destroy(): void {
    if (this.destroyed) return;
    this.close();
    this.unsubscribe();
    this.root.removeEventListener('keydown', this.onRootKeydown);
    this.root.remove();
    this.cards.clear();
    this.destroyed = true;
  }

  /** 构造主题卡根节点：4 张 button[data-theme-id]，每张带现场渲染的迷你预览。 */
  private buildRoot(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'theme-picker';
    root.setAttribute('role', 'radiogroup');
    root.setAttribute('aria-label', '界面主题');

    for (let i = 0; i < THEME_IDS.length; i++) {
      const id = THEME_IDS[i];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'theme-picker__card';
      card.dataset.themeId = id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', 'false');
      card.setAttribute('aria-label', THEME_LABELS[id]);

      const preview = document.createElement('span');
      preview.className = 'theme-picker__preview';
      preview.dataset.previewTheme = id;
      preview.setAttribute('aria-hidden', 'true');
      const bar = document.createElement('span');
      bar.className = 'theme-picker__preview-bar';
      const panel = document.createElement('span');
      panel.className = 'theme-picker__preview-panel';
      const line = document.createElement('span');
      line.className = 'theme-picker__preview-line';
      const cta = document.createElement('span');
      cta.className = 'theme-picker__preview-cta';
      panel.append(line, cta);
      preview.append(bar, panel);

      const name = document.createElement('span');
      name.className = 'theme-picker__name';
      name.textContent = THEME_LABELS[id];

      card.append(preview, name);
      card.addEventListener('click', () => {
        if (!this.destroyed) this.applyTheme(id);
      });
      this.cards.set(id, card);
      root.append(card);
    }
    return root;
  }

  /** 应用主题：manager.apply 即时换色，随后调用外部持久化钩子。 */
  private applyTheme(id: ThemeId): void {
    const resolved = this.manager.apply(id);
    this.sync(resolved);
    if (this.onSelect !== null) this.onSelect(resolved);
  }

  /** 按当前主题同步四张卡的 is-active / aria-checked。 */
  private sync(theme: ThemeId): void {
    const ids = Array.from(this.cards.keys());
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const card = this.cards.get(id);
      if (card === undefined) continue;
      const active = id === theme;
      card.classList.toggle('is-active', active);
      card.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  }

  /** 方向键在四张卡之间移动焦点并按 radio 语义选中。 */
  private handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
      && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const index = THEME_IDS.indexOf(this.manager.current);
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = THEME_IDS[(index + step + THEME_IDS.length) % THEME_IDS.length];
    const card = this.cards.get(next);
    if (card !== undefined) {
      card.focus();
      this.applyTheme(next);
    }
  }

  /** 视口边界翻转：右侧放不下则贴 anchor 左缘，下方放不下则翻到上方。 */
  private position(anchor: HTMLElement): void {
    const popover = this.popover;
    if (popover === null) return;
    const anchorRect = anchor.getBoundingClientRect();
    const size = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = anchorRect.right - size.width;
    if (left < VIEWPORT_MARGIN) left = anchorRect.left;
    if (left + size.width > viewportWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, viewportWidth - size.width - VIEWPORT_MARGIN);
    }

    let top = anchorRect.bottom + VIEWPORT_MARGIN;
    if (top + size.height > viewportHeight - VIEWPORT_MARGIN) {
      const above = anchorRect.top - size.height - VIEWPORT_MARGIN;
      top = above >= VIEWPORT_MARGIN
        ? above
        : Math.max(VIEWPORT_MARGIN, viewportHeight - size.height - VIEWPORT_MARGIN);
    }
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  /** Esc 关闭浮层；焦点归还在 close() 中统一处理。 */
  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.close();
  };

  /** 点击浮层与锚点之外关闭；浮层内部点击不关闭（允许连续试色）。 */
  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const popover = this.popover;
    const anchor = this.anchor;
    if (popover === null || anchor === null) return;
    const target = event.target;
    if (target instanceof Node && (popover.contains(target) || anchor.contains(target))) return;
    this.close();
  };

  /** 视口变化时重新定位，避免锚点滚动后浮层悬空。 */
  private readonly onViewportChange = (): void => {
    if (this.anchor !== null && this.anchor.isConnected) this.position(this.anchor);
  };

  /** 根节点方向键监听以具名函数保存，便于 destroy() 精确移除。 */
  private readonly onRootKeydown = (event: KeyboardEvent): void => {
    this.handleKeydown(event);
  };
}
