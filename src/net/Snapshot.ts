/**
 * Full 快照编解码（ARCHITECTURE §5.8 / §6.2）。
 *
 * 快照内容精确等于带 Replicated 标签的实体集合：没有标签的实体一个字节都不写；
 * 每个实体还带 presence 位掩码，因此未挂载的组件列不会被凭空补零成"有数据"。
 *
 * ArrayBuffer 布局（全部小端）：
 *   [0..27]    header: magic u32 / version u16 / flags u16 / tick u32 / mask u32 /
 *                      count u32 / statVersion u32 / reserved u32
 *   [28..]     presence: count × u32（每个实体的组件位掩码）
 *   [..]       netIds : count × u32（按 NetId 升序，eid 永不上线）
 *   [..]       列块   : 对 mask 中按位序升序的每个组件，按 netIds 顺序连续写其字段
 *
 * delta/量化不在此文件实现：通过 ISyncStrategy.buildDelta/applyDelta 接口后接（P6）。
 */
import { assert, CAP, WushuangError } from '../core/Constants';
import { add, has, query, spawn, type BattleWorld } from '../ecs/bit/adapter';
import {
  ALL_COMPONENTS,
  ActiveEffect,
  Attack,
  Collider,
  ControlSource,
  EffectTag,
  Faction,
  Health,
  Heading,
  Lifetime,
  Modifier,
  NetId,
  Owner,
  Pickup,
  PlayerId,
  Position,
  Projectile,
  Replicated,
  SpawnTick,
  Speed,
  StatBlock,
  StatSnapshotRef,
  Velocity,
  effectMask,
} from '../ecs/bit/components';
import type { Eid, SoAComponent } from '../ecs/bit/types';
import type { EntityRegistry } from './EntityRegistry';

const ERR_SNAPSHOT_FORMAT = 4002;
const ERR_SNAPSHOT_RANGE = 4003;

/** 'WSNP' 小端魔数。 */
export const SNAPSHOT_MAGIC = 0x504e5357;
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_HEADER_BYTES = 28;

const OFF_MAGIC = 0;
const OFF_VERSION = 4;
const OFF_FLAGS = 6;
const OFF_TICK = 8;
const OFF_MASK = 12;
const OFF_COUNT = 16;
const OFF_STAT_VERSION = 20;
const OFF_RESERVED = 24;

/** 对外冻结的快照结构。 */
export interface Snapshot {
  tick: number;
  mask: number;
  netIds: Uint32Array;
  data: ArrayBuffer;
  statVersion?: number;
}

type FieldKind = 'f32' | 'i32' | 'u32' | 'u8';

/** 一个被复制的组件列（字段顺序冻结，等于组件定义顺序）。 */
export interface SnapshotColumn {
  readonly component: SoAComponent;
  readonly componentIndex: number;
  readonly bit: number;
  readonly fields: readonly string[];
  readonly fieldKinds: readonly FieldKind[];
  readonly stride: number;
}

function fieldKindOf(component: SoAComponent, field: string): FieldKind {
  const array = component[field];
  if (array instanceof Float32Array) return 'f32';
  if (array instanceof Int32Array) return 'i32';
  if (array instanceof Uint32Array) return 'u32';
  if (array instanceof Uint8Array) return 'u8';
  throw new WushuangError(ERR_SNAPSHOT_FORMAT, `快照字段 ${field} 的 typed array 类型未知`);
}

function kindBytes(kind: FieldKind): number {
  return kind === 'u8' ? 1 : 4;
}

/**
 * 列位号按本清单内的序号分配（不复用 ALL_COMPONENTS 下标）：JS 位运算只有 32 位，
 * ALL_COMPONENTS 有 45 项，直接 1 << componentIndex 会发生移位回绕并产生位冲突。
 * SnapshotColumn.componentIndex 仍保留 ALL_COMPONENTS 下标，仅用于布局的 start 索引。
 */
