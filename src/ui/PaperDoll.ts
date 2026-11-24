/**
 * 纸娃娃视图（ARCH_UI_REFACTOR §3.2 / PRD §3.3 / US-01）。
 *
 * 职责边界：纯渲染 + 槽位事件转发。本文件不知道 SaveData 的写路径，
 * 不调用 equip()/unequip()，不持有 SaveSystem，不读墙钟，不使用随机数。
 * 人形轮廓是一张静态 SVG（pointer-events:none），13 个可聚焦 <button.doll-slot>
 * 以「容器百分比 + translate(-50%,-50%)」锚定在解剖位置上。
 *
 * 坐标契约：DOLL_SLOT_ANCHORS 与 EQUIPMENT_SLOT_IDS 顺序一致（13 槽）。
 */
import type { EquipmentSlotId } from '../art/EquipmentIconFactory';
import type { RarityId } from '../data/types';
import type { EquipmentItem } from '../game/SaveData';

/** 单个槽位的相对锚点（百分比，相对 .paper-doll 容器）。 */
export interface DollAnchor {
  readonly left: number;
  readonly top: number;
}

/** 13 槽锚点表（冻结契约，与 PRD §3.3 紧凑映射表逐项一致）。 */
export const DOLL_SLOT_ANCHORS: Readonly<Record<EquipmentSlotId, DollAnchor>> = {
  head: { left: 50, top: 2 },
  amulet: { left: 50, top: 12 },
  shoulders: { left: 50, top: 19 },
  chest: { left: 50, top: 27 },
  bracers: { left: 50, top: 38 },
  belt: { left: 50, top: 41 },
  gloves: { left: 50, top: 47 },
  ring1: { left: 30, top: 47 },
  ring2: { left: 70, top: 47 },
  mainHand: { left: 76, top: 52 },
  offHand: { left: 24, top: 52 },
  legs: { left: 50, top: 66 },
  boots: { left: 50, top: 84 },
};

/** 拖拽期的槽位落点状态。 */
export type DollDropState = 'idle' | 'compatible' | 'incompatible' | 'hover';

/** 纸娃娃唯一输入视图模型（由 EquipmentUI 组装）。 */
export interface DollSlotVM {
  readonly slotId: EquipmentSlotId;
  readonly label: string;
  readonly anchor: DollAnchor;
  readonly item: EquipmentItem | null;
  readonly iconUrl: string;
  readonly rarity: RarityId | null;
  readonly ariaLabel: string;
  readonly dropState: DollDropState;
}

/**
 * 静态人形轮廓：viewBox 0..100 与百分比锚点同坐标系，preserveAspectRatio="none"
 * 让轮廓随容器伸缩而不改变锚点语义。所有配色走 CSS 类（equipment.css 用 --ws-* 令牌）。
 */
const FIGURE_SVG: string = [
  '<svg class="doll-figure" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">',
  '<g stroke-width="0.6" stroke-linejoin="round">',
  '<circle class="doll-figure__head" cx="50" cy="8" r="6.4" />',
  '<rect class="doll-figure__neck" x="47.6" y="13.4" width="4.8" height="4" rx="1.6" />',
  '<path class="doll-figure__torso" d="M38.5 18 Q50 14.6 61.5 18 L59.5 26 L57 43 L43 43 L40.5 26 Z" />',
  '<path class="doll-figure__limb" d="M38.5 18.4 L31.6 21.4 L27.4 38 L31 41.6 L35.2 39 L40.6 25 Z" />',
  '<path class="doll-figure__limb" d="M61.5 18.4 L68.4 21.4 L72.6 38 L69 41.6 L64.8 39 L59.4 25 Z" />',
  '<rect class="doll-figure__waist" x="42.4" y="42.6" width="15.2" height="4.6" rx="2" />',
  '<path class="doll-figure__limb" d="M43 47.6 L49.2 47.6 L48.2 76 L42.6 76 Z" />',
  '<path class="doll-figure__limb" d="M57 47.6 L50.8 47.6 L51.8 76 L57.4 76 Z" />',
  '<path class="doll-figure__foot" d="M42.6 76 L48.2 76 L49.4 83.4 L40.2 83.4 Z" />',
  '<path class="doll-figure__foot" d="M57.4 76 L51.8 76 L50.6 83.4 L59.8 83.4 Z" />',
  '</g>',
  '</svg>',
].join('');

