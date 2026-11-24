/**
 * NetId ↔ eid ↔ playerId 三向映射（ARCHITECTURE §5.8 / §6.2）。
 *
 * 关键约束：eid 永远不上线。线上只传 NetId（Host 从 1 递增，0 无效），
 * 客户端通过全量快照重建自己的本地 eid 映射。alloc 只在 Host 角色下生效，
 * 返回 0 表示分配失败（席位非法 / eid 已绑定 / 达到容量），不抛异常打断 tick。
 */
import {
  assert,
  CAP,
  INVALID_EID,
  INVALID_NET_ID,
  MAX_PLAYERS,
} from '../core/Constants';
import { add, exists, has, query, type BattleWorld } from '../ecs/bit/adapter';
import { NetId, Owner, PlayerId } from '../ecs/bit/components';
import type { Eid } from '../ecs/bit/types';
import type { Snapshot } from './Snapshot';

const ERR_REGISTRY_CAPACITY = 4001;

/** 无效 playerId  sentinel：映射尚未从快照恢复时使用。 */
const UNKNOWN_PLAYER_ID = -1;

/**
 * 三向映射表。
 * - netToEid / netToPlayer 以 NetId 为下标（1..capacity）；
 * - eidToNet 以 eid 为下标（0..CAP-1）。
 */
export class EntityRegistry {
  private readonly netToEid: Int32Array;
  private readonly netToPlayer: Int32Array;
  private readonly eidToNet: Uint32Array;
  private readonly freeIds: number[] = [];
  private nextNetId = 1;
  private isHost = true;

  constructor(
    private readonly world: BattleWorld,
    readonly capacity: number = CAP,
  ) {
    assert(
      Number.isInteger(capacity) && capacity > 0 && capacity <= CAP,
      ERR_REGISTRY_CAPACITY,
      `EntityRegistry 容量非法: ${capacity}`,
    );
    this.netToEid = new Int32Array(capacity + 1);
    this.netToPlayer = new Int32Array(capacity + 1).fill(UNKNOWN_PLAYER_ID);
    this.eidToNet = new Uint32Array(CAP);
  }

  /** Host 独占分配入口；客户端调用返回 0。释放过的 NetId 优先复用。 */
  alloc(eid: Eid, playerId: number): number {
    if (!this.isHost) return INVALID_NET_ID;
    if (!Number.isInteger(eid) || eid < 0 || eid >= CAP) return INVALID_NET_ID;
    if (!Number.isInteger(playerId) || playerId < 0 || playerId >= MAX_PLAYERS) {
      return INVALID_NET_ID;
    }
    if (this.eidToNet[eid] !== INVALID_NET_ID) return INVALID_NET_ID;

    let netId = INVALID_NET_ID;
    while (this.freeIds.length > 0) {
      const candidate = this.freeIds.pop() as number;
      if (candidate > 0 && candidate <= this.capacity && this.netToEid[candidate] === INVALID_EID) {
        netId = candidate;
        break;
      }
    }
    if (netId === INVALID_NET_ID) {
      if (this.nextNetId > this.capacity) return INVALID_NET_ID;
      netId = this.nextNetId++;
    }
    this.bind(eid, netId, playerId);
    return netId;
  }

  /** 客户端从快照重建映射；Host 也可用于修正本地组件值。 */
  bind(eid: Eid, netId: number, playerId: number): void {
    if (!Number.isInteger(eid) || eid < 0 || eid >= CAP) return;
    if (!Number.isInteger(netId) || netId <= 0 || netId > this.capacity) return;

    const oldNetId = this.eidToNet[eid];
    if (oldNetId !== INVALID_NET_ID && oldNetId !== netId) {
      this.netToEid[oldNetId] = INVALID_EID;
      this.netToPlayer[oldNetId] = UNKNOWN_PLAYER_ID;
    }
    const previousEid = this.netToEid[netId];
    if (previousEid !== INVALID_EID && previousEid !== eid) {
      this.eidToNet[previousEid] = INVALID_NET_ID;
    }

    this.netToEid[netId] = eid;
    this.netToPlayer[netId] = Number.isInteger(playerId) && playerId >= 0
      ? playerId : UNKNOWN_PLAYER_ID;
    this.eidToNet[eid] = netId;
    if (netId + 1 > this.nextNetId) {
      this.nextNetId = netId + 1;
    }

    // 组件值同步只在真实存在的实体上进行，避免测试替身世界被污染。
    if (exists(this.world, eid)) {
      if (has(this.world, eid, NetId)) {
        NetId.value[eid] = netId;
      } else if (this.world.components.indexOf(NetId) >= 0) {
        add(this.world, eid, NetId);
        NetId.value[eid] = netId;
      }
      if (has(this.world, eid, Owner)) {
        Owner.netId[eid] = netId;
        if (this.netToPlayer[netId] >= 0) Owner.playerId[eid] = this.netToPlayer[netId];
      } else if (this.world.components.indexOf(Owner) >= 0) {
        add(this.world, eid, Owner);
        Owner.netId[eid] = netId;
        if (this.netToPlayer[netId] >= 0) Owner.playerId[eid] = this.netToPlayer[netId];
      }
    }
  }

