/**
 * 13 槽配装 UI（DESIGN §8.4 / ARCHITECTURE §5.7）。
 *
 * 分类折叠 + 纸娃娃 + 属性详情 + 装备比较试算；全部为 DOM，不进入 ECS。
 * 试算只读配置与存档，不修改任何游戏性数值。
 */
import type { GameConfig } from '../data/types';
import { AFFIX_POOL, findStat } from '../data/stats';
import { findRarity, LEGENDARY_EFFECT_DEFS, RARITY_DEFS, SLOT_DEFS } from '../data/equipment';
import type { EquipmentItem, SaveData } from '../game/SaveData';

function button(text: string, className: string = ''): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = text;
  return node;
}

function span(text: string, className: string = ''): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

export class EquipmentUI {
  private readonly overlay: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly foldButtons: HTMLButtonElement[] = [];
  private readonly categoryFolded = new Map<string, boolean>();
  private save: SaveData | null = null;
  private generalId = 'liubei';
  private selectedUid: string | null = null;
  private statArea: HTMLDivElement | null = null;

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
    this.overlay.append(this.panel);
    this.host.append(this.overlay);

    const categories = ['armor', 'jewelry', 'weapon'];
    for (let i = 0; i < categories.length; i++) {
      this.categoryFolded.set(categories[i], false);
    }
  }

  get visible(): boolean {
    return !this.overlay.hidden;
  }

  open(save: SaveData, generalId: string): void {
    this.save = save;
    this.generalId = generalId;
    this.overlay.hidden = false;
    this.render();
  }

  close(): void {
    this.overlay.hidden = true;
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

  private render(): void {
    if (this.save === null) return;
    this.panel.replaceChildren();
    this.foldButtons.length = 0;

    const header = document.createElement('header');
    header.className = 'panel__header';
    header.append(span(`配装 · ${this.generalId}`, 'panel__title'));
    const close = button('关闭');
    close.addEventListener('click', () => this.close());
    header.append(close);
    this.panel.append(header);

    const columns = document.createElement('div');
    columns.className = 'equip-columns';

    // 左：纸娃娃 / 13 槽网格
    const doll = document.createElement('div');
    doll.className = 'paper-doll';
    doll.append(span('纸娃娃', 'section-title'));
    const slots = document.createElement('div');
    slots.className = 'slot-grid';
    for (let i = 0; i < SLOT_DEFS.length; i++) {
      const slot = SLOT_DEFS[i];
      const uid = this.equippedUid(slot.id);
      const item = this.itemByUid(uid);
      const slotButton = button(item === null ? slot.name : `${slot.name}✓`, 'slot');
      slotButton.dataset.slot = slot.id;
      slotButton.title = item === null ? `${slot.name}（空）` : this.describeItem(item);
      slotButton.addEventListener('click', () => {
        this.selectedUid = uid;
        this.renderDetail(slot.id);
      });
      slots.append(slotButton);
    }
    doll.append(slots);

    // 右：仓库 + 分类折叠
    const inventory = document.createElement('div');
    inventory.className = 'inventory';
    inventory.append(span('仓库', 'section-title'));
    for (let c = 0; c < 3; c++) {
      const category = c === 0 ? 'armor' : c === 1 ? 'jewelry' : 'weapon';
      const name = c === 0 ? '防具' : c === 1 ? '首饰' : '武器';
      const fold = button(`${this.categoryFolded.get(category) ? '▸' : '▾'} ${name}`, 'fold-button');
      this.foldButtons.push(fold);
      const list = document.createElement('div');
      list.className = 'inventory-list';
      const items = this.save.meta.warehouse.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const def = this.config.equipment.tryGet(item.defId);
        if (def === undefined || def.slot === undefined) continue;
        const slotDef = SLOT_DEFS.find((s) => s.id === def.slot);
        if (slotDef === undefined || slotDef.category !== category) continue;
        const row = button(this.describeItem(item), `inventory-item rarity-${def.rarity}`);
        if (item.uid === this.selectedUid) row.classList.add('is-selected');
        row.addEventListener('click', () => {
          this.selectedUid = item.uid;
          this.renderDetail(def.slot);
        });
        list.append(row);
      }
      fold.addEventListener('click', () => {
        const next = !this.categoryFolded.get(category);
        this.categoryFolded.set(category, next);
        this.render();
      });
      list.style.display = this.categoryFolded.get(category) ? 'none' : '';
      inventory.append(fold, list);
    }
    columns.append(doll, inventory);
    this.panel.append(columns);

    const detail = document.createElement('div');
    detail.className = 'item-detail';
    this.statArea = detail;
    this.panel.append(detail);
    this.renderDetail(this.selectedSlotOfSelectedItem());
  }

  private selectedSlotOfSelectedItem(): string | null {
    if (this.save === null || this.selectedUid === null) return null;
    const def = this.itemByUid(this.selectedUid);
    if (def === null) return null;
    const itemDef = this.config.equipment.tryGet(def.defId);
    return itemDef !== undefined ? itemDef.slot : null;
  }

  private describeItem(item: EquipmentItem): string {
    const def = this.config.equipment.tryGet(item.defId);
    const rarity = def === undefined ? RARITY_DEFS[0] : findRarity(def.rarity);
    const name = def === undefined ? item.defId : def.id;
    const sockets = item.gems.length > 0 ? ` [${item.gems.length}/${item.sockets}]` : '';
    return `${rarity.name}·${name}${sockets}`;
  }

  private renderDetail(slotId: string | null): void {
    if (this.statArea === null) return;
    this.statArea.replaceChildren();
    if (slotId === null) {
      this.statArea.append(span('选择一件装备查看详情与试算', 'hint'));
      return;
    }
    const candidate = this.itemByUid(this.selectedUid);
    const current = this.itemByUid(this.equippedUid(slotId));
    if (candidate === null && current === null) {
      this.statArea.append(span(`${slotId}：空槽位`, 'hint'));
      return;
    }

    const slotName = SLOT_DEFS.find((s) => s.id === slotId)?.name ?? slotId;
    this.statArea.append(span(`${slotName} · ${candidate !== null ? this.describeItem(candidate) : '未选择'}`, 'detail-title'));

    const before = this.statsOf(current);
    const after = this.statsOf(candidate);
    const statIds: string[] = [];
    before.forEach((_value, key) => statIds.push(key));
    after.forEach((_value, key) => {
      if (statIds.indexOf(key) < 0) statIds.push(key);
    });
    statIds.sort();

    for (let i = 0; i < statIds.length; i++) {
      const key = statIds[i];
      const delta = (after.get(key) ?? 0) - (before.get(key) ?? 0);
      const sign = delta > 0 ? '+' : '';
      const row = span(`${this.formatStat(key, delta)}`, `stat-row ${delta >= 0 ? 'up' : 'down'}`);
      row.textContent = `${findStat(key)?.name ?? key}: ${sign}${this.formatDelta(key, delta)}`;
      this.statArea.append(row);
    }

    if (candidate !== null) {
      const equip = button(candidate === current ? '已装备' : '装备到该槽');
      equip.disabled = candidate === current;
      equip.addEventListener('click', () => this.equip(candidate, slotId));
      this.statArea.append(equip);
    }
    if (current !== null) {
      const unequip = button('卸下');
      unequip.addEventListener('click', () => this.unequip(slotId));
      this.statArea.append(unequip);
    }
  }

  private formatDelta(statId: string, value: number): string {
    const def = findStat(statId);
    const percent = def !== undefined && def.isPercent;
    return `${percent ? (value * 100).toFixed(1) : value.toFixed(1)}${percent ? '%' : ''}`;
  }

  unmount(): void {
    this.close();
    this.overlay.remove();
  }
}
