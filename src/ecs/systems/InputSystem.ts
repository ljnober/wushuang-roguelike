/**
 * 输入分发系统（scheduler §6.3 第 2 位）。
 *
 * 遍历 [PlayerId, ControlSource] 查询的控制源分发实现位于
 * ControlSourceRegistry.pollAll：按 source.kind（0 Local / 1 AI / 2 Remote）
 * 调用各自 poll() 并写入 InputCmd SoA 组件。本类作为 tick 调度入口，
 * 从 SimState 取出 world / events 总线后委托，避免在两处重复实现分发逻辑。
 */
import type { BattleWorld } from '../bit/adapter';
import type { GameEventBus } from '../bridge/GameEventBus';
import type { ControlSourceRegistry } from './control/IControlSource';

/** InputSystem 所需的最小 SimState 形状（结构与批次 B 的 SimState 兼容）。 */
export interface InputSystemState {
  world: BattleWorld;
  buses: { events: GameEventBus };
}

export class InputSystem {
  private readonly registry: ControlSourceRegistry;

  constructor(registry: ControlSourceRegistry) {
    this.registry = registry;
  }

  run(state: InputSystemState, tick: number): void {
    this.registry.pollAll(tick, state.world, state.buses.events);
  }
}
