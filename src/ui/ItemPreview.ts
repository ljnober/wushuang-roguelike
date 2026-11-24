/**
 * 只读装备预览浮层与移动端底部抽屉（ARCH_UI_REFACTOR §3.3 / PRD §3.6 / US-02）。
 *
 * 硬约束：
 *  - show()/hide() 绝不调用 equip()/unequip()/onChange，不写存档；
 *  - 抽屉的「装备到此槽」只通过构造注入的 onEquipRequest 事件上报，由 EquipmentUI 实现；
 *  - 桌面 hover 用 setTimeout(120) 延迟显示（零墙钟、零随机）；
 *  - 视口边缘自动翻转，浮层本体 pointer-events:none（仅按钮可交互）；
 *  - Esc / 外部点击 / pointerleave 只隐藏，不改变任何装备状态。
 */
import { EquipmentIconFactory, type EquipmentSlotId } from '../art/EquipmentIconFactory';
import { findRarity, LEGENDARY_EFFECT_DEFS, SET_DEFS, SLOT_DEFS } from '../data/equipment';
import { AFFIX_POOL, findStat } from '../data/stats';
import type { GameConfig } from '../data/types';
import type { EquipmentItem } from '../game/SaveData';

/** 属性差值行（由 EquipmentUI.statsOf 前后差值组装，同源同算法）。 */
export interface StatDelta {
  readonly statId: string;
  readonly name: string;
  readonly delta: number;
  readonly tone: 'up' | 'down' | 'flat';
}

/** 预览请求（唯一 show 入参）。 */
export interface PreviewRequest {
  readonly item: EquipmentItem;
  readonly slotId: EquipmentSlotId;
  readonly trigger: HTMLElement;
  readonly mode: 'hover' | 'drawer';
  readonly pointer?: { readonly x: number; readonly y: number };
  readonly deltas: readonly StatDelta[];
  readonly occupiedIn?: string;
}

/** 构造注入项：只读配置 + 图标工厂 + 装备事件回调。 */
export interface ItemPreviewOptions {
  readonly config: GameConfig;
  readonly icons: EquipmentIconFactory;
  readonly onEquipRequest?: (item: EquipmentItem, slotId: EquipmentSlotId) => void;
}

/** 桌面悬停延迟（PRD §3.6：120ms，零墙钟）。 */
export const HOVER_DELAY_MS = 120;
/** 浮层相对指针的偏移（对应 --ws-space-3）。 */
const PREVIEW_OFFSET_PX = 12;
/** 视口安全边距（对应 --ws-space-2）。 */
const VIEWPORT_GUTTER_PX = 8;

/** 是否应走底部抽屉：无 hover 能力或触屏指针。 */
export function prefersDrawer(pointerType?: string): boolean {
  if (pointerType === 'touch' || pointerType === 'pen') return true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(hover: none)').matches;
  }
  return false;
}

