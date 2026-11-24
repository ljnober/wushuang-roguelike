/**
 * 确定性模拟纯入口（ARCHITECTURE §5.8 / §6.1）。
 *
 * step(tick, inputFrame, state) 不读取 Date.now/performance.now，不读取画质档位，
 * 也不产生随机数：相同 state + 相同 tick + 相同输入序列必然得到相同结果。
 * 唯一权威时钟在 ecs/scheduler，这里通过 state.session.simTick 与之对齐；
 * SimState/PoolBundle/BusBundle/SimSystem 直接复用 scheduler 的定义（契约 §5.8）。
 */
import { assert } from '../core/Constants';
import { has, query, type BattleWorld } from '../ecs/bit/adapter';
import {
  ControlSource,
  InputCmd,
  NetId,
  Owner,
  PlayerId,
  PlayerTag,
  Replicated,
} from '../ecs/bit/components';
import type { InputFrame } from '../ecs/systems/control/IControlSource';
import { sessionFromState, writeSessionTick } from './session';
import { SNAPSHOT_COLUMNS } from './Snapshot';

export type {
  SimState,
  PoolBundle,
  BusBundle,
  SimSystem,
} from '../ecs/scheduler';
import type { SimState, SimSystem } from '../ecs/scheduler';

const ERR_SIM_TICK = 4005;

/** FNV-1a 素数与偏移基数。 */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** 复用同一块 4 字节缓冲把数值转成 IEEE754/整数位，hash 热路径零分配。 */
const hashScratch = new DataView(new ArrayBuffer(4));

function hashByte(hash: number, value: number): number {
  return Math.imul(hash ^ (value & 0xff), FNV_PRIME) >>> 0;
}

function hashU32(hash: number, value: number): number {
  hashScratch.setUint32(0, value >>> 0, true);
  for (let i = 0; i < 4; i++) hash = hashByte(hash, hashScratch.getUint8(i));
  return hash;
}

function hashF32(hash: number, value: number): number {
  hashScratch.setFloat32(0, value, true);
  for (let i = 0; i < 4; i++) hash = hashByte(hash, hashScratch.getUint8(i));
  return hash;
}

/**
 * 确定性模拟驱动：构造时冻结系统执行序列，step 只做输入注入 + 按序执行。
 */
export class DeterministicSim {
  private readonly orderedSystems: readonly SimSystem[];

  constructor(
    private readonly state: SimState,
    systems: readonly SimSystem[],
  ) {
    // 复制并稳定排序：注册顺序之外的重复安装不得改变 tick 语义。
    const copy = systems.slice();
    copy.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
    this.orderedSystems = copy;
  }

  /** 执行一个固定 tick。inputFrame 只被读取，不会被修改。 */
  step(tick: number, inputFrame: InputFrame, state: SimState): void {
    assert(Number.isInteger(tick) && tick >= 0, ERR_SIM_TICK, `非法逻辑 tick: ${tick}`);
    // 权威时钟写入：与 ecs/scheduler.stepTick 的行为保持一致。
    writeSessionTick(state.session, tick);
    const session = sessionFromState(state.session);
    this.writeLocalInput(state.world, session.localPlayerId, tick, inputFrame);
    for (let i = 0; i < this.orderedSystems.length; i++) {
      this.orderedSystems[i].run(state, tick);
    }
  }

  /**
   * 状态哈希：FNV-1a 逐字节覆盖 Replicated 列。
   * 实体按 NetId 排序，因此 eid 的分配/回收顺序不影响哈希（harness 可跨 frame jitter 对比）。
   */
  hash(state: SimState): number {
    const world = state.world;
    let hash = FNV_OFFSET;
    if (world.components.indexOf(Replicated) < 0) return hash;

    const entities = query(world, [Replicated]);
    const sorted: Array<{ eid: number; netId: number }> = [];
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      let netId = 0;
      if (world.components.indexOf(NetId) >= 0 && has(world, eid, NetId)) netId = NetId.value[eid];
      if (netId === 0 && world.components.indexOf(Owner) >= 0 && has(world, eid, Owner)) {
        netId = Owner.netId[eid];
      }
      sorted.push({ eid, netId: netId > 0 ? netId : eid + 0x10000000 });
    }
    sorted.sort((a, b) => a.netId - b.netId || a.eid - b.eid);

    for (let i = 0; i < sorted.length; i++) {
      const eid = sorted[i].eid;
      hash = hashU32(hash, sorted[i].netId >>> 0);
      for (let c = 0; c < SNAPSHOT_COLUMNS.length; c++) {
        const column = SNAPSHOT_COLUMNS[c];
        if (!has(world, eid, column.component)) {
          hash = hashByte(hash, 0);
          continue;
        }
        hash = hashU32(hash, column.bit);
        for (let f = 0; f < column.fields.length; f++) {
          const value = column.component[column.fields[f]][eid];
          if (column.fieldKinds[f] === 'f32') {
            hash = hashF32(hash, value);
          } else {
            hash = hashU32(hash, value);
          }
        }
      }
    }
    return hash >>> 0;
  }

  /** 构造时传入的系统数量（调试/注册完整性检查）。 */
  get systemCount(): number {
    return this.orderedSystems.length;
  }

  /** 构造时传入的 state 引用（step 允许短期切到另一个 state 做 A/B 对比）。 */
  get initialState(): SimState {
    return this.state;
  }

  /** 把输入帧写入本地玩家的 InputCmd；未找到本地玩家时保持命令组件不变。 */
  private writeLocalInput(
    world: BattleWorld,
    localPlayerId: number,
    tick: number,
    frame: InputFrame,
  ): void {
    if (world.components.indexOf(InputCmd) < 0 || world.components.indexOf(PlayerTag) < 0) return;
    const entities = query(world, [PlayerTag, InputCmd]);
    let target = 0;
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (world.components.indexOf(PlayerId) >= 0 && has(world, eid, PlayerId)
        && PlayerId.value[eid] === localPlayerId) {
        target = eid;
        break;
      }
      if (target === 0 && world.components.indexOf(ControlSource) < 0) target = eid;
    }
    if (target === 0) return;
    InputCmd.moveX[target] = frame.moveX;
    InputCmd.moveY[target] = frame.moveY;
    InputCmd.aimX[target] = frame.aimX;
    InputCmd.aimY[target] = frame.aimY;
    InputCmd.buttons[target] = frame.buttons;
    InputCmd.tick[target] = tick;
    InputCmd.seq[target] = frame.seq;
  }
}
