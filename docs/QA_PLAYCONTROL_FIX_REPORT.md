# 《无双》玩家操控失效 / 多英雄闪烁 BugFix — 独立回归验证报告

> 验证人：严过关（Yan）· QA 工程师
> 验证方式：全新视角独立验证，不采信工程师自查报告；未修改任何实现代码、任何既有测试，未执行 git commit。
> **最终结论：PASS — 三个用户报告症状全部实测消除；O-1（方向键未绑定移动）已修复并针对性复验通过。可交付。阻断问题数：0。**
> 关键：本轮以**真实浏览器手工操控**为主验（前几轮自动化测试从未覆盖键盘按住场景，正是本次漏检根因）。
> 更新：第十节为 O-1 方向键修复的针对性复验（新任务，不计入 2 轮全量限制）。

---

## 一、验证结论摘要

| 维度 | 结果 |
| --- | --- |
| **真实浏览器手工操控（默认 auto）** | **PASS** — 玩家实体 1；按住 D 700ms 位移 **+151.8px**、moveX 恒为 1、逐 tick 平滑；技能/闪避位 1/2/4/8 全部命中；0 报错 |
| **真实浏览器手工操控（手动 manual）** | **PASS** — 玩家实体 1；无操作 500ms 完全静止（xRange=0）；按住 D 700ms 位移 **+154px**；松键立即停住（Δx=0） |
| **方向键 O-1 修复复验（第十节）** | **PASS** — 四方向键在 auto/manual 下 Δ≈±139~147px、符号正确、逐 tick 单调、scrollY=0、实体数 1；混按/技能/repeat/无关键回归点全通过 |
| 症状① 无法操控 | **已修复**（原：只走 1 tick≈3.6px → 现：WASD 与方向键按住均持续移动 139–154px） |
| 症状② 多个英雄 | **已修复**（原：PlayerTag=3 → 现：=1，auto/manual 均验证） |
| 症状③ 闪烁自动移动 | **已修复**（截图确认仅 1 英雄 + 敌人；manual 无操作完全静止） |
| 单元测试 `npm test -- --run` | **162 / 162 全绿**（16 文件零跳过；含 fullrunDeterminism 86.8s 逐字段一致） |
| `npm run typecheck` | **零错误**（exit 0） |
| E2E legacy（E2E_BASE_URL，产物隔离 /tmp） | **7 / 7 全绿**（56.5s） |
| E2E fullrun（E2E_BASE_URL，产物隔离 /tmp） | **2 / 2 全绿**（53.5s） |
| 静态契约 / §6.2 grep / 冻结 diff | **全部合规** |
| 阻断问题 / 建议观察项 | **0 / 3（均非阻断；原 O-1 已修复并入第十节）** |

---

## 二、主验：真实浏览器手工操控（用户核心场景）

### 2.1 验证方法（零产品后门）

- `npx vite --host 127.0.0.1 --port 5173 --strictPort` 启动 dev server。
- Playwright 真实 Chromium（1280×720），走完整用户旅程：**Boot → Menu → 开始征战 → 选第一位武将 → 出征 → Battle**，全程**不修改任何设置**（默认存档 `controlMode:'auto'`）。
- 通过动态 import 页面已加载的 `App.ts` / `adapter.ts` / `components.ts`，patch `App.prototype.frameStep` 捕获运行实例（`window.__qaApp`），逐帧读取 ECS SoA 真值：`query(world,[PlayerTag])`、`Position.x`、`InputCmd.moveX/buttons/seq`。仅测试侧 prototype patch，**不改产品源码**。
- 键盘事件经真实 `page.keyboard.down/up('d')` 走 `TouchControls.onKeyDown → CommandBus → LocalHumanSource.poll → InputCmd` 全链路。

### 2.2 默认 auto 模式实测数据