/** 纸娃娃视图实现（接口成员与 ARCH §3.2 的 PaperDoll 契约一致）。 */
export class PaperDoll {
  readonly root: HTMLDivElement;

  private readonly slotLayer: HTMLDivElement;
  private readonly buttons = new Map<EquipmentSlotId, HTMLButtonElement>();

  /** 点击槽位 → 选中该槽（由 EquipmentUI 接管详情刷新）。 */
  onSlotClick?: (slotId: EquipmentSlotId) => void;
  /** 指针进入槽位 → 请求预览（由 EquipmentUI 决定是否弹浮层）。 */
  onSlotHover?: (slotId: EquipmentSlotId, el: HTMLElement) => void;
  /** 指针离开槽位 → 隐藏预览。 */
  onSlotLeave?: (slotId: EquipmentSlotId) => void;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'paper-doll';

    const figureWrap = document.createElement('div');
    figureWrap.className = 'doll-figure-wrap';
    figureWrap.innerHTML = FIGURE_SVG;

    this.slotLayer = document.createElement('div');
    this.slotLayer.className = 'doll-slots';

    this.root.append(figureWrap, this.slotLayer);
  }

  /** 整体替换 13 槽；切换武将后天然无残留（US-01-6）。 */
  render(vm: readonly DollSlotVM[]): void {
    this.buttons.clear();
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < vm.length; i++) {
      const model = vm[i];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'doll-slot';
      if (model.item === null) button.classList.add('is-empty');
      else if (model.rarity !== null) button.classList.add(`rarity-${model.rarity}`);
      button.dataset.slot = model.slotId;
      button.dataset.dropState = model.dropState;
      button.style.left = `${model.anchor.left}%`;
      button.style.top = `${model.anchor.top}%`;
      button.setAttribute('aria-label', model.ariaLabel);
      button.title = model.ariaLabel;

      const icon = document.createElement('img');
      icon.className = 'doll-slot__icon';
      icon.src = model.iconUrl;
      icon.alt = '';
      icon.draggable = false;

      const label = document.createElement('span');
      label.className = 'doll-slot__label';
      label.textContent = model.label;

      button.append(icon, label);

      const slotId = model.slotId;
      button.addEventListener('click', () => {
        if (this.onSlotClick !== undefined) this.onSlotClick(slotId);
      });
      button.addEventListener('pointerenter', () => {
        if (this.onSlotHover !== undefined) this.onSlotHover(slotId, button);
      });
      button.addEventListener('pointerleave', () => {
        if (this.onSlotLeave !== undefined) this.onSlotLeave(slotId);
      });

      this.buttons.set(slotId, button);
      fragment.append(button);
    }

    this.slotLayer.replaceChildren(fragment);
  }

  /** 拖拽期细粒度更新单个槽位，不触发整页重绘。 */
  setDropState(slotId: EquipmentSlotId, state: DollDropState): void {
    const button = this.buttons.get(slotId);
    if (button === undefined) return;
    button.dataset.dropState = state;
  }

  /** 清空所有落点状态（取消拖拽 / 关闭界面时调用）。 */
  clearDropStates(): void {
    this.buttons.forEach((button) => {
      button.dataset.dropState = 'idle';
    });
  }

  destroy(): void {
    this.buttons.clear();
    this.onSlotClick = undefined;
    this.onSlotHover = undefined;
    this.onSlotLeave = undefined;
    this.root.remove();
  }
}
