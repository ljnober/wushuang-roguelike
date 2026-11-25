# 《无双》设计稿 — 纯前端三国 Roguelike 割草游戏

> 本文件是《无双》项目的完整目标设计稿，供执行会话使用。
> 工作目录：`C:/Project/WS`（空目录，从零开发）。
> 执行方式：完整读取本文档，按第 12 节「实施阶段」P0 → P8 顺序推进；所有架构约束（第 2 节）为硬性要求，尤其「性能与游戏性解耦」。开发过程中对设计的任何修改，直接更新本文档对应章节，保持单一事实来源。

## 1. 项目概述

- 纯 Web 前端、无后端；浏览器 localStorage 存储全部数据；产物为可静态部署的静态包。
- 游戏名 **无双**；三国题材 roguelike 割草；初始可选 **40 位武将**；手机端友好（虚拟摇杆 + 技能按钮 + 响应式 UI）。
- 大量弹幕场景，渲染采用 **PixiJS v8**（WebGPU 优先，自动降级 WebGL；无 GPU 上下文时启用渲染低配模式——只改变渲染实现，不改变游戏逻辑）。
- 美术全部由**代码程序化生成矢量 Q 版形象**，无外部图片素材；40 将通过阵营配色、发型/头饰、胡须、武器、纹样参数化区分。
- 架构：**ECS（bitECS）**，战斗全实体化；效果与属性结算拆为组件与系统；**联机就绪（network-ready）**——PvE 合作、主机权威 + 状态同步、本地 AI 影子玩家模拟；渲染满帧 + 逻辑固定 tick + 插值。

## 2. 设计原则

### 2.1 时间：渲染满帧 + 逻辑固定 tick + 插值

- **渲染帧**：跟随刷新率满帧（60/120/144Hz），只做插值不参与模拟。
- **逻辑 tick**：固定步长，全局统一 60Hz（tickDt=1/60），属于游戏规则常量，**与设备性能、画质档位无关**。accumulator 模式：`acc += rawDt`；`while(acc>=tickDt){step(tickDt);simTick++;acc-=tickDt}`；`alpha=acc/tickDt`。
- **不跳过任何 tick**：逻辑 tick 序列完整执行，不设丢弃上限、不因帧率低削减。设备算力不足时游戏按自身 tick 节奏推进（整体慢动作），但世界演化序列与高性能设备逐 tick 一致——敌人数量、波次、掉落、伤害完全不变。
- **确定性**：相同 `(roomSeed, 输入序列)` → 逐 tick 完全一致；渲染帧抖动、设备性能、画质档位均不影响逻辑结果。
- **插值**：每 tick 积分前存 `x→px, y→py`；渲染时 `renderX=px+(x-px)*alpha`。传送/生成调用 `snapInterpolation` 防拖影。px/py 同时供扫掠碰撞使用（线段 `[px,py]→[x,y]` 为单 tick 位移）；碰撞只在 tick 粒度计算。

### 2.2 性能与游戏性解耦（硬性约束）

- **游戏性参数一律固定**：敌人生成速率与同屏数量、弹幕数量与速度、掉落表与掉率、伤害与数值、波次时间轴、BOSS 行为——全部由配置与 tick 决定，任何设备、任何帧率、任何画质档位下完全一致。
- **性能指标只描述渲染**：FPS 目标、分辨率、特效密度属于渲染质量，不作为削减游戏内容的手段。达不到 FPS 目标时优化渲染实现，不得减少敌人或弹幕、不得改变刷怪节奏。
- **渲染裁剪不影响逻辑**：Culled 实体仅跳过绘制，仍完整参与 AI、碰撞、伤害、掉落等全部系统。
- **实体容量 CAP 固定**：由游戏设计上限（波次表最大同屏敌人数 + 弹幕上限 + 特效余量）决定，所有设备统一，不随画质档位变化；CAP 不足属于设计缺陷，调高 CAP 而非削减实体。
- **低配模式仅指渲染降级**：如用普通 Sprite 池替代 ParticleContainer、降低渲染分辨率与特效密度，不改变任何逻辑参数。

### 2.3 内容：全配置化 + 注册表

- 武将、敌人、技能、槽位、稀有度、词缀、套装、特效、宝石、BOSS、波次、模式、掉落、材料、乘区、来源优先级——全部由配置定义；新增内容主要加配置，不改核心代码。
- 结构规则也配置化（槽位数、稀有度档、词缀池、宝石品级、材料、乘区类型）；引擎只处理通用 `Item / Modifier / Stat` 结构。
- `Registry<T>` 提供 `get(id)/all()/validate()`；内容按 content pack 模块化，启动时统一注册。

