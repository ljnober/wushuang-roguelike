# 局内成长闭环接口冻结（D3 秘境式）

本轮目标：击杀掉装备/宝石 → 拾取自动比较并装备 → 属性即时生效 → 经验三选一含技能强化 → 战利品带回仓库 → 下一局可穿戴局外装备开局。

## 1. 不变量

- 战斗仍是固定 tick 确定性模拟；新增随机全部走 `Rng` / `hash32(roomSeed, eid, tick, salt)`，禁止 `Math.random` / 墙钟。
- 系统顺序不变（Drop 13 / Pickup 14 / Exp 15 / LevelUp 16 / Boss 17）；装备属性只在拾取时编译，不在 tick 热路径新增实体。
- `equipment_gems` 数组存宝石 **defId**（与配装 UI / 存档一致），宝石 uid 只在背包中去重。
- 自动模式优先选技能卡；手动模式 ECS 不预选，玩家点选后下一 tick 生效。
- 普通怪按权重掉白/蓝装（合计约 26%），保证第一分钟就能形成换装反馈；精英按权重掉黄/传奇/远古/太古，BOSS 掉传奇/远古/太古，档位越高权重越低。
- BOSS 在 AI 视野（600px）内自动集火并贴身追击，避免 auto 轨迹 8 分钟超时战败。
- 快照列清单不变；局内战利品是玩家私有运行态，不进入网络快照。
- 无装备/无技能升级时伤害与旧版逐位一致（`damageStat=0` → 乘数 1）。确定性整局基线允许因新掉落重算，但两次复跑必须逐字段一致。

## 2. 拾取物编码（Pickup.kind）

| kind | 含义 | cfgId | amount |
| --- | --- | --- | --- |
| 0 | 经验球 | 0 | 经验值 |
| 1 | 材料 | 材料 id 长度（旧兼容） | 数量 |
| 2 | 装备 | `config.equipment.all()` 下标 + 1 | 词缀 roll seed |
| 3 | 宝石 | `config.gems.all()` 下标 + 1 | 等级 tier |

`DropSystem` 从掉落表 `equipment_common` / `equipment_blue` / `equipment_gold` / `equipment_legendary` / `equipment_ancient` / `equipment_primal` / `gem_*` 条目解析真实条目；材料条目保持旧行为。条目按 `weight` 加权抽取（旧版为等概率），cfgId 仍是注册表 1-based 下标。

## 3. `src/game/RunLoot.ts` 公共 API

```ts
resetRunLoot(): void                       // createBattleState 重置局内战利品/技能等级
setPendingLoadout(generalId, items): void  // 开战前注入局外仓库装备（不改 startBattle 签名）
applyPendingLoadout(state, playerId, owner): void
makeDroppedEquipment(state, cfgId, roll, eid, roomSeed): EquipmentItem | null
makeDroppedGem(state, cfgId): GemItem | null
grantLoot(state, playerId, owner, item, isGem): void
collectRunLoot(playerId): { equipment: EquipmentItem[]; gems: GemItem[] }
getEquipped(playerId): Record<string, EquipmentItem | null>
getSkillLevel(playerId, slot): number
levelUpSkill(playerId, slot): number
```

## 4. 属性编译规则

- 词缀：按 `AFFIX_POOL` + `RARITY_DEFS.coefficient` + roll seed 生成数值，`createModifier` 写 `Modifier`（sourceKind=affix）。词缀 tier 不得超过稀有度 `maxAffixTier`；tier4（damage / regen / expBonus）仅传奇及以上可 roll。
- 命名：`equipmentName(def, uid)` 对传说及以上返回固定 `def.name`，对白/蓝/黄返回「材质前缀 + 槽位名 · 词缀主题」的确定性随机名；六档稀有度各有独立颜色令牌与图标样式。
- `atk` 词缀额外生成 `damage` 修正 `value/24`，让攻击词缀真正提高效果伤害；基础 `damage=0` 时旧基线不变。
- 宝石：自动镶入「孔位未满且稀有度最高」的装备；每颗宝石生成一个 `gem` 来源 Modifier。
- 套装：统计已装备同套件数，≥2/≥4 编译 twoPiece/fourPiece；换装时整组重建。
- 传奇特效：按 `LEGENDARY_EFFECT_DEFS.modifiers` 编译，group 按特效序号，走既有 MAX 裁决。
- 换装：释放该槽全部 Modifier 实体（含宝石、套装），重新编译 → `DirtyStat` → 下一 tick `StatResolveSystem` 重算。

