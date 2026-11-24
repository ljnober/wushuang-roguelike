/**
 * 核心战斗组件分区再导出（变换 / 战斗 / 弹幕 / 掉落 / 生命周期）。
 * 组件本体只在 src/ecs/bit/components.ts 定义一次，此处不做重复定义。
 */
export {
  Position,
  Velocity,
  Heading,
  Collider,
  Speed,
  Health,
  Faction,
  Attack,
  Damage,
  Invulnerable,
  ExpValue,
  Projectile,
  Pickup,
  Magnet,
  Lifetime,
  Dead,
} from '../bit/components';

/** Faction.value 冻结值语义（设计 §3 / 架构 §6.2） */
export const FactionValue = {
  Player: 0,
  Enemy: 1,
  Neutral: 2,
} as const;

/** Collider.type 的常用数值（配置可扩展，0/1/2 冻结） */
export const ColliderType = {
  Circle: 0,
  Rect: 1,
  Capsule: 2,
} as const;

/** Damage.flags 位定义（只追加不重排） */
export const DamageFlag = {
  Critical: 1 << 0,
  Skill: 1 << 1,
  Projectile: 1 << 2,
  Contact: 1 << 3,
} as const;