| 指标 | 修复前（推断/原实现） | 修复后实测 | 判定 |
| --- | --- | --- | --- |
| 玩家实体数 `PlayerTag` | 3（1 真人 + 2 AI 影子） | **1**（playerId=0，controlKind=0） | ✅ 症状②消除 |
| 进入战斗无操作 500ms | 多个 AI 影子乱走 | AI 代管移动（x 9.03→−0.67，xRange 9.821）——**符合 auto 辅助代管设计** | ✅ 预期 |
| **按住 D 700ms 位移 Δx** | 仅 1 tick ≈3.6px（只按当帧生效） | **+151.806px**（x 3.001→154.807） | ✅ 症状①消除 |
| 按住期间 moveX | 瞬时 1 后归 0 | **恒为 1**（44 帧采样） | ✅ 锁存生效 |
| 移动平滑性 | — | tick 99→139 每 5 tick 位移 ~18.33px 匀速单调右移（3→21→39→58→76→94→113→131→149） | ✅ 无跳变、无 AI 乱走 |
| 技能 1/2/3 + 闪避 buttons | auto 下 AI 覆盖真人键 | 逐帧观测位集 **{0,1,2,4,8}**：1=技1、2=技2、4=技3、8=闪避全部命中 | ✅ 真人输入优先 |
| 松开所有键 | — | AI 重新代管（moveX 恢复 ±0.1~0.9）——**按当前设计属预期，不计 Bug** | ✅ 符合设计 |
| 连续观察 3 秒 | — | 新增 console/page error **0**；running=1，elapsed=7.05s | ✅ 稳定 |

截图：`/tmp/qa-playcontrol/01-auto-battle-entry.png`、`02-auto-after-hold-D.png`、`03-auto-after-skills.png`、`04-auto-observe-end.png`。
其中 `04`（7 秒后）目视确认：**画面中心仅 1 个玩家武将**，周围为敌人（不同模型），另有子弹特效；**无同款英雄重叠、无闪烁残影**；HUD 击杀 4 / 积分 140 / HP 120 正常。

### 2.3 手动 manual 模式实测数据（设置页切「手动」后重进战斗）

| 指标 | 实测 | 判定 |
| --- | --- | --- |
| 设置页「操作模式」选「手动」 | `button.chip.is-active` 文本 = **手动** | ✅ 切换生效 |
| 玩家实体数 | **1** | ✅ |
| 无操作 500ms | xStart=xEnd=0，**xRange=0**，moveX 恒 0 —— **完全静止，无 AI 代管** | ✅ 症状③消除（manual 语义） |
| **按住 D 700ms 位移 Δx** | **+154px**（3.667→157.667），moveX 恒 1，逐 tick ~18.33px 匀速 | ✅ 输入即时生效 |
| 松开 D 后 600ms | **Δx=0**，moveX 恒 0，x 停在 157.667 —— **立即停住，无幽灵移动** | ✅ 手动语义正确 |
| 技能 1/2/3 + 闪避 buttons | 位集 {0,1,2,4,8} 全命中 | ✅ |
| 连续观察 3 秒 | 新增错误 0；HUD/存档正常 | ✅ |

截图：`05-manual-setting.png`、`06-manual-after-hold-D.png`、`07-manual-after-release.png`（按钮区显示「手动」）。

---

## 三、潜在回归点主动核查（工程师可能自证不足处）

### 3.1 auto 确定性（fullrunDeterminism）— 通过

- `npm test -- --run` 中 `src/__tests__/fullrunDeterminism.test.ts` 单项 **86802ms 通过**，断言"两次独立复跑逐字段一致且命中 §0.1 冻结基线（M02/M03/M04/M05/M06/M07/M08/M10/M14）"。
- 原理核验：`LocalHumanSource.poll` 在无真人命令时 `latchedMoveX/Y=0`、`humanAim/buttons=0`，进入 auto 分支后 `autoSource.poll(tick,out)` 的输出**逐字段不覆盖**（三个 `if` 均不成立），`out.seq` 仍按 `max(maxSeq,latchedSeq)=0`。故整局 auto 输入流与旧实现一致，冻结基线不受影响。**独立确认成立。**

### 3.2 decodeAxis 边界 — 无缺陷（1 项低优先观察）

浏览器内直接驱动 `LocalHumanSource.poll`（`decodeAxis` 为模块私有，经 Move 命令间接测）：

| 输入 a（写入 Int32 后） | 解码 moveX | 说明 |
| --- | --- | --- |
| 1000 / −1000 | 1 / −1 | UI 摇杆放大 1000 倍，正确归一 |
| 500 / −500 / 999 | 0.5 / −0.5 / 0.999 | 线性正确 |
| 1 / −1 | 1 / −1 | 已是归一值，原样保留 |
| 2 / −2 / 1001 | 0.002 / −0.002 / 1.001 | 无除零；值略超 1 |
| Int32 极值 ±2147483647 | ±2147483.647 | **有限但超出 [-1,1]**（未 clamp） |
| NaN / Infinity / −Infinity | 0 / 0 / 0 | `Number.isFinite` 守卫生效，无 NaN 传播 |

