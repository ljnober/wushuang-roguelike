/**
 * 13 槽配装 UI（DESIGN §8.4 / ARCHITECTURE §5.7 / ARCH_UI_REFACTOR §3.1）。
 *
 * 公共 API 签名冻结：constructor / visible / open / close / equip / unequip /
 * onChange / unmount / attachThemePicker。equip 唯一性语义与 statsOf / formatStat /
 * formatDelta / describeItem 数值口径原样保留（NG-7），渲染层改为
 * 「纸娃娃 + 仓库 + 详情六区块 + 预览浮层 + 拖拽换装」。
 *
 * 本类只读 SaveData / GameConfig / EquipmentIconFactory；
 * 写数据仅经 onChange(save) 回调，绝不 new SaveSystem、绝不碰 documentElement.dataset。
 */
import {
  EquipmentIconFactory,
  EQUIPMENT_SLOT_IDS,
  type EquipmentSlotId,
} from '../art/EquipmentIconFactory';
import { findRarity, SET_DEFS, SLOT_DEFS } from '../data/equipment';
import { AFFIX_POOL, findStat } from '../data/stats';
import type { GameConfig, RarityId } from '../data/types';
import type { EquipmentItem, SaveData } from '../game/SaveData';
import { DragEquipController, type DragSourceVM } from './DragEquipController';
import { ItemPreview, prefersDrawer, type StatDelta } from './ItemPreview';
import { DOLL_SLOT_ANCHORS, PaperDoll, type DollSlotVM } from './PaperDoll';

import { LEGENDARY_EFFECT_DEFS, RARITY_DEFS } from '../data/equipment';

/** 主题选择器依赖倒置接口（T02 实现，T01 只依赖此签名，不 import 实现类）。 */
export interface ThemePickerLike {
  openAsPopover(anchor: HTMLElement): void;
  close(): void;
  readonly visible: boolean;
}

type CategoryFilter = 'all' | 'armor' | 'jewelry' | 'weapon';
type RarityFilter = 'all' | RarityId;
type SlotFilter = 'all' | EquipmentSlotId;
type SortMode = 'default' | 'rarity' | 'power';

const RARITY_ORDER: Readonly<Record<RarityId, number>> = {
  common: 0,
  blue: 1,
  gold: 2,
  legendary: 3,
};

/** 创建按钮（沿用既有风格）。 */
function button(text: string, className: string = ''): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = text;
  return node;
}

/** 创建文本 span（沿用既有风格）。 */
function span(text: string, className: string = ''): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/** 创建装饰性图标 img。 */
function image(src: string, className: string): HTMLImageElement {
  const node = document.createElement('img');
  node.className = className;
  node.src = src;
  node.alt = '';
  node.draggable = false;
  return node;
}

export class EquipmentUI {
  private readonly overlay: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly header: HTMLElement;
  private readonly headerTitle: HTMLSpanElement;
  private readonly headerActions: HTMLDivElement;
  private readonly columns: HTMLDivElement;
  private readonly detailRoot: HTMLDivElement;

  private readonly icons = new EquipmentIconFactory();
  private readonly paperDoll = new PaperDoll();
  private readonly preview: ItemPreview;
  private readonly drag: DragEquipController;

  private save: SaveData | null = null;
  private generalId = 'liubei';
  private selectedUid: string | null = null;
  private selectedSlotId: string | null = null;

  // 筛选 / 排序：纯 UI 态，不写存档。
  private categoryFilter: CategoryFilter = 'all';
  private rarityFilter: RarityFilter = 'all';
  private slotFilter: SlotFilter = 'all';
  private sortMode: SortMode = 'default';
  private visibleItems: readonly EquipmentItem[] = [];
  private renderToken = 0;

  // 指针位置用于桌面浮层定位；无墙钟读取。
  private lastPointer: { x: number; y: number } | null = null;

  private themePicker: ThemePickerLike | null = null;
  private themeToggle: HTMLButtonElement | null = null;

  private countLabel: HTMLSpanElement | null = null;
  private inventoryListRoot: HTMLDivElement | null = null;

  onChange: ((save: SaveData) => void) | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly config: GameConfig,
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay ws-equipment';
    this.overlay.hidden = true;

    this.panel = document.createElement('div');
    this.panel.className = 'panel panel--wide';

    this.header = document.createElement('header');
    this.header.className = 'panel__header';
    this.headerTitle = span('配装', 'panel__title');
    this.headerActions = document.createElement('div');
    this.headerActions.className = 'panel__actions';
    const close = button('关闭');
    close.addEventListener('click', () => this.close());
    this.headerActions.append(close);
    this.header.append(this.headerTitle, this.headerActions);

    this.columns = document.createElement('div');
    this.columns.className = 'equip-columns';
    this.detailRoot = document.createElement('div');
    this.detailRoot.className = 'equip-detail';