function createColumnFactory(): (component: SoAComponent, fields: readonly string[]) => SnapshotColumn {
  let ordinal = 0;
  return (component: SoAComponent, fields: readonly string[]): SnapshotColumn => {
    const componentIndex = ALL_COMPONENTS.indexOf(component);
    assert(componentIndex >= 0, ERR_SNAPSHOT_FORMAT, '快照列引用了未注册组件');
    const bit = 1 << ordinal++;
    assert(bit > 0, ERR_SNAPSHOT_FORMAT, '快照列数超过 32 位掩码上限');
    const kinds: FieldKind[] = [];
    let stride = 0;
    for (let i = 0; i < fields.length; i++) {
      const kind = fieldKindOf(component, fields[i]);
      kinds.push(kind);
      stride += kindBytes(kind);
    }
    return { component, componentIndex, bit, fields, fieldKinds: kinds, stride };
  };
}

const defineColumn = createColumnFactory();

/**
 * Replicated 列的冻结清单：只复制"完整参与模拟的状态组件"。
 * 渲染标签（Culled/RenderRef）、瞬时 Damage 标记、命令队列均不在其中；
 * NetId/Owner/PlayerId/SpawnTick 是客户端重建所必需的元数据，属于本集合。
 */
export const SNAPSHOT_COLUMNS: readonly SnapshotColumn[] = [
  defineColumn(Position, ['x', 'y', 'px', 'py']),
  defineColumn(Velocity, ['x', 'y']),
  defineColumn(Heading, ['angle']),
  defineColumn(Health, ['cur', 'max', 'regen']),
  defineColumn(Faction, ['value']),
  defineColumn(Speed, ['value']),
  defineColumn(Collider, ['r', 'type', 'w', 'h', 'layer']),
  defineColumn(Attack, ['damage', 'rate', 'cd', 'range']),
  defineColumn(Projectile, ['dx', 'dy', 'speed', 'pierce', 'hitMask']),
  defineColumn(Pickup, ['kind', 'amount', 'cfgId']),
  defineColumn(Lifetime, ['remaining']),
  defineColumn(ControlSource, ['kind', 'ref']),
  defineColumn(EffectTag, []),
  defineColumn(ActiveEffect, ['defId', 'state', 'elapsed', 'cd']),
  defineColumn(effectMask, ['value']),
  defineColumn(Modifier, [
    'stat', 'op', 'bucket', 'priority', 'sourceKind', 'sourceId',
    'group', 'condMask', 'duration', 'flags', 'value',
  ]),
  defineColumn(StatBlock, Object.keys(StatBlock)),
  defineColumn(StatSnapshotRef, ['poolIndex', 'version']),
  defineColumn(PlayerId, ['value']),
  defineColumn(NetId, ['value']),
  defineColumn(Owner, ['netId', 'playerId']),
  defineColumn(SpawnTick, ['value']),
].sort((a, b) => a.bit - b.bit);

/** presence / netIds / 列块的起始偏移及总长度。 */
export interface SnapshotLayout {
  readonly presenceOffset: number;
  readonly netIdsOffset: number;
  readonly columnsOffset: number;
  readonly starts: Int32Array;
  readonly totalBytes: number;
}

/** 按 mask 计算布局；未出现在 mask 的列 start 为 -1。 */
export function snapshotLayout(mask: number, count: number): SnapshotLayout {
  assert(Number.isInteger(count) && count >= 0, ERR_SNAPSHOT_RANGE, '快照实体数非法');
  const presenceOffset = SNAPSHOT_HEADER_BYTES;
  const netIdsOffset = presenceOffset + count * 4;
  const columnsOffset = netIdsOffset + count * 4;
  const starts = new Int32Array(ALL_COMPONENTS.length).fill(-1);
  let cursor = columnsOffset;
  for (let i = 0; i < SNAPSHOT_COLUMNS.length; i++) {
    const column = SNAPSHOT_COLUMNS[i];
    if ((mask & column.bit) === 0) continue;
    starts[column.componentIndex] = cursor;
    cursor += column.stride * count;
  }
  return { presenceOffset, netIdsOffset, columnsOffset, starts, totalBytes: cursor };
}

function readNumeric(view: DataView, kind: FieldKind, offset: number): number {
  switch (kind) {
    case 'f32': return view.getFloat32(offset, true);
    case 'i32': return view.getInt32(offset, true);
    case 'u32': return view.getUint32(offset, true);
    case 'u8': return view.getUint8(offset);
    default: return 0;
  }
}

