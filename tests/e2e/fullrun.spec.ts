/**
 * 《无双》整局可玩性 · 浏览器分段快进主流程 E2E。
 *
 * 覆盖矩阵：M01 开局进入战斗 / M03 阶段推进 / M04 击杀链 / M05 成长链 /
 *           M06 BOSS 登场 / M08 整局结算 / M11 DOM-HUD 与 session 同步 / M12 零运行时错误。
 * 设计依据：docs/ARCHITECTURE_FULLRUN.md §0.2 / §4.2 / §6 / §7.2 / §13。
 *
 * 本地复现：
 *   npx playwright install --with-deps chromium   # 首次
 *   npx playwright test --project=fullrun --reporter=line
 *   （playwright.config.ts 的 webServer 自动拉起 vite dev 5173）
 *
 * 终态口径：result ∈ {1,2} 且结算面板可见；BOSS 在 auto 下 480s 内可能未击杀而 Defeat，
 * 这是已记录的玩法平衡项，不强求 Victory。精确 Victory 断言只在 node 确定性测试做。
 */
import { test, expect, type Page } from '@playwright/test';
import { hookApp, waitForApp, freezeApp, type FrozenState } from './helpers/appHook';
import { fastForwardTo, type FastForwardSample } from './helpers/fastForward';
import { readHud, type HudSnapshot } from './helpers/hudProbe';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173/';
/** §7.2 冻结里程碑：覆盖 6 阶段 + BOSS + 强制结算。 */
const MILESTONES: readonly number[] = [60, 180, 300, 420, 470, 481];

interface SessionView {
  elapsed: number;
  result: number;
  kills: number;
  level: number;
  score: number;
  bossSpawned: number;
  waveIndex: number;
}

function watchErrors(page: Page): { errors: string[]; http404: string[] } {
  const errors: string[] = [];
  const http404: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.status() === 404) http404.push(res.url());
  });
  return { errors, http404 };
}

/** M01：真实 UI Boot → Menu → Select → Battle，不用任何内部 API。 */
async function enterBattle(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.scene--boot')).toBeVisible();
  await page.locator('.boot-enter').click();
  await expect(page.locator('.scene--menu')).toBeVisible();
  await page.locator('.menu-panel button.primary').click();
  await expect(page.locator('.scene--select')).toBeVisible();
  const first = page.locator('.general-grid .general-card').first();
  await expect(first, '第一位武将应可选').toBeEnabled();
  await first.click();
  await page.locator('.select-panel button.primary').click();
  await expect(page.locator('.scene--select')).toHaveCount(0);
  await expect(page.locator('.hud[data-hud="battle"]')).toBeVisible();
  await expect(page.locator('.touch-controls')).toBeVisible();
}

/** 从被冻结的 App 读取 session 快照（只读，用于 M11 与 HUD 逐字段比对）。 */
async function readSession(page: Page): Promise<SessionView> {
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
      elapsed: s.elapsed,
      result: s.result,
      kills: s.kills,
      level: s.level,
      score: s.score,
      bossSpawned: s.bossSpawned,
      waveIndex: s.waveIndex,
    };
  });
}

/** 与 HUD.setTime 同口径：向下取整到 mm:ss。 */
function formatTime(seconds: number): string {
  const sec = Math.max(0, Math.floor(seconds));
  return `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;
}

test('整局快进：Boot→Menu→Select→Battle → 六里程碑 → 结算（M01/M03/M04/M05/M06/M08/M11/M12）', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { errors, http404 } = watchErrors(page);

  // M01：真实 UI 进入战斗（选择器与 appFlow.spec.ts 一致）。
  await enterBattle(page);

  // hook + freeze：捕获运行中 App，停掉 RAF，之后时间完全由测试合成驱动。
  const hooked = await hookApp(page);
  expect(hooked.ok, `应找到页面已加载的 App 模块：${JSON.stringify(hooked)}`).toBe(true);
  await waitForApp(page);
  const frozen: FrozenState = await freezeApp(page);

  const samples: FastForwardSample[] = [];
  const hudSamples: HudSnapshot[] = [];
  const sessionSamples: SessionView[] = [];

  for (const milestone of MILESTONES) {
    const sample = await fastForwardTo(page, milestone);
    const hud = await readHud(page);
    const session = await readSession(page);
    samples.push(sample);
    hudSamples.push(hud);
    sessionSamples.push(session);

    const diag = JSON.stringify({
      milestone,
      frozen,
      samples,
      hudSamples,
      sessionSamples,
      errors,
      http404,
    });

    // M03：阶段推进（elapsed 达到里程碑；终局提前结算时允许停在结算时刻）。
    expect(
      sample.result !== 0 || sample.elapsed >= milestone,
      `里程碑 ${milestone}s 应推进 elapsed：${diag}`,
    ).toBe(true);
    // M11：DOM/HUD 与 session 逐字段同值（时间按 mm:ss 比对）。
    expect(hud.kills, `里程碑 ${milestone}s HUD.kills 应与 session 同值：${diag}`).toBe(
      session.kills,
    );
    expect(hud.score, `里程碑 ${milestone}s HUD.score 应与 session 同值：${diag}`).toBe(
      session.score,
    );
    expect(hud.time, `里程碑 ${milestone}s HUD.time 应与 session.elapsed 同值：${diag}`).toBe(
      formatTime(session.elapsed),
    );
  }

  const finalDiag = JSON.stringify({ frozen, samples, hudSamples, sessionSamples, errors, http404 });

  // M04：60s 已能击杀，且击杀数单调不减（历史 DEFECT 回归）。
  expect(samples[0].kills, `60s 时应有击杀：${finalDiag}`).toBeGreaterThan(0);
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i].kills, `击杀数应单调不减：${finalDiag}`).toBeGreaterThanOrEqual(
      samples[i - 1].kills,
    );
  }

  // M05：成长链（等级增长 + 经验条 > 0）。
  expect(samples[0].level, `60s 时等级应有效：${finalDiag}`).toBeGreaterThanOrEqual(1);
  expect(
    samples[samples.length - 1].level,
    `整局后等级应增长：${finalDiag}`,
  ).toBeGreaterThan(samples[0].level);
  expect(
    parseFloat(hudSamples[0].expWidth),
    `经验条应 > 0%：${finalDiag}`,
  ).toBeGreaterThan(0);

  // M06：420s 里程碑 BOSS 已登场。
  const at420 = samples[3];
  expect(at420.bossSpawned, `420s 里程碑 BOSS 应登场：${finalDiag}`).toBe(1);

  // M08：整局必须结算（Victory=1 / Defeat=2 均可，不强求胜负）。
  const final = samples[samples.length - 1];
  expect([1, 2], `终局 result 应为 Victory/Defeat：${finalDiag}`).toContain(final.result);
  expect(final.result, `终局 result 应非 0：${finalDiag}`).not.toBe(0);
  await expect(page.locator('.scene--result'), `结算场景应可见：${finalDiag}`).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.result-panel'), `结算面板应可见：${finalDiag}`).toBeVisible();

  // M12：零 pageerror / console.error / HTTP 404。
  expect(errors, `浏览器运行时错误：\n${errors.join('\n')}\n${finalDiag}`).toEqual([]);
  expect(http404, `HTTP 404 请求：\n${http404.join('\n')}\n${finalDiag}`).toEqual([]);
});
