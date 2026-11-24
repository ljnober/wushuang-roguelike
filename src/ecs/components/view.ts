/**
 * 渲染 / 输入组件分区再导出。
 * RenderRef 只在渲染层使用；Culled 仅跳过绘制，不影响任何游戏性系统。
 */
export { RenderRef, Culled, InputCmd, ControlMode, ControlSource } from '../bit/components';

/** ControlSource.kind 冻结值语义：本地真人 / AI 影子 / 远端玩家（架构 §6.2） */
export const ControlKind = {
  Local: 0,
  AI: 1,
  Remote: 2,
} as const;

/** InputCmd.buttons 位定义（只追加不重排） */
export const InputButton = {
  Basic: 1 << 0,
  Skill1: 1 << 1,
  Skill2: 1 << 2,
  Skill3: 1 << 3,
  Dodge: 1 << 4,
} as const;
