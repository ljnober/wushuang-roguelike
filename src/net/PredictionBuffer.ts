/**
 * 客户端预测与和解（ARCHITECTURE §5.8 / §6.1）。
 *
 * - InputHistory / SnapshotHistory 均为定长环形缓冲，不在 tick 热路径扩张数组；
 * - reconcile：误差 ≤ SNAP_LERP_THRESHOLD 用 0.5 插值，中等误差用 0.25 插值，
 *   误差 > SNAP_TELEPORT_THRESHOLD 直接 snap（Constants 阈值，随游戏规则冻结）；
 * - 应用权威快照后，把 snap.tick 之后仍未确认的输入逐条重放，返回重放 tick 数。
 */
import {
  assert,
  INPUT_HISTORY_SIZE,
  SNAPSHOT_HISTORY_SIZE,
  SNAP_LERP_THRESHOLD,
  SNAP_TELEPORT_THRESHOLD,
} from '../core/Constants';
import { createInputFrame, type InputFrame } from '../ecs/systems/control/IControlSource';
import { blendWithPositions, readPositions, type Snapshot } from './Snapshot';

const ERR_PREDICTION_CAPACITY = 4006;

/** 一条输入历史记录；frame 对象在构造期预分配，record 只做字段拷贝。 */
interface InputSlot {
  active: boolean;
  tick: number;
  frame: InputFrame;
}

/** 输入环形缓冲。 */
export class InputHistory {
  private readonly slots: InputSlot[];
  private writeIndex = 0;

  constructor(readonly capacity: number = INPUT_HISTORY_SIZE) {
    assert(capacity > 0, ERR_PREDICTION_CAPACITY, '输入历史容量必须为正');
    this.slots = [];
    for (let i = 0; i < capacity; i++) {
      this.slots.push({
        active: false,
        tick: 0,
        frame: createInputFrame(),
      });
    }
  }

  record(tick: number, frame: InputFrame): void {
    const slot = this.slots[this.writeIndex];
    slot.tick = tick;
    slot.frame.moveX = frame.moveX;
    slot.frame.moveY = frame.moveY;
    slot.frame.aimX = frame.aimX;
    slot.frame.aimY = frame.aimY;
    slot.frame.buttons = frame.buttons;
    slot.frame.tick = tick;
    slot.frame.seq = frame.seq;
    slot.active = true;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
  }

  /** 返回 tick 之后的所有输入（升序，拷贝 frame，调用方可安全修改）。 */
  after(tick: number): Array<{ tick: number; frame: InputFrame }> {
    const result: Array<{ tick: number; frame: InputFrame }> = [];
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.active && slot.tick > tick) {
        const copy = createInputFrame();
        copy.moveX = slot.frame.moveX;
        copy.moveY = slot.frame.moveY;
        copy.aimX = slot.frame.aimX;
        copy.aimY = slot.frame.aimY;
        copy.buttons = slot.frame.buttons;
        copy.tick = slot.frame.tick;
        copy.seq = slot.frame.seq;
        result.push({ tick: slot.tick, frame: copy });
      }
    }
    result.sort((a, b) => a.tick - b.tick);
    return result;
  }

  clearBefore(tick: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].active && this.slots[i].tick < tick) this.slots[i].active = false;
    }
  }

  clear(): void {
    for (let i = 0; i < this.slots.length; i++) this.slots[i].active = false;
    this.writeIndex = 0;
  }

  get size(): number {
    let total = 0;
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].active) total++;
    return total;
  }
}

/** 快照环形缓冲（保留引用，payload 为不可变 ArrayBuffer）。 */
export class SnapshotHistory {
  private readonly slots: Snapshot[] = [];
  private writeIndex = 0;

  constructor(readonly capacity: number = SNAPSHOT_HISTORY_SIZE) {
    assert(capacity > 0, ERR_PREDICTION_CAPACITY, '快照历史容量必须为正');
  }

  record(snap: Snapshot): void {
    this.slots[this.writeIndex] = snap;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
  }

  latest(): Snapshot | null {
    if (this.slots.length === 0) return null;
    const index = (this.writeIndex - 1 + this.capacity) % this.capacity;
    return this.slots[index] ?? null;
  }

  clear(): void {
    this.slots.length = 0;
    this.writeIndex = 0;
  }

  get size(): number {
    return this.slots.length;
  }
}

/** 预测缓冲：输入历史 + 快照历史 + 和解调度。 */
export class PredictionBuffer {
  private readonly inputHistory: InputHistory;
  private readonly snapshotHistory: SnapshotHistory;
  private ackedTick = 0;
  private predictedPositions: Float32Array | null = null;
  private lastApplied: Snapshot | null = null;

  constructor(capacity: number = INPUT_HISTORY_SIZE) {
    this.inputHistory = new InputHistory(capacity);
    this.snapshotHistory = new SnapshotHistory(SNAPSHOT_HISTORY_SIZE);
  }

  recordInput(tick: number, frame: InputFrame): void {
    this.inputHistory.record(tick, frame);
  }

  recordSnapshot(snap: Snapshot): void {
    this.snapshotHistory.record(snap);
    if (snap.tick > this.ackedTick) this.ackedTick = snap.tick;
  }

  lastAckedTick(): number {
    return this.ackedTick;
  }

  inputsAfter(tick: number): Array<{ tick: number; frame: InputFrame }> {
    return this.inputHistory.after(tick);
  }

  /**
   * 和解：把权威快照（必要时插值后）交给 apply，再重放 ack 之后的输入。
   * @returns 实际重放的输入 tick 数。
   */
  reconcile(
    snap: Snapshot,
    apply: (s: Snapshot) => void,
    replay: (tick: number, f: InputFrame) => void,
  ): number {
    this.recordSnapshot(snap);
    const authoritative = readPositions(snap);
    const baseline = this.predictedPositions
      ?? (this.lastApplied === null ? null : readPositions(this.lastApplied));

    let error = Number.POSITIVE_INFINITY;
    if (authoritative !== null && baseline !== null
      && authoritative.length === baseline.length && authoritative.length > 0) {
      error = 0;
      for (let i = 0; i < authoritative.length; i++) {
        const delta = Math.abs(authoritative[i] - baseline[i]);
        if (delta > error) error = delta;
      }
    }

    let target = snap;
    if (authoritative !== null && baseline !== null && error <= SNAP_TELEPORT_THRESHOLD) {
      const alpha = error <= SNAP_LERP_THRESHOLD ? 0.5 : 0.25;
      target = blendWithPositions(snap, baseline, alpha);
    }
    apply(target);
    this.lastApplied = target;

    const pending = this.inputHistory.after(snap.tick);
    for (let i = 0; i < pending.length; i++) {
      replay(pending[i].tick, pending[i].frame);
    }
    this.predictedPositions = null;
    if (snap.tick > this.ackedTick) this.ackedTick = snap.tick;
    return pending.length;
  }

  /**
   * 注入本地预测后的位置列（[x0,y0,x1,y1,...]，顺序与快照 netIds 一致）。
   * 由宿主系统在重放完成后写入，下一次 reconcile 据此计算误差。
   */
  setPredictedPositions(positions: Float32Array | null): void {
    this.predictedPositions = positions === null ? null : positions.slice();
  }

  reset(): void {
    this.inputHistory.clear();
    this.snapshotHistory.clear();
    this.ackedTick = 0;
    this.predictedPositions = null;
    this.lastApplied = null;
  }

  get inputCount(): number {
    return this.inputHistory.size;
  }

  get snapshotCount(): number {
    return this.snapshotHistory.size;
  }
}