    this.panel.append(this.header, this.columns);
    this.overlay.append(this.panel);
    this.host.append(this.overlay);

    // 纸娃娃槽位事件只绑定一次（render 会整体替换 13 个按钮，但回调挂在此实例上）。
    this.paperDoll.onSlotClick = (slotId: EquipmentSlotId): void => {
      this.selectedSlotId = slotId;
      this.selectedUid = this.equippedUid(slotId);
      this.renderDetail(slotId);
    };
    this.paperDoll.onSlotHover = (slotId: EquipmentSlotId, el: HTMLElement): void => {
      const item = this.itemByUid(this.equippedUid(slotId));
      if (item !== null) this.showPreview(item, slotId, el);
    };
    this.paperDoll.onSlotLeave = (): void => {
      if (this.preview.mode === 'hover') this.preview.hide();
    };

    this.preview = new ItemPreview({
      config: this.config,
      icons: this.icons,
      onEquipRequest: (item: EquipmentItem, slotId: EquipmentSlotId): void => {
        this.equip(item, slotId);
      },
    });

    this.drag = new DragEquipController({
      root: this.columns,
      sources: (): readonly DragSourceVM[] => this.dragSources(),
      isCompatible: (uid: string, target: EquipmentSlotId): boolean => this.isCompatible(uid, target),
      onDragState: (state): void => this.applyDragState(state),
      onEquip: (uid: string, target: EquipmentSlotId): void => {
        const item = this.itemByUid(uid);
        if (item !== null) this.equip(item, target);
      },
    });
    this.drag.attach();

