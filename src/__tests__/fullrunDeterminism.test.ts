/**
 * 《无双》整局可玩性 · node 整局确定性测试（M02–M08 / M10 / M14）。
 *
 * 唯一依据：docs/ARCHITECTURE_FULLRUN.md §0.1 spike 基线 / §6 测试矩阵 / §7.1 冻结参数 / §13 共享约定。
 * 本地复现：
 *   npm ci
 *   npx vitest run src/__tests__/fullrunDeterminism.test.ts
 * CI：.github/workflows/fullrun-e2e.yml 的 node-fullrun job（另在 deploy-pages.yml 显式跑一次）。
 *
 * 约束：vitest globals:true —— 只用全局 describe/it/expect，禁止 import ... from 'vitest'。
 * 所有失败 message 携带采样 JSON，便于 CI 日志定位。
 */
import { runFullRun, type FullRunResult, type FullRunSample } from './helpers/fullrunRunner';

/** §7.1 冻结基线（spike 两次独立复跑逐字段一致）。 */
const BASELINE = {
  result: 1,
  tick: 28210,
  elapsed: 470.166667,
  kills: 573,
  level: 8,
  score: 6530,
  bossSpawned: 1,
  waveIndex: 5,
  dropped: 0,
} as const;

/** §0.1 事件计数基线（tally key 由 eventName 统一映射）。 */
const EVENT_BASELINE: Readonly<Record<string, number>> = {
  Damage: 1370,
  Kill: 573,
  Pickup: 572,
  LevelUp: 9,
  BossWarn: 14,
  BossPhase: 2,
  Victory: 1,
};

const MAX_TICKS = 28980; // 480*60 + 180 缓冲
const DRAIN_EVERY_TICKS = 60;

/** 诊断载荷：终态 + 事件计数 + 异常 + 采样序列摘要。 */
function diagnostics(result: FullRunResult, samples: readonly FullRunSample[]): string {
  return JSON.stringify({
    sample: result.sample,
    events: result.events,
    thrown: result.thrown,
    sampleCount: samples.length,
    first: samples[0] ?? null,
    last: samples[samples.length - 1] ?? null,
  });
}

describe('整局确定性（node 直驱 scheduler，28800 tick）', () => {
  it(
    '两次独立复跑逐字段一致且命中 §0.1 冻结基线（M02/M03/M04/M05/M06/M07/M08/M10/M14）',
    () => {
      // M14：同一 it 内两次独立复跑；runner 内部 resetScheduler，复用同一进程也互不污染。
      const samplesA: FullRunSample[] = [];
      const a = runFullRun({
        maxTicks: MAX_TICKS,
        drainEveryTicks: DRAIN_EVERY_TICKS,
        onSample: (s) => samplesA.push({ ...s }),
      });
      const samplesB: FullRunSample[] = [];
      const b = runFullRun({
        maxTicks: MAX_TICKS,
        drainEveryTicks: DRAIN_EVERY_TICKS,
        onSample: (s) => samplesB.push({ ...s }),
      });

      const diagA = diagnostics(a, samplesA);
      const diagB = diagnostics(b, samplesB);
      expect(a.thrown, `首局不应抛异常：${diagA}`).toBeNull();
      expect(b.thrown, `复跑不应抛异常：${diagB}`).toBeNull();

      // M14：两次复跑逐字段一致。
      expect(a.sample, `两次复跑终态应逐字段一致：A=${diagA} B=${diagB}`).toEqual(b.sample);
      expect(a.events, `两次复跑事件计数应逐字段一致：A=${diagA} B=${diagB}`).toEqual(b.events);

      const s = a.sample;
      const events = a.events;

      // M02：时间时钟推进且终态精确。
      expect(s.tick, `终局 tick 应为 ${BASELINE.tick}：${diagA}`).toBe(BASELINE.tick);
      expect(s.elapsed, `终局 elapsed 应≈${BASELINE.elapsed}s：${diagA}`).toBeCloseTo(
        BASELINE.elapsed,
        5,
      );
      expect(samplesA.length, `应采样多个里程碑点：${diagA}`).toBeGreaterThan(1);
      for (let i = 1; i < samplesA.length; i++) {
        expect(
          samplesA[i].elapsed,
          `elapsed 应单调不减（第 ${i} 个采样）：${diagA}`,
        ).toBeGreaterThanOrEqual(samplesA[i - 1].elapsed);
      }

      // M03：波次推进到 5。
      expect(s.waveIndex, `waveIndex 应达 ${BASELINE.waveIndex}：${diagA}`).toBe(BASELINE.waveIndex);

      // M04：击杀链有效（历史 DEFECT）。
      expect(s.kills, `kills 应为 ${BASELINE.kills}：${diagA}`).toBe(BASELINE.kills);
      expect(events.Kill ?? 0, `Kill 事件应为 ${EVENT_BASELINE.Kill}：${diagA}`).toBe(
        EVENT_BASELINE.Kill,
      );

      // M05：成长链（拾取/升级/积分）有效且无二次计分。
      expect(events.Pickup ?? 0, `Pickup 事件应为 ${EVENT_BASELINE.Pickup}：${diagA}`).toBe(
        EVENT_BASELINE.Pickup,
      );
      expect(events.LevelUp ?? 0, `LevelUp 事件应为 ${EVENT_BASELINE.LevelUp}：${diagA}`).toBe(
        EVENT_BASELINE.LevelUp,
      );
      expect(s.level, `level 应为 ${BASELINE.level}：${diagA}`).toBe(BASELINE.level);
      expect(s.score, `score 应为 ${BASELINE.score}：${diagA}`).toBe(BASELINE.score);
      expect(s.score, `score 应等于 kills*10+level*100：${diagA}`).toBe(
        s.kills * 10 + s.level * 100,
      );

      // M06：BOSS 登场。
      expect(s.bossSpawned, `bossSpawned 应为 ${BASELINE.bossSpawned}：${diagA}`).toBe(
        BASELINE.bossSpawned,
      );
      expect(events.BossWarn ?? 0, `BossWarn 事件应为 ${EVENT_BASELINE.BossWarn}：${diagA}`).toBe(
        EVENT_BASELINE.BossWarn,
      );

      // M07：BOSS 阶段事件与胜利结算。
      expect(events.BossPhase ?? 0, `BossPhase 事件应为 ${EVENT_BASELINE.BossPhase}：${diagA}`).toBe(
        EVENT_BASELINE.BossPhase,
      );
      expect(events.Victory ?? 0, `Victory 事件应为 ${EVENT_BASELINE.Victory}：${diagA}`).toBe(
        EVENT_BASELINE.Victory,
      );

      // M08：整局正常结算（node 固定起点 → Victory）。
      expect(s.result, `result 应为 ${BASELINE.result}（Victory）：${diagA}`).toBe(BASELINE.result);
      expect(events.Damage ?? 0, `Damage 事件应为 ${EVENT_BASELINE.Damage}：${diagA}`).toBe(
        EVENT_BASELINE.Damage,
      );

      // M10：事件总线零丢失，且逐项精确匹配 spike 基线。
      expect(s.dropped, `droppedCount 应为 0：${diagA}`).toBe(BASELINE.dropped);
      for (const name of Object.keys(EVENT_BASELINE)) {
        expect(events[name] ?? 0, `${name} 事件计数应为 ${EVENT_BASELINE[name]}：${diagA}`).toBe(
          EVENT_BASELINE[name],
        );
      }
    },
    180_000,
  );
});
