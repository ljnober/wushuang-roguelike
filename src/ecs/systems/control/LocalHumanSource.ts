/**
 * 本地真人控制源：drain CommandBus 中本 playerId 的命令，写入 InputFrame。
 *
 * 热路径零分配：命令缓冲在构造期预分配，poll 只做环形读取与位运算。
 */
import type { IControlSource, InputFrame } from './IControlSource';
import type { Command, CommandBus } from '../../bridge/CommandBus';
import { CommandType } from '../../bridge/enums';
import { COMMAND_QUEUE_SIZE } from '../../../core/Constants';

/** AutoToggle 命令在 buttons 中占用的位（低 6 位留给技能 0..5）。 */
const AUTO_TOGGLE_BIT = 1 << 7;
/**
 * CommandBus 的 a/b 是 Int32：UI 把 [-1,1] 的摇杆轴放大 1000 倍后写入。
 * 控制源必须解码回归一化区间，否则 InputCmd/网络输入会得到 ±1000 的伪值。
 */
const AXIS_FIXED_SCALE = 1000;

/** 把 i32 轴值解码为 [-1,1]；已是归一化的值原样保留。 */
function decodeAxis(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw > 1 || raw < -1) return raw / AXIS_FIXED_SCALE;
  return raw;
}

export class LocalHumanSource implements IControlSource {
  readonly kind: 0 = 0;

  private readonly playerId: number;
  private readonly bus: CommandBus;
  /** 自动模式下代管本席位的 AI 源；默认 null 表示纯真人操作。 */
  private readonly autoSource: IControlSource | null;
  /** 由 AutoToggle 命令驱动，默认手动，避免改变既有确定性回放基线。 */
  private auto = false;
  /** 预分配 drain 缓冲，容量与命令总线一致，避免热路径分配。 */
  private readonly buffer: Command[] = [];
  /**
   * 持续输入锁存：键盘 / 摇杆只在状态"变化"时发 Move 命令，
   * 若只按当帧生效，按住 WASD 会只走 1 tick（≈3.6px），表现为"无法操控"。
   * 这里把最近一次 Move 作为持续状态，直到收到新的 Move（含松键时的 0）。
   */
  private latchedMoveX = 0;
  private latchedMoveY = 0;
  private latchedSeq = 0;

  constructor(cmdBus: CommandBus, playerId: number, autoSource: IControlSource | null = null) {
    this.bus = cmdBus;
    this.playerId = playerId;
    this.autoSource = autoSource;
    for (let i = 0; i < COMMAND_QUEUE_SIZE; i++) {
      this.buffer.push({ type: CommandType.Move, playerId: 0, a: 0, b: 0, c: 0, seq: 0 });
    }
  }

  poll(tick: number, out: InputFrame): void {
    out.moveX = 0;
    out.moveY = 0;
    out.aimX = 0;
    out.aimY = 0;
    out.buttons = 0;

    const count = this.bus.drain(this.buffer);
    let maxSeq = out.seq;
    // 真人本帧的瞬时意图：瞄准与技能按键只在收到的当帧生效。
    let humanAimX = 0;
    let humanAimY = 0;
    let humanButtons = 0;
    for (let i = 0; i < count; i++) {
      const cmd = this.buffer[i];
      if (cmd.playerId !== this.playerId) {
        // 多真人扩展时把不属于本席位的命令放回总线（drain 已清空，容量充足）。
        this.bus.push(cmd);
        continue;
      }
      switch (cmd.type) {
        case CommandType.Move:
          this.latchedMoveX = decodeAxis(cmd.a);
          this.latchedMoveY = decodeAxis(cmd.b);
          if (cmd.seq > this.latchedSeq) this.latchedSeq = cmd.seq;
          break;
        case CommandType.Aim:
          humanAimX = decodeAxis(cmd.a);
          humanAimY = decodeAxis(cmd.b);
          break;
        case CommandType.Skill: {
          const skillIndex = cmd.a | 0;
          if (skillIndex >= 0 && skillIndex < 6) humanButtons |= 1 << skillIndex;
          break;
        }
        case CommandType.AutoToggle:
          this.auto = cmd.a !== 0;
          humanButtons |= AUTO_TOGGLE_BIT;
          break;
        case CommandType.Pause:
        case CommandType.Ping:
        default:
          // 这两个命令由上层系统消费，不影响 InputCmd 形状。
          break;
      }
      if (cmd.seq > maxSeq) maxSeq = cmd.seq;
    }

    // 锁存的移动方向每帧都写入：按住方向键 / 摇杆不松手时持续生效。
    out.moveX = this.latchedMoveX;
    out.moveY = this.latchedMoveY;
    out.aimX = humanAimX;
    out.aimY = humanAimY;
    out.buttons = humanButtons;
    out.tick = tick;
    out.seq = maxSeq > this.latchedSeq ? maxSeq : this.latchedSeq;

    // 自动模式：AI 只作为"无人操作时的代管"。真人一旦给出移动 / 瞄准 / 技能，
    // 本帧立即以真人输入为准，避免默认 auto 变成"无法操控"的陷阱。
    // 没有任何真人输入时 AI 输出与旧实现逐字段一致（整局 auto 确定性基线不变）。
    if (this.auto && this.autoSource !== null) {
      this.autoSource.poll(tick, out);
      if (this.latchedMoveX !== 0 || this.latchedMoveY !== 0) {
        out.moveX = this.latchedMoveX;
        out.moveY = this.latchedMoveY;
      }
      if (humanAimX !== 0 || humanAimY !== 0) {
        out.aimX = humanAimX;
        out.aimY = humanAimY;
      }
      if (humanButtons !== 0) out.buttons = humanButtons;
      out.seq = maxSeq > this.latchedSeq ? maxSeq : this.latchedSeq;
    }
  }
}
