/**
 * 整局可玩性测试 · 事件总线 drain + 计数工具。
 *
 * 设计依据：ARCHITECTURE_FULLRUN.md §3.2 / §13。
 * 事件口径：GameEventType 数字枚举不可重排，tally key 统一走 eventName(type)。
 * 零产品后门：本文件只调用 GameEventBus 公开 API，不修改任何产品源码。
 */
import type { GameEventBus, GameEvent } from '../../ecs/bridge/GameEventBus';
import { createEventSlot } from '../../ecs/bridge/GameEventBus';
import { GameEventType } from '../../ecs/bridge/enums';

/** GameEventBus 默认容量（Constants.EVENT_QUEUE_SIZE = 8192），同时作为默认 out 预分配长度。 */
const DEFAULT_BUFFER_SIZE = 8192;

/**
 * 预填充事件槽。GameEventBus.drain 只写 out.length 个元素，
 * 预分配可避免热路径反复创建对象，并保证整批事件被完整消费。
 */
export function createEventBuffer(size: number = DEFAULT_BUFFER_SIZE): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < size; i++) {
    out.push(createEventSlot());
  }
  return out;
}

/**
 * 将总线中的事件全部 drain 到 out，并按名字累计到 tally。
 * @returns 本次 drain 实际写出的事件条数。
 */
export function drainAndTally(
  bus: GameEventBus,
  out: GameEvent[],
  tally: Record<string, number>,
): number {
  const drained = bus.drain(out);
  for (let i = 0; i < drained; i++) {
    const name = eventName(out[i].type);
    tally[name] = (tally[name] ?? 0) + 1;
  }
  return drained;
}

/**
 * 事件数字类型 → 冻结名字（1→Damage ... 13→NetEvent）。
 * 直接用数字枚举的反向映射，避免手写表与枚举漂移。
 */
export function eventName(type: number): string {
  const reverse = GameEventType as unknown as Record<number, string | undefined>;
  return reverse[type] ?? `Unknown(${type})`;
}