function writeNumeric(view: DataView, kind: FieldKind, offset: number, value: number): void {
  switch (kind) {
    case 'f32': view.setFloat32(offset, value, true); break;
    case 'i32': view.setInt32(offset, value | 0, true); break;
    case 'u32': view.setUint32(offset, value >>> 0, true); break;
    case 'u8': view.setUint8(offset, value & 0xff); break;
    default: break;
  }
}

/** 构造一个只有头部的空快照（无 Replicated 实体或错误恢复路径）。 */
export function createEmptySnapshot(tick: number = 0): Snapshot {
  const layout = snapshotLayout(0, 0);
  const data = new ArrayBuffer(layout.totalBytes);
  const view = new DataView(data);
  view.setUint32(OFF_MAGIC, SNAPSHOT_MAGIC, true);
  view.setUint16(OFF_VERSION, SNAPSHOT_VERSION, true);
  view.setUint16(OFF_FLAGS, 0, true);
  view.setUint32(OFF_TICK, tick >>> 0, true);
  view.setUint32(OFF_MASK, 0, true);
  view.setUint32(OFF_COUNT, 0, true);
  view.setUint32(OFF_STAT_VERSION, 0, true);
  view.setUint32(OFF_RESERVED, 0, true);
  return { tick, mask: 0, netIds: new Uint32Array(0), data, statVersion: 0 };
}

/**
 * 从世界构建 Full 快照。
 * 只遍历 [Replicated] 查询；返回实体的 NetId 从 registry 取（回退 NetId 组件）。
 */
export function buildSnapshot(
  world: BattleWorld,
  registry: EntityRegistry,
  tick: number,
): Snapshot {
  if (world.components.indexOf(Replicated) < 0) {
    return createEmptySnapshot(tick);
  }
  interface Entry { eid: Eid; netId: number; presence: number }
  const entries: Entry[] = [];
  const entities = query(world, [Replicated]);
  let statVersion = 0;

  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i];
    let netId = registry.byEid(eid);
    if (netId === 0 && world.components.indexOf(NetId) >= 0 && has(world, eid, NetId)) {
      netId = NetId.value[eid];
      if (netId > 0) {
        const playerId = world.components.indexOf(Owner) >= 0 && has(world, eid, Owner)
          ? Owner.playerId[eid] : 0;
        registry.bind(eid, netId, playerId);
      }
    }
    if (netId === 0) continue; // eid 永不上线：未分配 NetId 的实体不进快照

    let presence = 0;
    for (let c = 0; c < SNAPSHOT_COLUMNS.length; c++) {
      const column = SNAPSHOT_COLUMNS[c];
      if (has(world, eid, column.component)) presence |= column.bit;
    }
    entries.push({ eid, netId, presence });
    if (world.components.indexOf(StatSnapshotRef) >= 0 && has(world, eid, StatSnapshotRef)) {
      const version = StatSnapshotRef.version[eid];
      if (version > statVersion) statVersion = version;
    }
  }
  entries.sort((a, b) => a.netId - b.netId);

  let mask = 0;
  for (let i = 0; i < entries.length; i++) mask |= entries[i].presence;
  const count = entries.length;
  const layout = snapshotLayout(mask, count);
  const data = new ArrayBuffer(layout.totalBytes);
  const view = new DataView(data);
  view.setUint32(OFF_MAGIC, SNAPSHOT_MAGIC, true);
  view.setUint16(OFF_VERSION, SNAPSHOT_VERSION, true);
  view.setUint16(OFF_FLAGS, 0, true);
  view.setUint32(OFF_TICK, tick >>> 0, true);
  view.setUint32(OFF_MASK, mask, true);
  view.setUint32(OFF_COUNT, count, true);
  view.setUint32(OFF_STAT_VERSION, statVersion >>> 0, true);
  view.setUint32(OFF_RESERVED, 0, true);

  const presence = new Uint32Array(data, layout.presenceOffset, count);
  const netIds = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    presence[i] = entries[i].presence;
    netIds[i] = entries[i].netId;
    view.setUint32(layout.netIdsOffset + i * 4, entries[i].netId, true);
  }

  for (let c = 0; c < SNAPSHOT_COLUMNS.length; c++) {
    const column = SNAPSHOT_COLUMNS[c];
    if ((mask & column.bit) === 0) continue;
    const start = layout.starts[column.componentIndex];
    for (let i = 0; i < count; i++) {
      if ((entries[i].presence & column.bit) === 0) continue;
      const eid = entries[i].eid;
      let offset = start + i * column.stride;
      for (let f = 0; f < column.fields.length; f++) {
        const value = column.component[column.fields[f]][eid];
        writeNumeric(view, column.fieldKinds[f], offset, value);
        offset += kindBytes(column.fieldKinds[f]);
      }
    }
  }
  return { tick, mask, netIds, data, statVersion };
}

