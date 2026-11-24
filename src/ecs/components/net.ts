/**
 * 网络组件分区再导出。
 * eid 永不上线：一切跨端引用只使用 NetId；PlayerId 为席位 0..3。
 */
export {
  PlayerId,
  NetId,
  Owner,
  SpawnTick,
  PlayerTag,
  EnemyTag,
  Replicated,
  Predicted,
  NetControlled,
  NetSession,
} from '../bit/components';

/** NetSession.role 冻结值语义（架构 §6.2） */
export const AuthorityRole = {
  Standalone: 0,
  Host: 1,
  Client: 2,
  Electing: 3,
} as const;

/** 无效 NetId 与无效 eid（与 Constants 保持一致，便于网络层单独引用） */
export const INVALID_NET_ID = 0;
export const INVALID_EID = 0;
