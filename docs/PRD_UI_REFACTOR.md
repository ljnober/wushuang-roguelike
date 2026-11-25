# 《无双》UI 重构增量 PRD

> **文档类型**：增量 PRD（Incremental PRD）——针对既有可运行项目的 UI 层改造，**不重复** `docs/PRD.md` 已定义的产品目标、玩法、数值与 ECS 设计。
> **事实来源**：`C:/Project/WS/DESIGN.md`、`ARCHITECTURE.md`、以及本次实地勘察的 `src/ui/*`、`src/style.css`、`src/registration/presentation.ts`、`src/data/equipment.ts`、`src/game/SaveData.ts`、`tests/e2e/*`。
> **优先级口径**：本文 P0/P1/P2 = 需求优先级（Must / Should / Nice-to-have），与 `DESIGN.md §12` 的实施阶段 P0→P8 是**不同维度**，本文不重排实施阶段。
> **约束前提**：纯前端、无后端、无联网依赖、无位图美术资源（全部程序化生成）。本文中任何需求都**不得**引入后端接口、外部 CDN、付费素材包或需要美术外包的产出。

---

## 0. 项目信息

| 项 | 内容 |
| --- | --- |
| Language | 中文 |
| Programming Language | Vite + TypeScript + PixiJS v8（战场渲染）+ 原生 DOM（UI 层） |
| Project Name | `wushuang_roguelike`（增量分支：`wushuang_ui_refactor`） |
| 原始需求 | ① 装备界面必须有人形槽位（纸娃娃）与装备预览界面；② 所有 UI 重新设计、以用户友好的方式交互；③ 最好支持换肤（主题/皮肤切换） |
| 改造范围 | 仅 UI 层（DOM + CSS + 主题令牌 + 程序化图标生成）。**不动** ECS、战斗数值、存档业务语义、内容配置表 |
| 交付形态 | 静态包；`npm run build` + `vite preview` 无 404、无控制台错误 |

### 0.1 勘察基线（与 team-lead 描述的两处差异，需确认）

| 项 | team-lead 描述 | 实地勘察结果 | 结论 |
| --- | --- | --- | --- |
| `src/ui/` 文件数 | 6 个 | **5 个**：`HUD.ts` / `EquipmentUI.ts` / `MetaUI.ts` / `CardsAndLevelUp.ts` / `TouchControls.ts` | 以 5 个为准；无遗漏文件 |
| `EXTRA_CSS` | presentation.ts 顶部，约 40 行压缩 CSS | 确认存在，`presentation.ts` L42–L96 附近，约 **55 行压缩 CSS** | 以实地为准；坏味道成立 |

---

## 1. 产品目标与非目标

### 1.1 产品目标（3 个正交目标）

1. **配装可读性**：玩家在 3 秒内看清「我穿了什么 / 缺什么 / 换这件会变强还是变弱」，装备界面从「13 个文字按钮」升级为**人形纸娃娃 + 图标化仓库 + 悬停预览浮层**。
2. **UI 一致性与可换肤**：把散落在 `style.css`（278 行）与 `presentation.ts`（`EXTRA_CSS` 压缩串）中的样式收敛为**单一令牌层 + 分文件 CSS**，使「换一套皮肤」= 换一组 CSS 变量，零逻辑改动。
3. **跨端可操作**：桌面鼠标与移动触屏下，配装/预览/换肤三类核心操作均可达、最小命中区 ≥44px、关键路径可纯键盘完成。

### 1.2 非目标（明确不做）

| 编号 | 非目标 | 理由 |
| --- | --- | --- |
| NG-1 | 不改动 ECS / 实体 / 系统 / tick / 战斗数值 | UI 重构是表现层任务，改数值会破坏 `determinism.test.ts` / `hardConstraints.test.ts` |
| NG-2 | 不改装备 / 宝石 / 套装 / 传奇的**数值与配置表** | `contentIntegrity.test.ts` 对配置表有断言；本次只改**呈现** |
| NG-3 | 不做美术资源管线（不引入 PNG/SVG 文件资源、不做资源打包器） | 项目美术为全代码程序化生成（`src/art/*`），图标必须沿用同一路线 |
| NG-4 | 不做 3D 纸娃娃 / 骨骼动画 / 模型导入 | 需外部美术管线与资产，违反 NG-3；本次为**静态人形 + SVG 图标叠加** |
| NG-5 | 不做后端 / 账号 / 联机 UI / 云同步 | 纯前端项目；联机仅保留既有接口边界 |
| NG-6 | 不做玩家自定义主题（自由取色器 / CSS 编辑器） | 见 §8 Q3；P2 留接口，本次不实现 |
| NG-7 | 不做装备属性重算引擎 | 属性试算逻辑**沿用现有 `EquipmentUI.statsOf`**，只改展示层 |
| NG-8 | 不重构 `SaveData` 的 `version` / 业务结构 | 仅在 `meta.settings` 下**新增**可选字段，向后兼容（见 §6.3） |

---

## 2. 核心用户故事（10 条，含验收标准）

> 表达格式：Given-When-Then（前置条件 / 操作 / 可验证结果）。全部为**可勾选**验收条目。

### US-01 纸娃娃配装（核心）

**用户故事**：作为养成玩家，我想在**人形轮廓**上看到 13 件装备分别穿在头、肩、胸、腕、手、腰、腿、脚、颈、双指、左右手的位置，以便一眼看清我的角色穿了什么、哪里还空着。

- [ ] **US-01-1** Given 任意武将的配装界面已打开，When 渲染完成，Then 纸娃娃区域同时显示**人形轮廓图**与 **13 个锚定在解剖位置上的槽位**，且 13 个槽位在 DOM 中均带 `data-slot` 属性，值覆盖 `head/shoulders/chest/bracers/gloves/belt/legs/boots/amulet/ring1/ring2/mainHand/offHand`。
- [ ] **US-01-2** Given 某槽位已装备，When 渲染完成，Then 该槽位显示**该装备的程序化图标**（SVG data URL）**且**显示稀有度边框/底色；**不得**仅以文字按钮呈现。
- [ ] **US-01-3** Given 某槽位为空，When 渲染完成，Then 显示**空槽占位**（虚线描边 + 槽位中文名 + 灰度图标），且底色为 `--ws-slot-empty`。
- [ ] **US-01-4** Given 全部 13 槽均为空，When 渲染完成，Then 不报错、不空白，纸娃娃显示**完整裸人轮廓**且每个槽位均为空占位（空状态）。
- [ ] **US-01-5** Given 窗口宽度 < 720px，When 渲染完成，Then 纸娃娃区从三栏布局降级为**纵向堆叠**（纸娃娃在上、仓库在下、详情抽屉置底），纸娃娃尺寸按 `min(100%, 320px)` 自适应且槽位不重叠、不溢出容器。
- [ ] **US-01-6** Given 玩家切换武将，When 配装界面重渲染，Then 纸娃娃与所有槽位内容**整体替换**为新武将的 loadout，无残留旧武将数据。

### US-02 悬停 / 点击预览浮层

**用户故事**：作为养成玩家，我想在**不离开当前界面**的前提下看到一件装备的完整信息（图标、名称、稀有度、词缀、宝石、传奇特效、套装归属、与当前槽位的差值），以便判断要不要换。

- [ ] **US-02-1** Given 桌面端（`pointer: fine`），When 鼠标悬停在仓库条目或纸娃娃槽位上，Then 在 **≤150ms** 内出现预览浮层（`.item-preview`），且浮层**不遮挡被悬停的元素**。
- [ ] **US-02-2** Given 预览浮层已显示，When 查看内容，Then 浮层必须包含：图标、名称、稀有度标签、槽位名、词缀列表（名称 + 数值）、宝石列表（含孔位占用 `已镶 n/m`）、传奇特效名与描述（若有）、套装名（若有）、以及**与当前已装备件的差值对比**。
- [ ] **US-02-3** Given 浮层处于屏幕右/下边缘，When 渲染完成，Then 浮层**自动翻转**（left/top 或 right/bottom 方向），始终完整可见于视口内。
- [ ] **US-02-4** Given 移动端（无 hover），When 玩家**点击**装备条目，Then 浮层以**底部抽屉**形式出现（而非跟随指针），带明确的关闭按钮与「装备到此槽」主操作。
- [ ] **US-02-5** Given 浮层已显示，When 玩家按 `Esc` 或点击外部，Then 浮层关闭且不改变任何装备状态（**只读预览，不产生副作用**）。

### US-03 拖拽换装

**用户故事**：作为熟练玩家，我想**直接把仓库里的装备拖到纸娃娃的槽位上**来完成换装，以便比「点两下」更快。

- [ ] **US-03-1** Given 桌面端，When 玩家按下仓库条目并拖动，Then 该条目出现拖拽镜像（半透明、跟随指针），纸娃娃上**所有兼容槽位高亮**，不兼容槽位变暗。
- [ ] **US-03-2** Given 拖拽中，When 指针悬停在某个槽位上，Then 该槽位显示**落点高亮**；松手即完成装备，**不需要**二次确认。
- [ ] **US-03-3** Given 拖拽中，When 玩家松手于**非槽位区域**，Then 取消本次拖拽，装备状态不变，**不产生任何存档写入**。
- [ ] **US-03-4** Given 目标槽位**已有装备**，When 拖拽完成，Then 新装备替换旧装备，旧装备**回到仓库**（不得丢失）；`loadouts` 中该槽位指向新 uid。
- [ ] **US-03-5** Given 移动端，When 玩家长按（≥400ms）仓库条目，Then 进入**拖拽模式**（同桌面），且长按过程中不触发点击选中、不误触滚动。
- [ ] **US-03-6** Given 键盘用户，When 使用 `Tab` 聚焦到仓库条目并按 `Enter`，Then **等价于选中该条目**并打开预览抽屉（拖拽不是键盘唯一路径）。

### US-04 冲突与边界处理

**用户故事**：作为玩家，我想在「这件装备已穿在另一个槽位」「套装还差一件」「戒指只有一件但我要占两个槽」等情况下得到明确提示，而不是状态错乱。

- [ ] **US-04-1** Given 物品 `X` 已装备在槽位 A，When 玩家将 `X` 装备到槽位 B，Then 槽位 A 被**自动置空**（唯一性保证），`X` 出现在 B；UI 上 A 槽变为空占位。
- [ ] **US-04-2** Given 仓库中某件装备**已在任一槽位被占用**，When 渲染仓库列表，Then 该条目显示**「已装备」徽标**且其「装备」操作按钮为 `disabled`（不可重复装备同一 uid）。
- [ ] **US-04-3** Given 玩家已装备套装 `桃园结义` 的 2 件（`head` + `chest`），When 渲染，Then 套装面板显示 **2 件套已激活**并列出效果；`ring1` 若也穿上则升级为 **4 件套**，效果即时刷新。
- [ ] **US-04-4** Given 套装件数不足，When 渲染套装面板，Then 显示 **「x/2」进度条**与未激活的槽位清单，不隐藏套装信息。
- [ ] **US-04-5** Given 仓库为空，When 渲染配装界面，Then 仓库区显示空状态文案「暂无装备：战斗掉落会在结算后入库」，且**保留**纸娃娃与详情区（不塌陷布局）。
- [ ] **US-04-6** Given 某 `EquipmentItem.defId` 在配置表中查不到（脏存档），When 渲染，Then 该条目显示为「未知装备（`defId`）」灰色占位，**不抛异常、不中断整页渲染**。