  /** NetId → eid；不存在返回 INVALID_EID。 */
  byNetId(netId: number): Eid {
    if (!Number.isInteger(netId) || netId <= 0 || netId > this.capacity) return INVALID_EID;
    const eid = this.netToEid[netId];
    return eid < 0 ? INVALID_EID : eid;
  }

  /** eid → NetId；不存在返回 INVALID_NET_ID。 */
  byEid(eid: Eid): number {
    if (!Number.isInteger(eid) || eid < 0 || eid >= CAP) return INVALID_NET_ID;
    return this.eidToNet[eid];
  }

  /** NetId → playerId；不存在返回 -1。 */
  playerOf(netId: number): number {
    if (!Number.isInteger(netId) || netId <= 0 || netId > this.capacity) return -1;
    return this.netToPlayer[netId];
  }

  /** 解除三向映射，NetId 进入空闲栈供后续 alloc 复用。 */
  release(netId: number): void {
    if (!Number.isInteger(netId) || netId <= 0 || netId > this.capacity) return;
    const eid = this.netToEid[netId];
    if (eid !== INVALID_EID) {
      this.eidToNet[eid] = INVALID_NET_ID;
      if (exists(this.world, eid)) {
        if (has(this.world, eid, NetId)) NetId.value[eid] = INVALID_NET_ID;
        if (has(this.world, eid, Owner)) Owner.netId[eid] = INVALID_NET_ID;
      }
      this.netToEid[netId] = INVALID_EID;
    }
    this.netToPlayer[netId] = UNKNOWN_PLAYER_ID;
    if (this.freeIds.indexOf(netId) < 0) this.freeIds.push(netId);
  }

  /** 晚加入者的全量重建：按快照中的 NetId 列 + 世界中的 NetId 组件恢复映射。 */
  rebuild(snap: Snapshot): void {
    this.netToEid.fill(INVALID_EID);
    this.netToPlayer.fill(UNKNOWN_PLAYER_ID);
    this.eidToNet.fill(INVALID_NET_ID);
    this.freeIds.length = 0;

    const wanted = new Set<number>();
    for (let i = 0; i < snap.netIds.length; i++) {
      const netId = snap.netIds[i];
      if (netId > 0 && netId <= this.capacity) {
        wanted.add(netId);
        if (netId + 1 > this.nextNetId) this.nextNetId = netId + 1;
      }
    }
    if (this.world.components.indexOf(NetId) >= 0) {
      const entities = query(this.world, [NetId]);
      for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        const netId = NetId.value[eid];
        if (!wanted.has(netId)) continue;
        let playerId = UNKNOWN_PLAYER_ID;
        if (this.world.components.indexOf(Owner) >= 0 && has(this.world, eid, Owner)) {
          playerId = Owner.playerId[eid];
        } else if (this.world.components.indexOf(PlayerId) >= 0 && has(this.world, eid, PlayerId)) {
          playerId = PlayerId.value[eid];
        }
        this.bind(eid, netId, playerId);
      }
    }
    for (let netId = 1; netId < this.nextNetId; netId++) {
      if (this.netToEid[netId] === INVALID_EID && this.freeIds.indexOf(netId) < 0) {
        this.freeIds.push(netId);
      }
    }
  }

  /** 切换权威角色：客户端禁止 alloc，Host 允许。 */
  setAuthority(isHost: boolean): void {
    this.isHost = isHost;
  }

  get authority(): boolean {
    return this.isHost;
  }

  /** 下一个将分配的 NetId（调试/测试观测）。 */
  get next(): number {
    return this.nextNetId;
  }

  /** 当前已映射实体数。 */
  get size(): number {
    let total = 0;
    for (let netId = 1; netId < this.nextNetId; netId++) {
      if (this.netToEid[netId] !== INVALID_EID) total++;
    }
    return total;
  }
}
