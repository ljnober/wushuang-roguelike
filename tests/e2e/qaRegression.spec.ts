/**
 * QA 独立回归：《无双》"无法击杀怪物"缺陷（不复用工程师的临时脚本）。
 *
 * 覆盖：
 *  1. 默认 auto：Boot → Menu → Select → Battle，12~15 秒内 HUD 击杀数 > 0；
 *  2. 手动：设置页切手动后，移动 + 技能 0/1/2 + 闪避 均产生伤害/击杀，冷却后二次施法仍生效；
 *  3. 重开：刷新后再次 startBattle，计数归零且仍能继续击杀；
 *  4. 全程零 pageerror / console.error。
 *
 * 运行：E2E_BASE_URL=http://localhost:5173/ npx playwright test tests/e2e/qaRegression.spec.ts
 */
import { test, expect, type Page } from 'file:///C:/Users/liujian/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/test.mjs';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173/';
const SAVE_KEY = 'wushuang.profile.v1';

test.setTimeout(120_000);

interface HudSample {
  hp: string;
  time: string;
  kills: number;
  score: number;
  level: number;
  expWidth: string;
}

/** 从真实 DOM 读取 HUD 快照（只读，不注入任何测试后门）。 */
async function readHud(page: Page): Promise<HudSample> {
  return page.evaluate(() => {
    const values = Array.from(document.querySelectorAll('.hud .hud__value')).map(
      (node) => node.textContent?.trim() ?? '',
    );
    const num = (prefix: string): number => {
      const raw = values.find((v) => v.startsWith(prefix)) ?? '';
      const parsed = Number(raw.replace(prefix, '').trim());
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const bar = document.querySelector('.hud__bar-fill--exp') as HTMLElement | null;
    return {
      hp: values.find((v) => /^\d+ \/ \d+$/.test(v)) ?? '',
      time: values.find((v) => /^\d{2}:\d{2}$/.test(v)) ?? '',
      kills: num('击杀'),
      score: num('积分'),
      level: num('Lv.'),
      expWidth: bar?.style.width ?? '',
    };
  });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

/** 走完整 UI 流程进入战斗；不用任何内部 API/后门。 */
async function enterBattle(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.scene--boot')).toBeVisible();
  await page.locator('.boot-enter').click();
  await expect(page.locator('.scene--menu')).toBeVisible();
  await page.locator('.menu-panel button.primary').click();
  await expect(page.locator('.scene--select')).toBeVisible();
  const first = page.locator('.general-grid .general-card').first();
  await expect(first).toBeEnabled();
  await first.click();
  await page.locator('.select-panel button.primary').click();
  await expect(page.locator('.scene--select')).toHaveCount(0);
  await expect(page.locator('.hud[data-hud="battle"]')).toBeVisible();
  await expect(page.locator('.touch-controls')).toBeVisible();
}

/** 升级弹窗会遮挡控件：真实玩家会选卡，测试同样选第一张。 */
async function dismissLevelUp(page: Page): Promise<number> {
  const overlay = page.locator('.overlay.ws-levelup');
  if ((await overlay.count()) === 0 || (await overlay.isHidden())) return 0;
  const before = await readHud(page);
  await overlay.locator('.card').first().click();
  return (await readHud(page)).level - before.level;
}

function parseHp(hp: string): { cur: number; max: number } {
  const m = /^(\d+) \/ (\d+)$/.exec(hp);
  return m === null ? { cur: 0, max: 0 } : { cur: Number(m[1]), max: Number(m[2]) };
}

test('QA-1 默认 auto：真实浏览器 15 秒内持续击杀且无错误', async ({ page }) => {
  const errors = watchErrors(page);
  await enterBattle(page);

  const autoButton = page.locator('.touch-control__auto');
  await expect(autoButton, '默认应为自动模式').toHaveText('自动');
  // DEFECT-A 回归：进战斗瞬间应有 Lv.1 基线积分 100、击杀 0、经验条空。
  await expect
    .poll(async () => (await readHud(page)).score, { timeout: 5_000, intervals: [100] })
    .toBe(100);
  const t0 = await readHud(page);
  expect(t0.kills, '开局击杀应为 0').toBe(0);
  expect(t0.level, '开局等级应为 1').toBe(1);
  expect(parseFloat(t0.expWidth), '开局经验条应为空').toBe(0);
  const samples: HudSample[] = [t0];
  // 15 秒，每 1.5 秒采样；期间像玩家一样处理升级弹窗。
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1500);
    await dismissLevelUp(page);
    samples.push(await readHud(page));
  }
  console.log('[QA-1 HUD samples]', JSON.stringify(samples));

  const last = samples[samples.length - 1];
  expect(last.kills, `15 秒内击杀数应 > 0，采样=${JSON.stringify(samples)}`).toBeGreaterThan(0);
  expect(last.kills, '击杀数应单调递增').toBeGreaterThanOrEqual(t0.kills);
  const hp = parseHp(last.hp);
  expect(hp.cur, `HP 应有效，实际=${last.hp}`).toBeGreaterThan(0);
  expect(hp.max, `最大 HP 应有效，实际=${last.hp}`).toBeGreaterThan(0);
  expect(hp.cur, 'HP 不应超过上限').toBeLessThanOrEqual(hp.max);
  expect(last.time, 'HUD 计时应推进').not.toBe(t0.time);
  // DEFECT-A 硬回归：击杀增长必须带动积分与经验条。
  expect(last.score, `积分应超过 Lv.1 基线 100，采样=${JSON.stringify(samples)}`).toBeGreaterThan(100);
  expect(
    parseFloat(last.expWidth),
    `经验条百分比应 > 0%，采样=${JSON.stringify(samples)}`,
  ).toBeGreaterThan(0);
  console.log(
    `[QA-1 15s] 击杀=${last.kills}，HP=${last.hp}，积分=${last.score}，等级=${last.level}，经验条=${last.expWidth}`,
  );
  expect(errors, `浏览器错误：\n${errors.join('\n')}`).toEqual([]);
});