## 5. Smart loot 评分

`score = Σ(归一词缀值) × 稀有度系数 + 孔数 × 8 + 套装加成 12 + 传奇 30`。仅当新装备评分严格大于当前槽位时才替换；替换下来的旧装备保留在局内背包，结算一起带回仓库。

## 6. 升级三选一

- ECS `choicesByPlayer[i*3+c]` 编码：`0..2` = 武将技能槽 0/1/2 等级 +1；`3..` = `STAT_DEFS` 下标属性强化。
- `presentation.showLevelUp()` 用 `getLevelChoices()` 生成卡片；选择回调写 `selectLevelChoice()`，不再只写 `save.meta.upgrades`。
- `LevelUpSystem` 应用技能选择时调用 `levelUpSkill()`，该函数经 `EffectCompileSystem.levelSkillSlot()` 直接放大对应技能已编译的 damage 参数（×1.3/级），不重编译、不新增实体。
- auto 模式沿用默认选择 0（第一个技能槽），UI 弹窗在 auto 下自动应用，避免遮挡战斗与结算。

## 7. 结算带回

`presentation` 终局分支（已有 `resultShown` 去重）调用 `collectRunLoot(localPlayerId)`，把局内获得的装备/宝石写回 `save.meta.warehouse.items` / `save.meta.gems.inventory`（容量上限内），`saveSystem.saveNow(save)`。`ResultScene` 增加一行「本局获得装备 N · 宝石 M」展示。

## 8. 文件写权

- 新增：`src/game/RunLoot.ts`、`src/game/__tests__/runLoot.test.ts`、本文档。
- 修改：`ProgressionSystems.ts`（加权抽取）、`EffectSystems.ts`、`EffectCompileSystem` 参数放大、`presentation.ts`、`systems.ts`、`HUD.ts`、`scenes/index.ts`、`fullrunDeterminism.test.ts`（基线重算）。
- 冻结：`ecs/bit/*`、`ecs/scheduler.ts`、网络快照列清单、既有 E2E 断言。
- 例外：`data/combat.ts` 的 `drop_common` 保留白/蓝装并在精英/BOSS 表追加远古/太古条目；`fullrunDeterminism.test.ts` 基线因六档稀有度与权重掉落重算（两次复跑仍逐字段一致）。
- 六档稀有度新增/修改：`data/types.ts`、`data/stats.ts`、`data/equipment.ts`、`art/EquipmentIconFactory.ts`、`ui/EquipmentUI.ts`、`ui/ItemPreview.ts`、`ui/MetaUI.ts`、`ui/styles/*`。

## 9. 验证结果（2026-11-25，六档稀有度上线后）

- typecheck 0 错；单测 176/176（18 文件）；build 成功（主 chunk 575KB，体积告警非错误）。
- E2E 9/9（legacy 7 + fullrun 2），整局确定性两次复跑逐字段一致：Victory @ tick 25435 / 423.92s / kills 597 / level 10 / score 6970 / Equip 26 / GemSocket 8 / LevelUp 12。
- legacy E2E 需显式指定 `E2E_BASE_URL=http://127.0.0.1:5173/`：仓库里 `appFlow.spec.ts` 默认仍写死 4173 预览端口，与 playwright 配置拉起的 5173 开发服务器不一致（既有问题，非本轮改动）。
