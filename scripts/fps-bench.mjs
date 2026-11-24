/**
 * E2 FPS 压测驱动（ARCHITECTURE_INCREMENTAL_2 §1.2 / §3.3 / §6.2）。
 *
 * 桌面 1280×720/DSF=1 与移动 Pixel 7 / iPhone 13 模拟各 3 次独立运行；
 * 每次 3s（且≥180 帧）预热 + 10s 采样，帧时间取自 requestAnimationFrame(timestamp)。
 * 原样帧时间样本写入 docs/perf/fps-report.json，未达标如实记录并以非零码退出。
 *
 * 用法：
 *   node scripts/fps-bench.mjs --platform=both --runs=3 --out=docs/perf/fps-report.json
 *   node scripts/fps-bench.mjs --platform=desktop --base-url=http://127.0.0.1:5173/
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* ------------------------------------------------------------------ 参数解析 */

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
}

const PLATFORM = readArg('platform', 'both');
const RUNS = Math.max(1, Number(readArg('runs', '3')) || 3);
const BASE_URL = readArg('base-url', 'http://127.0.0.1:5173/').replace(/\/$/, '');
const OUT_PATH = resolve(readArg('out', 'docs/perf/fps-report.json'));
const WARMUP_MS = 3000;
const SAMPLE_MS = 10000;
const WARMUP_FRAMES = 180;
const MIN_SAMPLE_FRAMES = 300;
const TARGETS = { desktop: 50, mobile: 45 };
const BENCH_SEED = 0x9e3779b9;
const QUALITY_NAMES = ['low', 'medium', 'high'];

if (PLATFORM !== 'both' && PLATFORM !== 'desktop' && PLATFORM !== 'mobile') {
  console.error(`--platform 只能是 both / desktop / mobile，收到：${PLATFORM}`);
  process.exit(2);
}

/* ------------------------------------------------------------ Playwright 解析 */