### US-05 主题 / 皮肤切换

**用户故事**：作为玩家，我想给游戏换一套整体配色与质感，以便在不同的屏幕环境（强光户外 / 暗夜）下看得舒服。

- [ ] **US-05-1** Given 设置页已打开，When 渲染完成，Then 存在**主题选择区**，至少提供 **4 套**可选主题，当前主题高亮并标记 `aria-checked` / `is-active`。
- [ ] **US-05-2** Given 玩家点击某主题，When 切换完成，Then **全部 UI（场景、HUD、配装、魔盒、升级卡牌、触屏控件）** 在 **≤1 帧**内完成换色，无需刷新页面、无 404、无控制台错误。
- [ ] **US-05-3** Given 玩家切换主题后关闭游戏并重新打开，When 加载存档，Then 主题**保持为上次选择**（持久化）。
- [ ] **US-05-4** Given 玩家使用**旧版本存档**（`meta.settings` 中无主题字段），When 加载，Then 主题回退为**默认主题**（经典三国），**不得**报错、**不得**重置整个存档。
- [ ] **US-05-5** Given 配装界面已打开，When 玩家点击右上角**换肤快捷入口**，Then 在**当前界面内**弹出主题选择浮层并即时生效，无需跳转到设置页。
- [ ] **US-05-6** Given 任意主题生效，When 检查计算样式，Then 所有硬编码颜色（当前 `EXTRA_CSS` 与 `style.css` 中的 40+ 处十六进制色值）均已由 CSS 变量驱动，**不残留**内联硬编码颜色。

### US-06 仓库筛选与排序

**用户故事**：作为拥有大量装备的玩家，我想按**类别 / 稀有度 / 槽位**筛选并排序，以便快速找到那件我要的装备。

- [ ] **US-06-1** Given 配装界面已打开，When 渲染完成，Then 仓库区提供三个筛选维度：**类别**（防具 / 首饰 / 武器）、**稀有度**（白 / 蓝 / 黄 / 传奇 / 远古传说 / 太古传说）、**槽位**（13 槽单选 + 「全部」），筛选条件可叠加。
- [ ] **US-06-2** Given 已应用筛选，When 结果为空，Then 显示「无匹配装备」并提供**一键清除筛选**按钮（而非空白列表）。
- [ ] **US-06-3** Given 已应用筛选，When 结果非空，Then 显示结果计数（如「12 / 87 件」）。
- [ ] **US-06-4** Given 玩家切换排序（默认 / 稀有度 / 战力），When 列表刷新，Then 排序稳定且**不改变**装备数据与 loadouts。

### US-07 属性试算与比较

**用户故事**：作为玩家，我想在详情区看到「换上这件后，属性怎么变」，以便做取舍。

- [ ] **US-07-1** Given 选中一件装备，When 详情区渲染，Then 显示 **属性差值列表**：提升为正色（`--ws-stat-up`）、下降为负色（`--ws-stat-down`）、持平为中性色。
- [ ] **US-07-2** Given 差值为 0，When 渲染，Then 该行显示为中性且**不隐藏**（用户需要知道「无变化」）。
- [ ] **US-07-3** Given 当前槽位为空，When 选中候选装备，Then 全部属性行显示为正向差值（相对 0 基线）。
- [ ] **US-07-4** Given 试算结果，When 玩家点击「装备」但该槽位不存在（脏数据），Then 按钮为 `disabled` 并提示「无效槽位」，不写入 loadouts。

### US-08 跨端与可访问性

- [ ] **US-08-1** Given 任意主题下，When 检查所有 `button` / `.hit-target` / `.touch-control`，Then 计算样式的 `min-width` 与 `min-height` 均 **≥44px**（`--ws-hit-min`），`touch-action: none` 保持不变。
- [ ] **US-08-2** Given 玩家只用键盘，When 在配装界面按 `Tab`，Then 可依次聚焦：纸娃娃槽位 → 仓库条目 → 筛选器 → 详情操作按钮，焦点环**始终可见**（`:focus-visible`）。
- [ ] **US-08-3** Given 焦点在仓库条目上并按 `Space` / `Enter`，Then 等价于点击（选中 + 打开预览），且**不触发**双击/拖拽副作用。
- [ ] **US-08-4** Given 玩家在配装界面按 `Esc`，Then 依次关闭：预览浮层 → 抽屉 → 配装界面（多层关闭顺序稳定）。
- [ ] **US-08-5** Given 移动端进入配装界面，When 渲染完成，Then 仓库列表与详情区可**独立纵向滚动**，且**不**与页面级滚动冲突（触摸滚动不被 `touch-action:none` 误伤）。
- [ ] **US-08-6** Given 任意交互元素，When 检查可访问名称（accessible name），Then 非纯图标按钮均有可见文本或 `aria-label`。

### US-09 视觉统一与坏味道清理

- [ ] **US-09-1** Given 重构完成，When 检查 `src/registration/presentation.ts`，Then **`EXTRA_CSS` 常量被移除**，其样式内容迁移到按域拆分的 CSS 文件中（见 §6.2）。
- [ ] **US-09-2** Given 重构完成，When 全量检查 UI 样式，Then 所有颜色 / 间距 / 圆角 / 阴影 / 字号 / 动效时长均引用 §6.4 的设计令牌变量，**无**裸十六进制色值与像素值（令牌文件除外）。
- [ ] **US-09-3** Given 现有全部单测与 e2e，When 运行，Then 全部通过（59 项单测 + 4 个 e2e spec），**无**新增失败、无跳过。
- [ ] **US-09-4** Given 重构完成，When 运行 `npm run build`，Then 产物可 `vite preview` 正常访问，无 404、无 `console.error`、无 `pageerror`。

### US-10 加载 / 空 / 错误 / 禁用四态

- [ ] **US-10-1** Given 配装界面正在渲染大量装备（仓库 200 件上限），When 渲染中，Then 显示**骨架/占位态**（不卡顿主线程 >100ms），完成后平滑替换。
- [ ] **US-10-2** Given 某操作在写入存档时失败（QuotaExceededError），When 发生，Then 界面给出**可见错误提示**（沿用 `SaveSystem.lastError` 文案），且**不丢失**玩家当前选择。
- [ ] **US-10-3** Given 一个按钮处于不可用状态（如「已装备」/「卸下」在无装备时），When 渲染，Then `disabled` 属性为真且样式上有明确的**禁用视觉**（降透明 + 去阴影），**不**仅靠颜色区分。
- [ ] **US-10-4** Given 存档损坏回退默认存档，When 进入设置页查看主题，Then 主题区仍可正常使用（不因存档损坏而不可用）。

---

## 3. 信息架构与关键界面

### 3.1 配装界面整体信息架构

```
主菜单 ──► 配装界面（EquipmentUI）──► [纸娃娃区] [仓库区] [详情/试算区]
                ▲                              │
                │                              └─ 主题切换浮层（快捷入口）
                │
主菜单 ──► 设置页 ──► 主题区 ──► [主题卡 × 4+]
```

**布局决策**：采用 **三栏（桌面） / 两栏（平板） / 单栏堆叠（移动）** 的响应式方案。

| 断点 | 布局 | 说明 |
| --- | --- | --- |
| ≥ 1024px | 三栏：`纸娃娃 (320–360px) \| 仓库 (flex) \| 详情 (320–380px)` | 详情为常驻右栏 |
| 720–1023px | 两栏：`纸娃娃+仓库 (flex) \| 详情 (300px)` | 纸娃娃在上、仓库在下 |
| < 720px | 单栏纵向堆叠：纸娃娃 → 仓库 → 详情（详情变为**底部抽屉**） | 触屏优先 |

> **与现状差异**：现状是 `slot-grid` 4 列按钮网格（`.equip-columns` 2 栏）。本次把「13 槽网格」升级为「人形纸娃娃」，把「属性试算条」升级为「常驻详情栏/抽屉」。

### 3.2 区域一：纸娃娃区（Paper Doll）

| 组件 | 内容 | 交互 |
| --- | --- | --- |
| **人形轮廓** | 程序化生成的静态人形 SVG（按 `SLOT_DEFS` 锚点绘制），复用 `src/art/ChibiFactory.ts` 的配色工具 `colorToCss`/`shade`/`mixColor` | 纯展示，不接收指针事件（`pointer-events:none`），避免遮挡槽位 |
| **13 个槽位锚点** | 每槽一个 `<button class="doll-slot" data-slot="...">`，绝对定位在对应解剖位置 | 点击 = 选中该槽位并刷新详情；悬停 = 弹出预览浮层；可作为拖拽落点 |
| **槽位内容** | 空槽：灰度占位图标 + 槽位名；已装备：装备图标 + 稀有度描边 | 拖拽悬停时高亮 |
| **武将徽标** | 当前武将名与头像（`PortraitFactory` 生成的 data URL，复用现有 `general-portrait` 机制） | 只读 |
| **套装进度条** | 4 个套件的 `x/2` `x/4` 进度，已激活者亮起 | 点击套装名 → 筛选仓库到该套装 |

### 3.3 纸娃娃槽位空间布局（ASCII 示意图）

> 13 槽与人体部位的映射是**本文的核心提案**，需用户确认（见 §8 Q1）。

```
┌──────────────────────────────────────────────────────────────┐
│                     ┌───────────┐                             │
│                     │  head     │  头盔（头部）                 │
│                     │  头盔      │                             │
│                     └─────┬─────┘                             │
│            ┌────────┐      │      ┌────────┐                 │
│            │shoulders│     │      │        │                 │
│            │ 肩甲    ├──────┼──────┤  (对称) │  ← 双肩共用 1 槽 │
│            └────────┘   amulet │      └────────┘             │
│              躯干 chest ┌──┴──┐                              │
│                      ┌──┤胸甲 ├──┐                            │
│                      │  └─┬─┘  │                            │
│                      │  belt   │  腰带（腰部）                │
│                      └──┬──┬──┘                              │
│        bracelet(左腕)   │  │   bracelet(右腕)  ← 护腕：单槽双腕  │
│              ┌───┐  gloves   gloves ┌───┐                    │
│              │ 手 │  手套：单槽双手    │ 手 │  ring1 / ring2    │
│              │套 │                  │套 │  戒指：单槽双手     │
│              └─┬─┘                  └─┬─┘                    │
│           mainHand                  offHand                   │
│           主手武器                  副手武器                  │
│                │                       │                      │
│                └──────┬────────────────┘                      │
│                    ┌────┴────┐                                │
│                    │  legs   │  护腿（双腿，单槽）           │
│                    └────┬────┘                                │
│                   ┌─────┴─────┐                              │
│                   │   boots   │  靴子（双足，单槽）          │
│                   └───────────┘                              │
└──────────────────────────────────────────────────────────────┘
```

**等价的紧凑映射表（实现依据）**：

