/**
 * 拖拽换装控制器（ARCH_UI_REFACTOR §3.4 / PRD §4.2 / US-03）。
 *
 * 硬约束：
 *  - pointerdown/move/up/cancel + setPointerCapture（多指安全）；
 *  - 移动端长按 400ms 用 setTimeout（D-2 拍板），绝不读墙钟；
 *  - 位移 >8px 在长按未到时视为滚动并取消 timer（不误触换装）；
 *  - 落点非兼容槽 / pointercancel / detach → 零 onEquip、零 onChange、零存档写入；
 *  - 拖拽镜像 pointer-events:none，不遮挡 elementFromPoint 命中。
 */
import type { EquipmentSlotId } from '../art/EquipmentIconFactory';

/** 长按进入拖拽模式的时长（D-2：用 setTimeout 计数，不读墙钟）。 */
export const LONG_PRESS_MS = 400;
/** 超过该位移即判为滚动（移动端取消长按 / 桌面启动拖拽）。 */
export const MOVE_THRESHOLD_PX = 8;

/** 拖拽状态广播（供 EquipmentUI 驱动纸娃娃高亮）。 */
export interface DragState {
  readonly dragging: boolean;
  readonly uid: string | null;
  readonly over: EquipmentSlotId | null;
}

/** 拖拽源视图模型（由当前筛选后的仓库条目组装）。 */
export interface DragSourceVM {
  readonly uid: string;
  readonly slotId: EquipmentSlotId;
  readonly label: string;
  readonly iconUrl: string;
}

/** 构造注入项。 */
export interface DragEquipOptions {
  readonly root: HTMLElement;
  readonly sources: () => readonly DragSourceVM[];
  readonly isCompatible: (uid: string, target: EquipmentSlotId) => boolean;
  readonly onDragState: (state: DragState) => void;
  readonly onEquip: (uid: string, target: EquipmentSlotId) => void;
  readonly canLongPress?: () => boolean;
}

/** 拖拽控制器实现（接口成员与 ARCH §3.4 的 DragEquipController 契约一致）。 */
export class DragEquipController {
  private readonly options: DragEquipOptions;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private pointerId: number | null = null;
  private sourceEl: HTMLElement | null = null;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private pending: { uid: string } | null = null;
  private activeUid: string | null = null;
  private overSlot: EquipmentSlotId | null = null;
  private ghost: HTMLDivElement | null = null;
  private attached = false;

  constructor(options: DragEquipOptions) {
    this.options = options;
  }

  /** 是否处于拖拽中（长按计时阶段不算）。 */
  get active(): boolean {
    return this.activeUid !== null;
  }

