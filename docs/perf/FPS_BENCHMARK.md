# E2 FPS 压测基准说明

> 对应架构：`docs/ARCHITECTURE_INCREMENTAL_2.md` §1.2 / §3.3 / §6.2
> 实测证据：[`fps-report.json`](./fps-report.json)（`schemaVersion: 1`，6 次原始帧时间样本全部入库）
> 结论：桌面与移动模拟 **各 3 次全部达标**，`allPass = true`。

## 1. 复跑方式

前置条件：先启动 dev server（不要关闭），本机 `http://127.0.0.1:5173/` 返回 200。

```bash
# 桌面 + 移动，各 3 次，写正式报告（推荐）
node scripts/fps-bench.mjs --platform=both --runs=3 --out=docs/perf/fps-report.json

# E3 落地后等价命令
npm run bench:fps -- --platform=both --runs=3 --out=docs/perf/fps-report.json

# 单组调试（约 16 秒）
node scripts/fps-bench.mjs --platform=desktop --base-url=http://127.0.0.1:5173/
node scripts/fps-bench.mjs --platform=mobile  --runs=1 --out=/tmp/fps-mobile.json
```

依赖：Playwright 1.65.1 + Chromium。本机 `playwright` 未在项目中解析，脚本自动回退到
`file:///C:/Users/liujian/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`。
浏览器以 **有头模式** 启动（`headless: false`）；若渲染器降级为 headless，该次 `validForTarget=false`，不计达标。

并行开发期间，脚本在压测页屏蔽 Vite HMR 的 `full-reload`/`update` 消息，避免他人保存源码打断 10s 采样窗口；
dev server 与其它页面不受影响。首次加载始终使用最新代码，报告只记录本次实际加载的模块图。

## 2. 压力场景与只读探针

- `src/registration/benchmark.ts` 由 `main.ts` 的 `import.meta.glob('./registration/*.ts', { eager: true })` 自动侧载。
  `register()` 第一行判定 `?bench=1`，正常访问立即返回，**零副作用**。
- 场景沿用与正常战斗完全相同的一套系统链：调用 `startBattle('campaign_8min', 'liubei')` 后用
  `spawnCombatEntity()` / `fireProjectile()` 补足 **300 敌 / 500 弹幕**；无敌 + 超长寿命 + 确定性网格分布，
  每帧补位，采样期实体数恒定。不改 `CAP=4096`、`MAX_PROJECTILES=512`、波次表或刷怪率。
- `roomSeed = 0x9e3779b9`，输入序列为空（确定性）；`?q=0/1/2` 只设置渲染档位，不进入 `SimState`。
- `window.__WS_BENCH__.getSnapshot()` 只读，返回新对象：
  `{ sceneReady, enemies, bullets, tick, quality, headless, slots, seenReady }`。无写接口，防作弊。
- 场景代码不含 `Date.now` / `performance.now` / `Math.random`，也不 import `bitecs`；
  `hardConstraints.test.ts` 静态审查全绿。

## 3. 指标口径

| 指标 | 定义 |
| --- | --- |
| 帧时间 | 相邻两帧 `requestAnimationFrame(timestamp)` 之差（ms），原样入库、不裁剪 |
| 预热 | 3000ms **且** ≥180 帧，取较晚到达者；预热帧不计入样本 |
| 采样 | 10000ms；有效样本需 ≥300 帧，否则该次无效 |
| `frameTimesMs` | `samples` / `mean` / `p50` / `p95` / `p99` / `max` |
| `fps.mean` | `sampleFrames * 1000 / (lastTs - firstTs)` |
| `fps.p50` | `1000 / frameMs.p50` |
| `fps.p95LowerBound` | `1000 / frameMs.p95`，保守下界 |
| `refreshCapHz` | 预热阶段最小帧间隔估算；`capped = refreshCapHz < target + 10` |
| 达标 | `!headless && !capped && minObservedEnemies>=300 && minObservedBullets>=500 && tickDelta>0 && 有效样本>=300 && fps.mean>=target` |

目标：桌面 `50`，移动 `45`。桌面与移动各 3 次，取 `fps.mean` 中位数作为组结论。
未达标时脚本如实写报告并以退出码 1 结束，`notes` 写明瓶颈与优化建议；**严禁削减实体或伪造数据**。

## 4. 实测环境

