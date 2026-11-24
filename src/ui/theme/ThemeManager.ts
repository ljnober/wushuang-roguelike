/**
 * 主题管理器（PRD_UI_REFACTOR.md §5.3 / §6.4）。
 *
 * 核心机制：**只改 `document.documentElement.dataset.theme`**。
 * 所有配色差异由 `src/ui/styles/themes.css` 中的 `:root[data-theme='xxx']` 块承担，
 * 浏览器在一帧内完成重绘。因此：
 *   - 不遍历 DOM 逐元素改样式；
 *   - 不重建任何 DOM（不会丢失滚动位置与选中态）；
 *   - 切换耗时 ≤1 帧。
 *
 * 静态性（FC-5.1 / FC-5.2）：本文件零随机数调用、零墙钟、零 `bitecs` 依赖。
 * 主题色板全部硬编码在 themes.css，切换过程不做任何 JS 颜色计算。
 *
 * 持久化：调用方负责把 `save.meta.settings.theme` 写入存档并走 `SaveSystem.save()`；
 * 读取侧一律用 `resolveTheme()` 归一化（旧存档无 theme 字段 → 'classic'）。
 */
import { DEFAULT_THEME, THEME_IDS, type ThemeId } from '../../game/SaveData';

/**
 * 把任意输入归一化为合法主题 id；缺省/非法值一律回退 'classic'（旧存档兼容）。
 *
 * 非字符串、大小写不符、未知 id、null、undefined 均返回 'classic'。
 */
export function resolveTheme(value: unknown): ThemeId {
  if (typeof value !== 'string') return DEFAULT_THEME;
  for (let i = 0; i < THEME_IDS.length; i++) {
    if (THEME_IDS[i] === value) return THEME_IDS[i];
  }
  return DEFAULT_THEME;
}

/** 主题变化监听器。 */
export type ThemeListener = (theme: ThemeId) => void;

/**
 * 主题管理器：持有当前主题，负责写 DOM 属性并广播变化。
 *
 * 非 DOM 环境（node 单测 / headless）下 `apply()` 仍会更新内部状态，
 * 只是不写 `document`，保证逻辑层可无副作用地单测。
 */
export class ThemeManager {
  private theme: ThemeId;
  private readonly listeners: ThemeListener[] = [];

  constructor() {
    this.theme = this.readDomTheme() ?? DEFAULT_THEME;
  }

  /** 当前生效主题。 */
  get current(): ThemeId {
    return this.theme;
  }

  /**
   * 应用主题：写 `document.documentElement.dataset.theme`，不重建任何 DOM。
   * 返回归一化后的实际主题 id（非法输入回退 'classic'）。
   */
  apply(theme: unknown): ThemeId {
    const resolved = resolveTheme(theme);
    this.theme = resolved;
    if (typeof document !== 'undefined' && document.documentElement !== null) {
      document.documentElement.dataset.theme = resolved;
    }
    this.notify(resolved);
    return resolved;
  }

  /**
   * 订阅主题变化；返回取消订阅函数。
   *
   * 同一主题重复 apply 也会触发回调 —— 调用方需要自行去重（例如按 id 比较）。
   */
  subscribe(listener: (theme: ThemeId) => void): () => void {
    this.listeners.push(listener);
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** 读取 DOM 上已有的 data-theme；无 DOM 或无值时返回 null。 */
  private readDomTheme(): ThemeId | null {
    if (typeof document === 'undefined' || document.documentElement === null) return null;
    const raw = document.documentElement.dataset.theme;
    if (raw === undefined) return null;
    return resolveTheme(raw);
  }

  /** 广播主题变化（快照式遍历，允许回调内退订）。 */
  private notify(theme: ThemeId): void {
    const snapshot = this.listeners.slice();
    for (let i = 0; i < snapshot.length; i++) {
      snapshot[i](theme);
    }
  }
}
