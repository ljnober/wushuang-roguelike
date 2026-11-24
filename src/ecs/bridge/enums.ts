/**
 * 命令 / 事件的数字枚举（架构 §6.2 冻结）。
 * 编号只在末尾追加，永不重排 —— 存档、快照与协议兼容性依赖此约束。
 */

/** DOM → ECS 命令类型 */
export enum CommandType {
  Move = 1,
  Aim = 2,
  Skill = 3,
  AutoToggle = 4,
  Pause = 5,
  Ping = 6,
}

/** ECS → DOM 事件类型 */
export enum GameEventType {
  Damage = 1,
  Kill = 2,
  Pickup = 3,
  LevelUp = 4,
  BossWarn = 5,
  BossPhase = 6,
  Equip = 7,
  GemSocket = 8,
  CubeResult = 9,
  Death = 10,
  Victory = 11,
  Defeat = 12,
  NetEvent = 13,
}

/** 命令负载槽数量（Int32Array 环形队列的步长） */
export const COMMAND_STRIDE = 6;

/** 事件数据负载槽数量（Float32Array 环形队列的步长） */
export const EVENT_DATA_STRIDE = 3;