test('QA-4 DEFECT-A 关闭验证：HUD 成长反馈（击杀/积分/经验）三项同步', async ({ page }) => {
  const errors = watchErrors(page);
  await enterBattle(page);
  await expect
    .poll(async () => (await readHud(page)).score, { timeout: 5_000, intervals: [100] })
    .toBe(100);
  await expect
    .poll(async () => (await readHud(page)).kills, { timeout: 20_000, intervals: [500] })
    .toBeGreaterThan(0);
  // 经验球拾取受走位影响，按条件轮询而非固定等待，避免假阴性。
  await expect
    .poll(async () => parseFloat((await readHud(page)).expWidth), { timeout: 20_000, intervals: [500] })
    .toBeGreaterThan(0);
  await dismissLevelUp(page);
  const sample = await readHud(page);
  console.log(`[QA-4 DEFECT-A] HUD=${JSON.stringify(sample)}`);
  expect(sample.kills, '击杀数应 > 0').toBeGreaterThan(0);
  expect(sample.score, `积分应 > Lv.1 基线 100，实际=${sample.score}`).toBeGreaterThan(100);
  expect(parseFloat(sample.expWidth), `经验条应 > 0%，实际=${sample.expWidth}`).toBeGreaterThan(0);
  expect(errors, `浏览器错误：\n${errors.join('\n')}`).toEqual([]);
});

