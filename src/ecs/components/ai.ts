/**
 * AI 组件分区再导出。
 * 真实 AI 敌人（Faction=Enemy + AIState/Behavior）与影子玩家（PlayerTag + 玩家系统）互不混淆。
 */
export { AIState, Behavior, Threat } from '../bit/components';

/** AIState.policy 冻结值语义：最近 / 最弱 / 最高威胁 */
export const AIPolicy = {
  Nearest: 0,
  Weakest: 1,
  HighestThreat: 2,
} as const;

/** AIState.state 常用枚举（配置可扩展） */
export const AIStateValue = {
  Idle: 0,
  Chase: 1,
  Attack: 2,
  Retreat: 3,
  Telegraph: 4,
  Stunned: 5,
} as const;