    this.overlay.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('keydown', this.onKeyDown);
  }

  get visible(): boolean {
    return !this.overlay.hidden;
  }

  open(save: SaveData, generalId: string): void {
    this.save = save;
    this.generalId = generalId;
    // 整体替换 loadout 视图：不保留上一武将的选中态 / 预览 / 拖拽高亮。
    this.selectedUid = null;
    this.selectedSlotId = null;
    this.preview.hide(false);
    this.paperDoll.clearDropStates();
    this.overlay.hidden = false;
    this.render();
  }

  close(): void {
    this.overlay.hidden = true;
    this.preview.hide(false);
    this.paperDoll.clearDropStates();
  }

  /** 装备一件物品到槽位，先清理它在其它槽位的引用，保证唯一性。 */
  equip(item: EquipmentItem, slotId: string): void {
    if (this.save === null) return;
    const loadouts = this.save.meta.loadouts;
    const loadout = loadouts[this.generalId] ?? (loadouts[this.generalId] = {});
    const slots = Object.keys(loadout);
    for (let i = 0; i < slots.length; i++) {
      if (loadout[slots[i]] === item.uid) loadout[slots[i]] = null;
    }
    loadout[slotId] = item.uid;
    this.selectedUid = item.uid;
    if (this.onChange !== null) this.onChange(this.save);
    this.render();
  }

  unequip(slotId: string): void {
    if (this.save === null) return;
    const loadout = this.save.meta.loadouts[this.generalId];
    if (loadout !== undefined) {
      loadout[slotId] = null;
      if (this.onChange !== null) this.onChange(this.save);
    }
    this.render();
  }

  /** 注入主题快捷入口；不 import 实现类、不 new SaveSystem、不碰 data-theme。 */
  attachThemePicker(picker: ThemePickerLike | null): void {
    if (this.themeToggle !== null) {
      this.themeToggle.remove();
      this.themeToggle = null;
    }
    this.themePicker = picker;
    if (picker === null) return;

    const toggle = button('换肤', 'doll-theme-toggle');
    toggle.setAttribute('aria-label', '切换主题');
    toggle.addEventListener('click', () => picker.openAsPopover(toggle));
    this.headerActions.prepend(toggle);
    this.themeToggle = toggle;
  }

  private itemByUid(uid: string | null): EquipmentItem | null {
    if (this.save === null || uid === null) return null;
    const items = this.save.meta.warehouse.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].uid === uid) return items[i];
    }
    return null;
  }

  private equippedUid(slotId: string): string | null {
    if (this.save === null) return null;
    const loadout = this.save.meta.loadouts[this.generalId];
    return loadout !== undefined ? loadout[slotId] ?? null : null;
  }

  /** 词缀值 = 区间中值 × 稀有度系数；确定性，不依赖掉落时的随机数。 */
  private statsOf(item: EquipmentItem | null): Map<string, number> {
    const out = new Map<string, number>();
    if (item === null) return out;
    const def = this.config.equipment.tryGet(item.defId);
    if (def === undefined) return out;
    const coefficient = findRarity(def.rarity).coefficient;

    const affixCount = Math.min(item.affixes.length, def.affixes.length);
    for (let i = 0; i < affixCount; i++) {
      const affix = AFFIX_POOL[item.affixes[i]];
      if (affix === undefined) continue;
      const value = ((affix.min + affix.max) / 2) * coefficient;
      out.set(affix.stat, (out.get(affix.stat) ?? 0) + value);
    }

    for (let i = 0; i < item.gems.length; i++) {
      const gem = this.config.gems.tryGet(item.gems[i]);
      if (gem === undefined) continue;
      out.set(gem.stat, (out.get(gem.stat) ?? 0) + gem.value);
    }

    if (item.legendaryEffectId !== undefined) {
      for (let i = 0; i < LEGENDARY_EFFECT_DEFS.length; i++) {
        const effect = LEGENDARY_EFFECT_DEFS[i];
        if (effect.id !== item.legendaryEffectId) continue;
        for (let m = 0; m < effect.modifiers.length; m++) {
          const mod = effect.modifiers[m];
          out.set(mod.stat, (out.get(mod.stat) ?? 0) + mod.value);
        }
        break;
      }
    }
    return out;
  }

  private formatStat(statId: string, value: number): string {
    const def = findStat(statId);
    const isPercent = def !== undefined && def.isPercent;
    const shown = isPercent ? (value * 100).toFixed(1) : value.toFixed(value < 10 ? 1 : 0);
    return `${def !== undefined ? def.name : statId} ${shown}${isPercent ? '%' : ''}`;
  }

  private formatDelta(statId: string, value: number): string {
    const def = findStat(statId);
    const percent = def !== undefined && def.isPercent;
    return `${percent ? (value * 100).toFixed(1) : value.toFixed(1)}${percent ? '%' : ''}`;
  }

  private describeItem(item: EquipmentItem): string {
    const def = this.config.equipment.tryGet(item.defId);
    const rarity = def === undefined ? RARITY_DEFS[0] : findRarity(def.rarity);
    const name = def === undefined
      ? item.defId
      : (SLOT_DEFS.find((s) => s.id === def.slot)?.name ?? def.id);
    const sockets = item.gems.length > 0 ? ` [${item.gems.length}/${item.sockets}]` : '';
    return `${rarity.name}·${name}${sockets}`;
  }

  // ---------------------------------------------------------------------------
  // 渲染编排
  // ---------------------------------------------------------------------------

  private render(): void {
    if (this.save === null) return;
    this.preview.hide(false);

    const general = this.config.generals.tryGet(this.generalId);
    this.headerTitle.textContent = `配装 · ${general?.name ?? this.generalId}`;

    const dollWrap = document.createElement('section');
    dollWrap.className = 'paper-doll-wrap';
    dollWrap.append(span('纸娃娃', 'section-title'), this.paperDoll.root);

    const inventory = document.createElement('section');
    inventory.className = 'inventory';
    inventory.append(span('仓库', 'section-title'));

    this.countLabel = span('0 / 0 件', 'inventory__summary');
    inventory.append(this.countLabel);

    const list = document.createElement('div');
    list.className = 'inventory-list';
    this.inventoryListRoot = list;
    inventory.append(list);

    const filters = this.buildFilters();
    inventory.append(filters);

    // detailRoot 常驻第三栏：切换武将时仅替换其内部内容（不塌陷布局）。
    this.columns.replaceChildren(dollWrap, inventory, this.detailRoot);

    this.renderDoll();
    this.renderInventory();
    this.renderDetail(this.selectedSlotId);
  }

  /** 纸娃娃 13 槽视图模型组装。 */
  private renderDoll(): void {
    const models: DollSlotVM[] = [];
    for (let i = 0; i < SLOT_DEFS.length; i++) {
      const slot = SLOT_DEFS[i];
      const slotId = slot.id;
      const uid = this.equippedUid(slotId);
      const item = this.itemByUid(uid);
      const def = item !== null ? this.config.equipment.tryGet(item.defId) : undefined;
      const known = item !== null && def !== undefined;
      const rarity = known ? def.rarity : null;

      const iconUrl = known
        ? this.icons.dataUrlFor(slotId, def.rarity)
        : this.icons.placeholderDataUrlFor(slotId);
      const label = item === null
        ? slot.name
        : known
          ? slot.name
          : `未知装备（${item.defId}）`;
      const ariaLabel = item === null
        ? `${slot.name}：空`
        : known
          ? `${slot.name}：${this.describeItem(item)}`
          : `${slot.name}：未知装备（${item.defId}）`;

      models.push({
        slotId,
        label,
        anchor: DOLL_SLOT_ANCHORS[slotId],
        item,
        iconUrl,
        rarity,
        ariaLabel,
        dropState: 'idle',
      });
    }
    this.paperDoll.render(models);
  }

  /** 筛选行：类别 / 稀有度 / 槽位 + 排序（DOM 置于列表之后，CSS 视觉置顶）。 */
  private buildFilters(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'inventory-filters';

    const buildRow = (
      label: string,
      options: ReadonlyArray<{ value: string; text: string }>,
      current: string,
      onPick: (value: string) => void,
    ): HTMLDivElement => {
      const row = document.createElement('div');
      row.className = 'inventory__filter-row';
      row.append(span(label, 'inventory__filter-label'));
      for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const chip = button(option.text, 'chip');
        chip.dataset.filterValue = option.value;
        if (option.value === current) {
          chip.classList.add('is-active');
          chip.setAttribute('aria-pressed', 'true');
        } else {
          chip.setAttribute('aria-pressed', 'false');
        }
        chip.addEventListener('click', () => {
          onPick(option.value);
          this.renderInventory();
        });
        row.append(chip);
      }
      return row;
    };

    root.append(
      buildRow(
        '类别',
        [
          { value: 'all', text: '全部' },
          { value: 'armor', text: '防具' },
          { value: 'jewelry', text: '首饰' },
          { value: 'weapon', text: '武器' },
        ],
        this.categoryFilter,
        (value) => {
          this.categoryFilter = value as CategoryFilter;
        },
      ),
      buildRow(
        '稀有度',
        [
          { value: 'all', text: '全部' },
          { value: 'common', text: '白' },
          { value: 'blue', text: '蓝' },
          { value: 'gold', text: '金' },
          { value: 'legendary', text: '传奇' },
        ],
        this.rarityFilter,
        (value) => {
          this.rarityFilter = value as RarityFilter;
        },
      ),
      buildRow(
        '槽位',
        [{ value: 'all', text: '全部' }].concat(
          SLOT_DEFS.map((slot) => ({ value: slot.id, text: slot.name })),
        ),
        this.slotFilter,
        (value) => {
          this.slotFilter = value as SlotFilter;
        },
      ),
      buildRow(
        '排序',
        [
          { value: 'default', text: '默认' },
          { value: 'rarity', text: '稀有度' },
          { value: 'power', text: '战力' },
        ],
        this.sortMode,
        (value) => {
          this.sortMode = value as SortMode;
        },
      ),
    );
    return root;
  }

  /** 纯 UI 筛选；脏 defId 仅在「全部」条件下显示。 */
  private applyFilter(items: readonly EquipmentItem[]): EquipmentItem[] {
    const out: EquipmentItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const def = this.config.equipment.tryGet(item.defId);
      if (def === undefined) {
        if (this.categoryFilter === 'all' && this.rarityFilter === 'all' && this.slotFilter === 'all') {
          out.push(item);
        }
        continue;
      }
      const slot = SLOT_DEFS.find((s) => s.id === def.slot);
      const category = slot !== undefined ? slot.category : null;
      if (this.categoryFilter !== 'all' && category !== this.categoryFilter) continue;
      if (this.rarityFilter !== 'all' && def.rarity !== this.rarityFilter) continue;
      if (this.slotFilter !== 'all' && def.slot !== this.slotFilter) continue;
      out.push(item);
    }
    return out;
  }

  /** 稳定排序：默认顺序 / 稀有度降序 / 战力（statsOf 求和）降序。 */
  private applySort(items: EquipmentItem[]): void {
    if (this.sortMode === 'default') return;
    items.sort((a, b) => {
      let delta = 0;
      if (this.sortMode === 'rarity') {
        const da = this.config.equipment.tryGet(a.defId);
        const db = this.config.equipment.tryGet(b.defId);
        const ra = da !== undefined ? RARITY_ORDER[da.rarity] : -1;
        const rb = db !== undefined ? RARITY_ORDER[db.rarity] : -1;
        delta = rb - ra; // 降序
      } else {
        const power = (item: EquipmentItem): number => {
          let sum = 0;
          this.statsOf(item).forEach((value) => {
            sum += value;
          });
          return sum;
        };
        delta = power(b) - power(a); // 降序
      }
      return delta;
    });
  }

  private renderInventory(): void {
    const list = this.inventoryListRoot;
    if (list === null || this.save === null) return;
    // renderInventory 也会被筛选/排序 chip 直接调用：必须先清空，避免条目累积。
    list.replaceChildren();

    const all = this.save.meta.warehouse.items;
    const filtered = this.applyFilter(all);
    this.applySort(filtered);
    this.visibleItems = filtered.slice();
    if (this.countLabel !== null) this.countLabel.textContent = `${filtered.length} / ${all.length} 件`;

    if (this.save.meta.warehouse.capacity > 0 && all.length >= this.save.meta.warehouse.capacity) {
      list.append(
        span(
          `仓库已满（${all.length}/${this.save.meta.warehouse.capacity}），请拆解或替换`,
          'inventory__capacity error-bar',
        ),
      );
    }

    if (all.length === 0) {
      list.append(this.buildEmptyState('暂无装备：战斗掉落会在结算后入库'));
      return;
    }
    if (filtered.length === 0) {
      const empty = this.buildEmptyState('无匹配装备');
      const clear = button('清除筛选', 'inventory__clear');
      clear.addEventListener('click', () => {
        this.categoryFilter = 'all';
        this.rarityFilter = 'all';
        this.slotFilter = 'all';
        this.render();
      });
      empty.append(clear);
      list.append(empty);
      return;
    }

    if (all.length >= 100) {
      // 大仓库先显示骨架，再在下一个宏任务平滑替换（不阻塞主线程 >100ms，US-10-1）。
      const token = ++this.renderToken;
      const skeleton = document.createElement('div');
      skeleton.className = 'is-loading';
      for (let i = 0; i < 5; i++) skeleton.append(span('', 'skeleton inventory__skeleton'));
      list.append(skeleton);
      setTimeout(() => {
        if (token === this.renderToken && this.save !== null) {
          skeleton.replaceWith(this.buildRows(list, filtered));
        }
      }, 0);
      return;
    }

    this.renderToken++;
    list.append(this.buildRows(list, filtered));
  }

  /** 构造条目容器（拖拽根需要稳定的父节点）。 */
  private buildRows(list: HTMLElement, items: readonly EquipmentItem[]): HTMLDivElement {
    const rows = document.createElement('div');
    rows.className = 'inventory__rows';
    this.fillRows(rows, items, list);
    return rows;
  }

  /** 填充仓库条目；四段式：图标 + 名称/稀有度 + 槽位/状态 + 词缀数。 */
  private fillRows(container: HTMLDivElement, items: readonly EquipmentItem[], list: HTMLElement): void {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const def = this.config.equipment.tryGet(item.defId);
      const slotId = def !== undefined ? def.slot : '';
      const rarity = def !== undefined ? def.rarity : 'common';
      const slotName = def !== undefined
        ? SLOT_DEFS.find((s) => s.id === def.slot)?.name ?? def.slot
        : '未知部位';
      const displayName = def !== undefined
        ? this.describeItem(item)
        : `未知装备（${item.defId}）`;
      const equipped = this.isUidEquipped(item.uid);

      const row = button('', `inventory-item rarity-${rarity}`);
      row.dataset.uid = item.uid;
      row.dataset.dragUid = item.uid;
      if (slotId.length > 0) row.dataset.slot = slotId;
      row.setAttribute('aria-label', `${displayName}，${slotName}${equipped ? '，已装备' : ''}`);

      const iconUrl = def !== undefined
        ? this.icons.dataUrlFor(slotId, def.rarity)
        : this.icons.placeholderDataUrlFor(slotId);
      row.append(image(iconUrl, 'inventory-item__icon'));

      const text = document.createElement('span');
      text.className = 'inventory-item__text';
      text.append(span(displayName, 'inventory-item__name'));
      text.append(span(`${slotName} · ${findRarity(rarity).name}`, 'inventory-item__sub'));
      row.append(text);

      const status = document.createElement('span');
      status.className = 'inventory-item__status';
      if (equipped) status.append(span('已装备', 'badge badge--accent'));
      status.append(span(`词缀 ${item.affixes.length}`, 'inventory-item__affixes'));
      row.append(status);

      if (item.uid === this.selectedUid) {
        row.classList.add('is-selected');
        row.setAttribute('aria-selected', 'true');
      } else {
        row.setAttribute('aria-selected', 'false');
      }
      if (equipped) {
        row.disabled = true;
        row.classList.add('is-disabled');
        row.setAttribute('aria-disabled', 'true');
      }

      const targetSlot: EquipmentSlotId = slotId.length > 0 ? slotId : 'head';
      row.addEventListener('click', () => {
        this.selectedUid = item.uid;
        this.selectedSlotId = def !== undefined ? def.slot : null;
        this.renderDetail(this.selectedSlotId);
        // 重新标记选中态（不整页重绘，避免打断 hover / 拖拽）。
        const selected = list.querySelector<HTMLElement>(`.inventory-item.is-selected`);
        if (selected !== null) {
          selected.classList.remove('is-selected');
          selected.setAttribute('aria-selected', 'false');
        }
        row.classList.add('is-selected');
        row.setAttribute('aria-selected', 'true');
        if (prefersDrawer() && def !== undefined) {
          this.showPreview(item, targetSlot, row);
        }
      });

      row.addEventListener('dblclick', () => {
        if (def !== undefined && !equipped) this.equip(item, def.slot);
      });

      row.addEventListener('pointerenter', (event) => {
        if (prefersDrawer(event.pointerType)) return;
        this.showPreview(item, targetSlot, row, event.pointerType);
      });
      row.addEventListener('pointerleave', () => {
        if (this.preview.mode === 'hover') this.preview.hide();
      });

      container.append(row);
    }
  }

  private buildEmptyState(message: string): HTMLDivElement {
    const empty = document.createElement('div');
    empty.className = 'empty-state is-empty';
    empty.append(span('◈', 'empty-state__icon'), span(message, 'empty-state__text'));
    return empty;
  }

  // ---------------------------------------------------------------------------
  // 详情六区块 + 套装面板 + 差值
  // ---------------------------------------------------------------------------

  private renderDetail(slotId: string | null): void {
    this.detailRoot.replaceChildren();
    if (slotId === null) {
      this.detailRoot.append(this.buildEmptyState('选择一件装备查看详情与试算'));
      return;
    }

    const slotDef = SLOT_DEFS.find((s) => s.id === slotId);
    const slotName = slotDef !== undefined ? slotDef.name : slotId;
    const candidate = this.itemByUid(this.selectedUid);
    const current = this.itemByUid(this.equippedUid(slotId));
    const focusItem = candidate !== null ? candidate : current;
    if (focusItem === null) {
      this.detailRoot.append(this.buildEmptyState(`${slotName}：空槽位`));
      return;
    }

    const def = this.config.equipment.tryGet(focusItem.defId);
    const rarity = def !== undefined ? def.rarity : 'common';
    const iconUrl = def !== undefined
      ? this.icons.dataUrlFor(slotId, rarity)
      : this.icons.placeholderDataUrlFor(slotId);

    // —— 区块 1：标题区 ——
    const title = document.createElement('div');
    title.className = 'equip-detail__title';
    title.append(image(iconUrl, 'equip-detail__icon'));
    const titleText = document.createElement('div');
    titleText.className = 'equip-detail__title-text';
    titleText.append(span(def === undefined ? `未知装备（${focusItem.defId}）` : this.describeItem(focusItem), 'equip-detail__name'));
    const titleMeta = document.createElement('div');
    titleMeta.className = 'equip-detail__meta';
    titleMeta.append(
      span(findRarity(rarity).name, `badge rarity-${rarity}`),
      span(slotName, 'equip-detail__slot'),
    );
    if (focusItem === current && current !== null) titleMeta.append(span('已装备', 'badge badge--accent'));
    titleText.append(titleMeta);
    title.append(titleText);
    this.detailRoot.append(title);

    // —— 区块 2：词缀 ——
    const affixLines: HTMLElement[] = [];
    if (def !== undefined) {
      const coefficient = findRarity(def.rarity).coefficient;
      const count = Math.min(focusItem.affixes.length, def.affixes.length);
      for (let i = 0; i < count; i++) {
        const affix = AFFIX_POOL[focusItem.affixes[i]];
        if (affix === undefined) continue;
        affixLines.push(span(this.formatStat(affix.stat, ((affix.min + affix.max) / 2) * coefficient), 'equip-detail__line'));
      }
    }
    if (affixLines.length > 0) this.detailRoot.append(this.buildBlock('词缀', affixLines));

    // —— 区块 3：宝石 ——
    const gemLines: HTMLElement[] = [span(`已镶 ${focusItem.gems.length}/${focusItem.sockets}`, 'equip-detail__line')];
    for (let i = 0; i < focusItem.gems.length; i++) {
      const gem = this.config.gems.tryGet(focusItem.gems[i]);
      gemLines.push(span(gem === undefined
        ? `未知宝石（${focusItem.gems[i]}）`
        : this.formatStat(gem.stat, gem.value), 'equip-detail__line'));
    }
    this.detailRoot.append(this.buildBlock('宝石', gemLines));

    // —— 区块 4：传奇特效 ——
    if (focusItem.legendaryEffectId !== undefined) {
      let effectText = `未知特效（${focusItem.legendaryEffectId}）`;
      for (let i = 0; i < LEGENDARY_EFFECT_DEFS.length; i++) {
        if (LEGENDARY_EFFECT_DEFS[i].id === focusItem.legendaryEffectId) {
          effectText = `${LEGENDARY_EFFECT_DEFS[i].name}：${LEGENDARY_EFFECT_DEFS[i].description}`;
          break;
        }
      }
      this.detailRoot.append(this.buildBlock('传奇特效', [span(effectText, 'equip-detail__line')]));
    }

    // —— 区块 5：套装进度 ——
    this.renderSetPanel(this.detailRoot);

    // —— 区块 6：差值对比 ——
    const deltas = this.computeDeltas(focusItem, slotId);
    this.detailRoot.append(this.buildBlock('属性差值（对比当前装备）', this.buildDeltaRows(deltas)));

    // —— 操作区 ——
    const actions = document.createElement('div');
    actions.className = 'equip-detail__actions';
    const validSlot = slotDef !== undefined;
    const alreadyEquipped = candidate !== null && candidate === current;
    const equipButton = button(
      !validSlot ? '无效槽位' : alreadyEquipped ? '已装备' : '装备到该槽',
      'equip-detail__action',
    );
    const equipDisabled = !validSlot || candidate === null || alreadyEquipped;
    equipButton.disabled = equipDisabled;
    if (equipDisabled) {
      equipButton.classList.add('is-disabled');
      equipButton.setAttribute('aria-disabled', 'true');
    }
    if (!validSlot) equipButton.title = '无效槽位';
    else if (alreadyEquipped) equipButton.title = '已装备';
    if (candidate !== null && validSlot) {
      equipButton.addEventListener('click', () => this.equip(candidate, slotId));
    }
    actions.append(equipButton);

    const unequipButton = button('卸下', 'equip-detail__action');
    unequipButton.disabled = current === null;
    if (current === null) {
      unequipButton.classList.add('is-disabled');
      unequipButton.setAttribute('aria-disabled', 'true');
      unequipButton.title = '该槽位为空';
    } else {
      unequipButton.addEventListener('click', () => this.unequip(slotId));
    }
    actions.append(unequipButton);
    this.detailRoot.append(actions);
  }

  /** 通用区块容器。 */
  private buildBlock(title: string, lines: readonly HTMLElement[]): HTMLDivElement {
    const block = document.createElement('div');
    block.className = 'equip-detail__block';
    block.append(span(title, 'equip-detail__block-title'));
    const body = document.createElement('div');
    body.className = 'equip-detail__block-body';
    for (let i = 0; i < lines.length; i++) body.append(lines[i]);
    block.append(body);
    return block;
  }

  /** 套装进度：x/2 与 x/4，已激活效果即时刷新（US-04-3/4）。 */
  private renderSetPanel(parent: HTMLElement): void {
    const panel = document.createElement('div');
    panel.className = 'equip-detail__block set-panel';
    panel.append(span('套装', 'equip-detail__block-title'));

    let rendered = 0;
    for (let i = 0; i < SET_DEFS.length; i++) {
      const set = SET_DEFS[i];
      const count = this.setPieceCount(set.id);
      if (count === 0 && i > 0) continue; // 只展示已装备套装 + 第一套作为引导。

      const row = document.createElement('div');
      row.className = 'set-panel__row';
      row.append(span(set.name, 'set-panel__name'));
      row.append(span(`${count}/${set.slots.length}`, 'set-panel__count'));

      const bar = document.createElement('div');
      bar.className = 'set-panel__bar';
      const fill = document.createElement('div');
      fill.className = 'set-panel__bar-fill';
      fill.style.width = `${Math.min(100, (count / set.slots.length) * 100)}%`;
      bar.append(fill);
      row.append(bar);

      const effects: string[] = [];
      if (count >= 2) {
        for (let m = 0; m < set.twoPiece.length; m++) {
          effects.push(`2 件：${this.formatStat(set.twoPiece[m].stat, set.twoPiece[m].value)}`);
        }
      }
      if (count >= 4) {
        for (let m = 0; m < set.fourPiece.length; m++) {
          effects.push(`4 件：${this.formatStat(set.fourPiece[m].stat, set.fourPiece[m].value)}`);
        }
      }
      if (effects.length > 0) {
        row.append(span(effects.join(' · '), 'set-panel__effect'));
      } else {
        row.append(span(`未激活：还需 ${Math.max(0, 2 - count)} 件激活 2 件效果`, 'set-panel__hint'));
      }
      panel.append(row);
      rendered++;
      if (rendered >= SET_DEFS.length) break;
    }
    parent.append(panel);
  }

  /** 计算已装备的某套装件数（按槽位去重）。 */
  private setPieceCount(setId: string): number {
    let count = 0;
    for (let i = 0; i < SET_DEFS.length; i++) {
      const set = SET_DEFS[i];
      if (set.id !== setId) continue;
      for (let j = 0; j < set.slots.length; j++) {
        const item = this.itemByUid(this.equippedUid(set.slots[j]));
        if (item === null) continue;
        const def = this.config.equipment.tryGet(item.defId);
        if (def !== undefined && def.setId === setId) count++;
      }
      break;
    }
    return count;
  }

  /** 与当前槽位装备的差值；0 必须显示（US-07-2），空槽基线全正向（US-07-3）。 */
  private computeDeltas(item: EquipmentItem, slotId: string): StatDelta[] {
    const current = this.itemByUid(this.equippedUid(slotId));
    const before = this.statsOf(current);
    const after = this.statsOf(item);

    const statIds: string[] = [];
    before.forEach((_value, key) => statIds.push(key));
    after.forEach((_value, key) => {
      if (statIds.indexOf(key) < 0) statIds.push(key);
    });
    statIds.sort();

    const out: StatDelta[] = [];
    for (let i = 0; i < statIds.length; i++) {
      const key = statIds[i];
      const delta = (after.get(key) ?? 0) - (before.get(key) ?? 0);
      out.push({
        statId: key,
        name: findStat(key)?.name ?? key,
        delta,
        tone: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      });
    }
    return out;
  }

  /** 差值行：tone 三色，delta===0 保留显示。 */
  private buildDeltaRows(deltas: readonly StatDelta[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let i = 0; i < deltas.length; i++) {
      const d = deltas[i];
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.dataset.tone = d.tone;
      if (d.delta === 0) row.dataset.value = 'zero';
      const sign = d.delta > 0 ? '+' : '';
      row.textContent = `${d.name}: ${sign}${this.formatDelta(d.statId, d.delta)}`;
      out.push(row);
    }
    if (out.length === 0) out.push(span('无属性变化', 'equip-detail__line'));
    return out;
  }

  // ---------------------------------------------------------------------------
  // 预览 / 拖拽 / 键盘
  // ---------------------------------------------------------------------------

  /** 统一预览入口：模式判定（matchMedia / pointerType）在 prefersDrawer 内完成。 */
  private showPreview(item: EquipmentItem, slotId: EquipmentSlotId, trigger: HTMLElement, pointerType?: string): void {
    const mode = prefersDrawer(pointerType) ? 'drawer' : 'hover';
    this.preview.show({
      item,
      slotId,
      trigger,
      mode,
      pointer: mode === 'hover' ? this.lastPointer ?? undefined : undefined,
      deltas: this.computeDeltas(item, slotId),
      occupiedIn: this.occupiedLabelFor(item.uid, slotId),
    });
  }

  private occupiedLabelFor(uid: string, targetSlot: EquipmentSlotId): string | undefined {
    if (this.save === null) return undefined;
    const loadout = this.save.meta.loadouts[this.generalId];
    if (loadout === undefined) return undefined;
    const slots = Object.keys(loadout);
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === targetSlot) continue;
      if (loadout[slots[i]] !== uid) continue;
      const name = SLOT_DEFS.find((s) => s.id === slots[i])?.name ?? slots[i];
      return `已装备在：${name}`;
    }
    return undefined;
  }

  private isUidEquipped(uid: string): boolean {
    if (this.save === null) return false;
    const loadout = this.save.meta.loadouts[this.generalId];
    if (loadout === undefined) return false;
    const slots = Object.keys(loadout);
    for (let i = 0; i < slots.length; i++) {
      if (loadout[slots[i]] === uid) return true;
    }
    return false;
  }

  /** 拖拽源仅取当前筛选结果；已装备条目由 UI 禁用，不进入拖拽。 */
  private dragSources(): readonly DragSourceVM[] {
    const out: DragSourceVM[] = [];
    for (let i = 0; i < this.visibleItems.length; i++) {
      const item = this.visibleItems[i];
      if (this.isUidEquipped(item.uid)) continue;
      const def = this.config.equipment.tryGet(item.defId);
      if (def === undefined) continue;
      out.push({
        uid: item.uid,
        slotId: def.slot,
        label: this.describeItem(item),
        iconUrl: this.icons.dataUrlFor(def.slot, def.rarity),
      });
    }
    return out;
  }

  private isCompatible(uid: string, target: EquipmentSlotId): boolean {
    const item = this.itemByUid(uid);
    if (item === null) return false;
    const def = this.config.equipment.tryGet(item.defId);
    return def !== undefined && def.slot === target && EQUIPMENT_SLOT_IDS.indexOf(target) >= 0;
  }

  /** 拖拽态 → 纸娃娃高亮：兼容槽高亮、不兼容槽变暗、落点槽 hover。 */
  private applyDragState(state: { dragging: boolean; uid: string | null; over: EquipmentSlotId | null }): void {
    for (let i = 0; i < EQUIPMENT_SLOT_IDS.length; i++) {
      const slotId = EQUIPMENT_SLOT_IDS[i];
      let dropState: 'idle' | 'compatible' | 'incompatible' | 'hover' = 'idle';
      if (state.dragging) {
        const compatible = state.uid !== null && this.isCompatible(state.uid, slotId);
        dropState = compatible ? 'compatible' : 'incompatible';
        if (state.over === slotId && compatible) dropState = 'hover';
      }
      this.paperDoll.setDropState(slotId, dropState);
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.lastPointer = { x: event.clientX, y: event.clientY };
  };

  /** Esc 多层关闭：主题浮层 → 预览浮层/抽屉 → 配装界面（US-08-4）。 */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.visible) return;
    if (this.themePicker !== null && this.themePicker.visible) {
      this.themePicker.close();
      event.stopPropagation();
      return;
    }
    if (this.preview.visible) {
      this.preview.hide();
      event.stopPropagation();
      return;
    }
    this.close();
  };

  unmount(): void {
    this.close();
    document.removeEventListener('keydown', this.onKeyDown);
    this.overlay.removeEventListener('pointermove', this.onPointerMove);
    this.drag.detach();
    this.preview.destroy();
    if (this.themeToggle !== null) {
      this.themeToggle.remove();
      this.themeToggle = null;
    }
    this.themePicker = null;
    this.paperDoll.destroy();
    this.overlay.remove();
  }
}
