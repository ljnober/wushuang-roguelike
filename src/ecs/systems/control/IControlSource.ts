/**
 * 控制源抽象（ARCHITECTURE.md §5.7、DESIGN.md §4）。
 *
 * 三类玩家（真人 / AI 影子 / 远端）在战斗组件上完全一致，
 * 差异仅在 IControlSource.poll()：直接写调用方预分配的 InputFrame，零分配、不返回对象。
 */
import type { Eid } from '../../bit/types';
import type { BattleWorld } from '../../bit/adapter';
import { add, query, spawn } from '../../bit/adapter';
import type { CommandBus } from '../../bridge/CommandBus';
import type { GameEventBus } from '../../bridge/GameEventBus';
import {
  Attack,
  Collider,
  ControlMode,
  ControlSource,
  Faction,
  Health,
  Heading,
  InputCmd,
  NetId,
  Owner,
  PlayerId,
  PlayerTag,
  Position,
  SpawnTick,
  Speed,
  Velocity,
} from '../../bit/components';
import { MAX_PLAYERS } from '../../../core/Constants';
import { buildGameConfig } from '../../../data/index';
import type { GameConfig } from '../../../data/types';
import { AIShadowPlayerSystem } from './AIShadowPlayerSystem';
import { LocalHumanSource } from './LocalHumanSource';
import { RemoteInputSource } from './RemoteInputSource';

/** 单帧输入：字段与 InputCmd 组件一一对应，调用方预分配复用。 */
export interface InputFrame {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  buttons: number;
  tick: number;
  seq: number;
}

/** 创建一个全零输入帧（初始化 / 测试用，热路径不调用）。 */
export function createInputFrame(): InputFrame {
  return { moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0, tick: 0, seq: 0 };
}

/** 控制源类型：0 Local / 1 AI / 2 Remote（编号冻结，见 §6.2）。 */
export type ControlSourceKind = 0 | 1 | 2;

/** 控制源接口：poll 直接写 out，零分配。 */
export interface IControlSource {
  readonly kind: ControlSourceKind;
  poll(tick: number, out: InputFrame): void;
}

/** 按 eid 绑定 / 查询控制源，并在 pollAll 中把输入写回 InputCmd SoA 组件。 */
export class ControlSourceRegistry {
  private readonly sources = new Map<Eid, IControlSource>();
  /** 复用输入帧与查询缓冲，保证 pollAll 热路径零分配。 */
  private readonly frame: InputFrame = createInputFrame();
  private readonly queryTerms = [PlayerId, ControlSource];

  bind(eid: Eid, source: IControlSource): void {
    this.sources.set(eid, source);
    ControlSource.kind[eid] = source.kind;
  }

  unbind(eid: Eid): void {
    this.sources.delete(eid);
  }

  get(eid: Eid): IControlSource | undefined {
    return this.sources.get(eid);
  }

  /**
   * 遍历 [PlayerId, ControlSource] 查询，逐个 poll 并写入 InputCmd 组件。
   * bus 保留用于将来上报控制源异常（NetEvent）；当前不产生事件。
   */
  pollAll(tick: number, world: BattleWorld, bus: GameEventBus): void {
    void bus;
    const ents = query(world, this.queryTerms);
    const frame = this.frame;
    for (let i = 0; i < ents.length; i++) {
      const eid = ents[i];
      const source = this.sources.get(eid);
      if (source === undefined) continue;
      frame.moveX = 0;
      frame.moveY = 0;
      frame.aimX = 0;
      frame.aimY = 0;
      frame.buttons = 0;
      frame.tick = tick;
      frame.seq = 0;
      source.poll(tick, frame);
      InputCmd.moveX[eid] = frame.moveX;
      InputCmd.moveY[eid] = frame.moveY;
      InputCmd.aimX[eid] = frame.aimX;
      InputCmd.aimY[eid] = frame.aimY;
      InputCmd.buttons[eid] = frame.buttons;
      InputCmd.tick[eid] = tick;
      InputCmd.seq[eid] = frame.seq;
    }
  }
}

