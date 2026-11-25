// @vitest-environment jsdom
/**
 * 主题系统与令牌层回归（PRD_UI_REFACTOR.md §5.1~§5.3 / §6.1~§6.4）。
 *
 * 覆盖：
 *  - resolveTheme 归一化：缺省 / null / 非法值 / 大小写不符 → 'classic'
 *  - 4 个合法主题 id 均被正确识别
 *  - ThemeManager.apply 写 documentElement.dataset.theme，current 同步
 *  - subscribe 回调触发与取消订阅
 *  - tokens.css 与 themes.css 的**完整性**：16 个调色板角色 + 4 档稀有度色一个不缺
 *    （PRD §5.2「缺角色 = 主题不合格」）
 *
 * 使用全局 describe/it/expect（vite.config.ts globals:true），不加载第二份 runner。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THEME, THEME_IDS, type ThemeId } from '../../../game/SaveData';
import { resolveTheme, ThemeManager } from '../ThemeManager';

/** PRD §5.2 的 16 个调色板角色。 */
const COLOR_ROLES: readonly string[] = [
  '--ws-bg-canvas',
  '--ws-bg-texture',
  '--ws-bg-surface',
  '--ws-bg-raised',
  '--ws-border',
  '--ws-border-strong',
  '--ws-primary',
  '--ws-on-primary',
  '--ws-accent',
  '--ws-text',
  '--ws-text-muted',
  '--ws-danger',
  '--ws-stat-up',
  '--ws-stat-down',
  '--ws-slot-empty',
  '--ws-shadow',
];

/** 六档稀有度色（DESIGN §8.4）。 */
const RARITY_ROLES: readonly string[] = [
  '--ws-rarity-common',
  '--ws-rarity-blue',
  '--ws-rarity-gold',
  '--ws-rarity-legendary',
  '--ws-rarity-ancient',
  '--ws-rarity-primal',
];

const ALL_ROLES: readonly string[] = [...COLOR_ROLES, ...RARITY_ROLES];

/** 三个可切换主题（classic 由 :root 默认值承担，见 tokens.css）。 */
const OVERRIDE_THEMES: readonly ThemeId[] = ['ink', 'neon', 'sakura'];

