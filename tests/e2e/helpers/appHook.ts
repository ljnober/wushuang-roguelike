/**
 * 整局快进 E2E · App 实例捕获 / 冻结 helper。
 *
 * 设计依据：ARCHITECTURE_FULLRUN.md §3.2 / §4.2 / §13。
 * 手法复用已验证的 QA-5：动态 import 页面已加载的 /src/app/App.ts，
 * patch App.prototype.frameStep 捕获运行中实例到 window.__fullRunApp，然后 app.stop() 冻结 RAF。
 * 注入变量名冻结为 __fullRunApp / __fullRunTime，不复用 QA-5 的 __qaApp。
 * 零产品后门：只改测试侧 prototype，不改任何产品源码。
 */
import type { Page } from '@playwright/test';

/** 运行中被 hook 的 App 运行时视图（TS private 仅编译期，lastTime 运行时可读）。 */
export interface HookedApp {
  stop(): void;
  frameStep(t: number): void;
  tick: number;
  lastTime: number;
  state: { session: Record<string, number> };
}

export interface AppHookResult {
  ok: boolean;
  appUrl?: string;
  urls?: string[];
}

export interface FrozenState {
  lastTime: number;
  tick: number;
  result: number;
}

interface FullRunWindow {
  __fullRunApp?: HookedApp;
  __fullRunTime?: number;
}

/**
 * 找到 dev server 已加载的 App.ts ESM URL，patch 原型捕获实例。
 * 必须在进入战斗后调用：此时 RAF 正在跑，下一次 frameStep 即可捕获 this。
 */
export async function hookApp(page: Page): Promise<AppHookResult> {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((r) => r.name);
    const appUrl = urls.find((u) => /\/src\/app\/App\.ts/.test(u));
    if (appUrl === undefined) {
      return { ok: false, urls: urls.slice(0, 20) };
    }
    const mod = (await import(/* @vite-ignore */ appUrl)) as {
      App: { prototype: { frameStep: (this: unknown, t: number) => void } };
    };
    const original = mod.App.prototype.frameStep;
    if (typeof original !== 'function') {
      return { ok: false, appUrl, urls: urls.slice(0, 20) };
    }
    mod.App.prototype.frameStep = function (this: unknown, t: number): void {
      (window as unknown as { __fullRunApp?: unknown }).__fullRunApp = this;
      original.call(this, t);
    };
    return { ok: true, appUrl };
  });
}

/** 轮询等待下一次 RAF frameStep 捕获到实例（默认 5s）。 */
export async function waitForApp(page: Page, timeoutMs: number = 5000): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as FullRunWindow).__fullRunApp !== undefined,
    undefined,
    { timeout: timeoutMs, polling: 50 },
  );
}

/**
 * 冻结 App：记录 lastTime 为合成时间起点，初始化 __fullRunTime，然后 stop() 取消 RAF。
 * 之后所有推进只能通过 fastForward 显式调用 frameStep。
 */
export async function freezeApp(page: Page): Promise<FrozenState> {
  return page.evaluate(() => {
    const w = window as unknown as FullRunWindow;
    const app = w.__fullRunApp;
    if (app === undefined) {
      throw new Error('__fullRunApp 未就绪，无法冻结');
    }
    const frozen: FrozenState = {
      lastTime: app.lastTime,
      tick: app.tick,
      result: app.state.session.result,
    };
    w.__fullRunTime = app.lastTime;
    app.stop();
    return frozen;
  });
}

/**
 * 读取 window.__fullRunApp 的只读快照。
 * 说明：App 实例本身不可跨 page.evaluate 序列化，因此返回会话/时钟字段快照；
 * stop()/frameStep() 以 page.evaluate 异步委托实现（调用方无需等待返回值）。
 * 需要同步推进时请用 fastForward 系列，它在浏览器内直接调用 app.frameStep。
 */
export async function getApp(page: Page): Promise<HookedApp> {
  const snap = await page.evaluate(() => {
    const app = (window as unknown as FullRunWindow).__fullRunApp;
    if (app === undefined) {
      throw new Error('__fullRunApp 未就绪');
    }
    return {
      tick: app.tick,
      lastTime: app.lastTime,
      session: { ...app.state.session } as Record<string, number>,
    };
  });
  return {
    tick: snap.tick,
    lastTime: snap.lastTime,
    state: { session: snap.session },
    stop: () => {
      void page.evaluate(() => {
        const app = (window as unknown as FullRunWindow).__fullRunApp;
        if (app !== undefined) app.stop();
      });
    },
    frameStep: (t: number) => {
      void page.evaluate((time) => {
        const app = (window as unknown as FullRunWindow).__fullRunApp;
        if (app !== undefined) app.frameStep(time);
      }, t);
    },
  };
}