### 2.4 ECS：单 World 战斗 + 桥接层

- 单主战斗 World（`battleWorld`），逻辑/效果/属性实体同处其中，用**标签组件**分区（零成本）。UI/菜单使用 DOM，不进 ECS。
- 零分配桥接：DOM→ECS 用 `CommandBus`（`Int32Array` 环形队列，命令带 playerId）；ECS→DOM 用 `GameEventBus`（`Float32Array`+`Int32Array` 双环，数字事件枚举）。
- 扩展点：多 World 共享 eid 空间（`createEntityIndex()`）。

### 2.5 技术约束

- 采用 **bitECS 0.4.0（锁定版本）**：SoA typed array 组件由 `defineSoA` 工厂自行 `new Float32Array(CAP)`；**0.4.0 真实 API 与早期 0.3.x 心智模型不同**，以下为已核实口径（详见 `docs/ARCHITECTURE.md` §1.2）：
  - core 中无 `defineComponent`/`Types`、无 `enableManualEntityRecycling`/`flushRemovedEntities`；组件是普通 SoA 对象，须 `registerComponents(world, comps)` 显式注册。
  - `createWorld(...args)`，传 `createEntityIndex()` 可共享 eid 空间；`addComponent(world, eid, Comp)` 参数顺序为 world→eid→组件。
  - 实体回收用 `removeEntity(world, eid)` + `commitRemovals(world)`，由 `EntityPool` 维护空闲 eid 栈；`createEntityIndex()` 默认关闭 versioning（与「禁用 eid versioning」约束一致）。
  - `query(world, terms, asBuffer)`、`noCommit`、`observe`、`createRelation`/`getRelationTargets` 为 0.4.0 可用接口。
- `src/ecs/bit/` 集中定义组件工厂、类型别名与公共常量；**所有 bitECS 调用只允许出现在 `src/ecs/bit/adapter.ts`**，业务层禁止直接 `import 'bitecs'`，保持调用方式统一。
- typed array 容量 CAP 由游戏设计上限（波次最大同屏敌人数 + 弹幕上限 + 余量）统一分配，所有设备一致；warm-up 断言 `eid < CAP`；禁用 eid versioning（会导致 eid 暴涨越界）。
- **eid 永不上线**：网络层一切使用 NetId。

### 2.6 联机就绪范围

- 目标形态：PvE 合作（2–4 人组队割草/共打 BOSS），玩家互为友军，敌人 AI 支持多目标。
- 权威模型：主机权威 + 状态同步。Host 跑全量模拟并广播快照，客户端发输入、做预测与和解。严格确定性只需在 Host 上成立，跨浏览器浮点 bit 级一致不作为目标。
- 本次交付范围：多玩家实体模型、控制源抽象、权威与同步接口、本地 AI 影子玩家 + Loopback 模拟；网络协议实现（WebRTC/WS）仅定义接口边界，不实现。
- 原则：凡本地模拟无法覆盖、无法测试的网络能力不纳入实现。

## 3. ECS 组件设计

SoA typed array 字段；标签组件为空对象；关系组件用 `createRelation()`。

| 组 | 组件（字段） |
| --- | --- |
| 变换运动 | `Position{x,y,px,py}`、`Velocity{x,y}`、`Heading{angle}`、`Collider{r,type,w,h,layer}`、`Speed{value}` |
| 生命战斗 | `Health{cur,max,regen}`、`Faction{value}`(0玩家/1敌/2中立)、`Attack{damage,rate,cd,range}`、`Damage{amount,flags}`、`Invulnerable{remaining}`、`ExpValue{value}` |
| AI | `AIState{state,timer,target,policy,retargetTimer,targetNetId}`、`Behavior{type,p0,p1,p2}`、`Threat{value}` |
| 弹幕掉落 | `Projectile{dx,dy,speed,pierce,hitMask}`、`Pickup{kind,amount,cfgId}`、`Magnet{radius}`、`Lifetime{remaining}`、`Dead{}` |
| 渲染 | `RenderRef{slot,kind,z,anim,animT,flipX,tint,scale,alpha,dirty}` |
| 输入 | `InputCmd{moveX,moveY,aimX,aimY,buttons,tick,seq}`、`ControlMode{value}`、`ControlSource{kind,ref}`(0 Local/1 AI/2 Remote) |
| 效果 | `EffectTag`、`TriggerReg{trigger,condMask,paramRef,effectCfgId}`、`ActiveEffect{defId,state,elapsed,cd}`、`Condition{type,cmp,threshold,arg}`、`Action{op,paramRef,paramCount}`、`EffectOwner`/`EffectTarget`/`ChildOf`(relation)、`EffectContext{source,target,hitValue,flags}`、逻辑实体 `effectMask:ui32` |
| 属性 | `Modifier{stat,op,value,bucket,priority,sourceKind,sourceId,group,condMask,duration,flags}`、`ModifierOwner`(relation)、`DirtyStat{mask}`、`StatBlock`(由 stat 配置动态生成字段)、`StatSnapshotRef{poolIndex,version}` |
| 网络 | `PlayerId{value:ui16}`(席位 0–3)、`NetId{value:ui32}`(Host 分配，0 无效)、`Owner{netId,playerId}`、`SpawnTick{value}`、`PlayerTag{}`、`Replicated{}`、`Predicted{}`、`NetControlled{}`、`NetSession{role,localNetId,hostNetId,localPlayerId,roomSeed,simTick,lastAckedTick,tickRate(固定60),playerCount}`(会话单例) |


