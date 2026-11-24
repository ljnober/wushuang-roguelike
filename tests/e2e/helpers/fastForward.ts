/**
 * 整局快进 E2E · 合成时间分段推进 helper。
 *
 * 设计依据：ARCHITECTURE_FULLRUN.md §3.2 / §4.2 / §7.2 / §13。
 * 时间口径：每步 window.__fullRunTime += stepMs(1000) 后调用 app.frameStep(t)，
 * App.frameStep 内部换算 rawDt=1s → scheduler 60 tick；每次 evaluate 最多 maxStepsPerCall(150) 步，
 * 避免单次 480000ms 同步阻塞 30s+ 造成浏览器无响应（spike §0.3 修正项）。
 * 零产品后门：只在浏览器侧驱动已冻结的 App 实例，不改任何产品源码。
 */
import type { Page } from '@playwright/test';

export interface FastForwardOptions {
  stepMs?: number;
  maxStepsPerCall?: number;
  timeoutMs?: number;
}

export interface FastForwardSample {
  wallMs: number;
  steps: number;
  elapsed: number;
  result: number;
  kills: number;
  level: number;
  score: number;
  bossSpawned: number;
  tick: number;
}

/** 浏览器内单次 evaluate 返回的步级快照（不含 wallMs，由 Node 侧汇总）。 */
interface ChunkSample {
  steps: number;
  elapsed: number;
  result: number;
  kills: number;
  level: number;
  score: number;
  bossSpawned: number;
  tick: number;
}

const DEFAULT_STEP_MS = 1000;
const DEFAULT_MAX_STEPS_PER_CALL = 150;
const DEFAULT_TIMEOUT_MS = 120000;

/** 快进到 session.elapsed >= targetElapsedSec，或整局结算（result != 0）为止。 */
export async function fastForwardTo(
  page: Page,
  targetElapsedSec: number,
  opts: FastForwardOptions = {},
): Promise<FastForwardSample> {
  const stepMs = opts.stepMs ?? DEFAULT_STEP_MS;
  const maxStepsPerCall = opts.maxStepsPerCall ?? DEFAULT_MAX_STEPS_PER_CALL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startWall = Date.now();
  let totalSteps = 0;
  let last: ChunkSample = {
    steps: 0,
    elapsed: 0,
    result: 0,
    kills: 0,
    level: 1,
    score: 0,
    bossSpawned: 0,
    tick: 0,
  };

  while (Date.now() - startWall < timeoutMs) {
    const chunk = await page.evaluate(
      (arg) => {
        const w = window as unknown as {
          __fullRunApp?: {
            tick: number;
            frameStep(t: number): void;
            lastTime: number;
            state: { session: Record<string, number> };
          };
          __fullRunTime?: number;
        };
        const app = w.__fullRunApp;
        if (app === undefined) {
          throw new Error('__fullRunApp 未就绪，无法快进（请先 hookApp + freezeApp）');
        }
        const read = (): ChunkSample => ({
          steps: 0,
          elapsed: app.state.session.elapsed,
          result: app.state.session.result,
          kills: app.state.session.kills,
          level: app.state.session.level,
          score: app.state.session.score,
          bossSpawned: app.state.session.bossSpawned,
          tick: app.tick,
        });
        let sample = read();
        let steps = 0;
        while (steps < arg.max && sample.elapsed < arg.target && sample.result === 0) {
          w.__fullRunTime = (w.__fullRunTime ?? app.lastTime) + arg.stepMs;
          app.frameStep(w.__fullRunTime);
          sample = read();
          steps++;
        }
        sample.steps = steps;
        return sample;
      },
      { target: targetElapsedSec, stepMs, max: maxStepsPerCall },
    );

    totalSteps += chunk.steps;
    last = chunk;
    // 达标 / 结算 / 无法再推进（0 步）三种情况都结束本段。
    if (chunk.elapsed >= targetElapsedSec || chunk.result !== 0 || chunk.steps === 0) {
      break;
    }
  }

  // 终局事件由 HUDSystem 以 100ms 墙钟节流 drain；步进在 result 翻转的那一 tick 立即停下，
  // 该帧的 Victory/Defeat 可能仍滞留在总线里。等待一个节流周期后补一帧（rawDt=0，不推进 tick），
  // 让渲染系统把终局事件送进 HUD → 结算场景切换。这是唯一的测试侧稳定化，不改产品代码。
  if (last.result !== 0) {
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const w = window as unknown as {
        __fullRunApp?: { frameStep(t: number): void; lastTime: number };
        __fullRunTime?: number;
      };
      const app = w.__fullRunApp;
      if (app !== undefined) app.frameStep(w.__fullRunTime ?? app.lastTime);
    });
  }

  return {
    wallMs: Date.now() - startWall,
    steps: totalSteps,
    elapsed: last.elapsed,
    result: last.result,
    kills: last.kills,
    level: last.level,
    score: last.score,
    bossSpawned: last.bossSpawned,
    tick: last.tick,
  };
}

/** 按冻结里程碑顺序逐段快进，每段返回一份采样（里程碑之间 session 连续推进）。 */
export async function fastForwardThrough(
  page: Page,
  milestones: readonly number[],
  opts: FastForwardOptions = {},
): Promise<FastForwardSample[]> {
  const samples: FastForwardSample[] = [];
  for (const milestone of milestones) {
    samples.push(await fastForwardTo(page, milestone, opts));
  }
  return samples;
}