| 槽位 id | 中文名 | 人体部位 | 锚点坐标（相对人形容器，百分比） | 双侧共享 |
| --- | --- | --- | --- | --- |
| `head` | 头盔 | 头部 | `left:50% top:2%` | 否 |
| `amulet` | 项链 | 颈部 | `left:50% top:12%` | 否 |
| `shoulders` | 肩甲 | 双肩 | `left:50% top:19%` | 是（双肩同槽） |
| `chest` | 胸甲 | 躯干 | `left:50% top:27%` | 否 |
| `bracers` | 护腕 | 双腕 | `left:50% top:38%` | 是 |
| `gloves` | 手套 | 双手 | `left:50% top:47%` | 是 |
| `belt` | 腰带 | 腰部 | `left:50% top:41%` | 否 |
| `ring1` | 戒指一 | 左手 | `left:30% top:47%` | 戒指槽共用双手 |
| `ring2` | 戒指二 | 右手 | `left:70% top:47%` | 戒指槽共用双手 |
| `mainHand` | 主手武器 | 右手 | `left:76% top:52%` | 否 |
| `offHand` | 副手武器 | 左手 | `left:24% top:52%` | 否 |
| `legs` | 护腿 | 双腿 | `left:50% top:66%` | 是 |
| `boots` | 靴子 | 双足 | `left:50% top:84%` | 是 |

> **实现约束**：人形轮廓与槽位**分离渲染**（轮廓 SVG 一张，槽位按钮为独立 DOM 元素绝对定位）。这样槽位天然可聚焦、可拖拽、可读屏，且不需要在 SVG 内做交互逻辑。槽位坐标以「容器百分比 + `transform: translate(-50%,-50%)`」表达，保证缩放不破版。

### 3.4 区域二：仓库区（Inventory）

```
┌ 仓库 ──────────────────────────── [筛选器 ▾] [排序 ▾] [12/87 件] ┐
│ ┌── 筛选行（可折叠）────────────────────────────────────────────┐ │
│ │ 类别: [全部][防具][首饰][武器]                                  │ │
│ │ 稀有度: [全部][白][蓝][金][传奇]                                │ │
│ │ 槽位: [全部][头盔][肩甲]...（横向滚动条）                        │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│ ┌── 列表（虚拟滚动 / 折叠分组）───────────────────────────────────┐ │
│ │ [icon] 传奇·方天画戟        武器·主手   已装备      词缀 3  [⚔]│ │
│ │ [icon] 金·赤兔              防具·腰带                词缀 3  [⚔]│ │
│ │ [icon] 白·布鞋              防具·靴子                词缀 1  [⚔]│ │
│ └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

| 组件 | 说明 |
| --- | --- |
| 筛选行 | 三个维度可叠加；「全部」为默认；筛选状态是**纯 UI 态**，不写入存档 |
| 列表条目 | 由「文字一行」升级为「图标 + 名称 + 稀有度色 + 槽位 + 状态徽标 + 词缀数」四段式；条目**必须**带 `data-uid` |
| 稀有度视觉 | 6 档：白（灰）/ 蓝 / 黄 / 传奇 / 远古传说 / 太古传说。现状只有文字颜色（`.rarity-*`），本次升级为**边框 + 底色 + 图标辉光**三重编码 |
| 排序 | 默认（获得顺序）/ 稀有度降序 / 战力估算降序（复用 `statsOf` 求和） |
| 空状态 | 「暂无装备：战斗掉落会在结算后入库」（仓库为空）／「无匹配装备」+ 清除筛选按钮（有筛选但无结果） |
| 边界 | 仓库容量 `capacity`（默认 200）满时在列表顶部显示「仓库已满（200/200），请拆解或替换」 |

### 3.5 区域三：详情 / 试算区（Detail & Comparison）

| 区块 | 内容 |
| --- | --- |
| 标题区 | 装备大图标 + 名称 + 稀有度徽章 + 槽位名 + 「已装备」状态 |
| 词缀区 | 每条词缀：属性名 + 数值（取 `AFFIX_POOL` 区间中值 × 稀有度系数，与现有 `statsOf` 一致，**不改数值口径**） |
| 宝石区 | 已镶宝石（图标 + 属性 + 数值）+ 孔位 `已镶 n/m` |
| 传奇特效区 | 特效名 + 描述（有 `legendaryEffectId` 时显示） |
| 套装区 | 所属套装名 + 该套装当前件数 + 已激活效果列表 |
| 试算区 | 与当前槽位装备的属性差值列表（正/负/零三色） |
| 操作区 | 主操作「装备到该槽」（已是该装备则 disabled + 文案「已装备」）；次操作「卸下」（槽位为空时 disabled） |

### 3.6 装备预览浮层（Item Preview）

> 浮层是**只读**的，不承载「装备」动作的最终执行（移动端抽屉除外，见 US-02-4）。

| 区块 | 内容 |
| --- | --- |
| 头部 | 装备图标（48px）+ 名称 + 稀有度徽章 + 槽位名 |
| 词缀 | 逐条：属性名 + 数值 |
| 宝石 | 宝石图标行 + `已镶 n/m` |
| 传奇 | 特效名 + 描述（若有） |
| 套装 | 套装名 + 件数进度（若有） |
| 差值 | 与该槽位当前装备的属性差值（正/负/零三色），与详情区**同源同算法** |
| 状态 | 「已装备在：头盔」等占用提示（若有） |

**触发规则**：

| 平台 | 触发 | 表现 |
| --- | --- | --- |
| 桌面（`pointer:fine`） | `mouseenter` 悬停 | 跟随指针浮层，延迟 120ms 显示，边缘自动翻转 |
| 桌面 | 移出 / `Esc` / 点击外部 | 立即隐藏 |
| 移动端 | 单击条目 | **底部抽屉**（含「装备到此槽」按钮） |
| 移动端 | 长按条目 | 进入拖拽模式（此时不弹抽屉） |
| 全平台 | 点击纸娃娃已装备槽位 | 底部抽屉/右栏展开该装备详情（等同选中） |

### 3.7 换肤界面位置与交互

| 入口 | 位置 | 交互 |
| --- | --- | --- |
| **主入口** | 设置页 `.settings-panel`，新增「主题」分组，位置在「画质」之上 | 主题卡网格：每张卡显示**该主题的真实预览配色**（用主题变量现场渲染一个迷你预览块），点击即切换 |
| **快捷入口** | 配装界面右上角（主题图标按钮 `.doll-theme-toggle`） | 就地弹出主题选择浮层（复用同一组件），即时生效，不跳场景 |
| **游戏内快捷入口** | 主菜单底部小字链接 | 可选（P2），跳转到设置页的主题分组 |

**主题切换生效范围**（必须全覆盖，无遗漏）：

| 层 | 元素 |
| --- | --- |
| 场景层 | boot / menu / select / battle / result / settings 六个 DOM 覆盖层的背景、面板、按钮、标题 |
| HUD | 血条、经验条、数值面板、toast、BOSS 警告 |
| 配装 | 纸娃娃轮廓、槽位、仓库、详情、预览浮层 |
| 魔盒/宝石/排行 | tab、chip、材料行、宝石行、排行榜 |
| 升级三选一 | 卡牌边框、稀有度角标、标签 |
| 触屏控件 | 摇杆、技能键、自动键 |
| 战场背景 | `#app` 的径向光晕 / 网格线（`style.css` 的 `#app` 背景） |

> **注意**：战场内的 **Pixi 渲染实体配色**（武将/敌人/子弹）**不随主题改变**——那是玩法可视化识别度的一部分，改动会伤害可读性与既有视觉基线。此项写入非目标（NG-3 的延伸，见 §8 Q5）。

---

## 4. 交互规范

### 4.1 桌面端（鼠标 / 键盘）

| 动作 | 行为 |
| --- | --- |
| 悬停仓库条目 / 槽位 | 120ms 后显示预览浮层；离开立即隐藏 |
| 单击仓库条目 | 选中该装备 → 刷新详情栏与试算 |
| 单击槽位 | 选中该槽位 → 详情栏显示该槽当前装备 |
| 双击仓库条目 | **快捷装备**到该装备对应槽位（若已被占用则替换） |
| 拖拽仓库条目 → 槽位 | 释放即装备；兼容槽高亮，不兼容槽变暗 |
| 拖拽到非槽位区域 | 取消，无副作用 |
| `Esc` | 关闭浮层 → 关闭抽屉 → 关闭配装界面 |
| `Tab` | 焦点顺序：纸娃娃槽位（Tabindex 0，按视觉顺序）→ 筛选器 → 仓库列表 → 详情按钮 |
| `Enter` / `Space` | 聚焦在仓库条目 = 选中并打开抽屉；聚焦在槽位 = 选中该槽位 |
| `Enter`（抽屉内） | 触发主操作「装备到此槽」 |

### 4.2 移动端（触屏）

| 动作 | 行为 |
| --- | --- |
| 单击仓库条目 | 选中 + 弹出**底部抽屉**（预览 + 操作） |
| 长按（≥400ms）仓库条目 | 进入拖拽模式（Haptic 反馈可选），条目放大 1.08×；长按期间不触发 click |
| 拖拽中移动 | 幽灵图标跟随手指；兼容槽位高亮 |
| 拖拽释放于槽位 | 完成装备 |
| 拖拽释放于其它区域 | 取消 |
| 单击纸娃娃槽位 | 选中槽位，详情以底部抽屉展示 |
| 抽屉下滑手势（可选） | 关闭抽屉；不实现则用关闭按钮 + 遮罩点击 |
| 仓库列表滚动 | **独立滚动容器**，`overscroll-behavior: contain`，避免与外层 `touch-action:none` 冲突 |

> **实现要点**：仓库/详情这类**需要滚动**的容器必须显式设置 `touch-action: pan-y`，覆盖 body 的 `touch-action: none`；否则移动端无法滚动列表（这是现有 `style.css` 的全局 `touch-action:none` 带来的实际风险点）。

### 4.3 命中区与可访问性

| 规则 | 值 |
| --- | --- |
| 最小命中区 | 所有 `button` / `.hit-target` / `.touch-control` ≥ **44×44px**（`--ws-hit-min`），**冻结契约，不得下调** |
| 槽位热区 | 纸娃娃槽位按钮 **≥44×44px**（视觉图标可小于热区，热区用透明 padding 扩展） |
| 浮层关闭热区 | 抽屉关闭按钮 ≥44×44px |
| 焦点可见 | 所有可聚焦元素提供 `:focus-visible` 轮廓（≥2px 高对比），**不得** `outline:none` 了事 |
| 语义 | 浮层 `role="dialog"` + `aria-modal`；主题卡 `role="radio"`；抽屉 `aria-labelledby` 指向标题 |
| 键盘陷阱 | 抽屉打开时焦点锁在抽屉内，`Esc` 关闭后焦点**归还**触发元素 |
| 屏幕阅读器 | 槽位按钮 `aria-label="头盔：传奇·方天画戟"` / `aria-label="头盔：空"` |
| 动效 | 尊重 `prefers-reduced-motion: reduce` → 关闭位移/缩放动画，仅保留透明度淡入 |

### 4.4 四态规范

| 状态 | 表现 | 类名 |
| --- | --- | --- |
| 加载中 | 骨架块（浅色脉冲）替换内容区；禁止交互 | `.is-loading` + `.skeleton` |
| 空 | 图标 + 一句说明 + 一个明确的下一步动作 | `.is-empty` + `.empty-state` |
| 错误 | 红色边框条 + 可读错误文案（优先复用 `SaveSystem.lastError`） | `.is-error` + `.error-bar` |
| 禁用 | `disabled` 属性 + 透明度 0.45 + 去除阴影 + `cursor:not-allowed` + `aria-disabled` | `.is-disabled` |
| 选中 | 主色描边 + 轻微提亮 + `aria-selected="true"` | `.is-selected`（**沿用现有类名**） |
| 激活（设置项） | 同「选中」，另加 `is-active`（**沿用现有类名**） | `.is-active` |

---

## 5. 主题 / 皮肤需求