复杂数据（条件数组、动作参数数组）拆为子实体 + `ChildOf` 关系；参数存外部 `Float32Array`（`ParamPool`），`paramRef` 指向池内偏移。

## 4. 多玩家实体与控制源

- **三类玩家统一表示**：本地真人 / AI 影子 / 远端玩家在 `Health/Attack/StatBlock/EffectOwner/Collider/Position` 等组件上完全一致；Movement/Collision/Damage/Effect/StatResolve 系统一视同仁。差异**仅存在于控制源分发处**。
- 本地真人：`PlayerTag+PlayerId+NetId+Owner(self)+ControlSource{Local}`
- AI 影子：`PlayerTag+PlayerId+NetId+Owner(self)+ControlSource{AI,ref}`
- 远端玩家：`PlayerTag+PlayerId+NetId+Owner(self)+ControlSource{Remote}+NetControlled`
- **控制源抽象**（`src/ecs/systems/control/`）：`IControlSource.poll(tick,out)` 直接写 SoA、零分配。
- `LocalHumanSource`：drain CommandBus。
- `AIShadowPlayerSystem`：自动战斗（寻敌、kiting、按 cd 放技能），使用确定性 Rng（key=`(seed,playerId,tick)`），产出与真人同形状的 InputCmd。
- `RemoteInputSource`：从 `NetInputBuffer` 读取。
- `InputSystem` 为分发器：遍历 `[PlayerId, ControlSource]` 查询，按 kind 取 source 写入 InputCmd。
- **敌人 AI 多目标**：`AIState.policy`（最近/最弱/最高威胁）、`retargetTimer`；遍历 `playerQuery=[PlayerTag,Health,Position]` 按 policy 打分选目标；Boss 按 Threat 加权确定性随机；`targetNetId` 经 EntityRegistry 解析避免 eid 漂移。影子玩家与真人在敌人眼中同为 PlayerTag 目标。
- **影子玩家与真实 AI 敌人彻底分离**：影子 = PlayerTag + 玩家系统 + PlayerAiBrain；敌人 = Faction=1 + AIState/Behavior + EnemyBrain。

## 5. ID 体系、权威模型与同步

- **`EntityRegistry`**（`src/net/EntityRegistry.ts`）：`netIdToEid / eidToNetId / netIdToPlayer` 映射 + Host 空闲 NetId 栈。仅 Host 分配 NetId（`nextNetId++`，spawn 由 seed+tick 驱动保证顺序一致）；晚加入下发全量快照重建映射；回收时清映射；`SpawnTick` 用于快照排序。
- **AuthorityRole FSM**（`src/net/session.ts`）：Standalone → Host → Client / Electing；Host 离开时取剩余最小 netId 者为新 Host（确定性选举）；掉线玩家实体 ControlSource 降级为 AI 影子。
- **同步接口**（`src/net/transport.ts`、`messages.ts`）：`ITransport`（connect/send/onMessage/close）；`NullTransport`、`LoopbackTransport`（本地多人模拟，可注入延迟/抖动/丢包）；WebRTC/WS 接口边界。`NetMsgType`：InputReport / StateSnapshot / EventBatch / Delta / Control。`ISyncStrategy` 提供输入上报、快照构建/应用、事件收集/重放、增量四组方法，Loopback 在同进程对接 Host↔Client 策略。
- **预测与和解**（`PredictionBuffer.ts`、`DeterministicSim.ts`）：一次 tick 的模拟抽成纯入口 `DeterministicSim.step(tick, inputFrame, state)`，Host 与客户端预测共用；客户端维护 `InputHistory / SnapshotHistory` 环形缓冲；收到 tick T 权威快照后重置本地玩家、用缓存输入重放 T+1..当前；小误差 lerp、大误差 snap。
- **确定性保障**：固定 tick；统一 Rng（禁用 `Math.random`，按 `(seed,playerId,tick)` 派生流）；稳定排序；关键处避免 sin/cos 平台差异。