/** 延迟构建共享 config，避免每次生成玩家都重建整张配置表。 */
let sharedConfig: GameConfig | null = null;
function getSharedConfig(): GameConfig {
  if (sharedConfig === null) sharedConfig = buildGameConfig();
  return sharedConfig;
}

/** 把影子数量约束到设计范围 1..3。 */
function clampShadowCount(shadowCount: number): number {
  if (!Number.isFinite(shadowCount)) return 1;
  const n = Math.floor(shadowCount);
  if (n < 1) return 1;
  if (n > MAX_PLAYERS - 1) return MAX_PLAYERS - 1;
  return n;
}

/**
 * 生成 1 个真人 + shadowCount 个 AI 影子玩家。
 *
 * 所有玩家挂完全一致的组件（Position/Velocity/Heading/Collider/Speed/Health/Faction/
 * Attack/InputCmd/ControlMode/ControlSource/PlayerId/NetId/Owner/SpawnTick/PlayerTag），
 * 仅 ControlSource.kind 不同（真人 0 / 影子 1）；影子不吃 NetControlled。
 *
 * @returns 生成的 eid 数组，下标即 playerId（0 为真人）。
 */
export function spawnLocalPlayers(
  world: BattleWorld,
  registry: ControlSourceRegistry,
  cmdBus: CommandBus,
  shadowCount: number,
  seed: number,
): Eid[] {
  const count = 1 + clampShadowCount(shadowCount);
  const result: Eid[] = [];
  const config = getSharedConfig();
  let nextNetId = 1;

  for (let playerId = 0; playerId < count; playerId++) {
    const eid = spawn(world);
    result.push(eid);

    // 运动 / 碰撞 / 战斗组件（三类玩家统一）。
    add(world, eid, Position);
    add(world, eid, Velocity);
    add(world, eid, Heading);
    add(world, eid, Collider);
    add(world, eid, Speed);
    add(world, eid, Health);
    add(world, eid, Faction);
    add(world, eid, Attack);
    add(world, eid, InputCmd);
    add(world, eid, ControlMode);
    add(world, eid, ControlSource);
    add(world, eid, PlayerId);
    add(world, eid, NetId);
    add(world, eid, Owner);
    add(world, eid, SpawnTick);
    add(world, eid, PlayerTag);

    Position.x[eid] = 0;
    Position.y[eid] = 0;
    Position.px[eid] = 0;
    Position.py[eid] = 0;
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
    Heading.angle[eid] = 0;
    Collider.r[eid] = 14;
    Collider.type[eid] = 0;
    Collider.w[eid] = 0;
    Collider.h[eid] = 0;
    Collider.layer[eid] = 0;
    Speed.value[eid] = 220;
    Health.cur[eid] = 120;
    Health.max[eid] = 120;
    Health.regen[eid] = 0;
    Faction.value[eid] = 0;
    Attack.damage[eid] = 24;
    Attack.rate[eid] = 1.8;
    Attack.cd[eid] = 0;
    Attack.range[eid] = 90;
    InputCmd.moveX[eid] = 0;
    InputCmd.moveY[eid] = 0;
    InputCmd.aimX[eid] = 0;
    InputCmd.aimY[eid] = 0;
    InputCmd.buttons[eid] = 0;
    InputCmd.tick[eid] = 0;
    InputCmd.seq[eid] = 0;
    ControlMode.value[eid] = 0;

    PlayerId.value[eid] = playerId;
    NetId.value[eid] = nextNetId;
    Owner.netId[eid] = nextNetId;
    Owner.playerId[eid] = playerId;
    SpawnTick.value[eid] = 0;
    nextNetId++;

    // 只在这里分派控制源：真人与影子组件完全相同。
    const source: IControlSource = playerId === 0
      ? new LocalHumanSource(cmdBus, playerId)
      : new AIShadowPlayerSystem({ world, config, seed, playerId });
    registry.bind(eid, source);
    ControlSource.ref[eid] = playerId;
  }

  return result;
}

/** 供 net 批次为远端玩家构造控制源时复用（本批次不直接 spawn 远端）。 */
export function makeRemoteSource(buffer: { read(tick: number, netId: number, out: InputFrame): boolean }, netId: number): IControlSource {
  return new RemoteInputSource(buffer, netId);
}
