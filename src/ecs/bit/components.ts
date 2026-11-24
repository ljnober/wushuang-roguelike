/**
 * 全部 ECS 组件的定义中心（架构 §2.4 / §5.5）。
 *
 * - 每个 SoA 组件由 defineSoA 分配长度为 CAP 的定长 typed array；
 * - 标签组件为空对象，由 defineTag 生成（每个标签必须是唯一对象引用）；
 * - 关系组件由 adapter.defineRelation 生成，不在 ALL_COMPONENTS 中注册
 *   （bitECS 0.4.0 会在 addComponent 时按需注册 pair 组件）；
 * - StatBlock 由 createStatBlock(stats) 按配置动态生成字段，组件本体导出默认字段集。
 */
import { assert, CAP, TICK_RATE } from '../../core/Constants';
import type { BitRelation } from './adapter';
import { defineRelation } from './adapter';
import type { FieldArray, FieldKind, SoAComponent } from './types';

const ERR_BAD_SCHEMA = 2004;

/** 依据字段类型分配对应 typed array；字段名/类型在 §5.5 冻结。 */
export function defineSoA<S extends Record<string, FieldKind>>(
  schema: S,
  capacity: number = CAP,
): { [K in keyof S]: FieldArray } {
  assert(capacity > 0, ERR_BAD_SCHEMA, 'defineSoA 的 capacity 必须为正数');
  const result = {} as { [K in keyof S]: FieldArray };
  const keys = Object.keys(schema) as Array<keyof S & string>;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const kind = schema[key];
    switch (kind) {
      case 'f32':
        result[key] = new Float32Array(capacity);
        break;
      case 'i32':
        result[key] = new Int32Array(capacity);
        break;
      case 'u32':
        result[key] = new Uint32Array(capacity);
        break;
      case 'u8':
        result[key] = new Uint8Array(capacity);
        break;
      default:
        assert(false, ERR_BAD_SCHEMA, `未知字段类型: ${String(kind)}`);
    }
  }
  return result;
}

/** 标签组件工厂：每次返回唯一空对象，供 bitECS 作为组件引用注册。 */
export function defineTag(): SoAComponent {
  return {} as SoAComponent;
}

/* ------------------------------ 变换运动 ------------------------------ */
export const Position = defineSoA({ x: 'f32', y: 'f32', px: 'f32', py: 'f32' });
export const Velocity = defineSoA({ x: 'f32', y: 'f32' });
export const Heading = defineSoA({ angle: 'f32' });
export const Collider = defineSoA({ r: 'f32', type: 'f32', w: 'f32', h: 'f32', layer: 'f32' });
export const Speed = defineSoA({ value: 'f32' });

/* ------------------------------ 生命战斗 ------------------------------ */
export const Health = defineSoA({ cur: 'f32', max: 'f32', regen: 'f32' });
export const Faction = defineSoA({ value: 'u8' });
export const Attack = defineSoA({ damage: 'f32', rate: 'f32', cd: 'f32', range: 'f32' });
export const Damage = defineSoA({ amount: 'f32', flags: 'u32' });
export const Invulnerable = defineSoA({ remaining: 'f32' });
export const ExpValue = defineSoA({ value: 'f32' });

/* -------------------------------- AI -------------------------------- */
// state/policy 为枚举（u32）；target 为 eid；timer/retargetTimer 为秒（f32）；targetNetId 为网络 id（u32）。
export const AIState = defineSoA({
  state: 'u32',
  timer: 'f32',
  target: 'u32',
  policy: 'u32',
  retargetTimer: 'f32',
  targetNetId: 'u32',
});
export const Behavior = defineSoA({ type: 'f32', p0: 'f32', p1: 'f32', p2: 'f32' });
export const Threat = defineSoA({ value: 'f32' });

/* ------------------------------ 弹幕掉落 ------------------------------ */
export const Projectile = defineSoA({
  dx: 'f32',
  dy: 'f32',
  speed: 'f32',
  pierce: 'f32',
  hitMask: 'u32',
});
export const Pickup = defineSoA({ kind: 'f32', amount: 'f32', cfgId: 'f32' });
export const Magnet = defineSoA({ radius: 'f32' });
export const Lifetime = defineSoA({ remaining: 'f32' });
export const Dead = defineTag();

/* -------------------------------- 渲染 -------------------------------- */
export const RenderRef = defineSoA({
  slot: 'f32',
  kind: 'f32',
  z: 'f32',
  anim: 'f32',
  animT: 'f32',
  flipX: 'f32',
  tint: 'f32',
  scale: 'f32',
  alpha: 'f32',
  dirty: 'f32',
});
/** 视口裁剪标签：仅跳过绘制，实体仍完整参与所有逻辑系统（设计 §9） */
export const Culled = defineTag();

/* -------------------------------- 输入 -------------------------------- */
export const InputCmd = defineSoA({
  moveX: 'f32',
  moveY: 'f32',
  aimX: 'f32',
  aimY: 'f32',
  buttons: 'f32',
  tick: 'f32',
  seq: 'f32',
});
export const ControlMode = defineSoA({ value: 'u8' });
export const ControlSource = defineSoA({ kind: 'u8', ref: 'u32' });

