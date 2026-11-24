# 《无双》UI 增量重构 — 独立集成回归验证报告（T04 / S6）

> 验证人：严过关（Yan）· QA 工程师
> 验证方式：全新视角独立验证，不采信实现者自查报告；不改动任何实现代码、测试文件，不执行 git commit。
> **最终结论（B-1 修复后第 3 次复验）：PASS — 全部阻断缺陷已消除，可以交付。**（前两轮曾为 FAIL，唯一阻断项 B-1 已经 T01 修复并经独立实测确认，详见第九节。）

---

## 一、验证结论摘要

| 维度 | 结果 |
| --- | --- |
| 单元测试 | **162 / 162 全绿**（16 个测试文件，零跳过） |
| TypeScript 类型检查 | **零错误**（`tsc --noEmit`，exit 0） |
| 生产构建 | **成功**（827 模块，仅有既有 PixiJS chunk >500kB 警告） |
| E2E legacy | 首轮 **7 / 7 全绿**；第 2 轮 **6 / 7**（QA-3 单项遇既有初始化时序 flaky，单独复跑通过，非本轮回归） |
| E2E fullrun | **2 / 2 全绿**（fullrun + fullrunResult，两轮均通过） |
| E2E 合计 | **4 个 spec**：fullrun 2/2 + legacy（首轮 7/7、第 2 轮 6/7，QA-3 flaky） |
| 静态契约审查 | **全部通过**（FC-5 / A-3 / A-12 / A-13 / 裸色值） |
| FC-3 选择器对照 | **全部一致** |
| 关键行为验证 | 主题闭环、配装写回闭环、13 槽数据、拖拽取消路径 **通过** |
| **纸娃娃槽位无重叠（A-7 / US-01-5）** | **PASS — B-1 修复后两视口实测重叠 0 对**（详见第九节；原为 7 对） |
| B-1 修复后回归（第 3 次复验） | 单测 162/162、typecheck 0、legacy 7/7、静态红线全过 |

---

## 二、测试矩阵结果

### 2.1 单元测试 `npm test -- --run`

```
Test Files  16 passed (16)
Tests       162 passed (162)
Duration    80.83s
```

16 个测试文件全部通过，无 skipped / todo。其中：
- `mobileTouch.test.ts` 7 项通过 → FC-4 源码文本断言（style.css / presentation.ts）保持。
- `hardConstraints.test.ts` 19 项通过 → FC-5 四条静态审查红线保持。
- `saveContract.test.ts` 7 项通过 → FC-2 存档结构兼容保持。
- `theme.test.ts` 14 项通过 → A-6 旧档/非法值回退 classic（L128–141）。
- `equipmentIcon.test.ts` 19 项通过 → A-14 同一 (slot,rarity) 连续 3 次 data URL 逐字节相同（L45–71），含清空缓存后一致性。
- `contentIntegrity.test.ts` 12 项通过 → FC-1 配置表数值未改。
- `fullrunDeterminism.test.ts` 1 项通过（耗时 79.9s）→ 确定性冻结基线命中。

> 说明：`fullrunDeterminism` 单项耗时约占单测总时长 99%，属既有测试特性，非本轮回归。

### 2.2 类型检查与构建

- `npm run typecheck`：exit 0，零错误。
- `npm run build`：exit 0，`✓ built in 863ms`。仅有 Vite 对 564.63 kB 主 chunk 的体积提示（PixiJS 依赖导致，既有现象）。

### 2.3 E2E

| 命令 | 结果 |
| --- | --- |
| `E2E_BASE_URL=http://127.0.0.1:5173/ npx playwright test --project=legacy --reporter=line` | **7 passed (1.2m)** |
| `E2E_BASE_URL=http://127.0.0.1:5173/ npx playwright test --project=fullrun --reporter=line` | **2 passed (55.3s)** |

覆盖：Boot→Menu→Select→Battle→HUD tick→存档；移动端触控 ≥44px / `touch-action:none`；QA-1~QA-5 战斗回归；整局快进六里程碑；结算文案/无二次计分/重开闭环。

**环境问题及处置**：首次运行 legacy e2e 时 Playwright 尝试清理 `test-results/`（含 2418 个历史产物），被沙箱 `safe-delete` 批量删除保护拦截。改用 `--output=C:/Project/WS/.pw-out-legacy`（及 `.pw-out-fullrun`）独立输出目录后正常运行，非代码缺陷。