test('QA-2 手动模式：技能 0/1/2 与闪避不再无反应，冷却后二次施法仍生效', async ({ page }) => {
  const errors = watchErrors(page);

  // 走 UI：Boot → Menu → 设置 → 操作模式「手动」→ 返回主菜单 → 出征。
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.scene--boot')).toBeVisible();
  await page.locator('.boot-enter').click();
  await expect(page.locator('.scene--menu')).toBeVisible();
  await page.locator('.menu-actions button', { hasText: '设置' }).click();
  await expect(page.locator('.scene--settings')).toBeVisible();
  const controlRow = page.locator('.settings-panel .setting-row').filter({
    has: page.locator('.setting-label', { hasText: '操作模式' }),
  });
  await controlRow.locator('.chip', { hasText: '手动' }).click();
  await expect(controlRow.locator('.chip', { hasText: '手动' })).toHaveClass(/is-active/);
  await page.locator('.settings-panel button.primary', { hasText: '返回主菜单' }).click();
  await expect(page.locator('.scene--menu')).toBeVisible();
  await page.locator('.menu-panel button.primary').click();
  await expect(page.locator('.scene--select')).toBeVisible();
  await page.locator('.general-grid .general-card').first().click();
  await page.locator('.select-panel button.primary').click();
  await expect(page.locator('.hud[data-hud="battle"]')).toBeVisible();

  const autoButton = page.locator('.touch-control__auto');
  await expect(autoButton, '设置页切手动后 HUD 应显示手动').toHaveText('手动');
  await expect(autoButton).toHaveAttribute('aria-pressed', 'false');
  const raw = await page.evaluate((key) => localStorage.getItem(key), SAVE_KEY);
  expect(raw, '手动模式应落盘').not.toBeNull();
  expect(JSON.parse(raw as string).meta.settings.controlMode).toBe('manual');

  const baseline = await readHud(page);
  const log: string[] = [`baseline=${JSON.stringify(baseline)}`];

  // 模拟真人：WASD 靠近怪物 + j 普攻 + 1/2/3 技能 + 闪避。
  // 键盘事件走 TouchControls.onKeyDown，技能键会调用 onSkill → CommandType.Skill。
  for (let round = 0; round < 8; round++) {
    await dismissLevelUp(page);
    await page.keyboard.down('d');
    await page.waitForTimeout(350);
    await page.keyboard.up('d');
    await page.keyboard.down('j');
    await page.waitForTimeout(120);
    await page.keyboard.up('j');
    for (const key of ['1', '2', '3']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(160); // > 0.1s 冷却，验证 cd 递减后再次施法
    }
    await page.keyboard.press(' '); // 闪避
    await page.waitForTimeout(400);
    log.push(`round${round}=${JSON.stringify(await readHud(page))}`);
  }
  console.log('[QA-2 manual samples]', log.join('\n'));

  const last = await readHud(page);
  expect(last.kills, `手动施法应能击杀怪物，采样=${log.join('\n')}`).toBeGreaterThan(baseline.kills);
  expect(errors, `浏览器错误：\n${errors.join('\n')}`).toEqual([]);
});

test('QA-3 重开闭环：再次 startBattle 后计数归零且仍能击杀', async ({ page }) => {
  const errors = watchErrors(page);
  await enterBattle(page);
  await expect(page.locator('.touch-control__auto')).toHaveText('自动');

  // 首局：证明能击杀。
  await expect
    .poll(async () => (await readHud(page)).kills, { timeout: 20_000, intervals: [500] })
    .toBeGreaterThan(0);
  await dismissLevelUp(page);
  const firstEnd = await readHud(page);
  console.log('[QA-3 first battle]', JSON.stringify(firstEnd));

  // 切场景重开：刷新页面后重新走完整 UI 旅程（等价于再次 startBattle）。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.scene--boot')).toBeVisible();
  await page.locator('.boot-enter').click();
  await expect(page.locator('.scene--menu')).toBeVisible();
  await page.locator('.menu-panel button.primary').click();
  await expect(page.locator('.scene--select')).toBeVisible();
  await page.locator('.general-grid .general-card').first().click();
  await page.locator('.select-panel button.primary').click();
  await expect(page.locator('.hud[data-hud="battle"]')).toBeVisible();

  const restarted = await readHud(page);
  console.log('[QA-3 restarted]', JSON.stringify(restarted));
  expect(restarted.kills, `重开后击杀数应归零，实际=${JSON.stringify(restarted)}`).toBe(0);
  expect(restarted.time, '重开后计时应归零').toBe('00:00');
  expect(restarted.level, '重开后等级应回到 1').toBe(1);
  expect(restarted.score, '重开后积分应回到 Lv.1 基线 100').toBe(100);
  expect(parseFloat(restarted.expWidth), '重开后经验条应为空').toBe(0);

  await expect
    .poll(async () => (await readHud(page)).kills, { timeout: 20_000, intervals: [500] })
    .toBeGreaterThan(0);
  await dismissLevelUp(page);
  const secondEnd = await readHud(page);
  expect(secondEnd.kills).toBeGreaterThan(0);
  expect(secondEnd.score, '第二局积分应超过 Lv.1 基线').toBeGreaterThan(100);
  expect(errors, `浏览器错误：\n${errors.join('\n')}`).toEqual([]);
});