| 项 | 值 |
| --- | --- |
| 浏览器 | Playwright 有头 Chromium `159.0.8154.6` |
| GPU / WebGL | `ANGLE (Intel, Intel(R) Graphics (0x00007DD1) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| `headless` | `false`（6 次全部为真实 GPU 渲染） |
| 桌面 | viewport `1280×720`，DSF `1`，quality `medium` |
| 移动 | Pixel 7 模拟 `412×839` DSF `2.625`（Android 14 UA）；iPhone 13 模拟 `390×664` DSF `3`（iOS UA） |
| seed | `2654435769`（`0x9e3779b9`） |
| 刷新率 | `refreshCapHz = 60`，`capped = false` |

## 5. 实测结果

| # | 平台 | viewport / DSF | mean fps | p50 fps | p95 帧时 | p95 下界 fps | 样本 | 敌/弹幕 | tickΔ | 绘制槽 | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | desktop | 1280×720 / 1 | 58.94 | 58.82 | 17.20ms | 58.14 | 590 | 300/500 | 785 | 800 | ✅ |
| 2 | desktop | 1280×720 / 1 | 58.93 | 58.82 | 17.20ms | 58.14 | 590 | 300/500 | 785 | 800 | ✅ |
| 3 | desktop | 1280×720 / 1 | 58.98 | 58.82 | 17.20ms | 58.14 | 590 | 300/500 | 784 | 800 | ✅ |
| 4 | mobile | Pixel 7 / 2.625 | 58.94 | 58.82 | 17.20ms | 58.14 | 590 | 300/500 | 784 | 509 | ✅ |
| 5 | mobile | iPhone 13 / 3 | 58.98 | 58.82 | 17.20ms | 58.14 | 590 | 300/500 | 785 | 509 | ✅ |
| 6 | mobile | Pixel 7 / 2.625 | 58.92 | 58.82 | 17.20ms | 58.14 | 590 | 300/500 | 784 | 509 | ✅ |

**中位数**：desktop `mean = 58.94`（目标 50，余量 +8.94）；mobile `mean = 58.94`（目标 45，余量 +13.94）。
`allPass = true`。精确浮点值见 `fps-report.json` 的 `median` 与 `runs[*].fps`。

## 6. 瓶颈观察与优化建议（当前已达标，留作回归基线）

- **60Hz 刷新率上限**：`mean ≈ 58.94`、`p95 帧时 17.20ms`，已贴近 60Hz 显示器理论上限；
  `p95LowerBound ≈ 58.14`。若要验证 >60fps，需高刷新率显示器，否则 `capped` 判定会拦截结论。
- **绘制槽差异**：桌面 `slots=800`，移动 `slots=509`。移动视口更小，视锥裁剪掉更多实体，负载反而略低；
  这说明当前瓶颈不在实体数量，而在显示刷新率。
- **GPU 为 Intel 集显（D3D11）**：300 敌 + 500 弹幕下 GPU 仍有余量。若未来实体规模继续扩大，
  优先优化渲染层而非削减实体：①同 texture 精灵合批减少 draw call；②降低 HUD DOM 写入频率；
  ③对远距离/视锥外实体只保留逻辑、不分配绘制槽；④视需要把粒子特效降级到低档位。
- **环境真实性风险**：`headless=true` 或 WebGL 不可用时数字一律无效；真机数据（尤其低端 Android）
  需由 QA 补充，模拟器数据不能替代真机结论。
- **HMR 干扰**：并行保存源码会触发 full-reload，导致 `Execution context was destroyed`；
  脚本已在压测页屏蔽 HMR 消息，复跑时无需人工协调他人暂停编辑。

## 7. 与冻结契约的一致性

- 报告顶层：`{ schemaVersion:1, runs, median:{desktop,mobile}, allPass }`；
  单次含 `environment` / `scenario` / `frameTimesMs` / `fps` / `determinism` / `notes`。
- `schemaVersion=1`，`minObservedEnemies=300`、`minObservedBullets=500`、`headless=false` 全部满足 §6.2。
- `tickDelta ∈ [784, 785] > 0`，证明逻辑仍走同一套系统链，bench 场景未替换系统实现。
- 正常访问（不带 `?bench=1`）无副作用：`npm test` 122 项全绿（含 `hardConstraints` 静态审查）、
  `npm run typecheck` 0 错、`npm run build` 成功。
