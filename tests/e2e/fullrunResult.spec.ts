/**
 * 《无双》整局可玩性 · 结算面板契约 / 重开闭环专项 E2E（M09 / M15 / M16 / M17）。
 *
 * 覆盖：真实快进到自然终局（Victory 或 Defeat 均由产品链路自行结算）；结算文案四要素；
 *       panel.score == HUD.score == session.score 且无二次计分；终局升级弹窗不遮挡结算按钮；
 *       不带 force 的真实点击「再来一局」→选将→出征→新局从 0 开始并能继续击杀；时长取 session 口径。
 * 设计依据：docs/ARCHITECTURE_FULLRUN.md §0.2 / §6 M09/M15/M16/M17 / §13。
 *
 * 本地复现：
 *   npx playwright test --project=fullrun --reporter=line
 *   （playwright.config.ts 的 webServer 自动拉起 vite dev 5173）
 */
import { test, expect, type Page } from '@playwright/test';
import { hookApp, waitForApp, freezeApp } from './helpers/appHook';
import { fastForwardTo, type FastForwardSample } from './helpers/fastForward';
import { readHud, readResultPanel, type HudSnapshot } from './helpers/hudProbe';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173/';
/** §7.2 冻结里程碑，真实快进到自然终局，不手工投递任何终局事件。 */
const MILESTONES: readonly number[] = [60, 180, 300, 420, 470, 481];
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

  // 真实快进到自然终局；全程不点选升级卡，也不手工投递终局事件。
  const samples: FastForwardSample[] = [];
  const hudSamples: HudSnapshot[] = [];
  for (const milestone of MILESTONES) {
    samples.push(await fastForwardTo(page, milestone));
    hudSamples.push(await readHud(page));
  }
  const terminal = samples[samples.length - 1];
  const diagRun = JSON.stringify({ samples, hudSamples, errors });

  // M16 前置：快进期间确实发生过升级（等级只读自 DOM，证明升级事件链路有效）。
  const maxLevel = Math.max(...hudSamples.map((h) => h.level));
  expect(maxLevel, `快进期间应发生过升级：${diagRun}`).toBeGreaterThan(1);
  expect([1, 2], `应由产品链路自然结算：${diagRun}`).toContain(terminal.result);

  await expect(page.locator('.scene--result'), `自然终局应切结算场景：${diagRun}`).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.result-panel')).toBeVisible();

  // 合法的渲染同步：跨过 HUDSystem 100ms drain 节流后补一帧 rawDt=0 的 frameStep。
  // 不推进 tick、不注入事件、不改 session；若 HUD 仍滞后于权威 session，轮询等待其追平。
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const w = window as unknown as {
      __fullRunApp?: { frameStep(t: number): void; lastTime: number };
      __fullRunTime?: number;
    };
    const app = w.__fullRunApp;
    if (app !== undefined) app.frameStep(w.__fullRunTime ?? app.lastTime);
  });
  await expect
    .poll(async () => (await readHud(page)).score, { timeout: 5_000 })
    .toBe(terminal.score);

  const panel = await readResultPanel(page);
  const hud = await readHud(page);
  const session = await readResultSession(page);
  const diag = JSON.stringify({ samples, hudSamples, panel, hud, session, errors });

  // M16（P0）：ResultScene.onEnter 必须真正隐藏常驻升级弹窗，不得靠 CSS 盖住。
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

  // M09：三方同值 + 无二次计分（payload 以 session 为权威，HUD 仅 fallback）。
  expect(panel.score, `结算分应等于 session.score：${diag}`).toBe(session.score);
  expect(hud.score, `HUD.score 应等于 session.score：${diag}`).toBe(session.score);
  expect(panel.score, `结算分应等于 HUD.score：${diag}`).toBe(hud.score);
  expect(panel.score, `结算分不得等于 session.score*2：${diag}`).not.toBe(session.score * 2);
  expect(panel.kills, `结算击杀应与 session.kills 同值：${diag}`).toBe(session.kills);
  expect(panel.level, `结算等级应与 session.level 同值：${diag}`).toBe(session.level);

  // M17（P2）：结算时长取 session.elapsed（允许 ±1s），面板按 Math.floor 展示。
  expect(
    Math.abs(panel.elapsed - session.elapsed),
    `结算时长应与 session.elapsed 一致（≤1s）：${diag}`,
  ).toBeLessThanOrEqual(1);
  expect(panel.elapsed, `结算时长应等于 session.elapsed 向下取整：${diag}`).toBe(
    Math.floor(session.elapsed),
  );

  // M15/M16：不加 force、不注入 DOM，真实点击「再来一局」验证弹窗不再拦截。
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