### 5.1 主题清单（4 套基础主题 + 1 套预留）

| # | id | 名称 | 气质 | 关键词 |
| --- | --- | --- | --- | --- |
| T1 | `classic` | **经典三国** | 暖褐金、羊皮纸质、锈铁与官窑釉色 | 厚重、正统、暖金 |
| T2 | `ink` | **墨韵水墨** | 宣纸白底 + 焦墨黑 + 一点朱砂 | 清雅、留白、书法感 |
| T3 | `neon` | **暗夜霓虹** | 深靛底 + 青紫洋红辉光 + 高饱和描边 | 赛博、锐利、暗底高对比 |
| T4 | `sakura` | **春日和风** | 樱粉 + 竹青 + 米白 + 淡金 | 柔和、明亮、花瓣感 |
| T5 | `wasteland` | **荒漠孤烟**（P2 预留） | 沙褐 + 铁锈 + 暗红残阳 | 荒凉、粗粝 |

> T1 是**默认主题**，且必须与**当前视觉基线**（`#e8b84b` 金、`#1a1107` 墨、`#b3352b` 朱红、`#8ce8ff` 青）**视觉等价**，以保证「不改主题 = 不改现状」，把换肤做成纯增量。

### 5.2 主题调色板角色定义

每套主题必须定义**完整**下列角色，缺一不可（缺角色 = 主题不合格）：

| 角色 | 变量 | 语义 | T1 经典三国 | T2 墨韵水墨 | T3 暗夜霓虹 | T4 春日和风 |
| --- | --- | --- | --- | --- | --- | --- |
| 画布底 | `--ws-bg-canvas` | 页面最底层 | `#100b07` | `#e8e2d4` | `#0a0a14` | `#fdf7f3` |
| 画布纹理 | `--ws-bg-texture` | 网格/纹理层 | `rgba(232,184,75,.035)` | `rgba(40,40,40,.05)` | `rgba(140,120,255,.06)` | `rgba(220,140,160,.05)` |
| 表面底 | `--ws-bg-surface` | 面板/卡片底 | `#2c2014` | `#f6f1e4` | `#141428` | `#ffffff` |
| 表面高 | `--ws-bg-raised` | 悬浮/次级卡片 | `#3c2c1b` | `#fffdf6` | `#1e1e3a` | `#fff7fa` |
| 边框 | `--ws-border` | 常规描边 | `rgba(232,184,75,.62)` | `rgba(60,55,45,.45)` | `rgba(140,120,255,.55)` | `rgba(200,140,160,.5)` |
| 边框强 | `--ws-border-strong` | 强调描边 | `#f6dda0` | `#2b2b28` | `#7cf7ff` | `#e08fa8` |
| 主色 | `--ws-primary` | 主要动作 | `#e8b84b` | `#2b2b28` | `#7cf7ff` | `#e07b96` |
| 主色前景 | `--ws-on-primary` | 主色上的文字 | `#1a1107` | `#f6f1e4` | `#0a0a14` | `#ffffff` |
| 强调色 | `--ws-accent` | 选中/高亮 | `#8ce8ff` | `#a8321f`（朱砂） | `#ff5cc8` | `#5aa06f`（竹青） |
| 文字主 | `--ws-text` | 正文 | `#f4e7c8` | `#2b2b28` | `#e8e8ff` | `#3a2f33` |
| 文字次 | `--ws-text-muted` | 次要/提示 | `rgba(244,231,200,.65)` | `rgba(43,43,40,.62)` | `rgba(232,232,255,.6)` | `rgba(58,47,51,.62)` |
| 危险/负 | `--ws-danger` | 错误、下降 | `#ff8a80` | `#a8321f` | `#ff5c7a` | `#c2453f` |
| 正向 | `--ws-stat-up` | 提升 | `#8ce8ff` | `#2f6b46` | `#7cff9b` | `#3f8f5c` |
| 负向 | `--ws-stat-down` | 下降 | `#ff8a80` | `#a8321f` | `#ff5c7a` | `#c2453f` |
| 槽位空 | `--ws-slot-empty` | 空槽描边 | `rgba(232,184,75,.28)` | `rgba(43,43,40,.22)` | `rgba(140,120,255,.25)` | `rgba(200,140,160,.28)` |
| 阴影 | `--ws-shadow` | 面板投影 | `rgba(0,0,0,.72)` | `rgba(60,50,40,.22)` | `rgba(0,0,255,.35)` | `rgba(160,120,130,.24)` |

**稀有度色**（6 档，**全局统一**，随主题微调但保持可辨识的色相顺序 灰→蓝→金→橙→翠→紫）：

| 稀有度 | 变量 | T1 | T2 | T3 | T4 |
| --- | --- | --- | --- | --- | --- |
| 白 common | `--ws-rarity-common` | `#ddd` | `#8a857a` | `#c8c8dd` | `#b8acae` |
| 蓝 blue | `--ws-rarity-blue` | `#8dc6ff` | `#3f6b9a` | `#5cc8ff` | `#7fa8d8` |
| 黄 gold | `--ws-rarity-gold` | `#f3c744` | `#9a7b25` | `#ffd24c` | `#e0b04a` |
| 传奇 legendary | `--ws-rarity-legendary` | `#ff9d3f` | `#a8321f` | `#ff8a3d` | `#e0653f` |
| 远古传说 ancient | `--ws-rarity-ancient` | `#54d6a0` | `#16805d` | `#4df0ae` | `#218765` |
| 太古传说 primal | `--ws-rarity-primal` | `#c77dff` | `#7b3fb8` | `#d69bff` | `#9048a8` |

### 5.3 主题切换的生效范围与持久化

| 项 | 要求 |
| --- | --- |
| **生效范围** | §3.7 表格中列出的全部 UI 层 + `#app` 战场背景（DOM 层）。**不含** Pixi 战场实体配色 |
| **生效机制** | `document.documentElement.dataset.theme = 'ink'`（或 class），CSS 变量定义在 `[data-theme='xxx']` 选择器下；**不做**运行时逐元素改写样式 |
| **即时性** | 切换后 ≤1 帧（≈16ms）完成重绘；不重建 DOM（避免丢失滚动位置与选中态） |
| **静态性** | 主题色板**全部硬编码在 `themes.css`**；切换过程**零 `Math.random()`**、**零墙钟**、零 JS 计算（FC-5.1 / FC-5.2）。主题切换是纯 CSS 变量替换，天然满足确定性要求 |
| **持久化** | 写入 `SaveData.meta.settings.theme: ThemeId`（见 §6.3）；`SaveSystem.save()` 走既有节流 |
| **向后兼容** | 旧存档缺 `theme` 字段 → 视为 `'classic'`；**不改** `SaveData.version`（保持 1），**不触发**「版本不匹配」重置 |
| **非法值** | 读档时若 `theme` 不在已知集合内 → 回退 `'classic'`（防御性） |
| **作用域** | 仅本地玩家档案（`meta` 已是玩家私有，无需额外归属处理） |

---

## 6. 视觉设计令牌（Design Tokens）清单

### 6.1 命名约定

```
--ws-<类别>-<语义>-<可选变体>
```

| 类别前缀 | 含义 | 示例 |
| --- | --- | --- |
| `--ws-bg-*` | 背景 / 表面 | `--ws-bg-surface` |
| `--ws-text-*` | 文字 | `--ws-text-muted` |
| `--ws-border-*` | 描边 | `--ws-border-strong` |
| `--ws-primary` / `--ws-accent` / `--ws-danger` | 语义色 | `--ws-accent` |
| `--ws-rarity-*` | 稀有度色 | `--ws-rarity-legendary` |
| `--ws-slot-*` | 槽位状态 | `--ws-slot-empty` |
| `--ws-stat-*` | 数值增减 | `--ws-stat-up` |
| `--ws-space-*` | 间距阶（4px 基） | `--ws-space-2` |
| `--ws-radius-*` | 圆角阶 | `--ws-radius-md` |
| `--ws-shadow-*` | 阴影阶 | `--ws-shadow-panel` |
| `--ws-font-*` | 字号 / 字重 / 行高 | `--ws-font-sm` |
| `--ws-dur-*` / `--ws-ease-*` | 动效时长 / 缓动 | `--ws-dur-fast` |
| `--ws-z-*` | 层级 | `--ws-z-modal` |
| `--ws-hit-min` | **冻结**：最小命中区 44px | `--ws-hit-min: 44px` |

### 6.2 令牌层级与 CSS 文件拆分

#### 6.2.1 现状坏味道（本次必须修复）

| 项 | 现状 | 问题 | 目标 |
| --- | --- | --- | --- |
| **B-1** `EXTRA_CSS` 字符串 | `src/registration/presentation.ts` 顶部有一个约 **40–55 行**（压缩单行）CSS 字符串常量，承载了**大部分** UI 样式（HUD、触控条、卡牌、配装两栏、槽位网格、仓库列表、稀有度色、魔盒 tab/chip、设置行、40 将卡片、标题渐变、媒体查询等） | ① 样式与逻辑**割裂**（`presentation.ts` 是注册入口，却承担样式职责）；② 无法被 IDE / lint / 主题令牌工具分析；③ 与 `src/style.css` 存在**重复定义**与**优先级耦合**（如 `.rarity-*`、`.panel--wide`、`.equip-columns` 两处都有）；④ 无法做主题化（硬编码色值散落） | **`EXTRA_CSS` 常量整体删除**（不是改名、不是留残块）；样式统一迁到 `src/ui/styles/*.css`；`presentation.ts` **只保留逻辑**（注册、装配、事件绑定）+ **一个独立的 4 行 `TOUCH_SAFE_AREA_CSS` 常量**（见 §6.2.3，测试契约所需，非样式主体） |
| **B-2** 样式双源 | `src/style.css`（278 行，reset/HUD/overlay/panel/按钮）与 `EXTRA_CSS`（组件级）并行 | 同一视觉概念分散在两处，改主题需同时改两处 | **单一入口**：`src/ui/styles/` 目录（Vite 直接 import CSS 即可），或全部并入 `src/style.css` 单一文件（若架构师偏好少文件，可把 9 个域文件用 `@import` 汇入一个入口） |

#### 6.2.2 目标文件结构

```
src/ui/styles/
  index.css          ← 唯一入口，@import 下列全部（由 presentation.ts 或 main.ts 引入一次）
  tokens.css         ← :root 默认（= 经典三国）+ 全部令牌定义（唯一允许出现裸色值/裸尺寸的文件）
  themes.css         ← [data-theme='ink'|'neon'|'sakura'|'wasteland'] 覆盖块
  base.css           ← reset、body/#app 背景、overlay/panel、按钮基类、safe-area
  hud.css            ← HUD 全部样式（从 EXTRA_CSS + style.css 迁移）
  equipment.css      ← 纸娃娃、槽位、仓库、详情、预览浮层
  meta.css           ← 魔盒 / 宝石 / 排行
  cards.css          ← 升级三选一卡牌
  touch.css          ← 摇杆 / 技能键 / 自动键（**含两条 safe-area 规则的样式主体**；但断言所依赖的文本副本仍留在 presentation.ts 的 TOUCH_SAFE_AREA_CSS，见 §6.2.3）
  components.css     ← 通用组件：chip / tab / row / badge / skeleton / empty-state / error-bar
```

