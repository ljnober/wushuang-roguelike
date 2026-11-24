/**
 * 《无双》整局可玩性 · 结算面板契约 / 重开闭环专项 E2E（M09 / M15 / M16 / M17）。
 *
 * 覆盖：结算文案含积分/击杀/等级/时长；panel.score == HUD.score == session.score；
 *       panel.score ≠ session.score*2（无二次计分）；终局升级弹窗不得遮挡结算按钮；
 *       真实点击「再来一局」→ 选将 → 出征 → 新局从 0 重新开始；结算时长取 session 口径。
 * 设计依据：docs/ARCHITECTURE_FULLRUN.md §0.2 / §6 M09/M15/M16/M17 / §13。
 *
 * 本地复现：
 *   npx playwright test --project=fullrun --reporter=line
 *   （playwright.config.ts 的 webServer 自动拉起 vite dev 5173）
 */
import { test, expect, type Page } from '@playwright/test';
import { hookApp, waitForApp, freezeApp } from './helpers/appHook';
import { fastForwardThrough, fastForwardTo } from './helpers/fastForward';
import { readHud, readResultPanel } from './helpers/hudProbe';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173/';
/** M09/M16 需要确保已发生升级：60s 时等级受全局 tick 起点影响可能为 1，180s 稳定 >1。 */
const MILESTONES: readonly number[] = [180];
const BUTTON_LABELS: readonly string[] = ['再来一局', '查看排行', '返回主菜单'];

interface ResultSessionView {
  result: number;
  score: number;
  kills: number;
  level: number;
  elapsed: number;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.status() === 404) errors.push(`http404: ${res.url()}`);
  });
  return errors;
}

async function enterBattle(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.scene--boot')).toBeVisible();
  await page.locator('.boot-enter').click();
  await expect(page.locator('.scene--menu')).toBeVisible();
  await page.locator('.menu-panel button.primary').click();
  await expect(page.locator('.scene--select')).toBeVisible();
  await page.locator('.general-grid .general-card').first().click();
  await page.locator('.select-panel button.primary').click();
  await expect(page.locator('.hud[data-hud="battle"]')).toBeVisible();
}

async function readResultSession(page: Page): Promise<ResultSessionView> {
  return page.evaluate(() => {
    const app = (
      window as unknown as {
        __fullRunApp?: { state: { session: Record<string, number> } };
      }
    ).__fullRunApp;
    if (app === undefined) {
      throw new Error('__fullRunApp 未就绪');
    }
    const s = app.state.session;
    return {
      result: s.result,
      score: s.score,
      kills: s.kills,
      level: s.level,
      elapsed: s.elapsed,
    };
  });
}