## 6. 效果管线与属性结算

### 6.1 效果管线（触发与行为）

- **声明层**：`EffectDef{trigger, conditions, actions, params}`。触发器：`onHit / onKill / onCast / onDamaged / onMove / onTimer / onDeath / onPickup / onCritical` 等（配置可扩展）。动作：`damage / heal / buffStat / summon / spawnProjectile / area / status / cdReduce / dropItem` 等。
- **注册层**：`EffectRegistry` 以数字 id 注册处理函数；引擎内建通用动作 handler；复杂效果注册自定义 handler，不修改战斗循环。
- **编译层**：`EffectCompileSystem`（开局/换装/升级时调用）读配置，从 `EffectEntityPool` 取预分配实体，填字段、建 `ChildOf`/`EffectOwner` 关系、置宿主 `effectMask`；展开为"主 Effect 实体 + Condition/Action 子实体"。运行期零 `addEntity`、零闭包、零字符串查找。
- **运行层**：`EffectTriggerSystem` 按 trigger 掩码短路；`ActionDispatchSystem` 按 `Action.op` 数字下标 O(1) 分派；全程复用唯一 `EffectContext`。

### 6.2 属性结算系统（StatResolveSystem）

8 阶段结算，数据全在 ECS 组件，算法使用 System 私有复用的 scratch typed array；脏宿主驱动（非每帧）：

```
Stage 0 基础值   : 武将配置 + 局外养成 → StatBlock 初值
Stage 1 收集     : query(Modifier, ModifierOwner) 按 Owner 归入宿主 scratch（稳定顺序）
Stage 2 条件过滤 : condMask & EffectContext.flags，不成立剔除
Stage 3 排序     : Uint32Array 索引按 (sourceOrder → priority → id) 稳定排序
Stage 4 冲突裁决 : OVERRIDE / MUTEX / MAX / MIN 按 group+priority 选唯一胜出者
Stage 5 分桶聚合 : Float32Array(bucketSum) 清零；ADD/SUB 累加 flatSum；MUL 累加 bucketSum[bucket]
Stage 6 应用运算 : StatBlock[stat] = (base + flatSum) × Π(1 + bucketSum[i])，再套 MIN/MAX 钳制
Stage 7 生成快照 : 写 SnapshotPool（最终值 + 每条 Modifier 贡献 + 来源分组 + 乘区 breakdown），
                   StatSnapshotRef.version++，清 DirtyStat.mask
```

- 运算类型：ADD/SUB、MUL 乘区分桶、MAX/MIN、OVERRIDE/MUTEX/CONDITIONAL。
- 来源优先级链（配置化）：武将基础 < 装备词缀 < 普通宝石 < 套装 < 传奇特效 < 魔盒 < 技能 < 传说宝石 < 临时 buff。乘区内同类增伤不受来源影响一律相加；唯一特效走 MAX 去重。
- 重算触发：开局编译、穿脱装备、镶嵌/拆除、升级选牌、拾取装备、buff 起止、传说宝石升级、魔盒操作。热路径只读 `StatBlock` 最终值。
- 属性详情面板 `StatDetailUI.ts` 读 `SnapshotPool`：展示最终值、来源分组明细、乘区 breakdown；装备比较 tooltip 用克隆宿主注入临时 Modifier 试算取差值。

### 6.3 状态快照同步范围

- **进快照**（`Replicated` 标签）：Position、Velocity、Health、Faction、Attack.cd、AIState、ActiveEffect、StatBlock + statVersion。
- **不进快照**（本地派生）：RenderRef、Culled、InputCmd、DirtyStat、SnapshotPool、相机、HUD。
- 快照打包为 ArrayBuffer：header + 按 componentMask 排列的 SoA 列块，实体按 NetId 排序；delta 与量化封装在 `ISnapshotCodec` 接口后。`StatDetailSnapshot` 在 statVersion 变化时按 `(playerId, version)` 可靠下发，不逐 tick 同步。

## 7. System 调度

`src/ecs/scheduler.ts` 分 `simulateTick()`（固定步系统链）与 `renderFrame()`（插值+渲染+HUD）。

**每 tick 顺序：**