> **迁移后 `presentation.ts` 的职责边界**：只做「装配与接线」——创建 `Renderer` / `HUD` / `EquipmentUI` / `MetaUI` / `TouchControls`、注册场景、绑定 `SaveSystem` 与事件总线。**不含任何 CSS 字符串**，唯一例外是 §6.2.3 的 `TOUCH_SAFE_AREA_CSS`（4 行，测试契约，非样式主体）。

#### 6.2.3 与 `mobileTouch.test.ts` 源码文本断言的冲突处置（**已拍板**）

> **约束事实**：`src/__tests__/mobileTouch.test.ts` 会**按文本读取** `src/registration/presentation.ts` 并断言其中包含 `.touch-controls .joystick\{[^}]*env\(safe-area-inset-left` 与 `.touch-controls .skill-cluster\{[^}]*env\(safe-area-inset-right`。该测试**不关心**这两条规则属于哪个常量——它只做**文件级文本匹配**。

**✅ 已拍板解法（team-lead 决策，Q2 方案 A）**：

把这两条规则从 `EXTRA_CSS` 这个压缩 CSS 字符串常量里**提取出来**，作为**另一个独立命名的常量**留在 `presentation.ts` 中注入；其余 CSS **全部迁出**到 `src/ui/styles/`。

```ts
// src/registration/presentation.ts
/**
 * 触控条安全区适配：仅为兼容 mobileTouch.test.ts 的源码文本断言而保留。
 * 样式主体见 src/ui/styles/touch.css。
 */
const TOUCH_SAFE_AREA_CSS = `
.touch-controls .joystick{position:absolute;left:calc(env(safe-area-inset-left,0px) + 18px);bottom:calc(env(safe-area-inset-bottom,0px) + 20px)}
.touch-controls .skill-cluster{position:absolute;right:calc(env(safe-area-inset-right,0px) + 18px);bottom:calc(env(safe-area-inset-bottom,0px) + 20px);max-width:44%}
`;
```

**三个验收信号同时成立**：

| 信号 | 结果 | 说明 |
| --- | --- | --- |
| `grep -n "EXTRA_CSS" src/registration/presentation.ts` | **无结果** ✅ | `EXTRA_CSS` 常量整个被删除，不是改名、不是留残块 |
| `mobileTouch.test.ts` 断言 `presentation.ts` 含两条 safe-area 规则 | **仍然命中** ✅ | 文本在文件里，只是所属常量名从 `EXTRA_CSS` 变为 `TOUCH_SAFE_AREA_CSS` |
| 既有测试改动数 | **零** ✅ | 不修改 `mobileTouch.test.ts` 一个字符 |

> **已实测验证**：上述 `TOUCH_SAFE_AREA_CSS` 代码片段对照 `mobileTouch.test.ts` 的两条正则逐条跑过 —— `/\.touch-controls \.joystick\{[^}]*env\(safe-area-inset-left/s` → **true**；`/\.touch-controls \.skill-cluster\{[^}]*env\(safe-area-inset-right/s` → **true**；且片段中 `EXTRA_CSS` 字样**不出现**。工程师可直接复制该片段使用。

> **要点澄清（避免工程师误解）**：本方案**不是**「在 `presentation.ts` 里留一段样式」。它把 `presentation.ts` 里的 CSS 从「一个大杂烩常量」降为「一个 4 行的、语义单一的安全区适配常量」，并**附带明确注释说明它存在的原因**。样式主体（摇杆/技能键的完整视觉）在 `src/ui/styles/touch.css`。
>
> **被否决的替代方案**：
> - ~~方案 B：全部迁至 `touch.css` 并修改 `mobileTouch.test.ts`~~ → 需改既有测试，**已否决**。
> - ~~方案 C：全部迁出且不改测试~~ → 测试**必然失败**，**已否决**。

#### 6.2.4 新增 UI 文件的静态审查约束（FC-5 摘要）

| 约束 | 落地要求 |
| --- | --- |
| 零 `Math.random()` | 主题配色、纸娃娃轮廓、装备图标、辉光**全部静态配置化**（写死色值 / 查表 / `hash32` 确定性派生） |
| 零墙钟 | 新增 UI 文件**不得**调用 `Date.now()` / `performance.now()`（白名单仅 6 个既有文件）。拖拽长按判定改用**事件计数 / `setTimeout`** |
| 零 ECS 直连 | 新增 UI 文件**不得** `import ... from 'bitecs'`；数据一律经 `SaveData` / `config` / `Registry` |

> 详见 §8.1 **FC-5**（含逐条测试断言映射）。

### 6.3 令牌清单（明细）

**颜色**：`--ws-bg-canvas` `--ws-bg-texture` `--ws-bg-surface` `--ws-bg-raised` `--ws-border` `--ws-border-strong` `--ws-primary` `--ws-on-primary` `--ws-accent` `--ws-text` `--ws-text-muted` `--ws-danger` `--ws-stat-up` `--ws-stat-down` `--ws-slot-empty` `--ws-rarity-{common,blue,gold,legendary}` `--ws-shadow-color`

**间距**（4px 基）：`--ws-space-0:0` `--ws-space-1:4px` `--ws-space-2:8px` `--ws-space-3:12px` `--ws-space-4:16px` `--ws-space-5:24px` `--ws-space-6:32px` `--ws-space-7:48px`

**圆角**：`--ws-radius-xs:4px` `--ws-radius-sm:8px` `--ws-radius-md:12px` `--ws-radius-lg:16px` `--ws-radius-xl:22px` `--ws-radius-pill:999px`

**阴影**：`--ws-shadow-sm`（按钮）`--ws-shadow-md`（卡片）`--ws-shadow-lg`（面板/浮层）`--ws-shadow-glow`（传奇辉光）

**字号 / 行高**：`--ws-font-xs:10px` `--ws-font-sm:12px` `--ws-font-md:14px` `--ws-font-lg:16px` `--ws-font-xl:20px` `--ws-font-2xl:28px` `--ws-font-display:clamp(48px,8vw,76px)`；字重 `--ws-weight-normal:400` `--ws-weight-bold:700` `--ws-weight-heavy:800`；行高 `--ws-leading-tight:1.2` `--ws-leading-normal:1.5`

**动效**：`--ws-dur-instant:90ms` `--ws-dur-fast:120ms` `--ws-dur-base:180ms` `--ws-dur-slow:260ms`；缓动 `--ws-ease-out:cubic-bezier(.22,.61,.36,1)` `--ws-ease-in-out:cubic-bezier(.4,0,.2,1)` `--ws-ease-spring:cubic-bezier(.34,1.56,.64,1)`

**层级**：`--ws-z-scene:10` `--ws-z-hud:20` `--ws-z-modal:30` `--ws-z-preview:40` `--ws-z-toast:50` `--ws-z-debug:99`（**对齐现有 `style.css` 的 z-index 值，不得变动**）

**尺寸**：`--ws-hit-min:44px`（**冻结**）`--ws-doll-size:320px` `--ws-slot-size:44px` `--ws-preview-width:320px` `--ws-drawer-max-height:70vh`

### 6.4 存档字段新增（向后兼容）

```ts
// src/game/SaveData.ts
export type ThemeId = 'classic' | 'ink' | 'neon' | 'sakura';   // 'wasteland' 为 P2 预留

interface SaveData {
  meta: {
    settings: {
      // ...既有 6 个字段保持不变...
      /** 界面主题；缺省或非法值视为 'classic'（旧存档兼容）。 */
      theme?: ThemeId;      // ← 可选字段，旧存档无此键亦可
    };
  };
}
```

**兼容性规则**：
1. `theme` 必须是**可选属性**（`?`），旧存档反序列化后为 `undefined`，读取侧一律 `?? 'classic'`。
2. **不修改** `SaveData.version`（保持 `1`），不触发 `SaveSystem.load()` 的「版本不匹配」分支。
3. `createDefaultSave()` 中**显式写入** `theme: 'classic'`（新档有值，旧档无值 → 两条路径都落到 classic）。
4. `SaveSystem.load()` **不新增**版本判断逻辑；仅在 UI 层做 `resolveTheme()` 归一化（非法值 → `'classic'`）。
5. 存档体积影响：+约 20 字节，`<80KB` 上限无风险（`saveContract.test.ts` 断言仍应通过）。

---

## 7. 优先级需求池

| 优先级 | 需求项 | 交付说明 | 依赖 | 验收锚点 |
| --- | --- | --- | --- | --- |
| **P0** | 令牌层落地：`tokens.css` + `themes.css`，`--ws-*` 全量定义 | 现有颜色/尺寸全部改为变量引用 | 无 | US-09-2 |
| **P0** | 主题系统：4 套主题 + `data-theme` 切换 + 持久化 + 旧档兼容 | 覆盖场景/HUD/配装/魔盒/卡牌/触屏 | 令牌层 | US-05-1..6 |
| **P0** | 纸娃娃配装界面：人形轮廓 + 13 槽位锚点布局 | 替换现有 `slot-grid` | 令牌层 | US-01-1..6 |
| **P0** | 程序化装备图标生成（SVG data URL） | 沿用 `src/art/Palette.ts` 工具函数，13 槽各一款 + 稀有度辉光变体 | — | US-01-2 |
| **P0** | 装备预览浮层（桌面悬停）+ 移动端底部抽屉 | 抽屉含「装备到此槽」 | 纸娃娃 | US-02-1..5 |
| **P0** | 详情/试算区重构（词缀/宝石/传奇/套装/差值/操作） | 沿用 `statsOf` 数值口径 | 纸娃娃 | US-07-1..4 |
| **P0** | 拖拽换装（桌面拖拽 + 移动长按拖拽） | 兼容槽高亮、落点反馈、取消无副作用 | 纸娃娃 | US-03-1..6 |
| **P0** | 冲突处理：唯一性、已装备徽标、套装进度、空状态、脏数据容错 | 保持现有 `equip()` 唯一性语义 | — | US-04-1..6 |
| **P0** | `EXTRA_CSS` **整个删除** + CSS 按域拆分（`src/ui/styles/` 9 个文件 + 1 入口） | 按 §6.2；`presentation.ts` 只保留逻辑 + 独立常量 `TOUCH_SAFE_AREA_CSS`（4 行，已拍板） | 令牌层 | US-09-1、US-09-3、A-3 |
| **P0** | **新增 UI 文件的静态审查合规**：零 `Math.random()`、零墙钟、零 `bitecs` import | 配色/图标/轮廓全部静态配置化；长按 400ms 用 `setTimeout`（已拍板） | — | FC-5、A-13、A-14 |
| **P0** | **冻结契约回归**：全部 59 项单测 + 4 个 e2e spec 通过 | **既有测试零改动**（Q2 / Q11 均已拍板为「不改测试」） | 全部 | US-09-3/4 |
| **P0** | 四态规范（加载/空/错误/禁用）与 ≥44px 命中区 | 槽位按钮也须 ≥44px | — | US-10、US-08-1 |
| **P1** | 仓库筛选（类别/稀有度/槽位）+ 排序 + 计数 + 清除筛选 | 纯 UI 态，不入库 | — | US-06-1..4 |
| **P1** | 套装面板：4 套件数进度与已激活效果 | 复用 `SET_DEFS` | — | US-04-3/4 |
| **P1** | 键盘可达性：焦点顺序、focus-visible、Esc 多层关闭、焦点归还 | | — | US-08-2..4 |
| **P1** | 移动端滚动容器修正（`touch-action: pan-y` + `overscroll-behavior`） | 现有全局 `touch-action:none` 风险 | — | US-08-5 |
| **P1** | 配装页换肤快捷入口（浮层） | 复用主题组件 | 主题系统 | US-05-5 |
| **P1** | HUD / 魔盒 / 升级卡牌 / 结算面板的视觉重设计（仅表现层） | 不改数据与选择器 | 令牌层 | US-09-2 |
| **P1** | 主题预览卡（实时渲染迷你预览） | | 主题系统 | US-05-1 |
| **P2** | 第 5 套主题「荒漠孤烟」 | | 主题系统 | — |
| **P2** | 纸娃娃「高亮部位」模式（点击部位名高亮对应槽） | | 纸娃娃 | — |
| **P2** | 装备图标独立缓存层（避免重复生成 SVG） | | 图标 | — |
| **P2** | 玩家自定义主题（CSS 变量编辑器） | 需用户拍板 | — | §8 Q3 |
| **P2** | 纸娃娃换装动画（槽位淡入淡出，非骨骼动画） | | 纸娃娃 | — |
| **P2** | 配装方案预设（保存/切换 Build 预设） | 需新增存档字段 | — | §8 Q6 |
| **P2** | 主题切换过渡动画（颜色插值） | | 主题系统 | — |

