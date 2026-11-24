/**
 * bitECS 适配层的公共类型定义。
 *
 * 依据 docs/ARCHITECTURE.md §1.2 / §5.5：
 * 0.4.0 的 core 中没有 defineComponent / Types；组件就是普通的 SoA 对象，
 * 由 defineSoA(schema, CAP) 自行分配定长 typed array。
 * 本文件不含任何 bitecs 运行时调用，业务层只需依赖这里的类型。
 */

/** 实体 id（bitECS 0.4.0 的 EntityId 就是 number；禁用 versioning） */
export type Eid = number;

/** defineSoA 支持的字段类型 */
export type FieldKind = 'f32' | 'i32' | 'u32' | 'u8';

/** SoA 组件中允许的 typed array 类型 */
export type FieldArray = Float32Array | Int32Array | Uint32Array | Uint8Array;

/** SoA 组件：字段名 → 定长 typed array */
export interface SoAComponent {
  readonly [field: string]: FieldArray;
}

/** 所有受支持的字段类型（供校验使用，顺序冻结） */
export const FIELD_KINDS: readonly FieldKind[] = ['f32', 'i32', 'u32', 'u8'] as const;

/**
 * 组件名枚举（冻结）。
 * 仅用于调试、断言、序列化与日志，不参与 bitECS 组件对象身份判定。
 * 新增名称只能在末尾追加，永不重排。
 */
export enum ComponentName {
  Position = 'Position',
  Velocity = 'Velocity',
  Heading = 'Heading',
  Collider = 'Collider',
  Speed = 'Speed',
  Health = 'Health',
  Faction = 'Faction',
  Attack = 'Attack',
  Damage = 'Damage',
  Invulnerable = 'Invulnerable',
  ExpValue = 'ExpValue',
  AIState = 'AIState',
  Behavior = 'Behavior',
  Threat = 'Threat',
  Projectile = 'Projectile',
  Pickup = 'Pickup',
  Magnet = 'Magnet',
  Lifetime = 'Lifetime',
  Dead = 'Dead',
  RenderRef = 'RenderRef',
  Culled = 'Culled',
  InputCmd = 'InputCmd',
  ControlMode = 'ControlMode',
  ControlSource = 'ControlSource',
  EffectTag = 'EffectTag',
  TriggerReg = 'TriggerReg',
  ActiveEffect = 'ActiveEffect',
  Condition = 'Condition',
  Action = 'Action',
  EffectOwner = 'EffectOwner',
  EffectTarget = 'EffectTarget',
  ChildOf = 'ChildOf',
  EffectContext = 'EffectContext',
  EffectMask = 'effectMask',
  Modifier = 'Modifier',
  ModifierOwner = 'ModifierOwner',
  DirtyStat = 'DirtyStat',
  StatBlock = 'StatBlock',
  StatSnapshotRef = 'StatSnapshotRef',
  PlayerId = 'PlayerId',
  NetId = 'NetId',
  Owner = 'Owner',
  SpawnTick = 'SpawnTick',
  PlayerTag = 'PlayerTag',
  EnemyTag = 'EnemyTag',
  Replicated = 'Replicated',
  Predicted = 'Predicted',
  NetControlled = 'NetControlled',
  NetSession = 'NetSession',
}
