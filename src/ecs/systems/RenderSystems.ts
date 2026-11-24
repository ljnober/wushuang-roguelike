/**
 * 每帧渲染系统（ARCHITECTURE §5.10 / §6.3 / DESIGN §9）。
 *
 * 顺序：ViewportSystem（打 Culled）→ RenderSyncSystem（alpha 插值、跳过 Culled）
 *       → HUDSystem（10Hz drain 事件总线）。
 * Culled 只跳过绘制，实体仍完整参与全部逻辑系统。
 */
import { CAP, HUD_THROTTLE_MS, SNAP_TELEPORT_THRESHOLD } from '../../core/Constants';
import { add, exists, has, query, remove } from '../bit/adapter';
import { Culled, Dead, Heading, Pickup, PlayerTag, Position, RenderRef } from '../bit/components';
import type { BattleWorld } from '../bit/adapter';
import type { Eid } from '../bit/types';
import type { GameEvent, GameEventBus } from '../bridge/GameEventBus';
import { createEventSlot } from '../bridge/GameEventBus';
import type { PixiPools, RenderKind } from '../../engine/PixiPools';
import type { Viewport } from '../../engine/Viewport';
import { BULLET_KEY, EFFECT_KEYS, PICKUP_KEYS } from '../../art/ChibiFactory';

/**
 * RenderRef.kind 的数值约定，与批次 B 的生成点保持一致（只追加，不重排）。
 * 来源：LifecycleSystems.spawnEnemy(1/2)、spawnPickup(3)、CombatSystems.spawnProjectile(4)。
 */
export const RenderKindCode = {
  Player: 0,
  Enemy: 1,
  Boss: 2,
  Pickup: 3,
  Projectile: 4,
  Effect: 5,
} as const;

/** HUD 的渲染侧结构接口；DOM 实现见 src/ui/HUD.ts。 */
export interface HUDLike {
  onEvent(event: GameEvent): void;
  flush?(): void;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class ViewportSystem {
  private readonly terms = [Position, RenderRef];
  private readonly playerTerms = [Position, PlayerTag];

  constructor(
    private readonly world: BattleWorld,
    private readonly viewport: Viewport,
  ) {}

  run(): void {
    // 相机跟随本地玩家（存在多个时取最小 eid，行为确定）。
    const players = query(this.world, this.playerTerms);
    if (players.length > 0) {
      const eid = players[0] as Eid;
      this.viewport.follow(Position.x[eid], Position.y[eid]);
    }
    this.viewport.update();

    const entities = query(this.world, this.terms);
    const rect = this.viewport.rect;
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i] as Eid;
      const visible =
        Position.x[eid] >= rect.x &&
        Position.x[eid] <= rect.x + rect.w &&
        Position.y[eid] >= rect.y &&
        Position.y[eid] <= rect.y + rect.h;
      const culled = has(this.world, eid, Culled);
      if (visible && culled) {
        remove(this.world, eid, Culled);
      } else if (!visible && !culled) {
        add(this.world, eid, Culled);
      }
    }
  }
}

export class RenderSyncSystem {
  private readonly terms = [RenderRef, Position];
  private readonly lastX = new Float32Array(CAP);
  private readonly lastY = new Float32Array(CAP);
  private readonly synced = new Uint8Array(CAP);
  private readonly events: GameEvent[] = [];

  constructor(
    private readonly pools: PixiPools,
    private readonly world: BattleWorld,
  ) {}

  private kindFor(code: number): RenderKind {
    if (code <= RenderKindCode.Boss) return 'chibi';
    if (code === RenderKindCode.Projectile) return 'bullet';
    if (code === RenderKindCode.Pickup) return 'pickup';
    return 'effect';
  }

  private textureFor(eid: Eid, code: number): string {
    if (code === RenderKindCode.Player) return 'chibi:player';
    if (code === RenderKindCode.Boss) return 'chibi:boss';
    if (code === RenderKindCode.Enemy) return 'chibi:melee';
    if (code === RenderKindCode.Projectile) return BULLET_KEY;
    if (code === RenderKindCode.Pickup) {
      const pickupKind = has(this.world, eid, Pickup) ? Pickup.kind[eid] | 0 : 0;
      if (pickupKind === 1) return PICKUP_KEYS.hp;
      if (pickupKind === 2) return PICKUP_KEYS.gold;
      if (pickupKind === 3) return PICKUP_KEYS.equip;
      return PICKUP_KEYS.exp;
    }
    return EFFECT_KEYS.hit;
  }

