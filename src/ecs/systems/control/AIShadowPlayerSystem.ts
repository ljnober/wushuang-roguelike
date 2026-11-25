/**
 * AI 影子玩家控制源：自动寻敌 / kiting / 按 cd 放技能，产出与真人同形状的 InputFrame。
 *
 * 确定性：所有随机来自 hash32(seed, playerId, tick)，复用单个 Rng 实例，
 * 不使用 Math.random，不读墙钟（DESIGN §2.1 / ARCHITECTURE §5.7）。
 */
import type { Eid } from '../../bit/types';
import type { BattleWorld } from '../../bit/adapter';
import { has, query } from '../../bit/adapter';
import { Behavior, Faction, Health, PlayerId, Position } from '../../bit/components';
import { hash32, Rng } from '../../../core/Rng';
import { TICK_RATE } from '../../../core/Constants';
import type { GameConfig } from '../../../data/types';
import type { ControlSourceKind, IControlSource, InputFrame } from './IControlSource';

/** kiting 距离阈值（像素）：近于此远离，远于此靠近，区间内侧移。 */
const TOO_CLOSE_SQ = 70 * 70;
const TOO_FAR_SQ = 150 * 150;

export class AIShadowPlayerSystem implements IControlSource {
  readonly kind: 1 = 1;

  private readonly world: BattleWorld;
  private readonly seed: number;
  private readonly playerId: number;
  private readonly selfEid: Eid;
  private readonly rng: Rng;
  private readonly queryTerms = [Position, Health, Faction];
  private readonly playerTerms = [PlayerId, Position];
  /** 主技能 cd（tick 数），构造期从配置解析，热路径不做字符串查找。 */
  private readonly primaryCdTicks: number;
  private nextSkillTick = 0;

  constructor(deps: { world: BattleWorld; config: GameConfig; seed: number; playerId: number }) {
    this.world = deps.world;
    this.seed = deps.seed;
    this.playerId = deps.playerId;
    this.rng = new Rng(hash32(deps.seed, deps.playerId, 0, 0x5a17));

    const players = query(deps.world, this.playerTerms);
    let found: Eid = -1;
    for (let i = 0; i < players.length; i++) {
      const eid = players[i];
      if (PlayerId.value[eid] === deps.playerId) {
        found = eid;
        break;
      }
    }
    this.selfEid = found;

    const skills = deps.config.skills.all();
    const cooldownSec = skills.length > 0 ? skills[0].cooldown : 0.6;
    this.primaryCdTicks = Math.max(1, Math.round(cooldownSec * TICK_RATE));
  }

  poll(tick: number, out: InputFrame): void {
    out.moveX = 0;
    out.moveY = 0;
    out.aimX = 1;
    out.aimY = 0;
    out.buttons = 0;
    out.tick = tick;

    // 确定性随机流：key = (seed, playerId, tick)。
    this.rng.setState(hash32(this.seed, this.playerId, tick, 0x5a17));
    const jitter = this.rng.next() * 2 - 1;

    const self = this.selfEid;
    if (self < 0) {
      out.seq = tick;
      return;
    }
    const sx = Position.x[self];
    const sy = Position.y[self];

    // 找最近存活敌人（Faction=1）。query 返回 SoA 缓冲，零分配。
    const ents = query(this.world, this.queryTerms);
    let bestEid: Eid = -1;
    let bestDistSq = Number.POSITIVE_INFINITY;
    let bestDx = 0;
    let bestDy = 0;
    // BOSS 在视野内时优先集火：否则 auto 轨迹会永远打身边的小兵，8 分钟局超时战败。
    let bossEid: Eid = -1;
    let bossDistSq = 600 * 600;
    let bossDx = 0;
    let bossDy = 0;
    for (let i = 0; i < ents.length; i++) {
      const eid = ents[i];
      if (Faction.value[eid] !== 1) continue;
      if (Health.cur[eid] <= 0) continue;
      const dx = Position.x[eid] - sx;
      const dy = Position.y[eid] - sy;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestEid = eid;
        bestDx = dx;
        bestDy = dy;
      }
      if (
        has(this.world, eid, Behavior) && Behavior.p2[eid] > 0 && distSq < bossDistSq
      ) {
        bossDistSq = distSq;
        bossEid = eid;
        bossDx = dx;
        bossDy = dy;
      }
    }
    if (bossEid >= 0) {
      bestEid = bossEid;
      bestDistSq = bossDistSq;
      bestDx = bossDx;
      bestDy = bossDy;
    }

    if (bestEid < 0) {
      // 无敌可打：缓慢顺时针巡逻，方向由 tick 派生，保持确定性。
      const angle = (tick % 240) / 240 * Math.PI * 2;
      out.aimX = Math.cos(angle);
      out.aimY = Math.sin(angle);
      out.moveX = out.aimX * 0.4;
      out.moveY = out.aimY * 0.4;
      out.seq = tick;
      return;
    }

    const dist = Math.sqrt(bestDistSq);
    const inv = dist > 0 ? 1 / dist : 0;
    const dirX = bestDx * inv;
    const dirY = bestDy * inv;
    out.aimX = dirX;
    out.aimY = dirY;

    // kiting：过近远离、过远靠近、适中侧移；jitter 提供确定性扰动。
    let moveX: number;
    let moveY: number;
    if (bestDistSq < TOO_CLOSE_SQ) {
      moveX = -dirX + -dirY * jitter * 0.45;
      moveY = -dirY + dirX * jitter * 0.45;
    } else if (bestDistSq > TOO_FAR_SQ) {
      moveX = dirX + -dirY * jitter * 0.35;
      moveY = dirY + dirX * jitter * 0.35;
    } else {
      const side = jitter >= 0 ? 1 : -1;
      moveX = -dirY * side + dirX * 0.2;
      moveY = dirX * side + dirY * 0.2;
    }
    // BOSS 战不再 kiting：贴身追击才能进入范围技能半径，否则 8 分钟局永远打不掉 BOSS。
    if (bossEid >= 0) {
      moveX = dirX;
      moveY = dirY;
    }
    const moveLen = Math.sqrt(moveX * moveX + moveY * moveY);
    if (moveLen > 0) {
      out.moveX = moveX / moveLen;
      out.moveY = moveY / moveLen;
    }

    // 按 cd 放技能：与主技能冷却对齐，范围外不放。
    if (bestDistSq <= TOO_FAR_SQ * 4 && tick >= this.nextSkillTick) {
      out.buttons = 1;
      this.nextSkillTick = tick + this.primaryCdTicks;
    }
    out.seq = tick;
  }
}
