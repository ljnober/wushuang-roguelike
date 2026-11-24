/**
 * B2 侧载注册入口（ARCHITECTURE §6.5 / §6.3）。
 *
 * main.ts 用 import.meta.glob('./registration/*.ts', { eager: true }) 加载本文件；
 * glob key 按路径排序，加载顺序为 net.ts → presentation.ts → systems.ts，
 * 因此本 register(app) 执行时 app.state.world 仍为 null，不能立即构造 registry。
 *
 * 策略与 order -2/-1/18 在注册期一次性装好，避免 tick 循环中动态加系统；
 * 世界依赖由 order -3 的 NetBootstrap 在首个可用 tick 注入，并在 B1 重开战斗
 * 替换 app.state.world 时自动重建注册表与缓冲区。
 */
import type { App } from '../app/App';
import { CAP } from '../core/Constants';
import { query, type BattleWorld } from '../ecs/bit/adapter';
import { NetId, PlayerId, PlayerTag } from '../ecs/bit/components';
import type { GameEventBus } from '../ecs/bridge/GameEventBus';
import { EntityRegistry } from '../net/EntityRegistry';
import { NetInputBuffer } from '../net/messages';
import { FullSnapshotStrategy, configureNetRuntime, installNetSystems } from '../net/NetSystems';
import { PredictionBuffer } from '../net/PredictionBuffer';
import { createNetSession, sessionFromState, type NetSession } from '../net/session';
import { NullTransport } from '../net/transport';

/** App.state 的运行时可变视角（A 的 SimStateLike 用 any 描述这些字段）。 */
interface NetAppStateView {
  world: BattleWorld | null;
  session: unknown;
  buses: { events: GameEventBus } | null;
}

/**
 * 由 main.ts 的侧载循环自动调用。
 * 只注册网络自己的负 order 与 18，绝不触碰 B1 的 1..17/19。
 */
export function register(app: App): void {
  // Standalone 默认使用 NullTransport：onMessage 可订阅但 send 全部丢弃。
  const strategy = new FullSnapshotStrategy({
    transport: new NullTransport(1),
    session: createNetSession(),
  });
  installNetSystems(app, strategy);

  let worldToken: BattleWorld | null = null;
  let sessionToken: unknown = null;

  app.registerSimSystem(-3, () => {
    const state = app.state as unknown as NetAppStateView;
    const world = state.world;
    if (world === null || world === undefined) return;
    const events = state.buses === null || state.buses === undefined
      ? null : state.buses.events;
    if (events === null || events === undefined) return;

    const sessionView: NetSession = sessionFromState(state.session);
    if (world === worldToken && state.session === sessionToken) return;
    worldToken = world;
    sessionToken = state.session;

    // 同一世界只绑定一次；后续 B1 重开换 world 时这里是唯一的重建点。
    const registry = new EntityRegistry(world, CAP);
    const hasPlayerTerms = world.components.indexOf(PlayerTag) >= 0
      && world.components.indexOf(NetId) >= 0
      && world.components.indexOf(PlayerId) >= 0;
    if (hasPlayerTerms) {
      const players = query(world, [PlayerTag, NetId, PlayerId]);
      for (let i = 0; i < players.length; i++) {
        const eid = players[i];
        const playerId = PlayerId.value[eid];
        const existing = NetId.value[eid];
        if (existing > 0) {
          registry.bind(eid, existing, playerId);
        } else {
          // A3 已为玩家分配 NetId；这里只兜底处理缺失场景，不改动组件以外的数据。
          registry.alloc(eid, playerId);
        }
      }
    }

    const inputBuffer = new NetInputBuffer();
    const prediction = new PredictionBuffer();
    strategy.attach({
      world,
      registry,
      events,
      session: sessionView,
      inputBuffer,
      prediction,
    });
    // 运行时持有真实可变 session（不是 sessionFromState 的拷贝），
    // 这样 lastAckedTick/roomSeed 等回写会落在 B1 的会话对象上。
    configureNetRuntime({
      session: (state.session ?? sessionView) as NetSession,
      inputBuffer,
      prediction,
      events,
    });
  }, 'NetBootstrap');
}