async function loadPlaywright() {
  const candidates = [
    'playwright',
    'file:///C:/Users/liujian/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs',
  ];
  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await import(candidates[i]);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法加载 Playwright：${String(lastError)}`);
}

/* ------------------------------------------------------------------ 统计工具 */

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function medianOf(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

function frameStats(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  return {
    samples,
    mean: samples.length > 0 ? sum / samples.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
  };
}

function fpsStats(frameMs, sampleFrames, firstTs, lastTs, target) {
  const span = lastTs - firstTs;
  return {
    mean: span > 0 ? (sampleFrames * 1000) / span : 0,
    p50: frameMs.p50 > 0 ? 1000 / frameMs.p50 : 0,
    p95LowerBound: frameMs.p95 > 0 ? 1000 / frameMs.p95 : 0,
    target,
  };
}

/* ---------------------------------------------------------- 页面内 rAF 采样器 */

/**
 * 在页面上下文执行；预热与采样都用 rAF timestamp，绝不读 Date.now / performance.now。
 * 每秒调用一次只读探针记录实体数最小值；tick 差值用于验证逻辑仍在推进。
 */
async function sampleInPage(config) {
  const probe = window.__WS_BENCH__;
  if (probe === undefined || probe === null) {
    throw new Error('window.__WS_BENCH__ 未安装：请确认 URL 带 ?bench=1');
  }

  const tickAtStart = probe.getSnapshot().tick;

  // 预热：3000ms 与 180 帧取较晚到达者，同时记录最小帧间隔估算刷新率上限。
  let warmupFrames = 0;
  let warmupStart = 0;
  let previousTs = 0;
  let minDelta = Number.POSITIVE_INFINITY;
  await new Promise((done) => {
    const step = (ts) => {
      if (warmupStart === 0) {
        warmupStart = ts;
        previousTs = ts;
      } else {
        const delta = ts - previousTs;
        if (delta > 0 && delta < minDelta) minDelta = delta;
        previousTs = ts;
      }
      warmupFrames++;
      if (ts - warmupStart >= config.warmupMs && warmupFrames >= config.warmupFrames) {
        done();
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });
  const refreshCapHz = Number.isFinite(minDelta) && minDelta > 0 ? Math.round(1000 / minDelta) : 0;

  // 采样：10s，帧间隔原样入 samples；每秒读取一次探针最小值。
  const samples = [];
  let minObservedEnemies = Number.POSITIVE_INFINITY;
  let minObservedBullets = Number.POSITIVE_INFINITY;
  let sampleStart = 0;
  let lastTs = 0;
  let lastSecond = -1;
  await new Promise((done) => {
    const step = (ts) => {
      if (sampleStart === 0) {
        sampleStart = ts;
        lastTs = ts;
      } else {
        samples.push(ts - lastTs);
        lastTs = ts;
      }
      const second = Math.floor((ts - sampleStart) / 1000);
      if (second > lastSecond) {
        lastSecond = second;
        const snap = probe.getSnapshot();
        if (snap.enemies < minObservedEnemies) minObservedEnemies = snap.enemies;
        if (snap.bullets < minObservedBullets) minObservedBullets = snap.bullets;
      }
      if (ts - sampleStart >= config.sampleMs) {
        done();
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });

  const tickAtEnd = probe.getSnapshot().tick;
  const lastSnap = probe.getSnapshot();
  return {
    samples,
    warmupFrames,
    sampleFrames: samples.length,
    minObservedEnemies: Number.isFinite(minObservedEnemies) ? minObservedEnemies : 0,
    minObservedBullets: Number.isFinite(minObservedBullets) ? minObservedBullets : 0,
    tickAtStart,
    tickAtEnd,
    refreshCapHz,
    firstTs: sampleStart,
    lastTs,
    probe: lastSnap,
  };
}

/** 采集浏览器/WebGL 环境信息；探针的 quality/headless 仅作环境标注。 */
async function readEnvironment(page, browserVersion, platform) {
  return page.evaluate(
    ({ version, platformName, qualityNames, seed }) => {
      const testCanvas = document.createElement('canvas');
      const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
      let webglRenderer = null;
      if (gl !== null) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        webglRenderer = debugInfo !== null
          ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
          : String(gl.getParameter(gl.RENDERER));
      }
      const snap = window.__WS_BENCH__ === undefined ? null : window.__WS_BENCH__.getSnapshot();
      return {
        browser: 'chromium',
        browserVersion: version,
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        deviceScaleFactor: window.devicePixelRatio,
        webglRenderer,
        headless: snap === null ? true : snap.headless,
        quality: qualityNames[snap === null ? 0 : snap.quality] || qualityNames[0],
        refreshCapHz: 0,
        capped: false,
        seed,
        slots: snap === null ? 0 : snap.slots,
        seenReady: snap === null ? false : snap.seenReady,
        platformName,
      };
    },
    {
      version: browserVersion,
      platformName: platform,
      qualityNames: QUALITY_NAMES,
      seed: BENCH_SEED,
    },
  );
}

/* -------------------------------------------------------------------- 单次运行 */

async function runOnce(browser, platform, index, notes, devices) {
  const target = TARGETS[platform];
  let context = null;
  try {
    const contextOptions =
      platform === 'desktop'
        ? { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }
        : index % 2 === 0
          ? { ...devices['Pixel 7'] }
          : { ...devices['iPhone 13'] };
    context = await browser.newContext(contextOptions);
    // 并行开发时 Vite HMR 的 full-reload 会打断 10s 采样窗口；仅在本压测页屏蔽 HMR 消息，
    // 保证一次运行内模块图稳定、数据可复现。dev server 与其它页面不受影响。
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class BenchWebSocket extends NativeWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          this.addEventListener(
            'message',
            (event) => {
              let text = '';
              try {
                text = String(event.data);
              } catch {
                return;
              }
              if (text.includes('full-reload') || text.includes('"update"') || text.includes('"prune"')) {
                event.stopImmediatePropagation();
              }
            },
            true,
          );
        }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => notes.push(`[run ${platform}#${index + 1}] 页面异常：${String(error)}`));

    const url = `${BASE_URL}/?bench=1&seed=${BENCH_SEED}&q=1&platform=${platform}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
      () => {
        const probe = window.__WS_BENCH__;
        if (probe === undefined || probe === null) return false;
        const snap = probe.getSnapshot();
        return snap.sceneReady === true && snap.enemies >= 300 && snap.bullets >= 500;
      },
      null,
      { timeout: 30000, polling: 100 },
    );

    const raw = await page.evaluate(sampleInPage, {
      warmupMs: WARMUP_MS,
      warmupFrames: WARMUP_FRAMES,
      sampleMs: SAMPLE_MS,
    });
    const environment = await readEnvironment(page, browser.version(), platform);
    environment.refreshCapHz = raw.refreshCapHz;
    environment.capped = raw.refreshCapHz > 0 && raw.refreshCapHz < target + 10;

    const frameMs = frameStats(raw.samples);
    const fps = fpsStats(frameMs, raw.sampleFrames, raw.firstTs, raw.lastTs, target);
    const validForTarget = !environment.headless && !environment.capped;
    const enoughSamples = raw.sampleFrames >= MIN_SAMPLE_FRAMES;
    const enoughEntities = raw.minObservedEnemies >= 300 && raw.minObservedBullets >= 500;
    const pass =
      validForTarget && enoughSamples && enoughEntities && raw.tickAtEnd > raw.tickAtStart && fps.mean >= target;

    const runNotes = [];
    if (environment.headless) runNotes.push('渲染器 headless，数字不可作为达标依据');
    if (environment.capped) runNotes.push(`刷新率钳制 ${raw.refreshCapHz}Hz < 目标+10，属环境受限`);
    if (!enoughSamples) runNotes.push(`有效样本 ${raw.sampleFrames} < ${MIN_SAMPLE_FRAMES}，本次无效`);
    if (!enoughEntities) runNotes.push(`采样期实体不足：敌 ${raw.minObservedEnemies} / 弹幕 ${raw.minObservedBullets}`);
    if (raw.tickAtEnd <= raw.tickAtStart) runNotes.push('逻辑 tick 未推进，压测场景未接上系统链');
    if (fps.mean < target) runNotes.push(`fps.mean ${fps.mean.toFixed(2)} 低于目标 ${target}`);

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      platform,
      pass,
      validForTarget,
      environment,
      scenario: {
        targetEnemies: 300,
        targetBullets: 500,
        minObservedEnemies: raw.minObservedEnemies,
        minObservedBullets: raw.minObservedBullets,
        warmupMs: WARMUP_MS,
        sampleMs: SAMPLE_MS,
        warmupFrames: raw.warmupFrames,
        sampleFrames: raw.sampleFrames,
      },
      frameTimesMs: frameMs,
      fps,
      determinism: {
        tickAtStart: raw.tickAtStart,
        tickAtEnd: raw.tickAtEnd,
        tickDelta: raw.tickAtEnd - raw.tickAtStart,
      },
      notes: runNotes,
    };
    notes.push(
      `[run ${platform}#${index + 1}] pass=${pass} mean=${fps.mean.toFixed(2)} p95=${frameMs.p95.toFixed(2)}ms ` +
        `敌=${raw.minObservedEnemies} 弹幕=${raw.minObservedBullets} slots=${environment.slots} tickΔ=${report.determinism.tickDelta}`,
    );
    return report;
  } catch (error) {
    notes.push(`[run ${platform}#${index + 1}] 执行失败：${String(error)}`);
    return buildFailedRun(platform, target, String(error));
  } finally {
    if (context !== null) {
      await context.close().catch(() => undefined);
    }
  }
}