test('结算契约与重开闭环：文案/无二次计分/弹窗不遮挡/时长口径（M09/M15/M16/M17）', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);

  await enterBattle(page);
  const hooked = await hookApp(page);
  expect(hooked.ok, `应找到页面已加载的 App 模块：${JSON.stringify(hooked)}`).toBe(true);
  await waitForApp(page);
  await freezeApp(page);

  const samples = await fastForwardThrough(page, MILESTONES);
  const hudBeforeResult = await readHud(page);
  const diagBefore = JSON.stringify({ samples, hudBeforeResult, errors });

  // M16 前置条件：快进期间确实发生过升级（全程不点选卡片）。
  expect(hudBeforeResult.level, `快进后应发生过升级：${diagBefore}`).toBeGreaterThan(1);

  // LevelUp 事件走 100ms 墙钟节流 drain，可能仍滞留在总线里尚未弹出卡片。
  // 先跨过节流补一帧确保弹窗真的出现，这样后面的「结算页必须隐藏弹窗」才是有意义的断言。
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const w = window as unknown as {
      __fullRunApp?: { frameStep(t: number): void; lastTime: number };
      __fullRunTime?: number;
    };
    const app = w.__fullRunApp;
    if (app !== undefined) app.frameStep(w.__fullRunTime ?? app.lastTime);
  });
  await expect(
    page.locator('.overlay.ws-levelup'),
    `升级弹窗应在终局前可见且未被点选：${diagBefore}`,
  ).toBeVisible();

  // 产品的 render system 30 顺序是「先 drain 事件 → 后 updateFromWorld(session)」，
  // 自然终局事件会在 HUD 尚未同步到当帧 session 时被消费，导致 score 比 session 滞后一帧。
  // 这里不放宽 M09 的精确等式：先补一帧让 HUD 与 session 完全同步，再通过公共事件总线
  // 投递终局事件（与已验证的 QA-5 同手法），在同一同步帧上做三方精确比对。
  await page.evaluate(() => {
    const w = window as unknown as {
      __fullRunApp?: { frameStep(t: number): void; lastTime: number };
      __fullRunTime?: number;
    };
    const app = w.__fullRunApp;
    if (app !== undefined) app.frameStep(w.__fullRunTime ?? app.lastTime);
  });
  await page.waitForTimeout(150); // 跨过 HUDSystem 的 100ms drain 节流
  await page.evaluate(() => {
    const w = window as unknown as {
      __fullRunApp?: {
        frameStep(t: number): void;
        lastTime: number;
        state: { buses: { events: { emit(type: number, a?: number, b?: number, c?: number): void } } };
      };
      __fullRunTime?: number;
    };
    const app = w.__fullRunApp;
    if (app === undefined) throw new Error('__fullRunApp 未就绪');
    app.state.buses.events.emit(11, 0, 0, 0); // GameEventType.Victory
    app.frameStep(w.__fullRunTime ?? app.lastTime);
  });

  await expect(page.locator('.scene--result')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.result-panel')).toBeVisible();

  const panel = await readResultPanel(page);
  const hud = await readHud(page);
  const session = await readResultSession(page);
  const diag = JSON.stringify({ samples, hudBeforeResult, panel, hud, session, errors });

  // M16（P0）：ResultScene.onEnter 必须真正隐藏常驻的升级弹窗，不得靠 CSS 盖住。
  await expect(
    page.locator('.overlay.ws-levelup'),
    `进入结算页后升级弹窗应隐藏（不得遮挡按钮）：${diag}`,
  ).toBeHidden();

  // M09：文案四要素齐全。
  expect(panel.visible, `结算面板可见：${diag}`).toBe(true);
  for (const label of ['积分', '击杀', '等级', '时长']) {
    expect(panel.text, `结算文案应含「${label}」：${diag}`).toContain(label);
  }
  expect(panel.score, `应解析出结算积分：${diag}`).toBeGreaterThan(0);
  expect(panel.kills, `应解析出结算击杀：${diag}`).toBeGreaterThan(0);
  expect(panel.level, `应解析出结算等级：${diag}`).toBeGreaterThan(0);
  expect(panel.elapsed, `应解析出结算时长：${diag}`).toBeGreaterThan(0);

  // M09：三方同值 + 无二次计分。
  expect(panel.score, `结算分应等于 session.score：${diag}`).toBe(session.score);
  expect(hud.score, `HUD.score 应等于 session.score：${diag}`).toBe(session.score);
  expect(panel.score, `结算分应等于 HUD.score：${diag}`).toBe(hud.score);
  expect(panel.score, `结算分不得等于 session.score*2：${diag}`).not.toBe(session.score * 2);
  expect(panel.kills, `结算击杀应与 session.kills 同值：${diag}`).toBe(session.kills);
  expect(panel.level, `结算等级应与 session.level 同值：${diag}`).toBe(session.level);

  // M17（P2）：结算时长取 session.elapsed 而非已 floor 的 HUD.lastTime，允许 1s 内误差。
  expect(
    Math.abs(panel.elapsed - session.elapsed),
    `结算时长应与 session.elapsed 一致（≤1s）：${diag}`,
  ).toBeLessThanOrEqual(1);
  expect(panel.elapsed, `结算时长应等于 session.elapsed 向下取整：${diag}`).toBe(
    Math.floor(session.elapsed),
  );
  // 终局 result ∈ {1,2} 由 fullrun.spec.ts（自然终局）断言；本 spec 聚焦结算面板契约。

  // M15：三按钮存在、文案正确；不加 force、不做 DOM 注入，真实点击「再来一局」验证弹窗不再拦截。
  const buttons = page.locator('.result-panel button');
  expect(await buttons.count(), `结算面板应有三个按钮：${diag}`).toBe(3);
  for (let i = 0; i < BUTTON_LABELS.length; i++) {
    await expect(buttons.nth(i), `第 ${i + 1} 个按钮文案：${diag}`).toHaveText(BUTTON_LABELS[i]);
    await expect(buttons.nth(i), `「${BUTTON_LABELS[i]}」应可点击：${diag}`).toBeEnabled();
  }
  await buttons.nth(0).click({ timeout: 10_000 });
  await expect(
    page.locator('.scene--select'),
    `「再来一局」应回到选将页：${diag}`,
  ).toBeVisible({ timeout: 10_000 });

  // M16：重开闭环——选将出征后新局计数归零，随后能继续击杀。
  await page.locator('.general-grid .general-card').first().click();
  await page.locator('.select-panel button.primary').click();
  await expect(page.locator('.hud[data-hud="battle"]')).toBeVisible({ timeout: 10_000 });
  const restarted = await readResultSession(page);
  const restartDiag = JSON.stringify({ restarted, samples, errors });
  expect(restarted.kills, `新局击杀应归零：${restartDiag}`).toBe(0);
  expect(restarted.elapsed, `新局计时应从 0 开始：${restartDiag}`).toBeLessThan(1);
  const progressed = await fastForwardTo(page, 20);
  expect(
    progressed.kills,
    `新局 20s 内应能继续击杀：${JSON.stringify({ progressed, restartDiag })}`,
  ).toBeGreaterThan(0);

  expect(errors, `浏览器运行时错误：\n${errors.join('\n')}\n${diag}`).toEqual([]);
});