---

## 三、静态契约审查结果（独立执行，未采信工程师报告）

| # | 审查项 | 命令/方法 | 结果 |
| --- | --- | --- | --- |
| 1 | FC-5 禁用调用 | Grep `Math.random(\|Date.now(\|performance.now(\|from ['"]bitecs['"]` 于 `src/ui` `src/ui/theme` `src/art` `src/game` | **合规**。命中仅 5 处，全部位于 FC-5.2 白名单文件：`src/ui/HUD.ts:131,199`、`src/game/SaveSystem.ts:122,138`、`src/game/scenes/index.ts:303,307`。新增 UI 文件（PaperDoll / ItemPreview / DragEquipController / ThemePicker / EquipmentIconFactory）零命中。 |
| 2 | EXTRA_CSS 移除 | Grep `EXTRA_CSS\|TOUCH_SAFE_AREA_CSS` presentation.ts | **合规**。仅命中 `TOUCH_SAFE_AREA_CSS`（L45 定义、L167 注入），`EXTRA_CSS` **零命中**；L41–44 带明确注释说明其为 `mobileTouch.test.ts` 文本契约。 |
| 3 | 配装写回闭环 | Grep `\.onChange\s*=` src | **合规**。`src/registration/presentation.ts:149` 存在 `equipment.onChange = ...`。 |
| 4 | 裸色值 | Grep `#[0-9a-fA-F]{3,8}` 于 `src/ui/styles/*.css` | **合规**。命中全部落在令牌文件 `tokens.css` / `themes.css`（含 T02 追加的主题卡预览色板）。新增 `equipment.css` 及 T03 写权的 `hud/cards/touch/meta/base/index.css` **零裸色命中**。 |
| 5 | 冻结文件零改动 | `git diff --name-only -- src/ecs src/data src/game/SaveSystem.ts src/__tests__ tests/e2e ...` | **合规**，输出为空。`src/style.css` 的 97 行删除属 S1 CSS 拆分基线，FC-4 断言仍通过。 |
| 6 | 13 槽集合一致性 | Grep `SLOT_DEFS` / `EQUIPMENT_SLOT_IDS` / `DOLL_SLOT_ANCHORS` | **合规**。三方均 13 项、值完全相同、无重复无缺失：`head shoulders chest bracers gloves belt legs boots amulet ring1 ring2 mainHand offHand`。 |

**新增测试文件说明**：`src/art/__tests__/equipmentIcon.test.ts` 与 `src/ui/theme/__tests__/theme.test.ts` 为本次新增（非冻结清单内的既有测试），不属于"修改既有测试"，合规。

---

## 四、关键行为验证结论

### 4.1 主题闭环 — 通过

- **启动 apply 落点**：`presentation.ts:85–86` 创建全工程唯一 `ThemeManager` 单例并 `theme.apply(save.meta.settings.theme)`，位于 UI 创建（L138–142）与 `registerScenes`（L423）之前，满足"首帧即存档主题"。
- **设置页复用同一组件**：`scenes/index.ts:354` `const pickerRoot = this.deps.themePicker.render()`，主题区插在「画质」（L367）之前；L357–366 通过 `theme.subscribe` 同步 `is-active` / `aria-checked`；`onExit`（L437–441）退订，无泄漏。
- **配装页快捷入口**：`EquipmentUI.ts:227–240` `attachThemePicker` 创建 `.doll-theme-toggle`「换肤」按钮，click → `picker.openAsPopover(toggle)`；`presentation.ts:156–161` 按冻结接口结构化调用注入。
- **写回与错误条**：`presentation.ts:105–113` `onSelect` → `theme.apply(id)` → `save.meta.settings.theme = resolved` → `saveSystem.save(save)`，失败时用 `saveSystem.lastError` 走 `showThemeSaveError`（L91–100，4s 自动隐藏，`role="alert"`）。
- **组件实现**：`ThemePicker.ts` 单一根节点两用（浮层打开移入、关闭归位 L112–149），4 张 `button[data-theme-id]` + `role=radio` + `aria-checked`（L177–212），方向键、Esc、外部点击关闭、焦点归还齐备；`position()`（L252–275）做视口边界翻转。
- **旧档回退**：`SaveData.ts` 新增 `theme?: ThemeId` 可选字段 + `createDefaultSave()` 写 `classic`；`theme.test.ts` 覆盖 `undefined` / `null` / 非法值 / 大小写不符 → `classic`。