function buildFailedRun(platform, target, reason) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform,
    pass: false,
    validForTarget: false,
    environment: {
      browser: 'chromium',
      browserVersion: '',
      userAgent: '',
      viewport: { width: 0, height: 0 },
      deviceScaleFactor: 0,
      webglRenderer: null,
      headless: true,
      quality: 'medium',
      refreshCapHz: 0,
      capped: false,
      seed: BENCH_SEED,
      slots: 0,
      seenReady: false,
    },
    scenario: {
      targetEnemies: 300,
      targetBullets: 500,
      minObservedEnemies: 0,
      minObservedBullets: 0,
      warmupMs: WARMUP_MS,
      sampleMs: SAMPLE_MS,
      warmupFrames: 0,
      sampleFrames: 0,
    },
    frameTimesMs: { samples: [], mean: 0, p50: 0, p95: 0, p99: 0, max: 0 },
    fps: { mean: 0, p50: 0, p95LowerBound: 0, target },
    determinism: { tickAtStart: 0, tickAtEnd: 0, tickDelta: 0 },
    notes: [`运行失败：${reason}`],
  };
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const notes = [];
  const { chromium, devices } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-gpu-sandbox', '--enable-webgl'],
  });
  notes.push(`Playwright 有头 Chromium ${browser.version()}，WebGL 需实际可用；headless 数据不计达标。`);

  const runs = [];
  try {
    const platforms = PLATFORM === 'both' ? ['desktop', 'mobile'] : [PLATFORM];
    for (let p = 0; p < platforms.length; p++) {
      const platform = platforms[p];
      for (let i = 0; i < RUNS; i++) {
        const report = await runOnce(browser, platform, i, notes, devices);
        runs.push(report);
        console.log(
          `[${platform} ${i + 1}/${RUNS}] pass=${report.pass} mean=${report.fps.mean.toFixed(2)} ` +
            `p95=${report.frameTimesMs.p95.toFixed(2)}ms samples=${report.scenario.sampleFrames}`,
        );
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const median = {
    desktop: { mean: 0, p50: 0, p95LowerBound: 0, target: 50 },
    mobile: { mean: 0, p50: 0, p95LowerBound: 0, target: 45 },
  };
  const platforms = PLATFORM === 'both' ? ['desktop', 'mobile'] : [PLATFORM];
  for (let p = 0; p < platforms.length; p++) {
    const platform = platforms[p];
    const group = runs.filter((run) => run.platform === platform && run.scenario.sampleFrames >= MIN_SAMPLE_FRAMES);
    median[platform] = {
      mean: medianOf(group.map((run) => run.fps.mean)),
      p50: medianOf(group.map((run) => run.fps.p50)),
      p95LowerBound: medianOf(group.map((run) => run.fps.p95LowerBound)),
      target: TARGETS[platform],
    };
  }
  const allPass =
    runs.length > 0 &&
    runs.every((run) => run.pass) &&
    platforms.every((platform) => median[platform].mean >= TARGETS[platform]);

  if (!allPass) {
    notes.push('未达标诊断：');
    notes.push('- 若 headless=true：当前无 GPU/WebGL，数字无效；需在带 GPU 的桌面会话复跑。');
    notes.push('- 若 capped=true：显示刷新率不足，改用高刷新率显示器；这不代表逻辑失败，但 mean 仍须达标。');
    notes.push('- 若 minObserved 不足：检查 topUp 是否被日志/回收打断，严禁下调 300/500 目标。');
    notes.push('- 若 mean 偏低但数量达标：瓶颈在渲染（Pixi 绘制槽、DOM HUD 更新、粒子批处理），');
    notes.push('  建议按渲染层优化：合并同 texture 精灵批次、降低 HUD DOM 写入频率、对远距离实体只绘制不更新属性，');
    notes.push('  严禁通过减少实体数、缩短采样或放宽帧时间裁剪来「达标」。');
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runs,
    median,
    allPass,
    notes,
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`报告已写入 ${OUT_PATH}`);
  console.log(
    `中位数 desktop mean=${median.desktop.mean.toFixed(2)} (目标 ${median.desktop.target}) / ` +
      `mobile mean=${median.mobile.mean.toFixed(2)} (目标 ${median.mobile.target}) / allPass=${allPass}`,
  );
  if (!allPass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('FPS 压测失败：', error);
  process.exitCode = 2;
});