- **无除零、无无限循环、无越界写**；极端值虽超范围但 `MovementSystem` 在 `len>1` 时归一化（mx/len），实际速度被压到 1×移速，不产生穿墙/超高速。UI 侧 `Math.round(x*1000)` 且 x∈[-1,1]（见 `TouchControls.emitKeyboardMove` 归一化、`presentation.ts:222`），实际不可能注入极值。
- **观察 O-2（非阻断）**：`decodeAxis`（`LocalHumanSource.ts:20-24`）只除以 1000 不 clamp 到 [-1,1]。建议后续可选加 `Math.max(-1,Math.min(1,...))` 提升鲁棒性。

### 3.3 命令锁存清理 — 通过（无幽灵移动）

| 场景 | 操作 | 结果 | 判定 |
| --- | --- | --- | --- |
| 切换武将 / 重开战斗 | 按住 D 不松手（moveX=1, x=97.63）时直接 `startBattle(mode,generalId,0)` | 新世界玩家 **1 个**，x=0，**moveX=0**（新 `LocalHumanSource` 实例锁存归零）；补发 keyup 后仍 0 | ✅ 无残留 |
| 暂停 / 恢复 | 按住 D（moveX=1, x=69.67）→ `running=0` → 暂停中松键（Move(0,0) 入总线）→ `running=1` | 恢复后 x 保持 69.67，**moveX=0** | ✅ 无残留 |
| 组件重建 | `createBattleState` → `clearComponentData()` 全组件 fill(0)，`InputCmd` 归零 | 见重开结果 | ✅ |

> 说明：UI 侧无 `CommandType.Pause` 实际绑定（grep 零命中），暂停场景按会话层 `running` 标志直接驱动，覆盖等价路径。

### 3.4 多人 / 联机路径 — 未受影响

- `makeRemoteSource`（`IControlSource.ts:227-229`）与 `RemoteInputSource` 本轮**零改动**；net 目录测试 `loopback.test.ts` 15 项、`snapshotContract.test.ts` 11 项全绿。
- `startBattle` 新增可选第三参后：真实单机入口 `presentation.ts:330` 与 `scenes/index.ts:487` 显式传 0；`benchmark.ts:206` 及 `src/__tests__/battleSessionFlow.test.ts` 等旧调用**省略第三参**，仍走默认 `DEFAULT_SHADOW_COUNT=2`（`systems.ts:73,119,331-332`）。`battleSessionFlow` 4 项、`determinism` 11 项、`hardConstraints` 19 项全绿，证明"省略=2 影子"语义未变。
- 存档 `multiplayer.shadowCount:2`（`SaveData.ts:150`）为独立联机配置，未被本修复触碰。

### 3.5 UI 显示一致性 — 观察项（非 FAIL）

默认存档 `controlMode:'auto'` 未改（E2E 冻结"默认自动"断言），UI「自动」按钮仍高亮；但 auto 语义已由"纯 AI 托管"变为"**无人操作时 AI 代管、真人一有输入立即接管**"。实测 auto 下按住 D 时真人确实接管（moveX=1 覆盖 AI），行为正确；但按钮文案仍为「自动」，用户可能不知道"我现在按方向键就能接管"。
- **观察 O-3（非阻断，按任务要求记录）**：建议在设置页「自动」旁加「（可随时手动接管）」提示，或在教程/HUD 提示。仅体验优化，不影响功能正确性，不判 FAIL。

---

## 四、全量回归（独立重跑，不采信工程师报告）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `npm test -- --run` | **16 文件 / 162 测试全绿**，零 skipped/todo；耗时 87.93s；fullrunDeterminism 单项 86802ms 通过 |
| 类型检查 | `npm run typecheck` | exit 0，零错误 |
| E2E legacy | `E2E_BASE_URL=http://127.0.0.1:5173/ npx playwright test --project=legacy --reporter=line --output=/tmp/ws-playcontrol-legacy` | **7 passed (56.5s)**，QA-1~QA-5 全过（含 QA-2 手动模式技能/闪避、QA-3 重开闭环） |
| E2E fullrun | `E2E_BASE_URL=http://127.0.0.1:5173/ npx playwright test --project=fullrun --reporter=line --output=/tmp/ws-playcontrol-fullrun` | **2 passed (53.5s)**（六里程碑 + 结算契约/重开闭环） |
| 静态 §6.2 grep | `grep Math.random(/Date.now(/performance.now(/from bitecs` 于 src/ui、src/art、src/game | 命中仅 5 处，全在既有白名单：`HUD.ts:131,199`、`SaveSystem.ts:122,138`、`scenes/index.ts:303,307`；新增/改动控制文件零命中 |
| 冻结文件 diff | `git diff --name-only -- src/data src/__tests__ tests/e2e` | **空** — 配置表 / 测试 / 数据零改动 |
| 修改范围 | `git diff --name-only` | 本轮修复相关 5 文件：`LocalHumanSource.ts`、`IControlSource.ts`、`systems.ts`、`presentation.ts`、`scenes/index.ts`（其余为上一轮 UI 重构既有未提交改动，非本轮） |