/** 创建一个带类名的 span（本文件私有小工具）。 */
function span(text: string, className: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/** 创建一个普通按钮（本文件私有小工具）。 */
function button(text: string, className: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = text;
  return node;
}

/** 只读预览组件实现（接口成员与 ARCH §3.3 的 ItemPreview 契约一致）。 */
export class ItemPreview {
  private readonly hoverRoot: HTMLDivElement;
  private readonly drawerRoot: HTMLDivElement;
  private readonly options: ItemPreviewOptions;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentRequest: PreviewRequest | null = null;
  private activeMode: 'hover' | 'drawer' | null = null;

  constructor(options: ItemPreviewOptions) {
    this.options = options;

    this.hoverRoot = document.createElement('div');
    this.hoverRoot.className = 'item-preview item-preview--hover';
    this.hoverRoot.setAttribute('role', 'dialog');
    this.hoverRoot.setAttribute('aria-label', '装备预览');
    this.hoverRoot.hidden = true;

    this.drawerRoot = document.createElement('div');
    this.drawerRoot.className = 'item-preview item-preview--drawer';
    this.drawerRoot.hidden = true;

    document.body.append(this.hoverRoot, this.drawerRoot);
  }

  /** 当前展示形态；供调用方区分「离开条目时是否该隐藏」。 */
  get mode(): 'hover' | 'drawer' | null {
    return this.activeMode;
  }

  /** 是否正在展示（hover 延迟期也算待展示）。 */
  get visible(): boolean {
    return this.currentRequest !== null;
  }

  /** 显示预览：hover 模式延迟 120ms，drawer 模式立即出现。 */
  show(req: PreviewRequest): void {
    this.clearTimer();
    this.currentRequest = req;

    if (req.mode === 'hover') {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.currentRequest === req) this.renderHover(req);
      }, HOVER_DELAY_MS);
      return;
    }

    this.renderDrawer(req);
  }

  /** 仅隐藏，绝不触碰装备状态；抽屉关闭后把焦点归还触发元素。 */
  hide(restoreFocus: boolean = true): void {
    const trigger = this.currentRequest?.trigger;
    const wasDrawer = this.activeMode === 'drawer';
    const activeBefore = document.activeElement;
    const focusWasInside = activeBefore !== null && this.drawerRoot.contains(activeBefore);

    this.clearTimer();
    this.currentRequest = null;
    this.activeMode = null;
    this.hoverRoot.hidden = true;
    this.hoverRoot.replaceChildren();
    this.drawerRoot.hidden = true;
    this.drawerRoot.replaceChildren();

    if (restoreFocus && wasDrawer && focusWasInside && trigger !== undefined && document.contains(trigger)) {
      trigger.focus();
    }
  }

  destroy(): void {
    this.hide();
    this.hoverRoot.remove();
    this.drawerRoot.remove();
  }

  // ---------------------------------------------------------------------------
  // 渲染：桌面浮层
  // ---------------------------------------------------------------------------

  private renderHover(req: PreviewRequest): void {
    const card = this.buildCard(req);
    this.hoverRoot.replaceChildren(card);
    this.hoverRoot.hidden = false;
    this.hoverRoot.classList.add('is-visible');
    this.activeMode = 'hover';
    this.positionHover(req);
  }

  /** 视口边缘翻转：右溢翻左、下溢翻上，四角均完整可见（A-8）。 */
  private positionHover(req: PreviewRequest): void {
    const rect = this.hoverRoot.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : 0;
    const height = rect.height > 0 ? rect.height : 0;

    let anchorX = req.pointer !== undefined ? req.pointer.x : 0;
    let anchorY = req.pointer !== undefined ? req.pointer.y : 0;
    if (req.pointer === undefined) {
      const target = req.trigger.getBoundingClientRect();
      anchorX = target.left + target.width / 2;
      anchorY = target.top + target.height / 2;
    }

    let left = anchorX + PREVIEW_OFFSET_PX;
    let top = anchorY + PREVIEW_OFFSET_PX;

    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;

    if (viewportWidth > 0 && left + width > viewportWidth - VIEWPORT_GUTTER_PX) {
      left = anchorX - width - PREVIEW_OFFSET_PX;
    }
    if (viewportHeight > 0 && top + height > viewportHeight - VIEWPORT_GUTTER_PX) {
      top = anchorY - height - PREVIEW_OFFSET_PX;
    }
    if (left < VIEWPORT_GUTTER_PX) left = VIEWPORT_GUTTER_PX;
    if (top < VIEWPORT_GUTTER_PX) top = VIEWPORT_GUTTER_PX;

    this.hoverRoot.style.left = `${Math.round(left)}px`;
    this.hoverRoot.style.top = `${Math.round(top)}px`;
  }

  // ---------------------------------------------------------------------------
  // 渲染：移动端 / 键盘抽屉
  // ---------------------------------------------------------------------------

  private renderDrawer(req: PreviewRequest): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'item-preview__backdrop';
    backdrop.addEventListener('click', () => this.hide());

    const sheet = document.createElement('div');
    sheet.className = 'item-preview__sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    const titleId = `item-preview-title-${req.item.uid}`;
    sheet.setAttribute('aria-labelledby', titleId);

    const close = button('关闭', 'item-preview__close');
    close.setAttribute('aria-label', '关闭预览');
    close.addEventListener('click', () => this.hide());

    const card = this.buildCard(req, titleId);
    const equip = button('装备到此槽', 'item-preview__equip');
    equip.addEventListener('click', () => {
      const callback = this.options.onEquipRequest;
      this.hide();
      if (callback !== undefined) callback(req.item, req.slotId);
    });

    sheet.append(close, card, equip);
    this.drawerRoot.replaceChildren(backdrop, sheet);
    this.drawerRoot.hidden = false;
    this.activeMode = 'drawer';
    close.focus();
  }

  // ---------------------------------------------------------------------------
  // 内容组装（只读）
  // ---------------------------------------------------------------------------

  /** 构建预览卡片；titleId 供抽屉 aria-labelledby 引用。 */
  private buildCard(req: PreviewRequest, titleId?: string): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'item-preview__card';

    const def = this.options.config.equipment.tryGet(req.item.defId);
    const rarity = def !== undefined ? def.rarity : 'common';
    const slotDef = SLOT_DEFS.find((slot) => slot.id === req.slotId);
    const slotName = slotDef !== undefined ? slotDef.name : req.slotId;
    const displayName = def === undefined ? `未知装备（${req.item.defId}）` : slotName;
    const iconUrl = def !== undefined
      ? this.options.icons.dataUrlFor(req.slotId, def.rarity)
      : this.options.icons.placeholderDataUrlFor(req.slotId);

    // —— 头部 ——
    const header = document.createElement('div');
    header.className = 'item-preview__header';
    const icon = document.createElement('img');
    icon.className = 'item-preview__icon';
    icon.src = iconUrl;
    icon.alt = '';
    icon.draggable = false;

    const headText = document.createElement('div');
    headText.className = 'item-preview__head-text';
    const name = span(displayName, 'item-preview__name');
    name.id = titleId !== undefined ? titleId : `item-preview-name-${req.item.uid}`;
    const meta = document.createElement('div');
    meta.className = 'item-preview__meta';
    meta.append(
      span(findRarity(rarity).name, `badge rarity-${rarity}`),
      span(`槽位：${slotName}`, 'item-preview__slot'),
    );
    headText.append(name, meta);
    header.append(icon, headText);
    card.append(header);

    if (req.occupiedIn !== undefined && req.occupiedIn.length > 0) {
      card.append(span(req.occupiedIn, 'item-preview__occupied'));
    }

    // —— 词缀 / 宝石 / 传奇 / 套装 / 差值 ——
    const affixes = this.buildAffixes(req.item);
    if (affixes.length > 0) card.append(this.buildSection('词缀', affixes));

    const gems = this.buildGems(req.item);
    if (gems.length > 0) card.append(this.buildSection('宝石', gems));

    const legendary = this.buildLegendary(req.item);
    if (legendary.length > 0) card.append(this.buildSection('传奇特效', legendary));

    const setLines = this.buildSet(def !== undefined ? def.setId : undefined);
    if (setLines.length > 0) card.append(this.buildSection('套装', setLines));

    if (req.deltas.length > 0) {
      card.append(this.buildSection('属性差值（对比当前装备）', this.buildDeltas(req.deltas)));
    }

    return card;
  }

  /** 分区容器：标题 + 行列表。 */
  private buildSection(title: string, lines: readonly HTMLElement[]): HTMLDivElement {
    const section = document.createElement('div');
    section.className = 'item-preview__section';
    section.append(span(title, 'item-preview__section-title'));
    const body = document.createElement('div');
    body.className = 'item-preview__section-body';
    for (let i = 0; i < lines.length; i++) body.append(lines[i]);
    section.append(body);
    return section;
  }

  /** 词缀数值口径与 EquipmentUI.statsOf 一致：区间中值 × 稀有度系数。 */
  private buildAffixes(item: EquipmentItem): HTMLElement[] {
    const def = this.options.config.equipment.tryGet(item.defId);
    if (def === undefined) return [];
    const coefficient = findRarity(def.rarity).coefficient;
    const count = Math.min(item.affixes.length, def.affixes.length);
    const out: HTMLElement[] = [];
    for (let i = 0; i < count; i++) {
      const affix = AFFIX_POOL[item.affixes[i]];
      if (affix === undefined) continue;
      const value = ((affix.min + affix.max) / 2) * coefficient;
      const stat = findStat(affix.stat);
      const isPercent = stat !== undefined && stat.isPercent;
      const shown = isPercent ? `${(value * 100).toFixed(1)}%` : value.toFixed(value < 10 ? 1 : 0);
      out.push(span(`${stat !== undefined ? stat.name : affix.stat} +${shown}`, 'item-preview__line'));
    }
    return out;
  }

  /** 宝石列表 + 孔位占用文案「已镶 n/m」。 */
  private buildGems(item: EquipmentItem): HTMLElement[] {
    const out: HTMLElement[] = [span(`已镶 ${item.gems.length}/${item.sockets}`, 'item-preview__line item-preview__line--muted')];
    for (let i = 0; i < item.gems.length; i++) {
      const gem = this.options.config.gems.tryGet(item.gems[i]);
      if (gem === undefined) {
        out.push(span(`未知宝石（${item.gems[i]}）`, 'item-preview__line item-preview__line--muted'));
        continue;
      }
      const stat = findStat(gem.stat);
      const isPercent = stat !== undefined && stat.isPercent;
      const shown = isPercent ? `${(gem.value * 100).toFixed(1)}%` : gem.value.toFixed(gem.value < 10 ? 1 : 0);
      out.push(span(`${stat !== undefined ? stat.name : gem.stat} +${shown}`, 'item-preview__line'));
    }
    return out;
  }

  /** 传奇特效名 + 描述。 */
  private buildLegendary(item: EquipmentItem): HTMLElement[] {
    if (item.legendaryEffectId === undefined) return [];
    for (let i = 0; i < LEGENDARY_EFFECT_DEFS.length; i++) {
      const effect = LEGENDARY_EFFECT_DEFS[i];
      if (effect.id !== item.legendaryEffectId) continue;
      return [
        span(effect.name, 'item-preview__line item-preview__line--strong'),
        span(effect.description, 'item-preview__line item-preview__line--muted'),
      ];
    }
    return [span(`未知特效（${item.legendaryEffectId}）`, 'item-preview__line item-preview__line--muted')];
  }

  /** 套装归属（件数进度在详情面板中按 loadout 实时计算）。 */
  private buildSet(setId: string | undefined): HTMLElement[] {
    if (setId === undefined) return [];
    for (let i = 0; i < SET_DEFS.length; i++) {
      const set = SET_DEFS[i];
      if (set.id !== setId) continue;
      return [
        span(set.name, 'item-preview__line item-preview__line--strong'),
        span(`${set.slots.length} 件套，覆盖 ${set.slots.length} 个部位`, 'item-preview__line item-preview__line--muted'),
      ];
    }
    return [span(`未知套装（${setId}）`, 'item-preview__line item-preview__line--muted')];
  }

  /** 差值行：0 必须显示（US-07-2），tone 决定三色。 */
  private buildDeltas(deltas: readonly StatDelta[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let i = 0; i < deltas.length; i++) {
      const d = deltas[i];
      const row = document.createElement('div');
      row.className = 'stat-row item-preview__delta';
      row.dataset.tone = d.tone;
      const sign = d.delta > 0 ? '+' : '';
      const stat = findStat(d.statId);
      const isPercent = stat !== undefined && stat.isPercent;
      const shown = isPercent ? `${(d.delta * 100).toFixed(1)}%` : d.delta.toFixed(1);
      row.textContent = `${d.name} ${sign}${shown}`;
      out.push(row);
    }
    return out;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