  /** 在 root 上委托监听 pointerdown/move/up/cancel。 */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const root = this.options.root;
    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('pointermove', this.onPointerMove);
    root.addEventListener('pointerup', this.onPointerUp);
    root.addEventListener('pointercancel', this.onPointerCancel);
  }

  /** 清 timer、释放 capture、移 ghost、清高亮。 */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const root = this.options.root;
    root.removeEventListener('pointerdown', this.onPointerDown);
    root.removeEventListener('pointermove', this.onPointerMove);
    root.removeEventListener('pointerup', this.onPointerUp);
    root.removeEventListener('pointercancel', this.onPointerCancel);
    this.clearTimer();
    this.finish();
  }

  // ---------------------------------------------------------------------------
  // 事件处理
  // ---------------------------------------------------------------------------

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.activeUid !== null || this.pointerId !== null) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const sourceEl = target.closest<HTMLElement>('[data-drag-uid]');
    if (sourceEl === null) return;

    const uid = sourceEl.dataset.dragUid;
    if (uid === undefined || uid.length === 0) return;
    const sources = this.options.sources();
    let matched = false;
    for (let i = 0; i < sources.length; i++) {
      if (sources[i].uid === uid) {
        matched = true;
        break;
      }
    }
    if (!matched) return;

    this.pointerId = event.pointerId;
    this.sourceEl = sourceEl;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.pending = { uid };
    this.overSlot = null;
    this.capturePointer(sourceEl, event.pointerId);

    const pointerType = event.pointerType === undefined ? 'mouse' : event.pointerType;
    const allowLongPress = this.options.canLongPress === undefined ? true : this.options.canLongPress();
    if (pointerType !== 'mouse' && allowLongPress) {
      this.clearTimer();
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.pending !== null) this.beginDrag();
      }, LONG_PRESS_MS);
    }
    // 注意：此处不 preventDefault，避免破坏移动端滚动与 click 选中。
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.lastX = event.clientX;
    this.lastY = event.clientY;

    if (this.activeUid === null) {
      if (this.pending === null) return;
      const dx = event.clientX - this.startX;
      const dy = event.clientY - this.startY;
      if (dx * dx + dy * dy <= MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) return;

      if (this.timer !== null) {
        // 长按尚未到时即发生位移 → 判为滚动，取消长按（US-03-5 / R-11）。
        this.clearTimer();
        this.releasePointer();
        this.pending = null;
        this.pointerId = null;
        this.sourceEl = null;
        return;
      }
      // 鼠标按住后拖动超过阈值 → 进入拖拽。
      this.beginDrag();
    }

    if (this.activeUid === null) return;
    event.preventDefault();
    this.moveGhost();
    this.updateOverSlot();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.clearTimer();

    if (this.activeUid !== null) {
      // 以最终指针位置再次判定落点，避免最后一个 pointermove 丢失。
      this.updateOverSlot();
      const uid = this.activeUid;
      const slot = this.overSlot;
      const compatible = slot !== null && this.options.isCompatible(uid, slot);
      this.finish();
      if (compatible && slot !== null) {
        // 唯一写路径：交给 EquipmentUI.equip()（含唯一性清理 + onChange + 存档）。
        this.options.onEquip(uid, slot);
      }
      return;
    }

    // 未进入拖拽：Click 由 EquipmentUI 正常处理，这里只清理指针状态。
    this.releasePointer();
    this.pending = null;
    this.pointerId = null;
    this.sourceEl = null;
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.clearTimer();
    this.finish();
  };

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  /** 从 pending 创建拖拽镜像并广播拖拽开始。 */
  private beginDrag(): void {
    const pending = this.pending;
    if (pending === null) return;
    const source = this.options.sources();
    let vm: DragSourceVM | null = null;
    for (let i = 0; i < source.length; i++) {
      if (source[i].uid === pending.uid) {
        vm = source[i];
        break;
      }
    }
    if (vm === null) {
      this.pending = null;
      return;
    }

    this.pending = null;
    this.activeUid = vm.uid;
    this.overSlot = null;

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    const icon = document.createElement('img');
    icon.className = 'drag-ghost__icon';
    icon.src = vm.iconUrl;
    icon.alt = '';
    icon.draggable = false;
    const label = document.createElement('span');
    label.className = 'drag-ghost__label';
    label.textContent = vm.label;
    ghost.append(icon, label);
    document.body.append(ghost);
    this.ghost = ghost;
    this.moveGhost();

    this.emitState();
  }

  /** 镜像跟随指针。 */
  private moveGhost(): void {
    if (this.ghost === null) return;
    this.ghost.style.left = `${this.lastX}px`;
    this.ghost.style.top = `${this.lastY}px`;
  }

  /** elementFromPoint 找落点槽位；仅在变化时广播（避免重复重绘）。 */
  private updateOverSlot(): void {
    let slot: EquipmentSlotId | null = null;
    if (typeof document.elementFromPoint === 'function') {
      const hit = document.elementFromPoint(this.lastX, this.lastY);
      if (hit !== null) {
        const slotEl = hit.closest<HTMLElement>('.doll-slot[data-slot]');
        if (slotEl !== null) {
          const id = slotEl.dataset.slot;
          if (id !== undefined && id.length > 0) slot = id;
        }
      }
    }
    if (slot !== this.overSlot) {
      this.overSlot = slot;
      this.emitState();
    }
  }

  /** 广播当前拖拽状态。 */
  private emitState(): void {
    this.options.onDragState({
      dragging: this.activeUid !== null,
      uid: this.activeUid,
      over: this.overSlot,
    });
  }

  /** 清理一切视觉与计时状态；不触发 onEquip。 */
  private finish(): void {
    const wasDragging = this.activeUid !== null;
    if (this.ghost !== null) {
      this.ghost.remove();
      this.ghost = null;
    }
    this.releasePointer();
    this.activeUid = null;
    this.overSlot = null;
    this.pending = null;
    this.pointerId = null;
    this.sourceEl = null;
    if (wasDragging) this.emitState();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** jsdom / 老浏览器可能没有 setPointerCapture，做能力检测且吞掉同步异常。 */
  private capturePointer(el: HTMLElement, pointerId: number): void {
    if (typeof el.setPointerCapture !== 'function') return;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // 无效 pointerId 时忽略；不影响拖拽主流程。
    }
  }

  private releasePointer(): void {
    if (this.sourceEl === null || this.pointerId === null) return;
    const el = this.sourceEl;
    const id = this.pointerId;
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(id);
      } catch {
        // 已经释放 / pointerId 失效时忽略。
      }
    }
  }
}
