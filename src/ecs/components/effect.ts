/**
 * 效果组件分区再导出：声明层字段、关系、共享 EffectContext 与触发掩码组件。
 */
export {
  EffectTag,
  TriggerReg,
  ActiveEffect,
  Condition,
  Action,
  EffectOwner,
  EffectTarget,
  ChildOf,
  EffectContext,
  effectMask,
} from '../bit/components';

/** 触发位：与 TriggerType 顺序一致，只追加不重排（架构 §6.2） */
export const TriggerBit = {
  onHit: 1 << 0,
  onKill: 1 << 1,
  onCast: 1 << 2,
  onDamaged: 1 << 3,
  onMove: 1 << 4,
  onTimer: 1 << 5,
  onDeath: 1 << 6,
  onPickup: 1 << 7,
  onCritical: 1 << 8,
} as const;

/** Condition.cmp 的数值编码，与 CompareOp 顺序一致 */
export const CompareCode = {
  EQ: 0,
  NE: 1,
  GT: 2,
  GE: 3,
  LT: 4,
  LE: 5,
  HAS: 6,
} as const;

/** ActiveEffect.state 的冻结值语义 */
export const EffectState = {
  Disabled: 0,
  Active: 1,
  Cooldown: 2,
} as const;