/** 从线上 payload 还原 Snapshot；格式非法抛 WushuangError(4002)。 */
export function decodeSnapshot(payload: ArrayBuffer, fallbackTick = 0): Snapshot {
  if (payload.byteLength < SNAPSHOT_HEADER_BYTES) {
    throw new WushuangError(ERR_SNAPSHOT_FORMAT, '快照payload过短');
  }
  const view = new DataView(payload);
  const magic = view.getUint32(OFF_MAGIC, true);
  const version = view.getUint16(OFF_VERSION, true);
  if (magic !== SNAPSHOT_MAGIC || version !== SNAPSHOT_VERSION) {
    throw new WushuangError(ERR_SNAPSHOT_FORMAT, `快照魔数/版本不匹配: ${magic}/${version}`);
  }
  const tick = view.getUint32(OFF_TICK, true);
  const mask = view.getUint32(OFF_MASK, true);
  const count = view.getUint32(OFF_COUNT, true);
  const statVersion = view.getUint32(OFF_STAT_VERSION, true);
  const layout = snapshotLayout(mask, count);
  if (payload.byteLength < layout.totalBytes) {
    throw new WushuangError(ERR_SNAPSHOT_FORMAT, '快照payload与mask/count不匹配');
  }
  const netIds = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    netIds[i] = view.getUint32(layout.netIdsOffset + i * 4, true);
  }
  return {
    tick: tick === 0 && fallbackTick > 0 ? fallbackTick : tick,
    mask,
    netIds,
    data: payload,
    statVersion,
  };
}

/**
 * 应用 Full 快照：新 NetId 在客户端 spawn 本地 eid，随后逐列写回 SoA 组件。
 * 缺失的 NetId 不会凭空生成实体（那会造成 eid 漂移），只保留映射等待后续快照。
 */
export function applySnapshot(snap: Snapshot, world: BattleWorld, registry: EntityRegistry): void {
  if (snap.data.byteLength < SNAPSHOT_HEADER_BYTES) return;
  const view = new DataView(snap.data);
  if (view.getUint32(OFF_MAGIC, true) !== SNAPSHOT_MAGIC) return;

  const mask = view.getUint32(OFF_MASK, true);
  const count = view.getUint32(OFF_COUNT, true);
  const layout = snapshotLayout(mask, count);
  if (snap.data.byteLength < layout.totalBytes) return;
  const presence = new Uint32Array(snap.data, layout.presenceOffset, count);
  const netIds = snap.netIds.length === count ? snap.netIds : new Uint32Array(count);
  if (netIds !== snap.netIds) {
    for (let i = 0; i < count; i++) {
      netIds[i] = view.getUint32(layout.netIdsOffset + i * 4, true);
    }
  }

  for (let i = 0; i < count; i++) {
    const netId = netIds[i];
    if (netId === 0) continue;
    let eid = registry.byNetId(netId);
    const isNew = eid === 0;
    if (isNew) {
      eid = spawn(world);
      if (world.components.indexOf(Replicated) >= 0) add(world, eid, Replicated);
    }

    let playerId = isNew ? 0 : registry.playerOf(netId);
    const ownerColumn = SNAPSHOT_COLUMNS.find((column) => column.component === Owner);
    if (ownerColumn !== undefined && (presence[i] & ownerColumn.bit) !== 0) {
      const start = layout.starts[ownerColumn.componentIndex];
      const playerRaw = view.getUint32(start + i * ownerColumn.stride + 4, true);
      if (playerRaw <= 0x7fffffff) playerId = playerRaw;
    }

    for (let c = 0; c < SNAPSHOT_COLUMNS.length; c++) {
      const column = SNAPSHOT_COLUMNS[c];
      if ((mask & column.bit) === 0 || (presence[i] & column.bit) === 0) continue;
      if (!has(world, eid, column.component)) add(world, eid, column.component);
      let offset = layout.starts[column.componentIndex] + i * column.stride;
      for (let f = 0; f < column.fields.length; f++) {
        column.component[column.fields[f]][eid] = readNumeric(view, column.fieldKinds[f], offset);
        offset += kindBytes(column.fieldKinds[f]);
      }
    }
    registry.bind(eid, netId, playerId < 0 ? 0 : playerId);
    if (world.components.indexOf(NetId) >= 0 && has(world, eid, NetId)) {
      NetId.value[eid] = netId;
    }
  }
}