```
[客户端前置] SnapshotApply → Reconcile
1  TimeSystem           accumulator, simTick, alpha（不丢弃 tick）
2  InputSystem          控制源分发 → 各玩家 InputCmd
3  LifetimeSystem       remaining -= tickDt，到期打 Dead
4  SpawnSystem          波次 spawnAcc += rate*tickDt（Host 分配 NetId）
5  AISystem             敌人多目标 + 影子玩家 Brain
6  MovementSystem       InputCmd/AI → Velocity → Position += v*tickDt（存 px/py）
7  BulletSystem         弹幕积分
8  CollisionSystem      扫掠碰撞（线段 [px,py]→[x,y]）
9  DamageSystem         消费 hit → Health
10 EffectTriggerSystem  掩码短路 → 激活 Effect
11 ActionDispatchSystem 执行 Action.op
12 StatResolveSystem    脏驱动结算
13 DropSystem / 14 PickupSystem / 15 ExpSystem / 16 LevelUpSystem
17 BossSystem           阶段阈值 + 地面预警
18 [客户端] InputReport → [Host] BroadcastSnapshot
19 DeadRecycleSystem    flushRemovedEntities，回收 eid/NetId/slot（位于所有消费系统之后）
```

**每帧渲染**：ViewportSystem（Culled 标签）→ RenderSyncSystem（alpha 插值写 Pixi slot）→ HUDSystem（节流 10Hz 读 GameEventBus）。
**按需执行**：EffectCompileSystem、存档系统（节流）、snapshot codec。

## 8. 玩法系统

### 8.1 战斗手感与波次

- 基础参数（配置化）：移速 220px/s、最大生命 120、普攻 24 伤害、攻击 1.8 次/s、受击无敌帧 0.4s、拾取半径 60px。
- 经验曲线：`expToNext(L)=round(10+8L+0.8L²)`；小兵 1 / 精英 10 / BOSS 150 exp；8 分钟局目标 18–22 级。
- 8 分钟波次表（配置化阶段数组，所有设备一致）：

| 阶段 | 时间 | 生成速率 | 同屏上限 | 敌人 | 精英 |
| --- | --- | --- | --- | --- | --- |
| 熟悉期 | 0–60s | 2/s | 60 | 黄巾兵 | — |
| 弓兵登场 | 60–150s | 3→5/s | 120 | +弓兵 | 120s |
| 骑兵冲锋 | 150–240s | 5→8/s | 180 | +骑兵 | 180s、210s |
| 混合高压 | 240–330s | 8→12/s | 240 | 全部 | 270s、300s×2 |
| 饱和海 | 330–420s | 12→18/s | 300 | 全部 | 345s、375s、405s |
| BOSS 战 | 420–480s | 4→6/s | 200 | BOSS 专属小兵 | 420s BOSS 登场（提前 5s 预警） |


- 8 分钟模式：480s 前击杀 BOSS 为胜；死亡或超时为败；首胜解锁无尽模式。
- 无尽模式：`hpMult=1+0.12t+0.03t²`、`dmgMult=1+0.06t`、`spawnRate=6+4t`（封顶 40/s）；每 2 分钟精英潮、每 5 分钟名将 BOSS；计分公式配置化。本地 Top10 排行。

### 8.2 操作

- 默认 auto：CD 就绪且范围内有敌人时自动朝最近敌人释放。
- 手动接管：点击技能按钮接管该技能；拖动 >12px 进入瞄准显示方向线，松手释放（未拖动则朝最近敌人）；设置可切回 auto。
- 左摇杆与各技能按钮各自 `setPointerCapture(pointerId)` 支持多指；命中区 ≥44px、`touch-action:none`。
- 技能按钮可见内容使用按技能标签生成的矢量 SVG 图标（currentColor 随主题），不再显示「技1/技2/技3」；按钮 `aria-label` 显示当前武将的真实技能名。闪避键同样是矢量图标。

### 8.3 名将 BOSS

至少 8 个：吕布、张角、曹操、关羽、周瑜、赵云、典韦、貂蝉。配置为 `{phases:[{hpThreshold, skills:[{id, telegraph, pattern, counter}]}]}`，技能走效果系统；所有技能有地面预警与应对窗口。

### 8.4 装备（完整 13 槽）

| 类别 | 槽位 |
| --- | --- |
| 防具 8 格 | head / shoulders / chest / bracers / gloves / belt / legs / boots |
| 首饰 3 格 | amulet / ring1 / ring2 |
| 武器 2 格 | mainHand / offHand |


- 槽位、稀有度、词缀池、套装、传奇特效均为配置条目。稀有度六档（参考 D3）：白 → 蓝 → 黄 → 传奇 → 远古传说 → 太古传说。

