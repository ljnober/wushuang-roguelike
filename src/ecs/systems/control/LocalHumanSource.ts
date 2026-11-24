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

export class LocalHumanSource implements IControlSource {
  readonly kind: 0 = 0;

  private readonly playerId: number;
  private readonly bus: CommandBus;
  /** 预分配 drain 缓冲，容量与命令总线一致，避免热路径分配。 */
  private readonly buffer: Command[] = [];

  constructor(cmdBus: CommandBus, playerId: number) {
    this.bus = cmdBus;
    this.playerId = playerId;
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
    for (let i = 0; i < count; i++) {
      const cmd = this.buffer[i];
      if (cmd.playerId !== this.playerId) {
        // 多真人扩展时把不属于本席位的命令放回总线（drain 已清空，容量充足）。
        this.bus.push(cmd);
        continue;
      }
      switch (cmd.type) {
        case CommandType.Move:
          out.moveX = cmd.a;
          out.moveY = cmd.b;
          break;
        case CommandType.Aim:
          out.aimX = cmd.a;
          out.aimY = cmd.b;
          break;
        case CommandType.Skill: {
          const skillIndex = cmd.a | 0;
          if (skillIndex >= 0 && skillIndex < 6) out.buttons |= 1 << skillIndex;
          break;
        }
        case CommandType.AutoToggle:
          out.buttons |= AUTO_TOGGLE_BIT;
          break;
        case CommandType.Pause:
        case CommandType.Ping:
        default:
          // 这两个命令由上层系统消费，不影响 InputCmd 形状。
          break;
      }
      if (cmd.seq > maxSeq) maxSeq = cmd.seq;
    }
    out.tick = tick;
    out.seq = maxSeq;
  }
}