/** Position.x/y 列在快照中的字节信息；无 Position 列时返回 null。 */
export interface PositionColumn {
  readonly start: number;
  readonly stride: number;
  readonly count: number;
  readonly xOffset: number;
  readonly yOffset: number;
}

export function getPositionColumn(snap: Snapshot): PositionColumn | null {
  const positionIndex = ALL_COMPONENTS.indexOf(Position);
  const bit = 1 << positionIndex;
  if ((snap.mask & bit) === 0) return null;
  const view = new DataView(snap.data);
  const count = view.getUint32(OFF_COUNT, true);
  const layout = snapshotLayout(snap.mask, count);
  return {
    start: layout.starts[positionIndex],
    stride: 16, // Position{x,y,px,py} 全为 f32
    count,
    xOffset: 0,
    yOffset: 4,
  };
}

/** 读取快照位置列，返回 [x0,y0,x1,y1,...]；无位置列返回 null。 */
export function readPositions(snap: Snapshot): Float32Array | null {
  const column = getPositionColumn(snap);
  if (column === null) return null;
  const view = new DataView(snap.data);
  const result = new Float32Array(column.count * 2);
  for (let i = 0; i < column.count; i++) {
    const base = column.start + i * column.stride;
    result[i * 2] = view.getFloat32(base + column.xOffset, true);
    result[i * 2 + 1] = view.getFloat32(base + column.yOffset, true);
  }
  return result;
}

/**
 * 以权威快照为底稿，把位置列按 alpha 向预测位置插值：
 * result = authoritative + (predicted - authoritative) * alpha。
 * 仅克隆 payload，其余列与原快照逐字节一致。
 */
export function blendWithPositions(
  authoritative: Snapshot,
  predicted: Float32Array,
  alpha: number,
): Snapshot {
  const column = getPositionColumn(authoritative);
  if (column === null || predicted.length < column.count * 2) return authoritative;
  const data = authoritative.data.slice(0);
  const view = new DataView(data);
  const k = alpha < 0 ? 0 : (alpha > 1 ? 1 : alpha);
  const pairs = Math.min(column.count, Math.floor(predicted.length / 2));
  for (let i = 0; i < pairs; i++) {
    const base = column.start + i * column.stride;
    const x = view.getFloat32(base + column.xOffset, true);
    const y = view.getFloat32(base + column.yOffset, true);
    view.setFloat32(base + column.xOffset, x + (predicted[i * 2] - x) * k, true);
    view.setFloat32(base + column.yOffset, y + (predicted[i * 2 + 1] - y) * k, true);
  }
  return {
    tick: authoritative.tick,
    mask: authoritative.mask,
    netIds: authoritative.netIds,
    data,
    statVersion: authoritative.statVersion,
  };
}

/** 两个快照之间的位置插值（预测快照 vs 权威快照）。 */
export function blendSnapshots(
  authoritative: Snapshot,
  predicted: Snapshot,
  alpha: number,
): Snapshot {
  const positions = readPositions(predicted);
  if (positions === null) return authoritative;
  return blendWithPositions(authoritative, positions, alpha);
}

/** 快照数据长度（供 delta 封装估算），等于底层 ArrayBuffer 字节数。 */
export function snapshotByteLength(snap: Snapshot): number {
  return snap.data.byteLength;
}