  /** 回收已经死亡或被回收的实体的显示槽。 */
  private reclaim(): void {
    const capacity = this.pools.capacity;
    for (let slot = 0; slot < capacity; slot++) {
      const eid = this.pools.slotToEid[slot];
      if (eid === 0) continue;
      if (!exists(this.world, eid as Eid) || has(this.world, eid as Eid, Dead)) {
        this.pools.release(slot);
        this.synced[eid] = 0;
      }
    }
  }

  private readonly playerTerms = [Position, PlayerTag];

  run(alpha: number): void {
    this.reclaim();
    const entities = query(this.world, this.terms);
    const lerp = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i] as Eid;
      this.syncEntity(eid, RenderRef.kind[eid] | 0, true, lerp);
    }

    // 玩家实体在批次 B 中可能只挂 PlayerTag 而无 RenderRef；渲染层单独兜底，绝不改 ECS。
    const players = query(this.world, this.playerTerms);
    for (let i = 0; i < players.length; i++) {
      const eid = players[i] as Eid;
      if (has(this.world, eid, RenderRef)) continue;
      this.syncEntity(eid, RenderKindCode.Player, false, lerp);
    }
  }

  private syncEntity(eid: Eid, code: number, hasRef: boolean, lerp: number): void {
    if (has(this.world, eid, Culled) || has(this.world, eid, Dead)) return;

    let slot = hasRef ? RenderRef.slot[eid] | 0 : this.pools.getSlot(eid);
    if (slot < 0 || slot >= this.pools.capacity) {
      slot = this.pools.acquire(this.kindFor(code), this.textureFor(eid, code), eid);
      if (slot < 0) return;
      if (hasRef) RenderRef.slot[eid] = slot;
      this.synced[eid] = 0;
    }

    const x = Position.px[eid] + (Position.x[eid] - Position.px[eid]) * lerp;
    const y = Position.py[eid] + (Position.y[eid] - Position.py[eid]) * lerp;
    const dirty = (hasRef && RenderRef.dirty[eid] > 0) || this.synced[eid] === 0;
    const moved =
      Math.abs(x - this.lastX[eid]) > 0.02 || Math.abs(y - this.lastY[eid]) > 0.02;
    if (!dirty && !moved) return;

    this.pools.setPosition(slot, x, y);
    const teleport =
      Math.abs(x - this.lastX[eid]) > SNAP_TELEPORT_THRESHOLD ||
      Math.abs(y - this.lastY[eid]) > SNAP_TELEPORT_THRESHOLD;
    if (teleport) this.pools.snap(slot);

    // B 的 spawn 只写 kind/slot/dirty，tint/alpha 保持 0；0 视为"未设置"取渲染默认值。
    const tintRaw = hasRef ? RenderRef.tint[eid] | 0 : 0;
    const alphaRaw = hasRef ? RenderRef.alpha[eid] : 1;
    const anim = hasRef ? RenderRef.anim[eid] | 0 : 0;
    this.pools.setVisual(
      slot,
      anim,
      this.resolveFlip(eid),
      tintRaw === 0 ? 0xffffff : tintRaw,
      alphaRaw === 0 ? 1 : alphaRaw,
    );
    if (hasRef) RenderRef.dirty[eid] = 0;
    this.lastX[eid] = x;
    this.lastY[eid] = y;
    this.synced[eid] = 1;
  }

  private resolveFlip(eid: Eid): boolean {
    if (has(this.world, eid, Heading)) {
      const angle = Heading.angle[eid];
      if (angle !== 0) return Math.cos(angle) < 0;
    }
    return RenderRef.flipX[eid] > 0.5;
  }
}

/** 10Hz 事件抽取：把 ECS 事件转成 HUD 可读调用，节流只作用于读总线。 */
export class HUDSystem {
  private readonly out: GameEvent[] = [];
  private lastDrain = -Infinity;

  constructor(
    private readonly bus: GameEventBus,
    private readonly hud: HUDLike,
  ) {
    for (let i = 0; i < 128; i++) this.out.push(createEventSlot());
  }

  run(): void {
    const now = nowMs();
    if (now - this.lastDrain < HUD_THROTTLE_MS) return;
    this.lastDrain = now;
    const count = this.bus.drain(this.out);
    for (let i = 0; i < count; i++) this.hud.onEvent(this.out[i]);
    if (this.hud.flush !== undefined) this.hud.flush();
  }

  /** 结算/切场景时把瞬时事件全部送给 HUD，避免 10Hz 节流吞掉终局提示。 */
  flushAll(): void {
    const count = this.bus.drain(this.out);
    for (let i = 0; i < count; i++) this.hud.onEvent(this.out[i]);
    if (this.hud.flush !== undefined) this.hud.flush();
  }
}