### 4.2 配装写回闭环 — 通过

- `scenes/index.ts:172` `equipment.open(save, save.meta.selectedGeneral)`。
- `EquipmentUI.ts:202–214` `equip()`：先清其它槽对同一 uid 的引用（唯一性）→ 写 loadout → `onChange(save)` → `render()`；`unequip()` L216–224 同构。
- `presentation.ts:149–154` `onChange` 唯一出口调用 `saveSystem.save(updated)`，失败共用错误条。
- **拖拽取消零副作用**：`DragEquipController.ts` 中 `onEquip` 仅在 L181（落点兼容槽）调用一次；`pointercancel` / `detach` / 非槽位落点走 `cleanup`（L277–295，`clearTimeout` + 清视觉），**不触发 `onEquip`、零 `onChange`**。长按用 `setTimeout`（L130），未读墙钟。

### 4.3 纸娃娃 13 槽 — 数据通过 / 布局失败

- 13 槽 id 在 `SLOT_DEFS`（13 项）、`EQUIPMENT_SLOT_IDS`（13 项）、`DOLL_SLOT_ANCHORS`（13 项）三方一致，无重复无缺失。
- 脏 `defId` 容错：`EquipmentUI.ts:362–378` `known` 判定后显示「未知装备（defId）」灰色占位 + `aria-label`，不抛异常。
- **但实测存在热区重叠，详见第六节阻断缺陷。**

### 4.4 FC-3 选择器逐字对照 — 全部一致

| 契约项 | 源码位置 | 结论 |
| --- | --- | --- |
| `.scene--boot/menu/select/result/settings` | `scenes/index.ts:101` `overlay scene scene--${this.id}` | 一致（动态拼接） |
| `.boot-title` 文本"无双" / `.boot-enter` | `scenes/index.ts:129,131` | 一致 |
| `.menu-title` 文本"无双" / `.menu-panel button.primary`"开始征战" | `scenes/index.ts:159,160,166` | 一致 |
| `.select-panel button.primary` | `scenes/index.ts:203,259`（"出征"） | 一致 |
| `.general-grid .general-card`(≥40) / `.general-name` / `.general-portrait` data URL | `scenes/index.ts:234,239,242–244`（`img.src = portraits.dataUrlFor(def)`，e2e 校验 `data:image/svg+xml`） | 一致 |
| `.hint` 含"已选：" | `scenes/index.ts:258` | 一致 |
| `.hud[data-hud="battle"]` / `.hud__value` 前缀 | `HUD.ts:84,85,79`（`击杀 N` / `积分 N` / `Lv.N`）、HP `123 / 456`（L71）、时间 `01:23`（L83） | 一致；hudProbe 正则实测解析通过 |
| `.hud__bar-fill--exp` style.width 百分比 | `HUD.ts:77`；e2e 采样 `0%→36.8%` | 一致 |
| `.touch-controls` / `.joystick.touch-control` / 精确字符串 `.skill-button touch-control` / `[data-skill]`×3 / `.touch-control__auto` / `.joystick__knob` | `TouchControls.ts:53,58,67,77,84` | 一致（e2e 逐字数组断言通过） |
| `.card` / `.card-grid` / `.card__name/__desc/__level/__tags` / `.overlay.ws-levelup` | `CardsAndLevelUp.ts:70,80,124,129,132,135,138` | 一致 |
| `.result-panel` / `.result-lines`（积分/击杀/等级/时长） | `scenes/index.ts:314,319,320` | **语义一致**：e2e 实测 `积分 110 · 击杀 1 · 等级 1 · 时长 3s`，hudProbe 正则 `/时长\s*(\d+)\s*s/` 可解析（见建议项 S-1） |
| `.settings-panel .setting-row` / `.setting-label` / `.chip` / `.is-active` / button.primary"返回主菜单" | `scenes/index.ts:347,352,353,373,362,430` | 一致 |

---

## 五、A-1 ~ A-14 验收清单勾选

