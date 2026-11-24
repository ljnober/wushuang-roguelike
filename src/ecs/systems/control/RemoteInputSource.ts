/**
 * 远端玩家控制源：从 NetInputBuffer 读取指定 tick/netId 的输入帧。
 *
 * net/messages.ts 属批次 B，尚未落盘；这里用结构性接口描述其 read 签名，
 * 既避免运行时依赖，又能与真正的 NetInputBuffer 直接结构兼容（pump 时传入即可）。
 */
import type { ControlSourceKind, IControlSource, InputFrame } from './IControlSource';

/** 与 net/messages.ts 中 NetInputBuffer.read 相同的结构契约。 */
export interface NetInputBufferLike {
  read(tick: number, netId: number, out: InputFrame): boolean;
}

export class RemoteInputSource implements IControlSource {
  readonly kind: 2 = 2;

  private readonly buffer: NetInputBufferLike;
  private readonly netId: number;

  constructor(buffer: NetInputBufferLike, netId: number) {
    this.buffer = buffer;
    this.netId = netId;
  }

  poll(tick: number, out: InputFrame): void {
    const got = this.buffer.read(tick, this.netId, out);
    if (!got) {
      // 丢包/乱序导致无输入：沿用上一帧方向，只推进 tick，避免瞬移抖动。
      out.tick = tick;
    }
  }
}