| 稀有度 | 词缀 | 可用词缀 tier | 孔数 | 系数 | 命名 |
| --- | --- | --- | --- | --- | --- |
| 白 | 1 | 1（基础） | 0 | ×1.0 | 结构化随机名 |
| 蓝 | 2 | ≤2（进阶） | 1 | ×1.6 | 结构化随机名 |
| 黄 | 3 | ≤3（稀有） | 2 | ×2.4 | 结构化随机名 |
| 传奇 | 4 | ≤4（高阶） | 3 | ×3.0 | 固定名 |
| 远古传说 | 5 | ≤4 | 3 | ×4.2 | 固定名（沿用传奇底名） |
| 太古传说 | 6 | ≤4 | 3 | ×5.6 | 固定名（沿用传奇底名） |

- 词缀池 13 类，按 tier 分层：tier1 = atk / moveSpeed / maxHp / armor / pickup；tier2 = crit / critDmg / atkSpeed；tier3 = lifeSteal / skillLevel；tier4 = damage / regen / expBonus（仅传奇及以上可 roll）。同档位词缀不重复，数值 = 区间随机值 × 稀有度系数。
- 命名规则：传说及以上（含远古/太古）只用固定名，如「方天画戟」「青龙偃月刀」；白/蓝/黄由 `equipmentName(def, uid)` 确定性生成「材质前缀 + 槽位名 · 词缀主题」，例如「玄铁胸甲·破军」「精铁头盔·穿云」，保证可读、与词条相关，且同一件装备在仓库/纸娃娃/预览中同名。
- 传奇特效 ≥12 个，与技能标签联动：方天画戟、青龙偃月刀、丈八蛇矛、落月弓、的卢、赤兔、八卦阵图、太平要术、七星灯、连环计、虎牢关甲、藤甲等；每个特效在传奇/远古/太古三档各有一个固定名条目。
- 套装 4 套：桃园结义、五虎将、赤壁烽火、群雄逐鹿（各含 2 件与 4 件效果）；套装条目为黄装，名称同样结构化生成。
- 掉率按配置权重抽取；精英/BOSS 按权重依次掉黄/传奇/远古/太古，稀有度越高权重越低。smart-loot 配置化；局内黄以上弹提示，白蓝静默入包。UI 用可滚动网格 + 六档筛选 + 纸娃娃适配手机。

### 8.5 普通宝石

- 4 类（红/蓝/黄/绿）× T1–T5，配置化可增类增级。
- 孔数由稀有度配置：白 0 / 蓝 1 / 黄 2 / 传奇及以上 3；镶嵌属性产出 Modifier 进入结算系统。
- 合成 3→1 同级同类；无损拆除（消耗材料）；拆解带孔装备回收宝石。

### 8.6 卡奈魔盒

三功能，配方配置化：

1. 提取传奇特效：消耗传奇装备 + 材料，特效永久入账号；3 个魔盒槽（武器/护甲/饰品）各装一个，与装备同类特效走 MAX 裁决。
2. 重铸词缀：消耗材料重置单件装备词缀，可锁定一条（额外消耗）。
3. 稀有升传奇：消耗黄色装备 + 材料，升级为传奇并随机获得特效；升级后词缀改为目标传奇定义的 4 条。

材料：`essence`（拆解白蓝）、`soul`（拆解黄/传奇及以上、精英掉落）、`bossToken`（BOSS 掉落）。重铸时只在该稀有度允许的 tier 内重 roll。

### 8.7 传说宝石

- 首批 6 颗，配置数组驱动；只镶首饰孔。
- 等级无上限；成功率 `rate=max(0.15, 0.9-level*0.05)`，失败等级不变但消耗材料、下次 +5% 保底，成功后重置。
- 效果随等级增长，产出 Modifier 走结算系统；同类取最高；材料消耗随等级递增并设软上限。

### 8.8 局内成长闭环（D3 秘境式，2026-11-25 补充）

用户实机反馈后修正设计口径：装备/宝石的主要来源是**局内掉落**，不是只靠局外仓库。

- 击杀按掉落表权重产出装备（普通怪白/蓝；精英黄/传奇/远古/太古；BOSS 传奇/远古/太古）与普通宝石；走近自动拾取。
- 装备按评分自动比较并替换（smart loot），宝石自动镶入有孔装备；词缀/宝石/套装/传奇特效即时编译成 Modifier 并刷新属性。
- 经验三选一包含「本武将技能槽等级 +1」，技能等级直接放大已编译效果的伤害参数；每级另给 4% 基础增伤。
- 战利品结算带回仓库，下一局选将时可穿戴局外装备开局；局内/局外形成长期成长闭环。
- 接口、编码与基线见 `docs/ARCH_RUN_LOOT.md`。

### 8.9 局内角色状态面板（2026-11-25 补充）