| 项 | 结论 | 依据 |
| --- | --- | --- |
| A-1 | ✅ 通过 | build 成功；appFlow + fullrun e2e 走通全流程；诊断脚本 `pageErrors: []` |
| A-2 | ✅ 通过 | 162/162 单测 + 4 spec / 9 项 e2e 全绿，无新增失败、零跳过 |
| A-3 | ✅ 通过 | `EXTRA_CSS` 零命中；`TOUCH_SAFE_AREA_CSS` 带注释保留；mobileTouch 7 项通过 |
| A-4 | ✅ 通过 | FC-1~FC-5 对照见第三、四节 |
| A-5 | ⚠️ 需人工 | 代码路径与 theme.test.ts 覆盖；四主题 × 六场景的全组合视觉比对未自动化 |
| A-6 | ✅ 通过 | `resolveTheme(undefined/null/非法值)` → `classic`（theme.test.ts L128–141），存档其余字段不动 |
| A-7 | ❌ **失败** | 1280×720 与 390×844 均实测 **7 对槽位热区重叠**，详见第六节 |
| A-8 | ⚠️ 需人工 | `ItemPreview.ts:169–185` 有视口边界翻转实现；未做四角截图逐角验证 |
| A-9 | ⚠️ 需人工（代码路径通过） | `equip()` 唯一性 + 单一 `onEquip` 出口 + 取消零 `onChange` 已静态确认；未做真实拖放 e2e |
| A-10 | ⚠️ 部分通过 | 触控控件 ≥44px 由 e2e 实测通过；配装槽位实测 44×44；主题卡/浮层按钮未全量抽检 |
| A-11 | ⚠️ 需人工 | 无自动化覆盖纯键盘换装四步流程 |
| A-12 | ✅ 通过 | `git diff` 冻结目录输出为空 |
| A-13 | ✅ 通过 | 静态审查 6 项全合规，新增 UI 文件零违规 |
| A-14 | ✅ 通过 | 19 项图标测试覆盖连续 3 次与清缓存后逐字节一致 |

---

## 六、发现的问题与分级

### 🔴 阻断（1 项）— 必须修复后复验

#### B-1 纸娃娃 13 槽热区在两种视口下均存在 7 对重叠

- **验收锚点**：A-7、US-01-5（"槽位不重叠、不溢出容器"）、T01 完成判据（"1280×720 与 390×844 目视槽位无重叠"）。
- **严重性**：P0 核心功能。重叠区域内点击/拖拽落点会命中错误槽位（后渲染的 DOM 节点压盖先渲染者），且视觉边框互相覆盖。
- **根因**：`.paper-doll` 为 `width:320px` + `aspect-ratio:3/4`（高 427px，equipment.css L44–53），槽位 44×44px（L95–98）。冻结锚点中同一 x=50% 列有 9 个槽，纵向跨度仅 ~350px，9×44=396px > 350px，数学上必然重叠。现有 L153–156 仅对 `bracers` / `mainHand` / `offHand` 做了 margin 补偿，未覆盖其余冲突对。
- **实测数据**（Playwright 读取 `getBoundingClientRect()`，两视口结果相同）：

| 重叠槽位对 | 重叠宽(px) | 重叠高(px) |
| --- | --- | --- |
| head ↔ amulet | 44 | 1 |
| shoulders ↔ chest | 44 | 10 |
| shoulders ↔ amulet | 44 | 14 |
| bracers ↔ ring1 | 31 | 5 |
| gloves ↔ belt | 44 | 18 |
| ring1 ↔ offHand | 25 | 7 |
| ring2 ↔ mainHand | 25 | 7 |

- **可复现步骤**：
  1. `cd C:/Project/WS && npx vite --host 127.0.0.1 --port 5173 --strictPort`
  2. 浏览器打开 `http://127.0.0.1:5173/`，等待进入 Menu，点「装备」
  3. 对 `.doll-slot[data-slot]` 逐个取 `getBoundingClientRect()`，两两计算矩形交集
  4. 视口分别设 1280×720 与 390×844，均得到上表 7 对重叠
- **责任归属**：T01（`src/ui/styles/equipment.css:153–156`），`software-engineer-t01`。
- **修复建议（不越权，仅供主理人路由参考）**：
  - 沿用已有先例继续在 `equipment.css` 用 `margin-*` 补偿剩余冲突槽（如 `amulet`/`chest`/`belt`/`ring1`/`ring2`），**保持 `DOLL_SLOT_ANCHORS` 冻结百分比坐标不变**；
  - 或适度增大 `.paper-doll` 的 `aspect-ratio` 高度（如 3/5）拉开纵向间距，需评估三栏布局影响；
  - **禁止**通过把槽位缩到 <44px 规避（FC-4 冻结）；
  - 修复后须重跑上述矩形交集测量，确认零重叠，再复验 A-7 / US-01-5。