---

## 8. 验收标准与待确认问题

### 8.1 冻结契约清单（**必须保持不变**）

> 以下为本次重构的**硬边界**。任何实现分支若触碰其中任一项，必须先取得用户/team-lead 批准。

#### FC-1 ECS 与游戏逻辑接口（完全冻结）

| 项 | 契约 |
| --- | --- |
| ECS 组件 / 系统 / 调度 | `src/ecs/**` 一行不改；`simulateTick` / `renderFrame` 签名不变 |
| 战斗数值 | 不改任何 stat / 词缀 / 套装 / 传奇 / 宝石数值；`contentIntegrity.test.ts` 断言继续通过 |
| 确定性 | `determinism.test.ts` / `fullrunDeterminism.test.ts` / `hardConstraints.test.ts` 继续通过；**不得**在 UI 层引入 `Math.random`（UI 侧随机一律用 `hash32`/`Rng`）；详见 **FC-5.1** |
| CommandBus / GameEventBus | UI 只读订阅，不新增、不改枚举 |
| 渲染 | Pixi 实体配色、战场背景由 `#app` DOM 背景控制，**实体配色不改** |
| 静态源码审查 | 全工程零 `Math.random()`、墙钟白名单固定 6 文件、`bitecs` 仅 `adapter.ts` 可 import —— 详见 **FC-5** |

#### FC-2 存档结构兼容性

| 项 | 契约 |
| --- | --- |
| `SaveData.version` | 保持 `1`，不升级 |
| 既有字段 | `meta.*` 全部既有字段的**名称、类型、语义不变**；`meta.settings` 既有 6 字段不变 |
| 新增字段 | 仅允许在 `meta.settings` 下新增**可选**字段（`theme?`）；不得改动 `loadouts` / `warehouse` / `cube` / `legendaryGems` / `materials` 结构 |
| 落盘结构 | `saveContract.test.ts` 断言顶层键仍为 `['meta','perPlayerRunStats','version']`，且序列化结果**不含** `world`/`entities`/`simTick` |
| 容量 | 序列化后 < 80KB（UTF-8）；超限行为不变 |
| 归属 | `sanitizeForLocal` 逻辑不变；主题属 `meta`（玩家私有） |

#### FC-3 e2e 选择器契约（DOM 结构不可随意更改）

> 来源：`tests/e2e/*.spec.ts` 与 `tests/e2e/helpers/hudProbe.ts` 全量扫描。以下选择器**必须继续存在且语义不变**（可增加子元素、不可改名/移除/改变层级归属）。

| 选择器 | 出处 | 语义要求 |
| --- | --- | --- |
| `.scene--boot` `.scene--menu` `.scene--select` `.scene--result` `.scene--settings` | 全部 e2e | 场景覆盖层根节点 |
| `.boot-title`（文本"无双"） `.boot-enter` `.menu-title`（文本"无双"） | appFlow | 首屏元素与文案 |
| `.menu-panel button.primary`（文本"开始征战"） | appFlow / qaRegression | 主行动按钮 |
| `.select-panel button.primary` | appFlow | 选将页主按钮 |
| `.general-grid .general-card`（≥40 个） `.general-name` `.general-portrait`（`src` 必须是 `data:image/svg+xml` data URL，`naturalWidth>0`） | appFlow | **武将头像必须继续用 data URL，不得改为外链** |
| `.hint`（含"已选："） | appFlow | 提示文案 |
| `.hud[data-hud="battle"]` | appFlow | HUD 根节点带 `data-hud="battle"` |
| `.hud .hud__value` / `.hud__line .hud__value` | hudProbe / appFlow | **文本必须仍以"击杀"/"积分"/"Lv."前缀且可解析为数字**；HP 形如 `123 / 456`；时间形如 `01:23` |
| `.hud__bar-fill--exp` | hudProbe | 经验条填充（`style.width` 百分比） |
| `.touch-controls` `.joystick.touch-control` `.skill-button.touch-control`（4 个） `.skill-button[data-skill]`（3 个） `.touch-control__auto` `.joystick__knob` | appFlow / mobileTouch | 触控结构；`data-skill` 索引 0..2 |
| `.touch-control` 的 `min-width/min-height ≥44`、`touch-action:none`、`body{touch-action:none}` | appFlow | 命中区与触控 |
| `.touch-controls` 根节点初始 `display:none` | mobileTouch | 战斗外隐藏 |
| `.card` `.card-grid` `.card__name` `.card__desc` `.card__level` `.card__tags` | CardsAndLevelUp / e2e | 升级卡牌结构 |
| `.overlay.ws-levelup` | e2e | 升级弹层根 |
| `.result-panel` `.result-panel .result-lines`（含"积分/击杀/等级/时长"） `.result-panel button` | hudProbe / e2e | 结算面板与**文案格式**（"时长 123 s"） |
| `.settings-panel .setting-row` `.setting-label` `.chip` `.is-active` `.settings-panel button.primary`（"返回主菜单"） | qaRegression | 设置页结构；`is-active` 类名 |

#### FC-4 既有单测断言（源码级文本断言）

| 测试 | 断言内容 | 约束 |
| --- | --- | --- |
| `src/__tests__/mobileTouch.test.ts` | ① `src/style.css` 含 `--ws-hit-min\s*:\s*44px`；② `src/style.css` 含**连续选择器块** `.hit-target,\s*button,\s*\.hud button,\s*\.touch-control\s*\{[^}]*min-width:\s*var\(--ws-hit-min\)[^}]*min-height:\s*var\(--ws-hit-min\)`（`/s` 标志，跨行）；③ `src/style.css` 中 `.hud{...env(safe-area-inset-top`、`\.overlay{...env(safe-area-inset-`；④ **`src/registration/presentation.ts`** 含 `.touch-controls \.joystick\{[^}]*env\(safe-area-inset-left` 与 `.touch-controls \.skill-cluster\{[^}]*env\(safe-area-inset-right` | **①②③ 必须保留在 `style.css` 中（不得迁移到别处）**；④ **已拍板**：以独立常量 `TOUCH_SAFE_AREA_CSS` 留在 `presentation.ts`（§6.2.3），**测试零改动** |
| `src/__tests__/mobileTouch.test.ts` | `TouchControls` DOM 结构（`.joystick__knob` 数量、`.skill-button[data-skill]` 数量、初始 `display:none`、`setPointerCapture` 多指、12px 瞄准阈值） | 结构与行为不变 |
| `src/game/__tests__/saveContract.test.ts` | 默认存档 <80KB；超限拒绝；顶层键集合；版本/损坏容错；节流 2000ms；QuotaExceededError 上报 NetEvent(a=2) | 全部不变 |
| `src/data/__tests__/contentIntegrity.test.ts` | 内容配置表完整性 | 不变 |
| `src/__tests__/battleSessionFlow` / `combatLoop` / `skillSlotRouting` / `qaSkillRouting` / `qaCombatRegression` | 战斗与技能流程 | 不变 |
| `src/core/__tests__/adapter.test.ts` `src/net/__tests__/*` | ECS 适配器、快照契约、Loopback | 不变 |

> **额外约束**：`style.css` 与 `presentation.ts` 的 CSS 文本**只能增不能删**（针对被断言的选择器而言）；`style.css` 中 `.hit-target, button, .hud button, .touch-control` 的**连续四选择器块顺序**必须保留。

#### FC-5 静态源码审查约束（`hardConstraints.test.ts` 第 6 组）

> 该测试会**扫描 `src/` 下全部非 `__tests__` 的 `.ts` 文件**做正则静态审查。任何新增 UI 文件都会被扫描到，**无一例外**。

| # | 审查项 | 测试断言 | 对本次重构的约束 |
| --- | --- | --- | --- |
| FC-5.1 | **`Math.random()` 调用** | `expect(offenders).toEqual([])`（全工程零命中） | 主题配色、纸娃娃轮廓、装备图标、辉光/噪点效果**一律静态配置化**（写死色值 / 查表 / `hash32` 确定性派生），**不得**运行时随机生成。任何"每次打开颜色略不同"的想法一律否决 |
| FC-5.2 | **墙钟读取白名单** | 仅允许 6 个文件出现 `Date.now(` / `performance.now(`：`src/app/App.ts`、`src/game/SaveSystem.ts`、`src/game/scenes/index.ts`、`src/ui/HUD.ts`、`src/registration/presentation.ts`、`src/ecs/systems/RenderSystems.ts`；其余文件命中即 `offenders` 非空 → 测试失败 | **主题系统与纸娃娃一律不读墙钟**。本次新增的 UI 文件（纸娃娃 / 图标 / 主题 / 预览浮层 / 拖拽）**不得**调用 `Date.now()` 或 `performance.now()`。<br>⚠️ 特别提示：**拖拽换装**若需要"长按 ≥400ms"计时，**不能**用 `Date.now()` 计时——应改用**纯计数器**（如累计 `pointermove` 事件次数或 `setTimeout`）或把计时逻辑放在**已获白名单**的文件内。`setTimeout` 本身不触发该断言（正则只匹配 `Date.now(` / `performance.now(`） |
| FC-5.3 | **bitECS 直连** | `expect(offenders).toEqual(['src/ecs/bit/adapter.ts'])` | 新 UI 代码**零 ECS 直连**：`src/ui/**` 与新增文件**不得** `import ... from 'bitecs'`。纸娃娃、图标、主题、预览均不触碰 ECS 世界 |
| FC-5.4 | **逻辑层不读 quality** | 逻辑层根目录（`src/core`、`src/data`、`src/net`、`src/ecs/systems`、`src/registration/systems.ts`）中不得出现 `quality` 字样 | 本次改动不进入逻辑层，故天然满足；若未来把主题/画质耦合进逻辑层则违规 |

> **实现推论（架构师须知）**：
> 1. 主题切换是**纯 CSS 变量替换**（`data-theme` 属性），**不需要**任何计时器或随机数 —— 这与 FC-5.1 / FC-5.2 天然契合。
> 2. 装备图标与纸娃娃轮廓必须**确定性生成**：同一 `defId` / `slotId` 永远得到同一张 SVG。用 `hash32(id)` 派生形状参数（复用 `src/core/Rng.ts`），或直接用查表写死的几何参数。
> 3. 若新增文件确实需要墙钟（如拖拽长按计时），**必须**同步修改 `hardConstraints.test.ts` 的白名单 `Set`——这是**修改既有测试**，需用户批准（见 §8 Q11）。**推荐改法：避免使用墙钟**，用事件计数实现长按判定。