function readStyle(relative: string): string {
  const url = new URL(relative, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

const TOKENS_CSS = readStyle('../../styles/tokens.css');
const THEMES_CSS = readStyle('../../styles/themes.css');

/** 在一段 CSS 文本中判断某 CSS 自定义属性是否被真正声明（含冒号赋值）。 */
function declares(css: string, prop: string): boolean {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*:`).test(css);
}

/**
 * 抽取 `:root[data-theme='<id>'] { ... }` 块的正文（按花括号配对）。
 * 找不到该块时返回空串。
 */
function themeBlock(css: string, id: ThemeId): string {
  const marker = `:root[data-theme='${id}']`;
  const start = css.indexOf(marker);
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

/**
 * 收集全部顶层 `:root { ... }` 块的正文并拼接。
 *
 * tokens.css 按类别拆成了多个 `:root` 块（颜色 / 间距 / 圆角 …），
 * 因此完整性检查需要覆盖**所有** :root 块，而不是第一个。
 */
function allRootBlocks(css: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = css.indexOf(':root', cursor);
    if (start < 0) break;
    // 跳过 ':root[data-theme=...]' 这类带属性的选择器（只取裸 :root）。
    const after = css.slice(start + 5, start + 6);
    if (after === '[') {
      cursor = start + 5;
      continue;
    }
    const open = css.indexOf('{', start);
    if (open < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    parts.push(css.slice(open + 1, end));
    cursor = end + 1;
  }
  return parts.join('\n');
}

describe('主题 id 归一化', () => {
  it('缺省 / null / undefined 一律回退 classic', () => {
    expect(resolveTheme(undefined)).toBe('classic');
    expect(resolveTheme(null)).toBe('classic');
    expect(DEFAULT_THEME).toBe('classic');
  });

  it('非法值回退 classic，且不抛异常', () => {
    expect(resolveTheme('不存在的id')).toBe('classic');
    expect(resolveTheme('')).toBe('classic');
    expect(resolveTheme('wasteland')).toBe('classic');
    expect(resolveTheme('CLASSIC')).toBe('classic');
    expect(resolveTheme(42)).toBe('classic');
    expect(resolveTheme({ theme: 'ink' })).toBe('classic');
    expect(resolveTheme(['ink'])).toBe('classic');
  });

  it('4 个合法主题 id 均被正确识别', () => {
    expect(THEME_IDS).toEqual(['classic', 'ink', 'neon', 'sakura']);
    for (let i = 0; i < THEME_IDS.length; i++) {
      expect(resolveTheme(THEME_IDS[i])).toBe(THEME_IDS[i]);
    }
  });
});

describe('ThemeManager', () => {
  it('apply 写 documentElement.dataset.theme 且 current 同步', () => {
    const manager = new ThemeManager();
    expect(manager.apply('ink')).toBe('ink');
    expect(document.documentElement.dataset.theme).toBe('ink');
    expect(manager.current).toBe('ink');

    expect(manager.apply('neon')).toBe('neon');
    expect(document.documentElement.dataset.theme).toBe('neon');
    expect(manager.current).toBe('neon');

    expect(manager.apply('sakura')).toBe('sakura');
    expect(document.documentElement.dataset.theme).toBe('sakura');
    expect(manager.current).toBe('sakura');
  });

  it('apply 非法值回退 classic', () => {
    const manager = new ThemeManager();
    expect(manager.apply('非法值')).toBe('classic');
    expect(document.documentElement.dataset.theme).toBe('classic');
    expect(manager.current).toBe('classic');

    expect(manager.apply(undefined)).toBe('classic');
    expect(manager.current).toBe('classic');
  });

  it('subscribe 回调在 apply 时被调用，取消订阅后不再被调用', () => {
    const manager = new ThemeManager();
    const seen: ThemeId[] = [];
    const unsubscribe = manager.subscribe((theme) => seen.push(theme));

    manager.apply('ink');
    expect(seen).toEqual(['ink']);

    unsubscribe();
    manager.apply('neon');
    expect(seen).toEqual(['ink']);
    expect(manager.current).toBe('neon');
  });

  it('多个订阅者互不影响，取消其中一个不影响另一个', () => {
    const manager = new ThemeManager();
    const a: ThemeId[] = [];
    const b: ThemeId[] = [];
    const offA = manager.subscribe((t) => a.push(t));
    manager.subscribe((t) => b.push(t));

    manager.apply('sakura');
    offA();
    manager.apply('ink');

    expect(a).toEqual(['sakura']);
    expect(b).toEqual(['sakura', 'ink']);
  });
});

describe('令牌层完整性（PRD §5.2 / §6.3）', () => {
  it('tokens.css 的 :root 定义了全部 16 个颜色角色 + 4 档稀有度色', () => {
    const block = allRootBlocks(TOKENS_CSS);
    expect(block.length).toBeGreaterThan(0);
    const missing = ALL_ROLES.filter((role) => !declares(block, role));
    expect(missing).toEqual([]);
  });

  it('tokens.css 定义了间距 / 圆角 / 阴影 / 字号 / 动效 / 层级 / 尺寸令牌', () => {
    const block = allRootBlocks(TOKENS_CSS);
    const expected: string[] = [
      '--ws-space-0', '--ws-space-1', '--ws-space-2', '--ws-space-3',
      '--ws-space-4', '--ws-space-5', '--ws-space-6', '--ws-space-7',
      '--ws-radius-xs', '--ws-radius-sm', '--ws-radius-md',
      '--ws-radius-lg', '--ws-radius-xl', '--ws-radius-pill',
      '--ws-shadow-sm', '--ws-shadow-md', '--ws-shadow-lg', '--ws-shadow-glow',
      '--ws-shadow-color',
      '--ws-font-xs', '--ws-font-sm', '--ws-font-md', '--ws-font-lg',
      '--ws-font-xl', '--ws-font-2xl', '--ws-font-display',
      '--ws-weight-normal', '--ws-weight-bold', '--ws-weight-heavy',
      '--ws-leading-tight', '--ws-leading-normal',
      '--ws-dur-instant', '--ws-dur-fast', '--ws-dur-base', '--ws-dur-slow',
      '--ws-ease-out', '--ws-ease-in-out', '--ws-ease-spring',
      '--ws-z-scene', '--ws-z-hud', '--ws-z-modal',
      '--ws-z-preview', '--ws-z-toast', '--ws-z-debug',
      '--ws-hit-min', '--ws-doll-size', '--ws-slot-size',
      '--ws-preview-width', '--ws-drawer-max-height',
    ];
    const missing = expected.filter((token) => !declares(block, token));
    expect(missing).toEqual([]);
  });

  it('冻结契约：命中区 44px 与层级 z 值不被改动', () => {
    expect(TOKENS_CSS).toMatch(/--ws-hit-min\s*:\s*44px/);
    expect(TOKENS_CSS).toMatch(/--ws-z-scene\s*:\s*10/);
    expect(TOKENS_CSS).toMatch(/--ws-z-hud\s*:\s*20/);
    expect(TOKENS_CSS).toMatch(/--ws-z-modal\s*:\s*30/);
    expect(TOKENS_CSS).toMatch(/--ws-z-preview\s*:\s*40/);
    expect(TOKENS_CSS).toMatch(/--ws-z-toast\s*:\s*50/);
    expect(TOKENS_CSS).toMatch(/--ws-z-debug\s*:\s*99/);
  });

  it('themes.css 的 3 个覆盖块各自完整定义 16 角色 + 4 稀有度色', () => {
    for (let i = 0; i < OVERRIDE_THEMES.length; i++) {
      const id = OVERRIDE_THEMES[i];
      const block = themeBlock(THEMES_CSS, id);
      expect(block.length, `主题 ${id} 的覆盖块缺失`).toBeGreaterThan(0);
      const missing = ALL_ROLES.filter((role) => !declares(block, role));
      expect(missing, `主题 ${id} 缺少角色`).toEqual([]);
    }
  });

  it('themes.css 为每个主题给出独立取值（不是简单复制默认主题）', () => {
    const inkBlock = themeBlock(THEMES_CSS, 'ink');
    const neonBlock = themeBlock(THEMES_CSS, 'neon');
    const sakuraBlock = themeBlock(THEMES_CSS, 'sakura');
    expect(inkBlock).not.toBe(neonBlock);
    expect(neonBlock).not.toBe(sakuraBlock);
    expect(inkBlock).not.toBe(sakuraBlock);
    // 浅底主题 ink 的正文必须是深色（PRD R-12 / §5.2）。
    expect(inkBlock).toMatch(/--ws-text\s*:\s*#2b2b28/);
  });

  it('themes.css 不为 classic 定义覆盖块（classic 由 tokens.css 的 :root 承担）', () => {
    expect(themeBlock(THEMES_CSS, 'classic')).toBe('');
  });

  it('themes.css 与 tokens.css 之外不出现裸色值（令牌层自检）', () => {
    // 只检查本层交付的 4 个 CSS 文件中，tokens.css / themes.css 之外的两个
    // （base.css / components.css）必须不含十六进制色值。
    const baseCss = readStyle('../../styles/base.css');
    const componentsCss = readStyle('../../styles/components.css');
    const hex = /#[0-9a-fA-F]{3,8}\b/g;
    expect(baseCss.match(hex)).toBeNull();
    expect(componentsCss.match(hex)).toBeNull();
  });
});