- E2E 全程带 `E2E_BASE_URL`，产物隔离到 `C:/tmp`（Windows Node 下 `/tmp` 映射到 `C:/tmp`），未污染工作区。
- 环境问题：无。dev server 单次启动，legacy/fullrun 串行执行，无端口争用。

---

## 五、发现的问题与分级

### 🔴 阻断问题：无（0 项）

三个用户报告症状均以真实浏览器实测证据消除，全量回归全绿，无 P0/P1 缺陷。

### 🟡 观察项（3 项，均非阻断，不判 FAIL）

- **~~O-1 方向键（←→↑↓）未绑定移动~~ → 已修复并复验通过**：主理人采纳该观察项作为用户"根本无法操控"诉求的延续，工程师仅改 `TouchControls.ts` 新增 `normalizeKey()`。**针对性复验结论 PASS，详见第十节**：四方向键在 auto/manual 下位移 Δ≈±139~147px、符号正确、单调持续、scrollY=0、实体数恒 1，混按/技能/repeat/无关键回归点全通过。该项不再作为观察项。
- **O-2 decodeAxis 未 clamp**：见 §3.2，极端 Int32 值解码后超 [-1,1]，但下游归一化兜底、UI 不可能产生，低优先鲁棒性建议。
- **O-3 auto 文案语义**：见 §3.5，「自动」实际为"辅助代管"，建议加提示。
- **O-4 `playerCount`/`nextNetId` 用原始 shadowCount**：`systems.ts:142,146` 用未 clamp 的 `shadowCount` 计算（`1+shadowCount`），而 `spawnLocalPlayers` 用 clamp 后值；仅当传入越界负数/超 3 时两者不一致，真实入口只传 0 或默认 2，不影响。低优先一致性建议。

---

## 六、交付判定

**PASS — 可以交付。**

核心证据链完整：真实浏览器默认 auto 与手动 manual 两条路径均证明"玩家实体=1、按住 WASD **及方向键**持续平滑移动、技能闪避按键正确写入、松键行为符合模式语义、无重复英雄无闪烁无报错"；`decodeAxis` 解码正确且守卫完备；锁存在重开/暂停/切将路径均正确清零；auto 整局确定性与"省略第三参=2 影子"基线未被破坏；162/162 单测、typecheck 0、legacy 7/7、fullrun 2/2、静态契约全绿；冻结文件零改动。O-1 方向键修复已针对性复验通过（第十节）。

- **阻断问题数：0**
- **手工操控是否真实可用：是**（auto 与 manual 均实测按住 D 持续移动 151–154px；方向键四向 Δ≈±139~147px）
- **玩家实体数：1**（auto/manual/WASD/方向键全程均为 1，非 3）
- **全量通过率：单测 162/162 + typecheck 0 错误 + E2E 9/9（legacy 7 + fullrun 2）**
- **非阻断观察项：3**（O-2/O-3/O-4；原 O-1 已修复关闭）
- 边界：本轮全程未改实现代码、未改任何既有测试、未 git commit；临时验证脚本（`.qa-probe.mjs`/`.qa-playcontrol-verify.mjs`/`.qa-edge-verify.mjs`/`.qa-arrow-verify.mjs`/`.qa-arrow-clean.mjs`）已删除；截图与原始采样数据隔离于 `C:/tmp/qa-playcontrol/` 与 `C:/tmp/qa-arrow-verify/`。

---

## 十、O-1 方向键修复 — 针对性复验（新任务，主理人指派）

> 触发：主理人采纳 O-1 为用户"根本无法操控"诉求的延续，工程师仅改 `src/ui/TouchControls.ts`（`normalizeKey()` + `onKeyDown`/`onKeyUp` 归一化与 `preventDefault`）。本节为独立针对性复验，不采信工程师自测，不重复整局 2 轮全量。