### 8.2 总体验收清单

- [ ] **A-1** `npm run build` 成功；`vite preview` 打开后 Boot → Menu → Select → Battle → Result 全流程可用，无 404、无 `console.error`、无 `pageerror`。
- [ ] **A-2** 全部既有单测通过（59 项），既有 e2e 4 个 spec 全部通过，**无新增失败**。
- [ ] **A-3** `grep -n "EXTRA_CSS" src/registration/presentation.ts` **无结果**（常量整个删除）；文件中仅保留独立命名的 `TOUCH_SAFE_AREA_CSS`（4 行，带注释说明其为 `mobileTouch.test.ts` 的源码文本契约），且 `mobileTouch.test.ts` **零改动**仍通过。
- [ ] **A-4** 冻结契约清单 FC-1 ~ FC-5 逐条自检通过，并附一份**对照表**（选择器 → 新旧是否一致 → 结论）。
- [ ] **A-5** 4 套主题在 6 个场景 + HUD + 配装 + 魔盒 + 卡牌 + 触屏控件下均正确换色；切换后刷新页面主题保持。
- [ ] **A-6** 用旧存档（手写一份缺 `theme` 的 localStorage）加载，主题回退 classic，**其余存档数据不丢失**。
- [ ] **A-7** 纸娃娃 13 槽全部可见、位置正确、无重叠；1280×720 与 390×844 两种视口下均通过。
- [ ] **A-8** 预览浮层在 4 个角落触发时均完整可见于视口内。
- [ ] **A-9** 拖拽换装：拖到兼容槽成功、拖到非槽位无副作用、覆盖旧装备时旧装备回到仓库（可数仓库数量验证）。
- [ ] **A-10** 所有交互元素命中区 ≥44px（用 `getComputedStyle` 抽检，方式同 `appFlow.spec.ts`）。
- [ ] **A-11** 纯键盘完成一次完整换装流程（Tab → Enter 选中 → Enter 装备 → Esc 关闭）。
- [ ] **A-12** `git diff` 显示 **零** `src/ecs/**`、`src/data/**`、`src/game/SaveSystem.ts` 的非预期改动。
- [ ] **A-13** 新增的 UI 文件**零** `Math.random(` 调用、**零** `Date.now(` / `performance.now(` 调用、**零** `from 'bitecs'` import（可 `grep` 自查）；`hardConstraints.test.ts` 的「静态源码审查」4 条断言继续通过。
- [ ] **A-14** 主题切换与纸娃娃渲染**完全确定性**：同一 `themeId` / `slotId` / `defId` 连续渲染 3 次产出的 SVG `data:` URL **逐字节相同**（用 `hash32` 派生形状，禁用随机）。

### 8.3 待确认问题（需用户拍板）

| # | 问题 | 选项 | 推荐 | 影响 |
| --- | --- | --- | --- | --- |
| **Q1** | 纸娃娃的 13 槽与人体部位的**映射方案**是否认可？（本文 §3.3：肩甲/护腕/手套/腰带/护腿/靴子/戒指均为「双侧共享单槽」） | A. 认可本文映射；B. 双侧槽拆成左右两个可分别装备（会使槽位数从 13 → 17+，**与 DESIGN §8.4 的 13 槽冲突**，需改配置表）；C. 认可映射但允许「左右手武器」位置更对称 | **A** | 决定纸娃娃坐标表与图标形态 |
| **Q2** | 移除 `EXTRA_CSS` 会打破 `mobileTouch.test.ts` 对 `presentation.ts` 的源码文本断言。如何处置？ | A. 把两条 safe-area 规则**提取为独立命名常量 `TOUCH_SAFE_AREA_CSS`** 留在 `presentation.ts`，`EXTRA_CSS` 整个删除，其余迁出 → 测试零改动；B. 全部迁至 `touch.css` 并**同步修改该测试**；C. 不迁（则 P0 的坏味道清理不成立） | **A（✅ 已由 team-lead 拍板）** | 见 §6.2.3 完整解法与代码示例；A-3 验收同步更新 |
| **Q3** | 是否需要支持**玩家自定义主题**（自由调色）？ | A. 本期不支持，仅 4 套内置（P2 留接口）；B. 本期支持（需要主题编辑器 UI + 存档存 6~10 个自定义色值 + 校验） | **A** | 影响 P2 范围与存档结构 |
| **Q4** | 主题数量确认：**4 套**够不够？是否要第 5 套？ | A. 4 套（classic/ink/neon/sakura）；B. 5 套（加「荒漠孤烟」）；C. 3 套 | **A（P2 预留第 5 套）** | 影响主题系统工作量 |
| **Q5** | 换肤是否包含**战场内 Pixi 实体配色**（武将/敌人/子弹）？ | A. **不包含**（仅 DOM UI 层）；B. 包含（需要给 Palette 加主题维度，改动面大且可能影响战斗可读性） | **A** | 决定是否触碰 `src/art/Palette.ts` 与视觉基线 |
| **Q6** | 是否需要「配装方案预设 / Build 存档槽」？ | A. 本期不做；B. 做（需在 `meta` 新增 `loadoutPresets` 结构） | **A（本期不做）** | 存档结构影响 |
| **Q7** | 纸娃娃是否需要**换装动效**（装备时槽位淡入）？是否需要**骨骼动画 / 3D**？ | A. 仅静态人形 + 轻量淡入（P2）；B. 需要骨骼动画（需引入动画管线，**超出纯前端无资源约束**，建议否决） | **A** | 决定是否需要动画系统 |
| **Q8** | 装备图标风格确认：**程序化 SVG**（几何化、非写实）可接受吗？ | A. 接受（沿用 `PortraitFactory` 的程序化路线，与武将头像风格一致）；B. 需写实素材（需美术外包，**与 NG-3 冲突**） | **A** | 决定图标实现路线 |
| **Q9** | 仓库列表在 200 件满载时是否需要**虚拟滚动**？ | A. 需要（`content-visibility` 或简单窗口化）；B. 不需要（折叠分组 + 筛选已够用） | **A（用 `content-visibility: auto` 低成本方案）** | 影响仓库渲染性能 |
| **Q10** | 配装界面的**默认进入位置**是主菜单的「装备」按钮，还是战斗结算后自动打开？ | A. 保持现状（主菜单入口）；B. 结算后提供「查看配装」快捷入口 | **A（现状）+ B 作为 P2** | 影响场景跳转逻辑 |
| **Q11** | 拖拽长按（≥400ms）判定需要计时。是否允许**新增 UI 文件进入墙钟白名单**（改 `hardConstraints.test.ts`）？ | A. **不新增白名单**：长按判定改用**事件计数 / `setTimeout`** 实现（`setTimeout` 不触发该断言）；B. 允许把新文件加入白名单（**需修改既有测试**，需用户批准） | **A（✅ 已由 team-lead 拍板：长按 400ms 用 `setTimeout` 实现，`hardConstraints.test.ts` 不改）** | `hardConstraints.test.ts` 保持零改动 |
| **Q12** | 纸娃娃人形轮廓与装备图标的具体**风格**（写实剪影 / 几何图标 / 简笔小人）？ | A. 几何化图标风（与 `PortraitFactory` 现有程序化风格一致）；B. 写实剪影（需手工绘制更多路径，工作量上升但更"人形"） | **A（✅ 已由 team-lead 拍板：几何化图标风）** | 决定 `src/art/` 新增文件的复杂度 |

---

## 9. 风险与依赖

### 9.1 风险登记表

| # | 风险 | 概率 | 影响 | 缓解措施 | 触发信号 |
| --- | --- | --- | --- | --- | --- |
| R-1 | **CSS 拆分打破 `mobileTouch.test.ts` 的源码文本断言** | 中（已缓解） | 高（单测红） | **已拍板解法**：独立常量 `TOUCH_SAFE_AREA_CSS` 留在 `presentation.ts`（§6.2.3），`EXTRA_CSS` 整个删除；拆分后**先跑** `mobileTouch.test.ts` 再继续 | `npm test` 出现 `style.css`/`presentation.ts` 匹配失败 |
| R-2 | **e2e 选择器被"优化"掉**（如把 `.hud__value` 拆成新类、把 `.general-portrait` 改为外链图片） | 中 | 高（e2e 红） | 把 FC-3 清单贴在开发 PR 描述里；改前先跑 e2e | e2e `locator(...).toBeVisible()` 超时 |
| R-3 | **全局 `touch-action: none` 导致移动端仓库列表无法滚动** | 中 | 中 | 为可滚动容器显式 `touch-action: pan-y` + `overscroll-behavior: contain` | 真机手测列表滚不动 |
| R-4 | 主题切换遗漏某些硬编码色（尤其 `presentation.ts` 的 `EXTRA_CSS` 内的 `#e8b84b` 等） | 高 | 中 | 拆分后 grep 裸色值；建一条 lint 脚本（可选）断言 `styles/` 外无裸色值 | 切主题后某元素仍是原色 |
| R-5 | 存档加字段导致**旧档读取报错**（若误用必填属性 + 非 strict 编译会报 undefined） | 低 | 高（旧档丢失） | `theme?` 必为可选 + 读取侧 `?? 'classic'` + 防御性 `resolveTheme()` | 加载旧档后主题空白 |
| R-6 | 纸娃娃锚点在小屏 / 缩放下**槽位重叠或溢出** | 中 | 中 | 百分比定位 + `translate(-50%,-50%)`；为 `320px`~`420px` 区间做 3 档断点 | 截图目视检查 |
| R-7 | 拖拽实现引入 **PointerEvent 兼容问题**（现有测试用 jsdom 合成事件，且项目已禁用 `Math.random`） | 中 | 中 | 拖拽用 `pointerdown/move/up` + `setPointerCapture`（与 `TouchControls` 同套路）；不引入随机 | 移动端拖拽无响应 |
| R-8 | 预览浮层**遮挡被悬停元素**或溢出视口 | 中 | 中 | 边缘翻转 + `pointer-events:none` 于浮层本体（仅按钮可交互） | 浮层挡住槽位 |
| R-9 | 大量仓库条目渲染**卡顿**（200 件 × 复杂 SVG 图标） | 中 | 中 | 图标生成结果按 `defId` **缓存复用**（`Map`）；列表用 `content-visibility` | 打开配装界面掉帧 |
| R-10 | **范围蔓延**：本次重构被当作"重做整个游戏" | 中 | 中 | 严守 §1.2 非目标；任何新需求走 §8 Q 拍板 | 出现后端/素材/玩法相关需求 |
| R-11 | 拖拽换装**误触**导致误装备（尤其移动端长按与滚动冲突） | 中 | 中 | 长按阈值 400ms + 移动阈值 8px 判定为滚动；未达阈值不进入拖拽 | 滚动列表时误换装 |
| R-12 | 主题对比度不足（T2 墨韵为**浅底**，现有 UI 是深底假设） | 中 | 中 | T2 必须**重定义**阴影/边框/面板底，而非简单反色；对比度目标 WCAG AA（正文 ≥4.5:1） | T2 下文字发飘 |
| R-13 | **新增 UI 文件误用 `Math.random()`**（如"每件装备随机生成一点色差/花纹"） | 中 | 高（`hardConstraints.test.ts` 静态审查红） | 图标/轮廓全部**查表或 `hash32` 确定性派生**；提交前按 §9.3 的 grep 命令自查 | `hardConstraints.test.ts` 第 6 组失败 |
| R-14 | **新增 UI 文件误用 `Date.now()` / `performance.now()`**（拖拽长按计时是高发点） | 低（已缓解） | 高（静态审查红） | **已拍板**：长按 400ms 用 `setTimeout` 实现（Q11 方案 A），**不改** `hardConstraints.test.ts` 白名单 | 静态审查「墙钟只出现在帧驱动/渲染/UI/存档节流入口」失败 |
| R-15 | 新 UI 文件**误 import `bitecs`**（如想直接读实体装备状态） | 低 | 高（静态审查红） | UI 一律走 `SaveData` / `config` / `Registry` 读数据；不碰 ECS 世界 | `offenders` 多出 UI 文件路径 |
| R-16 | `EXTRA_CSS` 迁移后 `presentation.ts` **仍残留**大段样式字符串（重构不彻底） | 中 | 中 | 验收项 A-3：`grep -n "EXTRA_CSS" src/registration/presentation.ts` 应无结果；允许残留的仅 `TOUCH_SAFE_AREA_CSS`（4 行，须带注释） | 代码审查发现残留 |