### 🟡 建议（3 项）— 不阻断交付

- **S-1 文案字面偏差（非本轮回归）**：`scenes/index.ts:320` 结算文案为 `时长 ${elapsed}s`（如 `时长 3s`），PRD FC-3 文字描述为"时长 123 s"（数字与 s 间有空格）。经 `git diff` 确认该行本轮未改，且 hudProbe 正则 `/时长\s*(\d+)\s*s/` 兼容，实际 e2e 通过。建议统一文档描述或文案，避免歧义。
- **S-2 文档写权标注冲突**：`src/main.ts` 本轮新增 `import './ui/styles/index.css'`（L8–10）。PRD §6.2.2 明确允许 `index.css` 由 `presentation.ts` 或 `main.ts` 引入一次，但 ARCH §2.4 将 `main.ts` 标为"只读"。功能正确且必要，建议架构师回写 ARCH 标注以免后续误判越权。
- **S-3 测试产物污染**：仓库根存在未跟踪的 `test-results/`（2418 个 Playwright 产物）及本次生成的 `.pw-out-legacy/` / `.pw-out-fullrun/`；前者曾触发沙箱批量删除保护。建议加入 `.gitignore` 并清理；下次 e2e 可继续使用 `--output` 隔离目录。

### ⚪ 需人工确认（4 项）

A-5（四主题全场景视觉比对）、A-8（浮层四角截图）、A-9（真实拖拽落点）、A-11（纯键盘换装流程）。这些项代码路径与单测/e2e 均有佐证，但自动化未直接覆盖最终交互效果。

---

## 七、交付判定

**FAIL。** 全部自动化测试与静态契约审查通过，证明主题、配装写回、选择器冻结、确定性等基线质量良好；但 A-7「纸娃娃 13 槽无重叠」在两种目标视口下均有可复现的实测失败，属于 P0 核心交互缺陷。建议主理人将 B-1 路由给 T01 工程师修复，修复后仅需复跑槽位矩形测量 + legacy/fullrun e2e + 单测即可复验；其余部分可安全交付。

> 本报告验证过程未修改任何实现代码或既有测试，未执行 git commit。

---

## 八、第 2 轮复验（T02 修复后，按当前工作树重跑）

> 触发：T02 在首轮验证后完成一处修复；主理人要求按最新工作树重新全量验证、不依赖先前行号。本轮为 2 轮上限的最后一轮。

### 8.1 当前工作树确认

- `presentation.ts`：`import type { QualityLevel, SaveData, ThemeId }`（L14）含 `SaveData`；`equipment.onChange = (updated: SaveData) => {...}` 位于 **L149–154**（L148 为注释行）；错误条前缀已由「保存主题失败：」泛化为「**存档失败：**」（L93），仍逐字拼接 `saveSystem.lastError`（L109/L151 取 message）；`createThemeErrorBar`（L427–436）用 `role="alert"`。经核查无测试断言该前缀，不构成 FC-3/FC-4 违规。
- `git status` 冻结文件清单首轮一致：`src/ecs/**`、`src/data/**`、`SaveSystem.ts`、`src/__tests__/**`、`tests/e2e/**` 仍零改动。

### 8.2 复测结果矩阵

| 项目 | 第 2 轮结果 | 说明 |
| --- | --- | --- |
| `npm test -- --run` | **162 / 162 全绿**（exit 0，16 文件零跳过） | 与首轮一致 |
| `npm run typecheck` | **零错误**（exit 0） | 与首轮一致 |
| `npm run build` | **成功**（exit 0，691ms） | 与首轮一致，仅既有 chunk 体积提示 |
| `E2E fullrun`（2 spec） | **2 / 2 全绿** | 与首轮一致 |
| `E2E legacy`（5 spec 项） | **6 / 7，QA-3 单项失败**（详见 8.3） | 首轮 7/7；本轮出现 1 次时序 flaky |
| 静态审查（FC-5 / EXTRA_CSS / onChange / 裸色 / 冻结 diff） | **全部通过** | 与首轮一致；onChange 落点更新为 L149 |
| 纸娃娃槽位重叠（B-1） | **仍存在，7 对逐项一致** | T02 修复未触及 `equipment.css`，B-1 未修复 |

