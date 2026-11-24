/**
 * 全局游戏规则常量、错误类型与断言（ARCHITECTURE §5.1）。
 *
 * 这些数值是游戏规则的一部分：与设备性能、帧率、画质档位完全无关。
 * 生产构建保留 CAP/eid 断言，静默损坏会破坏确定性。
 */

export const TICK_RATE = 60;
/** 固定逻辑步长（游戏规则常量，与设备/画质无关）。 */
export const TICK_DT = 1 / 60;
/** 玩家席位 0..3。 */
export const MAX_PLAYERS = 4;
/** 实体容量：300 敌 + 500 弹幕 + 特效/掉落 + 余量，所有设备统一。 */
export const CAP = 4096;
export const MAX_PROJECTILES = 512;
export const MAX_ENEMIES = 320;
/** EffectEntityPool 预留段起点。 */
export const EFFECT_ENTITY_BASE = 2048;
export const COMMAND_QUEUE_SIZE = 4096;
export const EVENT_QUEUE_SIZE = 8192;
/** ParamPool 的 Float32Array 长度。 */
export const PARAM_POOL_SIZE = 65536;
export const SNAPSHOT_POOL_SIZE = 256;
/** SnapshotPool 每条属性贡献槽。 */
export const MAX_CONTRIB_PER_STAT = 64;
export const INPUT_HISTORY_SIZE = 256;
export const SNAPSHOT_HISTORY_SIZE = 128;
export const SAVE_KEY = 'wushuang.profile.v1';
export const SAVE_MAX_BYTES = 80 * 1024;
export const SAVE_THROTTLE_MS = 2000;
export const HUD_THROTTLE_MS = 100;
/** 小于此误差 lerp。 */
export const SNAP_LERP_THRESHOLD = 1.5;
/** 大于此误差 snap。 */
export const SNAP_TELEPORT_THRESHOLD = 20;
export const INVALID_NET_ID = 0;
export const INVALID_EID = 0;

/** 经验曲线：round(10 + 8L + 0.8L²)。 */
export const EXP_CURVE = (L: number): number => Math.round(10 + 8 * L + 0.8 * L * L);

/** 带稳定错误码的项目异常（1xxx 配置/注册；2xxx ECS/CAP；3xxx 存档；4xxx 网络；5xxx 渲染）。 */
export class WushuangError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'WushuangError';
    Object.setPrototypeOf(this, WushuangError.prototype);
  }
}

/** 条件失败时抛 WushuangError；CAP / eid / 枚举非法必须断言。 */
export function assert(cond: unknown, code: number, message: string): asserts cond {
  if (!cond) {
    throw new WushuangError(code, message);
  }
}