### 10.1 修复内容核验（逐项查源码，未盲信）

- `normalizeKey(key)`（`TouchControls.ts:251-257`）：`arrowleft→a`、`arrowright→d`、`arrowup→w`、`arrowdown→s`，其余原样；入参为 `event.key.toLowerCase()`，大小写兼容。✅
- `onKeyDown`（L259-276）：`event.repeat` 早退仍在最前（L260）；`raw=key.toLowerCase()` → `key=normalizeKey(raw)`；`key!==raw`（即方向键）才 `preventDefault()`；随后沿用既有 `keys.add(key)` → `emitKeyboardMove()` → `k`/`1`/`2`/`3`/空格逻辑，一行未改。✅
- `onKeyUp`（L278-284）：同样归一化 + `preventDefault`，`keys.delete(key)` 后对 a/d/w/s 发 Move(0)。✅
- 改动范围：`git diff --numstat -- src/ui/TouchControls.ts` = `28 + / 3 -`；DOM 结构、className、pointer 逻辑、44px 命中区、`touch-action:none` 均未触及；`git diff --name-only -- src/data src/__tests__ tests/e2e` 为空（冻结文件零改动）。✅

### 10.2 四方向键实测（真实 Chromium，逐帧 ECS SoA 真值，默认设置 + 手动模式）

沿用主验方法：动态 import `App.ts`/`adapter.ts`/`components.ts` patch `frameStep` 捕获实例，逐帧读 `query(world,[PlayerTag])` + `Position.x/y` + `InputCmd.moveX/Y`。各方向键按住 **650ms**。

**默认 auto（不改设置）：**

| 方向键 | 位移 Δ | 首→末坐标 | moveX/Y 符号 | 单调持续 | 反向/零步 | 采样帧 | 实体数 | scrollY |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ArrowRight | **+143.000px** | 11.73→154.73 | moveX=+1, moveY=0 | ✅ | 0 | 40 | 1 | 0 |
| ArrowLeft | **−143.000px** | 143.42→0.42 | moveX=−1, moveY=0 | ✅ | 0 | 40 | 1 | 0 |
| ArrowUp | **−142.932px** | −23.45→−166.38 | moveY=−1 | ✅ | 0 | 40 | 1 | 0 |
| ArrowDown | **+146.667px** | −183.77→−37.10 | moveY=+1 | ✅ | 0 | 41 | 1 | 0 |

**手动 manual（设置页切「手动」后重进战斗）：**

| 方向键 | 位移 Δ | 首→末坐标 | moveX/Y 符号 | 单调持续 | 反向/零步 | 采样帧 | 实体数 | scrollY |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ArrowRight | **+139.334px** | 7.33→146.67 | moveX=+1, moveY=0 | ✅ | 0 | 40 | 1 | 0 |
| ArrowLeft | **−139.333px** | 143.00→3.67 | moveX=−1, moveY=0 | ✅ | 0 | 39 | 1 | 0 |
| ArrowUp | **−143.000px** | −3.67→−146.67 | moveY=−1 | ✅ | 0 | 40 | 1 | 0 |
| ArrowDown | **+143.000px** | −143.00→0 | moveY=+1 | ✅ | 0 | 40 | 1 | 0 |

- 四方向幅度均 ≈220px/s × 0.65s（139~147px），与 D 键基线一致；**逐 tick 单调、零反向步**，证明"按住持续移动"而非只走 1 tick。
- **preventDefault 生效**：浏览器内后置监听器实测四方向键 keydown 与 keyup 的 `defaultPrevented === true`（8/8），两模式 `scrollY` 全程 `[0,0]`。
- **松键行为**：manual 下松键 500ms `moveX=moveY=0`、Δx=Δy=0（立即停住）；auto 下松键后 AI 恢复代管（moveX ±0.1~0.4、moveY ≈−0.9）——**按设计预期，不计 Bug**。
- 截图：`C:/tmp/qa-arrow-verify/auto-arrow-battle.png`、`manual-arrow-battle.png`。

### 10.3 回归点核查（工程师可能自证不足处）