### 8.3 QA-3 单项失败定性 —— 既有时间敏感 flaky，非本轮回归

- **现象**：第 2 轮完整 legacy 中 `QA-3 重开闭环` 失败，断言 `重开后积分应回到 Lv.1 基线 100`，`Expected 100 / Received 0`；失败采样为 `{"hp":"0 / 1","time":"00:00","kills":0,"score":0}`（正常应为 `hp 120/120 / score 100`）。
- **定性证据**：
  1. `hp="0 / 1"` 是 ECS 战斗世界刚创建、玩家 `Health` 尚未被战斗系统初始化前的中间帧（`safeMax=1` 兜底，HUD.ts L141），属初始化竞态；
  2. 测试用例在 `.hud[data-hud="battle"]` 刚 `toBeVisible()` 后立即 `readHud()`（qaRegression.spec.ts L234–236），未等待首帧初始化完成，本身对时序敏感；
  3. **首轮 7/7 通过、本轮单独重跑 QA-3 通过**（`{"hp":"120 / 120","score":100}`）、本轮 fullrun 重开闭环全绿；
  4. `git diff src/ui/HUD.ts` 显示本轮仅追加 BEM 修饰类与 `role/aria`（`updateFromWorld`/`setHealth`/`reset` 数值逻辑一行未改），T02 修复仅改错误条文案 —— 均无改变积分基线或渲染时序。
- **结论**：判定为既有 e2e 时间敏感 flaky，**非本次 UI 重构引入的回归**，不作为阻断。按 `tests/e2e/**` 冻结契约，QA 不修改该测试；作为建议项记录（S-4：QA-3 在 `readHud()` 前增加首帧初始化等待可消除 flaky，需主理人授权由测试归属方处理）。
- **诚实声明**：本轮 legacy 实测确为 6/7，**不伪造全绿**；QA-3 单独复跑通过，全量复跑受初始化时序影响存在偶发。

> 第 2 轮 e2e 期间曾因两个 e2e 并行争用 5173 端口导致 fullrun 首次启动失败（环境/调度问题），已改为串行单独重跑，fullrun 2/2 通过。

### 8.4 最终判定（基于当前工作树）

**维持 FAIL。** 与首轮结论一致：全部自动化（单测 162/162、fullrun 2/2、typecheck、build、静态审查）通过，T02 的 onChange 写回与错误条文案修复验证无误；但阻断缺陷 **B-1（纸娃娃 13 槽 7 对热区重叠，A-7/US-01-5 失败）在第 2 轮复测中仍逐项存在**，未被本轮任何修复覆盖。QA-3 为既有 flaky，另行记录但不阻断。

- 阻断问题数：**1（B-1）**
- 交付建议：B-1 须由 T01 修复并重测零重叠后方可交付；其余部分已具备交付条件。
- 边界：第 2 轮全程未改实现代码、未改任何既有测试、未 git commit；验证用临时诊断脚本 `.qa-slotcheck.mjs` 已删除。

---

## 九、B-1 修复后针对性复验（第 3 次验证 · 新任务，主理人指派）

> 触发：T01 交付 B-1 修复，仅改 `src/ui/styles/equipment.css`；主理人要求独立复验重叠是否真正消除。本节覆盖该项，为最终判定依据。

### 9.1 修复内容核验（未盲信，逐项查源码）

`equipment.css` 实际改动与本轮验证一致：
- `.paper-doll`（L44–55）：`aspect-ratio:3/4`（320×427）→ `height: calc(var(--ws-doll-size)*2)`（320×640），为同列 9 槽提供 ≥9×44px 纵向空间；宽度仍 `min(100%, 320px)` 自适应。
- `.doll-figure-wrap`（L59–63）与 `.doll-slots`（L87–90）：`inset: calc(var(--ws-hit-min)/2)` = 22px，使 0%/100% 映射到热区内边界，head(top2%)/boots(top84%) 的 44px 热区完整落在容器内。
- 锚点微调（L163–167）：保留 bracers 左移 `slot-size×-1.15`、mainHand/offHand 下移 `--ws-space-4`；新增 amulet 上移 `--ws-space-2`(8px)、belt 上移 `--ws-space-4`(16px)。均用令牌变量，无裸色。
- `DOLL_SLOT_ANCHORS` 13 个百分比坐标经 `PaperDoll.ts` 逐项核对，与架构 §3.2 **完全一致、未改动**；`--ws-hit-min:44px` 原样保留。