- 战斗中可打开四页浮层（角色 / 装备 / 技能 / 数值）：HUD 固定入口按钮或 `Tab` 打开/切页，`Esc` 关闭；**面板不暂停战斗**（边打边看）。
- 13 槽装备页显示真实词缀 roll 值与已镶嵌宝石，空槽显式占位；词缀值由 `affixValueOf()` 单一口径重算，与效果编译逐位一致。
- 技能页显示说明文字、当前等级与下一级增益；文案由 `src/data/skillDescription.ts` 统一 formatter 生成（`×1.3^(level-1)` + 每级 4% 增伤），升级弹窗与面板共用同一来源。
- 数值页展示 `StatBlock` 真值（非局外区间中值估算），攻击/生命/暴击/护甲四项给出 `SnapshotPool.readBreakdown()` 来源分解（基础/词缀/宝石/套装/传奇/魔盒/技能/传说宝石/Buff）。
- 数据链路 `ECS → presentation 层只读 VM → 面板`，面板零 ECS / 零墙钟 / 零随机（FC-5.3）；玩家按 `session.localPlayerId` 精确匹配，不回退 `players[0]`。
- manual 模式的升级三选一弹窗显示期间暂停战斗（`session.running=0`，三守卫：非 auto / 仅 battle / 幂等），选卡后恢复；auto 模式不暂停，确定性基线不受影响。
- 完整契约与任务分解见 `docs/PRD_RUN_STATUS.md`、`docs/ARCH_RUN_STATUS.md`。

## 9. 渲染与美术

- `RenderRef` 与 `PixiPools` 双向映射（slot↔eid）；敌人 Sprite 池按兵种纹理分组、弹幕 ParticleContainer 池、掉落/特效 Sprite 池。
- `RenderSyncSystem` 只同步 dirty 或位置变化的实体，跳过 Culled；无 GPU 上下文时用普通 Sprite 池替代 ParticleContainer。
- 视口裁剪：`ViewportSystem` 打 Culled 标签；**Culled 仅跳过绘制，实体仍完整参与 AI、碰撞、伤害、掉落等全部逻辑**。
- **画质档位（quality）只控制渲染层**：渲染分辨率、纹理精度、粒子与特效密度、是否启用附加视觉层；**不控制任何游戏性参数**（敌人数量、生成速率、弹幕数量、掉落、数值、波次、BOSS 行为一律固定）。
- 美术：`PortraitFactory.ts` 生成 40 个矢量 Q 版头像（选将卡片），`ChibiFactory.ts` 复用参数生成战场小人纹理并缓存。

## 10. 存档设计

- 单机 profile（货币/解锁/养成/仓库/配装/宝石/魔盒/排行）为玩家私有，存 localStorage；房间状态是临时会话，不写入存档。
- `SaveData` 结构：

```
version
meta {
  currency, unlockedGenerals, selectedGeneral, upgrades, stats,
  settings { controlMode, quality(仅渲染), sfx, netRolePreferred, playerColor, localPlayerName },
  unlockedModes, firstBossClearAt,
  materials { [materialId]: number },
  warehouse { items: EquipmentItem[], capacity },
  loadouts { [generalId]: { [slotId]: uid|null } },
  gems { inventory: GemItem[] },
  cube { extracted: string[], slots: { [cubeSlot]: effectId|null } },
  legendaryGems { inventory: LegendaryGemItem[], equipped: { [jewelrySlot]: uid|null } },
  multiplayer { localSeatPreference, shadowCount, aiShadowDifficulty, knownPeers },
  leaderboards { [modeId]: LeaderboardEntry[] }
}
run? { mode, generalId, elapsed, playerId, participants[], pickedEquipment, pickedGems, pity }
perPlayerRunStats { [roomSeed:playerId]: stats }
```

- `Loadout`/`slots` 使用 `Record<string, ...>`，槽位配置扩展后存档结构保持兼容。
- `SaveSystem` 只序列化本地玩家（playerId == localPlayerId）的运行数据与 profile meta；写入 try/catch + 节流；`QuotaExceededError` 时提示拆解。

## 11. 目录结构