/* -------------------------------- 效果 -------------------------------- */
export const EffectTag = defineTag();
export const TriggerReg = defineSoA({
  trigger: 'u32',
  condMask: 'u32',
  paramRef: 'u32',
  effectCfgId: 'u32',
});
export const ActiveEffect = defineSoA({
  defId: 'f32',
  state: 'f32',
  elapsed: 'f32',
  cd: 'f32',
});
// type/cmp 为小枚举（u8）；threshold 为数值；arg 为池内偏移/配置 id（u32）。
export const Condition = defineSoA({
  type: 'u8',
  cmp: 'u8',
  threshold: 'f32',
  arg: 'u32',
});
export const Action = defineSoA({ op: 'u32', paramRef: 'u32', paramCount: 'u32' });

/** 关系组件：pair 组件由 bitECS 自动注册；store 为空 SoA 便于 add() 统一类型 */
const emptyStore = (): SoAComponent => ({} as SoAComponent);
export const EffectOwner: BitRelation<SoAComponent> = defineRelation<SoAComponent>({ store: emptyStore });
export const EffectTarget: BitRelation<SoAComponent> = defineRelation<SoAComponent>({ store: emptyStore });
export const ChildOf: BitRelation<SoAComponent> = defineRelation<SoAComponent>({ store: emptyStore });

export const EffectContext = defineSoA({
  source: 'u32',
  target: 'u32',
  hitValue: 'f32',
  flags: 'u32',
});
/** 逻辑实体的触发位掩码（单一 u32 字段组件，配合 §6.2 的只追加位约定） */
export const effectMask = defineSoA({ value: 'u32' });

/* -------------------------------- 属性 -------------------------------- */
export const Modifier = defineSoA({
  stat: 'u8',
  op: 'u8',
  bucket: 'u8',
  priority: 'u32',
  sourceKind: 'u8',
  sourceId: 'u32',
  group: 'u32',
  condMask: 'u32',
  duration: 'f32',
  flags: 'u32',
  value: 'f32',
});
export const ModifierOwner: BitRelation<SoAComponent> = defineRelation<SoAComponent>({ store: emptyStore });
export const DirtyStat = defineSoA({ mask: 'u32' });

/**
 * 默认属性字段集：与 src/data/stats.ts 的 STAT_DEFS 顺序一致（共 14 项）。
 * 正式世界可按 config.stats 调用 createStatBlock 生成同构组件；
 * 字段顺序即 stage6 写入顺序，必须与快照列块顺序保持一致。
 */
export const DEFAULT_STAT_NAMES: readonly string[] = [
  'hp',
  'maxHp',
  'atk',
  'armor',
  'crit',
  'critDmg',
  'atkSpeed',
  'moveSpeed',
  'lifeSteal',
  'pickup',
  'skillLevel',
  'damage',
  'regen',
  'expBonus',
] as const;

/** 依据 stats 配置动态生成 StatBlock 组件（字段顺序 = stats 顺序，stage6 按此顺序写入） */
export function createStatBlock(stats: readonly string[]): SoAComponent {
  const schema: Record<string, FieldKind> = {};
  const seen = new Set<string>();
  for (let i = 0; i < stats.length; i++) {
    const name = stats[i];
    assert(name.length > 0 && !seen.has(name), ERR_BAD_SCHEMA, `非法或重复的属性名: ${name}`);
    seen.add(name);
    schema[name] = 'f32';
  }
  return defineSoA(schema) as SoAComponent;
}

export const StatBlock: SoAComponent = createStatBlock(DEFAULT_STAT_NAMES);
export const StatSnapshotRef = defineSoA({ poolIndex: 'u32', version: 'u32' });

/* -------------------------------- 网络 -------------------------------- */
export const PlayerId = defineSoA({ value: 'u32' }); // 设计中的 u16 席位提升为 u32（§5.5）
export const NetId = defineSoA({ value: 'u32' });
export const Owner = defineSoA({ netId: 'u32', playerId: 'u32' });
export const SpawnTick = defineSoA({ value: 'u32' });
export const PlayerTag = defineTag();
export const EnemyTag = defineTag();
export const Replicated = defineTag();
export const Predicted = defineTag();
export const NetControlled = defineTag();
export const NetSession = defineSoA({
  role: 'u8',
  localNetId: 'u32',
  hostNetId: 'u32',
  localPlayerId: 'u32',
  roomSeed: 'u32',
  simTick: 'u32',
  lastAckedTick: 'u32',
  playerCount: 'u32',
  tickRate: 'u32',
});
// tickRate 是游戏规则常量，固定 60（会话单例槽 0）。
NetSession.tickRate[0] = TICK_RATE;

/**
 * 需要在 createBattleWorld 中注册的全部 SoA/标签组件（关系组件除外）。
 * 顺序冻结：bitflag 由注册顺序决定，调试与快照掩码依赖该顺序。
 */
export const ALL_COMPONENTS: SoAComponent[] = [
  Position, Velocity, Heading, Collider, Speed,
  Health, Faction, Attack, Damage, Invulnerable, ExpValue,
  AIState, Behavior, Threat,
  Projectile, Pickup, Magnet, Lifetime, Dead,
  RenderRef, Culled,
  InputCmd, ControlMode, ControlSource,
  EffectTag, TriggerReg, ActiveEffect, Condition, Action, EffectContext, effectMask,
  Modifier, DirtyStat, StatBlock, StatSnapshotRef,
  PlayerId, NetId, Owner, SpawnTick, PlayerTag, EnemyTag, Replicated, Predicted, NetControlled,
  NetSession,
];