test('QA-5 结算口径：HUD.score 与 session.score 同值，Victory 不二次计分', async ({ page }) => {
  const errors = watchErrors(page);
  await enterBattle(page);
  await expect
    .poll(async () => (await readHud(page)).score, { timeout: 5_000, intervals: [100] })
    .toBe(100);

  // 仅测试注入：动态导入页面已加载的同一 App 模块，patch 原型以捕获运行中的实例。
  // 不修改任何源码，也不新增产品代码后门。
  const hooked = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((r) => r.name);
    const appUrl = urls.find((u) => /\/src\/app\/App\.ts/.test(u));
    if (appUrl === undefined) return { ok: false, urls: urls.slice(0, 12) };
    const mod = (await import(/* @vite-ignore */ appUrl)) as {
      App: { prototype: { frameStep: (this: unknown, t: number) => void } };
    };
    const original = mod.App.prototype.frameStep;
    mod.App.prototype.frameStep = function (this: unknown, t: number): void {
      (window as unknown as { __qaApp: unknown }).__qaApp = this;
      original.call(this, t);
    };
    return { ok: true, appUrl };
  });
  console.log('[QA-5 hook]', JSON.stringify(hooked));
  expect(hooked.ok, `应找到页面已加载的 App 模块，实际=${JSON.stringify(hooked)}`).toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __qaApp?: unknown }).__qaApp !== undefined), {
      timeout: 3_000,
      intervals: [100],
    })
    .toBe(true);

  // 产生非基线积分后冻结会话，便于精确比对 HUD 与 session（结算本身也会 endBattle）。
  await expect
    .poll(async () => (await readHud(page)).kills, { timeout: 20_000, intervals: [500] })
    .toBeGreaterThan(0);
  await dismissLevelUp(page);
  await page.evaluate(() => {
    const app = (window as unknown as { __qaApp: { state: { session: { running: number } } } }).__qaApp;
    app.state.session.running = 0;
  });
  await page.waitForTimeout(300);

  const sessionSnap = await page.evaluate(() => {
    const s = (window as unknown as { __qaApp: { state: { session: Record<string, number> } } }).__qaApp
      .state.session;
    return { kills: s.kills, score: s.score, level: s.level, exp: s.exp, expNext: s.expNext };
  });
  const hudSnap = await readHud(page);
  console.log('[QA-5 before Victory]', JSON.stringify({ sessionSnap, hudSnap }));
  expect(sessionSnap.kills, 'session.kills 应 > 0').toBeGreaterThan(0);
  expect(sessionSnap.score, 'session.score 应与 kills/level 同公式').toBe(
    sessionSnap.kills * 10 + sessionSnap.level * 100,
  );
  expect(sessionSnap.expNext, 'expNext 应与 EXP_CURVE(1) 同口径').toBe(19);
  expect(hudSnap.score, 'HUD.score 应与 session.score 同值').toBe(sessionSnap.score);
  expect(hudSnap.kills, 'HUD.kills 应与 session.kills 同值').toBe(sessionSnap.kills);

  // 触发 Victory（GameEventType.Victory=11），等待结算面板渲染。
  await page.evaluate(() => {
    const app = (window as unknown as {
      __qaApp: { state: { buses: { events: { emit: (t: number, a?: number, b?: number, c?: number) => void } } } };
    }).__qaApp;
    app.state.buses.events.emit(11, 0, 0, 0);
  });
  await expect(page.locator('.scene--result')).toBeVisible({ timeout: 5_000 });
  const resultText = await page.locator('.result-panel .result-lines').innerText();
  const resultScore = Number(/积分\s*(\d+)/.exec(resultText)?.[1] ?? NaN);
  console.log('[QA-5 result]', JSON.stringify({ resultText, resultScore, sessionSnap }));
  expect(Number.isFinite(resultScore), `结算应含积分：${resultText}`).toBe(true);
  expect(resultScore, '结算分应等于 HUD.score，不得二次叠加').toBe(sessionSnap.score);
  expect(resultScore, '结算分不得等于 HUD.score + kills*10 + level*100 的旧重复公式').not.toBe(
    sessionSnap.score * 2,
  );
  expect(errors, `浏览器错误：\n${errors.join('\n')}`).toEqual([]);
});
