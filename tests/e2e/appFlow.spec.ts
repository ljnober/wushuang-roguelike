/**
 * 《无双》真实浏览器端到端流程（DESIGN §13 / PRD P8）。
 *
 * 运行前提：
 *   npm run build
 *   npx vite preview --port 4173 --host 127.0.0.1
 *   npx playwright test tests/e2e/appFlow.spec.ts
 *
 * 验证目标：不是"单测存在"，而是浏览器里真的能从 Boot 走到战斗并留下存档。
 */
// 本机 Playwright 由 npx 缓存在项目 node_modules 之外；用绝对 file:// 路径导入其测试入口。
// 若项目已安装 playwright，可改回 `import { test, expect } from 'playwright/test';`
import { test, expect } from 'file:///C:/Users/liujian/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/test.mjs';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173/';
const SAVE_KEY = 'wushuang.profile.v1';

test.setTimeout(90_000);

test('启动流程：Boot → Menu → Select → Battle → HUD tick → 刷新存档', async ({ page }) => {
  const errors: string[] = [];
  const http404: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.status() === 404) http404.push(res.url());
  });

  // --- Arrange：打开静态部署首页 ---
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  // --- Act/Assert 1：Boot 页 ---
  await expect(page.locator('.scene--boot')).toBeVisible();
  await expect(page.locator('.boot-title')).toHaveText('无双');
  await expect(page.locator('.boot-enter')).toBeVisible();

  // --- Act/Assert 2：Menu 页 ---
  await page.locator('.boot-enter').click();
  await expect(page.locator('.scene--menu')).toBeVisible();
  await expect(page.locator('.menu-title')).toHaveText('无双');
  const start = page.locator('.menu-panel button.primary');
  await expect(start).toHaveText('开始征战');

  // --- Act/Assert 3：Select 页，选第一位武将 ---
  await start.click();
  await expect(page.locator('.scene--select')).toBeVisible();
  const cards = page.locator('.general-grid .general-card');
  const cardCount = await cards.count();
  expect(cardCount, '武将卡数量应不少于 40').toBeGreaterThanOrEqual(40);

  // BUG-01 回归：全部头像应解码成功（naturalWidth > 0），src 为 data URL 而非裸 SVG 相对请求。
  const portraits = cards.locator('.general-portrait');
  await expect(portraits).toHaveCount(cardCount);
  const decoded = await portraits.evaluateAll((imgs) =>
    imgs.map((img) => ({
      src: (img as HTMLImageElement).getAttribute('src') ?? '',
      width: (img as HTMLImageElement).naturalWidth,
    })),
  );
  expect(decoded.every((p) => p.src.startsWith('data:image/svg+xml')), '头像 src 应为 data URL').toBe(true);
  expect(decoded.filter((p) => p.width > 0).length, '全部头像应渲染成功').toBe(cardCount);

  const first = cards.first();
  await expect(first, '第一位武将应可选').toBeEnabled();
  const generalName = await first.locator('.general-name').innerText();
  await first.click();
  await expect(page.locator('.hint')).toContainText('已选：');

  // --- Act/Assert 4：出征进入战斗 ---
  await page.locator('.select-panel button.primary').click();
  await expect(page.locator('.scene--select')).toHaveCount(0);
  await expect(page.locator('.hud[data-hud="battle"]')).toBeVisible();
  await expect(page.locator('.touch-controls')).toBeVisible();
  const hpText = page.locator('.hud__line .hud__value').first();
  await expect(hpText).toHaveText(/^\d+ \/ \d+$/);

  // --- Act/Assert 5：等待若干 tick，HUD 计时推进且无控制台错误 ---
  const timeText = page.locator('.hud .hud__value', { hasText: /^\d{2}:\d{2}$/ }).first();
  const t0 = await timeText.innerText();
  await page.waitForTimeout(2500);
  const t1 = await timeText.innerText();
  expect(t1, `HUD 计时应在若干 tick 后推进（起始 ${t0}）`).not.toBe(t0);
  // BUG-01 已修复：严格断言无任何控制台错误与 404。
  expect(errors, `浏览器控制台错误：\n${errors.join('\n')}`).toEqual([]);
  expect(http404, `HTTP 404 请求：\n${http404.join('\n')}`).toEqual([]);

  // --- Act/Assert 6：存档已落盘 ---
  const raw = await page.evaluate((key) => localStorage.getItem(key), SAVE_KEY);
  expect(raw, 'localStorage 应写入 wushuang.profile.v1').not.toBeNull();
  const profile = JSON.parse(raw as string) as { meta: { selectedGeneral: string }; run?: { generalId: string } };
  expect(profile.meta.selectedGeneral, `首位武将名=${generalName}`).toBeTruthy();
  // 注：run 属局内房间状态，DESIGN §10 明确不入库；此处只校验 meta 持久化。

  // --- Act/Assert 7：刷新后存档仍在 ---
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.scene--boot')).toBeVisible();
  const raw2 = await page.evaluate((key) => localStorage.getItem(key), SAVE_KEY);
  expect(raw2, '刷新后存档应保留').not.toBeNull();
  const profile2 = JSON.parse(raw2 as string) as { meta: { selectedGeneral: string } };
  expect(profile2.meta.selectedGeneral).toBe(profile.meta.selectedGeneral);
  await page.locator('.boot-enter').click();
  await expect(page.locator('.scene--menu')).toBeVisible();
});