### 9.2 依赖关系

```
[令牌层 tokens.css + themes.css]
        │
        ├──────────────► [主题系统] ──────────► [主题持久化 + 旧档兼容]
        │                     │
        │                     └────────────► [配装页换肤快捷入口 P1]
        │
        ├──────────────► [CSS 拆分 / EXTRA_CSS 移除]（依赖 Q2 决策）
        │
        ├──────────────► [程序化装备图标]
        │                        │
        │                        └──► [纸娃娃槽位渲染] ──► [预览浮层]
        │                                     │                    │
        │                                     ├──► [拖拽换装]       │
        │                                     ├──► [详情/试算重构]  │
        │                                     └──► [套装面板 P1]    │
        │
        └──────────────► [HUD / 魔盒 / 卡牌 / 结算 视觉重设计 P1]
```

**外部依赖**：**无**。本次改造不需要后端、CDN、第三方 UI 库、图标字体包或任何外部素材。所有图标由代码生成（SVG data URL），所有样式为项目内 CSS 文件。

**内部依赖（既有代码，只读或微调）**：
- `src/art/Palette.ts` — 复用 `colorToCss` / `shade` / `mixColor`（**只读**，不改）
- `src/art/PortraitFactory.ts` — 复用武将头像 data URL 机制
- `src/data/equipment.ts` — 只读 `SLOT_DEFS` / `RARITY_DEFS` / `SET_DEFS` / `LEGENDARY_EFFECT_DEFS`
- `src/data/stats.ts` — 只读 `AFFIX_POOL` / `findStat`
- `src/ui/EquipmentUI.ts` — 主要改造对象（`statsOf` / `equip` / `unequip` 逻辑保留，渲染层重写）
- `src/game/SaveData.ts` — 新增**可选** `theme` 字段
- `src/registration/presentation.ts` — 移除 `EXTRA_CSS`，只保留装配逻辑
- `src/core/Rng.ts` — 复用 `hash32` 做**确定性**图标/轮廓派生（**不用 `Math.random`**）
- `src/ecs/__tests__/hardConstraints.test.ts` — 静态审查的 4 条断言是**红线**（FC-5）；除非 §8 Q11 批准，**不修改**

### 9.3 建议实施顺序（供架构师参考）

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| **S0** | 令牌层 + 主题系统（含持久化 + 旧档兼容） | 4 套主题可切、可持久化、旧档不炸；**零 `Math.random` / 零墙钟** |
| **S1** | CSS 拆分（`EXTRA_CSS` **整个删除** → `src/ui/styles/`），`presentation.ts` 只留逻辑 + `TOUCH_SAFE_AREA_CSS` | `grep -n "EXTRA_CSS" src/registration/presentation.ts` 无结果；`TOUCH_SAFE_AREA_CSS` 存在且带注释；**先跑 `mobileTouch.test.ts`** 再继续 |
| **S2** | 程序化装备图标 + 纸娃娃布局（**确定性生成**，同一 id 产出同一 SVG） | 13 槽在 2 种视口下位置正确；A-14 逐字节一致性通过 |
| **S3** | 仓库筛选/排序 + 详情/试算重构 | US-06、US-07 全通过 |
| **S4** | 预览浮层 + 拖拽换装（长按判定用**事件计数/`setTimeout`**，不读墙钟） | US-02、US-03 全通过；静态审查仍绿 |
| **S5** | HUD / 魔盒 / 卡牌 / 结算 视觉重设计 | 视觉令牌全覆盖 |
| **S6** | 回归：59 单测 + 4 e2e + 冻结契约自检表（含 FC-5 静态审查） | A-1 ~ A-14 全通过 |

> 每阶段结束都应执行 `npm test` 与 e2e，**红灯不进入下一阶段**。S0–S4 期间每阶段额外跑一次静态自查。**范围已按 FC-5.2 修正**：不含 `src/registration/presentation.ts`（本身在墙钟白名单内）；`bitecs` 匹配同时覆盖单引号与双引号写法。
>
> ```bash
> # 搜索范围：新增/改动最集中的 UI 与美术目录
> # 排除：FC-5.2 墙钟白名单文件 HUD.ts / SaveSystem.ts / scenes-index.ts
> grep -rnE "Math\.random\(|Date\.now\(|performance\.now\(|from ['\"]bitecs['\"]" \
>   src/ui src/art src/game \
>   --exclude=HUD.ts --exclude=SaveSystem.ts --exclude=index.ts
> ```
>
> 期望结果：**零命中**（当前实测已为零命中）。
> **注意**：`--exclude=index.ts` 会同时排除 `src/game/scenes/index.ts`（白名单文件）。若日后在 `src/game/scenes/` 下新增文件，需改为逐文件核查。

---

## 附录 0：已拍板决策记录（Decision Log）

| # | 问题 | 决策 | 决策人 | 影响章节 | 落地约束 |
| --- | --- | --- | --- | --- | --- |
| **D-1** | Q2 `EXTRA_CSS` 移除与 `mobileTouch.test.ts` 源码文本断言冲突 | **方案 A（独立常量）**：两条 safe-area 规则提取为 `TOUCH_SAFE_AREA_CSS` 留在 `presentation.ts`；`EXTRA_CSS` **整个删除**；其余 CSS 迁至 `src/ui/styles/` | team-lead | §6.2.1 B-1、§6.2.3、§8.1 FC-4④、§8.2 A-3、§8.3 Q2 | 既有测试**零改动**；`grep "EXTRA_CSS"` 无结果；`TOUCH_SAFE_AREA_CSS` 须带注释 |
| **D-2** | Q11 是否新增 UI 文件到墙钟白名单 | **方案 A**：不新增、不改 `hardConstraints.test.ts`；长按 400ms 用 **`setTimeout`** 实现 | team-lead | §8.1 FC-5.2、§7 P0、§9.1 R-14、§9.3 S4 | `setTimeout` 不触发 `/Date\.now|performance\.now\s*\(/` 正则 |
| **D-3** | Q12 纸娃娃轮廓 / 装备图标风格 | **方案 A**：**几何化图标风**，与 `PortraitFactory` 现有程序化风格一致 | team-lead | §3.2、§3.3、§5、§8.3 Q12 | 图形参数用查表或 `hash32` 确定性派生（**零 `Math.random`**） |
| **D-4** | A-14 程序化图标确定性验收 | **保留** | team-lead | §8.2 A-14 | 同一 `themeId`/`slotId`/`defId` 连续渲染 3 次产出 SVG data URL **逐字节相同** |
| **D-5** | 静态自查 grep 范围修正 | 范围 `src/ui src/art src/game`，排除白名单文件 `HUD.ts`/`SaveSystem.ts`/`index.ts`；`bitecs` 匹配覆盖单/双引号 | team-lead | §9.3 | 命令见 §9.3 代码块；期望零命中 |

> **状态**：PRD 于本轮**定稿**。架构方案（`docs/ARCH_UI_REFACTOR_DRAFT.md`）若与本文冲突，以架构方案为准，并回到本文做一次回写。

---

## 附录 A：现状 → 目标对照（纸娃娃部分）

| 现状（`EquipmentUI.ts` L172–191） | 目标 |
| --- | --- |
| `div.paper-doll` 内是 `div.slot-grid`（4 列按钮网格） | `div.paper-doll` 内是 `svg.doll-figure`（人形轮廓）+ 13 个绝对定位的 `button.doll-slot[data-slot]` |
| 槽位按钮文本为 `头盔` 或 `头盔✓` | 槽位按钮内为 `img.doll-slot__icon`（SVG data URL）+ 空槽时灰度占位 + `aria-label` |
| 稀有度仅通过仓库条目的 `.rarity-*` 文字颜色体现 | 槽位与仓库条目**均**使用边框 + 底色 + 辉光三重编码 |
| 无图标 | 13 槽各一款程序化 SVG 图标（按 `SLOT_DEFS` 顺序缓存） |
| 无悬停预览 | `.item-preview` 浮层（桌面）/ 底部抽屉（移动） |
| 无拖拽 | 拖拽换装 + 兼容槽高亮 |
| 仓库按 3 类折叠，无筛选/排序 | 折叠保留 + 筛选行 + 排序 + 计数 |
| 详情区 `.item-detail` 为面板底部一条横排 | `.equip-detail` 右栏（或移动端抽屉），分 6 个区块 |

## 附录 B：主题 CSS 骨架示例

```css
/* tokens.css —— 唯一允许出现裸色值的文件 */
:root {
  /* T1 经典三国 = 当前视觉基线 */
  --ws-bg-canvas:#100b07; --ws-bg-surface:#2c2014; --ws-bg-raised:#3c2c1b;
  --ws-border:rgba(232,184,75,.62); --ws-border-strong:#f6dda0;
  --ws-primary:#e8b84b; --ws-on-primary:#1a1107; --ws-accent:#8ce8ff;
  --ws-text:#f4e7c8; --ws-text-muted:rgba(244,231,200,.65);
  --ws-danger:#ff8a80; --ws-stat-up:#8ce8ff; --ws-stat-down:#ff8a80;
  --ws-slot-empty:rgba(232,184,75,.28);
  --ws-rarity-common:#ddd; --ws-rarity-blue:#8dc6ff;
  --ws-rarity-gold:#f3c744; --ws-rarity-legendary:#ff9d3f;
  /* 间距 / 圆角 / 阴影 / 字号 / 动效 …见 §6.3 */
  --ws-hit-min:44px;            /* 冻结 */
}

/* themes.css */
[data-theme='ink']   { --ws-bg-canvas:#e8e2d4; --ws-bg-surface:#f6f1e4; /* … */ }
[data-theme='neon']  { --ws-bg-canvas:#0a0a14; --ws-bg-surface:#141428; /* … */ }
[data-theme='sakura']{ --ws-bg-canvas:#fdf7f3; --ws-bg-surface:#ffffff; /* … */ }
```

```ts
// 切换（无 DOM 重建，仅改根属性）
document.documentElement.dataset.theme = resolveTheme(save.meta.settings.theme);
```

---

*本文档为增量 PRD，不替代 `docs/PRD.md`。所有待确认项（§8.3）经用户拍板后，应回写本文并标注决策日期与结论。*
