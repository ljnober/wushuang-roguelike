/**
 * 网络协议消息与输入缓冲（ARCHITECTURE §5.8 / §6.2）。
 *
 * - NetMsgType 编号冻结：1 InputReport / 2 StateSnapshot / 3 EventBatch / 4 Delta / 5 Control；
 * - NetMessage 是唯一线上信封，payload 一律为 ArrayBuffer（小端编码）；
 * - NetInputBuffer 供 A3 的 RemoteInputSource 以结构接口 read(tick,netId,out) 读取，签名完全兼容；
 * - 所有编解码辅助函数不依赖墙钟、不做字符串查找，分配只发生在消息构造期（不在 tick 热路径反复创建）。
 */
import { MAX_PLAYERS } from '../core/Constants';
import type { InputFrame } from '../ecs/systems/control/IControlSource';

/** 协议类型编号冻结，新增只能在末尾追加。 */
export enum NetMsgType {
  InputReport = 1,
  StateSnapshot = 2,
  EventBatch = 3,
  Delta = 4,
  Control = 5,
}

/** 网络消息信封。from/to 均为 NetId（0 表示无对端/本地）。 */
export interface NetMessage {
  type: NetMsgType;
  from: number;
  to: number;
  tick: number;
  payload: ArrayBuffer;
}

/** 控制消息（join/leave/promote/roomSeed 按可选字段编码，缺省即不使用）。 */
export interface ControlMessage {
  join?: number;
  leave?: number;
  promote?: number;
  roomSeed?: number;
}

/** 控制消息负载固定 4 个 u32：join / leave / promote / roomSeed（0 表示未设置）。 */
export const CONTROL_PAYLOAD_BYTES = 16;
/** 输入负载：8 个 f32 = netId + InputFrame 的 7 个字段。 */
export const INPUT_PAYLOAD_BYTES = 32;
/** 事件负载：4 个 i32 = type / a / b / c。 */
export const EVENT_STRIDE_BYTES = 16;

/** 编码单个输入帧；netId 与 frame 一并写入，接收端无需额外上下文。 */
export function encodeInputPayload(netId: number, frame: InputFrame): ArrayBuffer {
  const buffer = new ArrayBuffer(INPUT_PAYLOAD_BYTES);
  const view = new DataView(buffer);
  view.setFloat32(0, netId, true);
  view.setFloat32(4, frame.moveX, true);
  view.setFloat32(8, frame.moveY, true);
  view.setFloat32(12, frame.aimX, true);
  view.setFloat32(16, frame.aimY, true);
  view.setFloat32(20, frame.buttons, true);
  view.setFloat32(24, frame.tick, true);
  view.setFloat32(28, frame.seq, true);
  return buffer;
}

/** 解码输入负载，写入调用方预分配的 out；返回负载里的 netId。 */
export function decodeInputPayload(payload: ArrayBuffer, out: InputFrame): number {
  const view = new DataView(payload);
  out.moveX = view.getFloat32(4, true);
  out.moveY = view.getFloat32(8, true);
  out.aimX = view.getFloat32(12, true);
  out.aimY = view.getFloat32(16, true);
  out.buttons = view.getFloat32(20, true);
  out.tick = view.getFloat32(24, true);
  out.seq = view.getFloat32(28, true);
  return view.getFloat32(0, true) >>> 0;
}

/** 事件批量编码（GameEvent 的结构性接口，不引入桥接模块运行时依赖）。 */
export function encodeEvents(
  events: readonly { type: number; a: number; b: number; c: number }[],
): ArrayBuffer {
  const buffer = new ArrayBuffer(events.length * EVENT_STRIDE_BYTES);
  const view = new DataView(buffer);
  for (let i = 0; i < events.length; i++) {
    const base = i * EVENT_STRIDE_BYTES;
    const event = events[i];
    view.setInt32(base, event.type, true);
    view.setInt32(base + 4, event.a, true);
    view.setInt32(base + 8, event.b, true);
    view.setInt32(base + 12, event.c, true);
  }
  return buffer;
}

/** 事件批量解码；emit 由调用方提供（通常写入 GameEventBus）。返回事件数。 */
export function decodeEvents(
  payload: ArrayBuffer,
  emit: (type: number, a: number, b: number, c: number) => void,
): number {
  const view = new DataView(payload);
  const count = Math.floor(view.byteLength / EVENT_STRIDE_BYTES);
  for (let i = 0; i < count; i++) {
    const base = i * EVENT_STRIDE_BYTES;
    emit(view.getInt32(base, true), view.getInt32(base + 4, true),
      view.getInt32(base + 8, true), view.getInt32(base + 12, true));
  }
  return count;
}

