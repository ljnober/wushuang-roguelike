/**
 * 整局快进 E2E · 只读 DOM 探针（HUD / 结算面板）。
 *
 * 设计依据：ARCHITECTURE_FULLRUN.md §3.2 / §6 M11 / §13。
 * 选择器与产品 DOM 一致：.hud__value、.hud__bar-fill--exp、.scene--result /
 * .result-panel / .result-lines（src/ui/HUD.ts、src/game/scenes/index.ts）。
 * 只读：不注入任何状态、不改任何产品源码。
 */
import type { Page } from '@playwright/test';

export interface HudSnapshot {
  hp: string;
  time: string;
  kills: number;
  score: number;
  level: number;
  expWidth: string;
}

export interface ResultPanel {
  visible: boolean;
  text: string;
  score: number;
  kills: number;
  level: number;
  elapsed: number;
}

/** 从真实 DOM 读取 HUD 快照（与 qaRegression.spec.ts 的 readHud 同口径，但抽为共享 helper）。 */
export async function readHud(page: Page): Promise<HudSnapshot> {
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

/** 读取结算面板可见性与文案，并解析积分/击杀/等级/时长（时长单位 s）。 */
export async function readResultPanel(page: Page): Promise<ResultPanel> {
  const visible = await page.locator('.result-panel').isVisible().catch(() => false);
  const data = await page.evaluate(() => {
    const text = document.querySelector('.result-panel .result-lines')?.textContent?.trim() ?? '';
    const num = (pattern: RegExp): number => {
      const matched = pattern.exec(text);
      const parsed = matched === null ? Number.NaN : Number(matched[1]);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      text,
      score: num(/积分\s*(\d+)/),
      kills: num(/击杀\s*(\d+)/),
      level: num(/等级\s*(\d+)/),
      elapsed: num(/时长\s*(\d+)\s*s/),
    };
  });
  return { visible, ...data };
}