```text
src/ecs/
├─ bit/{adapter,components,types}.ts          bitECS 0.4.x API 封装/组件工厂/枚举常量
├─ components/{transform,combat,ai,projectile,pickup,lifetime,render,input,effect,stat,net}.ts
├─ world.ts  scheduler.ts                     建World/warm-up/simulateTick+renderFrame/profiling
├─ bridge/{CommandBus,GameEventBus,enums}.ts
├─ pools/{EffectEntityPool,ParamPool,SnapshotPool,EntityPool}.ts
├─ stages/                                    StatResolve 8 阶段纯函数
├─ systems/{Time,Input,Lifetime,Spawn,AI,Movement,Bullet,Collision,Damage,EffectTrigger,
│           ActionDispatch,EffectCompile,StatResolve,Drop,Pickup,Exp,LevelUp,Boss,
│           Viewport,DeadRecycle,RenderSync,HUD}.ts
├─ systems/control/{IControlSource,LocalHumanSource,AIShadowPlayerSystem,
│                   RemoteInputSource,ControlSourceRegistry}.ts
└─ __tests__/
src/net/{EntityRegistry,session,transport,messages,Snapshot,SnapshotCodec,
         PredictionBuffer,DeterministicSim,NetInputBuffer,NetSystems}.ts
src/core/{Registry,Config,Rng}.ts
src/data/（全配置化，含 stats/{stats,buckets,sourcePriority}.ts）
src/engine/{Renderer,PixiPools,Viewport,TextureFactory,SweptCollision}.ts
src/ui/{hud,TouchControls,LevelUpModal,SelectCards,InventoryUI,LoadoutUI,
        KanaiCubeUI,LeaderboardUI,StatDetailUI}.ts
src/game/scenes/{BootScene,MenuScene,SelectScene,ResultScene,SettingsScene}.ts
src/art/{PortraitFactory,ChibiFactory,Palette}.ts
```

## 12. 实施阶段

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| P0 | Vite/TS/Pixi 脚手架；bitECS 0.4.x 组件工厂与 CAP 守卫；网络基础（固定 tickRate/EntityRegistry 映射/ITransport 接口） | 组件工厂单测；确定性 harness（同 seed 跑 N tick 哈希一致）；dev/build 正常 |
| P1 | World/组件/pools/scheduler 骨架；StatResolveSystem + 8 阶段；net 组件 + NetSession + EntityRegistry | 属性金标准单测（ADD/MUL/MAX/OVERRIDE/MUTEX/CONDITIONAL）；NetId↔eid 往返/回收单测 |
| P2 | 40 将 + 矢量头像 + 全内容配置表 + 存档结构；控制源抽象 + LocalHuman + AIShadow + 本地 2–4 人生成 | 注册表完整性；1 真人 + 2–3 影子共享玩家组件/系统；控制源切换测试 |
| P3 | 战斗核心全 Systems；固定 tick + 插值时钟；敌人多目标 | 确定性 tick 测试（同 seed、不同帧抖动与不同画质档位下 tick N 的敌人数/状态/掉落完全一致）；300 敌/500 弹幕渲染 ≥50FPS |
| P4 | EffectCompile/Trigger/ActionDispatch；13 槽装备 + 套装 + 传奇 + 普通宝石 → Modifier；AuthorityRole + ITransport + Null/Loopback + Full 快照 | 热路径零分配；属性结算正确；loopback host↔client 消息闭环；快照精确等于 Replicated 集合 |
| P5 | 卡奈魔盒 + 传说宝石 + 属性详情面板；PredictionBuffer + DeterministicSim + 影子 loopback 和解 | 成功率保底单测；面板与快照一致；和解测试（注入延迟/抖动，N tick 内收敛） |
| P6 | 双模式 + 8 BOSS + 排行 + 局外养成；delta/量化 codec + StatDetailSnapshot 按 statVersion 同步 | 首胜解锁持久化；BOSS 配置扩展；Top10 持久化；快照体积指标 |
| P7 | 移动端渲染适配 + 渲染调优 + 音效；Host 迁移骨架 + 按玩家存档归属 | iPhone/Pixel 渲染 ≥45FPS 且波次/敌人数/掉落与桌面逐 tick 一致；本地多 peer 模拟杀 Host → 最小 netId 接管且状态保真；只存本地玩家 meta |
| P8 | Vitest/Playwright + 构建 + 网络就绪加固测试 | 单测全绿；确定性 fuzz / 控制源切换 / loopback chaos（丢包乱序重复）；E2E 全流程；存档 <80KB；静态部署无 404 |


## 13. 验证

- Vitest：确定性 harness、控制源切换、NetId 映射与回收、属性结算金标准、快照内容精确性、和解收敛、存档结构、数据完整性、碰撞、波次、掉率。
- **性能与游戏性解耦测试**：同一 seed 在模拟 30fps / 60fps / 144fps 帧序列、不同 quality 档位下，跑相同 tick 数后的敌人数、生成序列、掉落、BOSS 阶段必须完全一致。
- Playwright：桌面 + iPhone/Pixel 的 选模式→选将→13 槽配装→属性详情核对→镶嵌→魔盒→战斗→升级→掉落→结算→养成→刷新存档 全流程；本地多玩家影子模拟流程。
- 调试模式 `?debug=1`：性能压测、ECS inspector、loopback chaos、热路径分配观测。
- 构建：`npm run build` + `vite preview` 静态部署验证。