/** 控制消息编码（未设置字段写 0）。 */
export function encodeControlMessage(msg: ControlMessage): ArrayBuffer {
  const buffer = new ArrayBuffer(CONTROL_PAYLOAD_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, msg.join ?? 0, true);
  view.setUint32(4, msg.leave ?? 0, true);
  view.setUint32(8, msg.promote ?? 0, true);
  view.setUint32(12, msg.roomSeed ?? 0, true);
  return buffer;
}

/** 控制消息解码。 */
export function decodeControlMessage(payload: ArrayBuffer): ControlMessage {
  const view = new DataView(payload);
  return {
    join: view.getUint32(0, true),
    leave: view.getUint32(4, true),
    promote: view.getUint32(8, true),
    roomSeed: view.getUint32(12, true),
  };
}

interface InputRecord {
  tick: number;
  netId: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  buttons: number;
  seq: number;
}

/**
 * 输入历史缓冲：按 netId 分组保存 (tick, netId) → InputFrame。
 * 同一 tick/netId 重复 push 时覆盖旧值；clearBefore 用原地压缩，不产生新数组。
 *
 * 与 A3 RemoteInputSource 的契约：read(tick,netId,out) 未命中时保持 out 原值并返回 false。
 */
export class NetInputBuffer {
  private readonly records = new Map<number, InputRecord[]>();

  push(tick: number, netId: number, frame: InputFrame): void {
    if (!Number.isFinite(tick) || !Number.isInteger(netId) || netId <= 0) {
      return;
    }
    let list = this.records.get(netId);
    if (list === undefined) {
      list = [];
      this.records.set(netId, list);
    }
    for (let i = 0; i < list.length; i++) {
      const record = list[i];
      if (record.tick === tick) {
        record.moveX = frame.moveX;
        record.moveY = frame.moveY;
        record.aimX = frame.aimX;
        record.aimY = frame.aimY;
        record.buttons = frame.buttons;
        record.seq = frame.seq;
        return;
      }
    }
    // 按 tick 升序插入：乱序包也能被 O(log n) 定位，读端只做一次顺序扫描。
    let insertAt = list.length;
    for (let i = 0; i < list.length; i++) {
      if (list[i].tick > tick) {
        insertAt = i;
        break;
      }
    }
    list.splice(insertAt, 0, {
      tick,
      netId,
      moveX: frame.moveX,
      moveY: frame.moveY,
      aimX: frame.aimX,
      aimY: frame.aimY,
      buttons: frame.buttons,
      seq: frame.seq,
    });
  }

  read(tick: number, netId: number, out: InputFrame): boolean {
    const list = this.records.get(netId);
    if (list === undefined) {
      return false;
    }
    for (let i = 0; i < list.length; i++) {
      const record = list[i];
      if (record.tick === tick) {
        out.moveX = record.moveX;
        out.moveY = record.moveY;
        out.aimX = record.aimX;
        out.aimY = record.aimY;
        out.buttons = record.buttons;
        out.tick = tick;
        out.seq = record.seq;
        return true;
      }
      if (record.tick > tick) {
        break;
      }
    }
    return false;
  }

  /** 丢弃 tick 严格小于给定值的历史（保留该 tick 本身用于和解/重放）。 */
  clearBefore(tick: number): void {
    const keys: number[] = [];
    this.records.forEach((_list, netId) => keys.push(netId));
    for (let k = 0; k < keys.length; k++) {
      const list = this.records.get(keys[k]);
      if (list === undefined) {
        continue;
      }
      let write = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].tick >= tick) {
          list[write++] = list[i];
        }
      }
      list.length = write;
      if (write === 0) {
        this.records.delete(keys[k]);
      }
    }
  }

  /** 最近一条记录的 tick（供调试/和解边界判断）；无记录返回 0。 */
  latestTick(netId?: number): number {
    let result = 0;
    if (netId !== undefined) {
      const list = this.records.get(netId);
      if (list !== undefined && list.length > 0) {
        result = list[list.length - 1].tick;
      }
      return result;
    }
    this.records.forEach((list) => {
      if (list.length > 0 && list[list.length - 1].tick > result) {
        result = list[list.length - 1].tick;
      }
    });
    return result;
  }

  /** 清空全部输入历史。 */
  clear(): void {
    this.records.clear();
  }

  /** 当前缓存记录数（供测试与观测）。 */
  get size(): number {
    let total = 0;
    this.records.forEach((list) => { total += list.length; });
    return total;
  }
}

/** 校验 playerId 是否处于合法席位范围（网络控制消息入口校验）。 */
export function isValidPlayerId(playerId: number): boolean {
  return Number.isInteger(playerId) && playerId >= 0 && playerId < MAX_PLAYERS;
}