### 9.2 B-1 主验结果（dev server + Playwright，13 槽 `getBoundingClientRect()` 两两求交集）

| 指标 | 1280×720 | 390×844 | 判定 |
| --- | --- | --- | --- |
| 槽位数 / 唯一 data-slot | 13 / 13 | 13 / 13 | ✅ |
| `.paper-doll` 尺寸 | 320×640 | 320×640 | ✅ 高度按修复放大 |
| **重叠对数** | **0**（原 7） | **0**（原 7） | ✅ **B-1 消除** |
| 溢出容器槽位数 | 0 | 0 | ✅ |
| 热区 min-width/min-height | 44px / 44px | 44px / 44px | ✅ ≥44px |
| `getComputedStyle` 实测槽位矩形 | 44×44 | 44×44 | ✅ |
| 页面 JS 错误 | 0 | 0 | ✅ |

**原 7 对重叠全部消失**（head↔amulet、shoulders↔chest、shoulders↔amulet、bracers↔ring1、gloves↔belt、ring1↔offHand、ring2↔mainHand 现交集均为 0）。

### 9.3 Tab 顺序专项（注入带仓库装备的存档，真实按 Tab 遍历）

- 方法：浏览器内动态 import `createDefaultSave()` 构造存档，注入 3 件仓库装备（head/mainHand/ring1），reload 后进入配装界面并选中一件使详情按钮出现；焦点重置到文档起点后连续 Tab，按 `className` 归类区域。
- 实测顺序（首次出现步序）：**doll-slot（第 3–15 步，13 个槽全可聚焦）→ inventory-item（第 16 步）→ filter（第 17 步起）→ detail（第 43 步「装备到该槽」）**。
- 结论：完全符合"槽位 → 仓库 → 筛选 → 详情"，13 槽无遗漏、无乱序。✅

### 9.4 关键回归抽验（当前工作树）

| 项目 | 结果 |
| --- | --- |
| `npm test -- --run` | **162 / 162 全绿**（exit 0，16 文件零跳过） |
| `npm run typecheck` | **零错误**（exit 0） |
| `E2E legacy`（`E2E_BASE_URL=http://127.0.0.1:5173/`，output 隔离 `--output=/tmp/ws-b1-legacy`） | **7 / 7 全绿**（QA-3 本轮也通过，进一步印证 S-4 flaky 定性） |
| 架构 §6.2 静态红线 grep（排除白名单 HUD/SaveSystem/index） | **零命中** |
| `EXTRA_CSS` / `TOUCH_SAFE_AREA_CSS` | 无 EXTRA_CSS；TOUCH_SAFE_AREA_CSS 保留（L45/167） |
| 裸色值 grep（equipment/hud/cards/touch/meta/base/index.css） | **无裸色** |
| 冻结目录 git diff（ecs/data/SaveSystem/\_\_tests\_\_/e2e） | **空** |

### 9.5 改动范围核查

- 功能实现改动仅 `src/ui/styles/equipment.css`（B-1 修复）；`DOLL_SLOT_ANCHORS` 与公共 API 零改动；冻结目录零改动。
- 另有 `.gitignore` 被改（新增 `test-results/` 与 `.pw-out-*/` 忽略规则，针对 S-3 建议的回应），非冻结文件、不影响功能，如实记录。

### 9.6 最终判定

**PASS — 可以交付。** 唯一阻断缺陷 B-1 已确认修复：两视口重叠对数由 7 降为 0，13 槽全在容器内、热区 44px、Tab 顺序正确；单测 162/162、typecheck 0、legacy 7/7、静态红线与裸色审查全部通过。S-1~S-4 建议与 A-5/A-8/A-9/A-11 人工确认项保留（均非阻断）。

- 阻断问题数：**0**
- 边界：本节全程未改实现代码、未改任何既有测试、未 git commit；临时验证脚本 `.qa-b1-check.mjs`、`.qa-tab-check.mjs` 已删除；e2e 产物隔离至 `/tmp/ws-b1-legacy`。