| 回归点 | 实测结果 | 判定 |
| --- | --- | --- |
| **WASD 与方向键混按（按住 D 再按 ArrowLeft）** | D 按住 moveX=1/x=62.33 → ArrowLeft 归一化 'a' 后 moveX=0、x 不变（抵消）→ 松 ArrowLeft 恢复 moveX=1、x 62.33→132 → 松 D moveX=0 停住。**无 NaN、无锁死，符合直觉** | ✅ |
| **同向重复键（按住 ArrowRight 再按 D，松开 D 时 ArrowRight 仍按住）** | 松 D 后 moveX=0、停住。因 `keys` 为归一化后的 Set，同向两物理键共享 'd'，松开任一即清零——**非阻断边界观察 O-5**（见下） | ✅ 无 NaN/锁死 |
| **方向键按住时技能 1/2/3 + 空格闪避** | buttons 逐帧位集 {0,1,2,4,8}，技1/技2/技3/闪避全命中；ArrowDown 期间 moveY 恒 1，移动不中断 | ✅ 互不干扰 |
| **`k` 切自动（方向键仍按住）** | 切 auto 后 moveY 仍为 1（真人输入优先覆盖 AI），实体数 1 | ✅ 符合辅助代管设计 |
| **`event.repeat` 早退** | 纯净 manual 下合成 25 个 `repeat:true` 的 ArrowRight：moveX/moveY 恒 0、Δx=0、25/25 事件 `prevented=false`（证明早退发生在 preventDefault 之前）；随后真实单次 ArrowRight 仍正常生效（moveX=1，Δy 方向正确） | ✅ 早退仍在最前 |
| **`normalizeKey` 无关键原样返回** | 纯净 manual 下合成 `Arrow`/`Shift`/`Unidentified`/`Process`/`Control`/`Meta` 的 keydown+keyup：moveX/moveY 恒 0、Δx=0、全有限值、实体数 1；之后真实 ArrowUp 仍生效（moveY=−1，Δy=−91.7）——key 集合未被污染 | ✅ 不误伤 |
| **FC-4 DOM/触控契约** | `.touch-controls`×1、`.joystick.touch-control`×1、`.skill-button.touch-control`×4、`.touch-control__auto`×1；全部 `.touch-control` 计算样式 `touch-action:none`；命中区 132×132（摇杆）、60×60（技能）、51×60（自动）均 ≥44px | ✅ 类名/结构/命中区不变 |
| **控制台错误** | 两场景 + 补充复测全程 pageerror / console.error = **0** | ✅ |

> 说明：首轮回归脚本中 repeat/无关键两项曾受同脚本前置 `k` 切换（auto 代管）干扰，读数混入 AI 移动；已另起**纯净 manual 会话重测**（`C:/tmp/qa-arrow-verify/clean-results.json`），结论以重测为准，未伪造数据。

### 10.4 本轮快检

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `npm test -- --run` | **162 / 162 全绿**（16 文件零跳过；fullrunDeterminism 单项 88039ms 仍逐字段一致） |
| 类型检查 | `npm run typecheck` | exit 0，零错误 |
| 改动范围 | `git status` / `git diff --name-only` | 本轮仅 `src/ui/TouchControls.ts`（28+/3−）叠加在上一轮已验证的 5 文件 BugFix 之上；冻结文件（src/data、测试、e2e）零改动 |
| E2E 整局 | — | 本轮未重跑（任务明确免除；改动仅键盘归一化，不触及 DOM/渲染/会话/确定性内核，且上一轮 9/9 已验证） |

### 10.5 新增观察项（非阻断）

- **O-5 同向重复键释放语义**：方向键与同名 WASD 同时按住时，因归一化到同一 `keys` 集合元素，松开其中一个会清除整个方向（即使另一个物理键仍按住）。属 `Set<归一化键>` 方案的固有边界，方向正确、无 NaN、无锁死，重新按下即恢复；不影响"用方向键或 WASD 都能操控单一英雄"的核心诉求。若追求严格多物理键语义，可改为按原始 `event.code` 去重后归一化（独立小改，非本次阻断项）。

### 10.6 本节判定

**PASS — O-1 已修复并针对性复验通过，阻断问题数 0。** 用户用方向键（←→↑↓）或 WASD 均能真正操控单一英雄：四方向位移 ±139~147px、符号正确、逐 tick 单调持续、松键行为符合模式语义、scrollY=0、实体数恒 1；混按、技能/闪避/k 切换、`event.repeat` 早退、无关键、FC-4 触控契约全部通过；162/162 单测与 typecheck 0 错误。报告总体结论维持 PASS。