test('移动端触控：控件生成、命中区 ≥44px、touch-action:none、setPointerCapture', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.scene--boot')).toBeVisible();

  // 控件结构：摇杆 + 3 技能 + 闪避 + 自动
  await expect(page.locator('.touch-controls')).toHaveCount(1);
  await expect(page.locator('.joystick.touch-control')).toHaveCount(1);
  await expect(page.locator('.skill-button.touch-control')).toHaveCount(4);
  await expect(page.locator('.touch-control__auto')).toHaveCount(1);

  // 命中区与 touch-action（读取浏览器计算样式）
  const metrics = await page.locator('.touch-control').evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return {
        cls: node.className,
        minWidth: parseFloat(style.minWidth),
        minHeight: parseFloat(style.minHeight),
        touchAction: style.touchAction,
      };
    }),
  );
  expect(metrics.length).toBeGreaterThanOrEqual(6);
  for (const m of metrics) {
    expect(m.minWidth, `${m.cls} min-width`).toBeGreaterThanOrEqual(44);
    expect(m.minHeight, `${m.cls} min-height`).toBeGreaterThanOrEqual(44);
    expect(m.touchAction, `${m.cls} touch-action`).toBe('none');
  }
  const bodyTouch = await page.evaluate(() => getComputedStyle(document.body).touchAction);
  expect(bodyTouch, 'body touch-action').toBe('none');

  // 多指捕获：pointerdown 时各控件分别调用 setPointerCapture
  await page.evaluate(() => {
    const w = window as unknown as { __wsCaptures: Array<{ cls: string; id: number }> };
    w.__wsCaptures = [];
    const original = Element.prototype.setPointerCapture;
    Element.prototype.setPointerCapture = function (this: Element, id: number): void {
      w.__wsCaptures.push({ cls: (this as HTMLElement).className, id });
      try {
        original.call(this, id);
      } catch {
        // 合成事件下浏览器可能拒绝 capture；这里只验证调用发生。
      }
    };
  });
  await page.dispatchEvent('.joystick', 'pointerdown', {
    pointerId: 21,
    clientX: 120,
    clientY: 120,
    bubbles: true,
  });
  await page.dispatchEvent('.skill-button[data-skill="0"]', 'pointerdown', {
    pointerId: 22,
    clientX: 300,
    clientY: 500,
    bubbles: true,
  });
  const captures = await page.evaluate(
    () => (window as unknown as { __wsCaptures: Array<{ cls: string; id: number }> }).__wsCaptures,
  );
  const classes = captures.map((c) => c.cls);
  expect(classes, '摇杆应调用 setPointerCapture').toContain('joystick touch-control');
  expect(classes, '技能按钮应调用 setPointerCapture').toContain('skill-button touch-control');
  const ids = captures.map((c) => c.id);
  expect(new Set(ids).size, '多指应使用各自 pointerId').toBeGreaterThanOrEqual(2);
  expect(errors, `浏览器未捕获异常：\n${errors.join('\n')}`).toEqual([]);
});
