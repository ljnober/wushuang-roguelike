/**
 * 局外养成面板（DESIGN §8.6 / §8.7 / §8.1）。
 *
 * 卡奈魔盒三功能（提取/重铸/升级）、传说宝石升级（成功率+保底）、本地 Top10 排行。
 * 结果随机性来自确定性 Rng（种子由物品 uid 与本地操作序号派生），无 Math.random。
 *
 * T03/S5 变更（仅表现层）：为可滚列表、空态容器与行组补充语义/状态类作为令牌化 CSS 钩子。
 * 所有业务方法（pay/rngFor/extract/reroll/upgradeGem 等）与 FC-3 选择器零改动。
 */
import { hash32, Rng } from '../core/Rng';
import type { GameConfig } from '../data/types';
import {
  CUBE_RECIPE_DEFS,
  CUBE_SLOTS,
  LEGENDARY_EFFECT_DEFS,
  MATERIAL_DEFS,
  SLOT_DEFS,
  findRarity,
  legendaryGemCost,
  legendaryGemRate,
} from '../data/equipment';
import { AFFIX_POOL } from '../data/stats';
import type { EquipmentItem, SaveData } from '../game/SaveData';

export type MetaTab = 'cube' | 'gems' | 'leaderboard';

function btn(text: string, className: string = ''): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = text;
  return node;
}

function txt(text: string, className: string = ''): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

export class MetaUI {
  private readonly overlay: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly tabs: HTMLButtonElement[] = [];
  private save: SaveData | null = null;
  private tab: MetaTab = 'cube';
  private selectedUid: string | null = null;
  private opCounter = 0;
  private leaderboardMode = 'campaign_8min';

  onChange: ((save: SaveData) => void) | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly config: GameConfig,
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay ws-meta';
    this.overlay.hidden = true;
    this.panel = document.createElement('div');
    this.panel.className = 'panel panel--wide';
    this.overlay.append(this.panel);
    this.host.append(this.overlay);
  }

  get visible(): boolean {
    return !this.overlay.hidden;
  }

  open(save: SaveData, tab: MetaTab = 'cube'): void {
    this.save = save;
    this.tab = tab;
    this.overlay.hidden = false;
    this.render();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private rngFor(key: string): Rng {
    this.opCounter++;
    return new Rng(hash32(key.length, this.opCounter, key.charCodeAt(0) | 0));
  }

  private material(name: string): number {
    if (this.save === null) return 0;
    return this.save.meta.materials[name] ?? 0;
  }

  private pay(cost: Record<string, number>): boolean {
    if (this.save === null) return false;
    const names = Object.keys(cost);
    for (let i = 0; i < names.length; i++) {
      if (this.material(names[i]) < cost[names[i]]) return false;
    }
    for (let i = 0; i < names.length; i++) {
      this.save.meta.materials[names[i]] = this.material(names[i]) - cost[names[i]];
    }
    return true;
  }

  private recipe(functionId: 'extract' | 'reroll' | 'upgrade') {
    for (let i = 0; i < CUBE_RECIPE_DEFS.length; i++) {
      if (CUBE_RECIPE_DEFS[i].function === functionId) return CUBE_RECIPE_DEFS[i];
    }
    return undefined;
  }

  private selectedItem(): EquipmentItem | null {
    if (this.save === null || this.selectedUid === null) return null;
    const items = this.save.meta.warehouse.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].uid === this.selectedUid) return items[i];
    }
    return null;
  }

  /** 提取传奇特效：消耗传奇装备 + 材料，特效永久入账号。 */
  extract(): void {
    if (this.save === null) return;
    const item = this.selectedItem();
    if (item === null || item.legendaryEffectId === undefined) return;
    const recipe = this.recipe('extract');
    if (recipe === undefined || !this.pay(recipe.cost)) return;
    const extracted = this.save.meta.cube.extracted;
    if (extracted.indexOf(item.legendaryEffectId) < 0) extracted.push(item.legendaryEffectId);
    this.removeItem(item.uid);
    this.commit();
  }

  /** 重铸词缀：可锁定第一条（额外消耗 essence）。 */
  reroll(lockFirst: boolean): void {
    if (this.save === null) return;
    const item = this.selectedItem();
    if (item === null) return;
    const recipe = this.recipe('reroll');
    if (recipe === undefined) return;
    const cost: Record<string, number> = { ...recipe.cost };
    if (lockFirst) cost.essence = (cost.essence ?? 0) + 20;
    if (!this.pay(cost)) return;
    const rng = this.rngFor(`reroll:${item.uid}`);
    const count = Math.max(1, item.affixes.length);
    for (let i = lockFirst ? 1 : 0; i < count; i++) {
      item.affixes[i] = rng.int(AFFIX_POOL.length);
    }
    this.commit();
  }

  /** 稀有升传奇：金色装备 + 材料 → 同槽位的传奇装备与新特效。 */
  upgradeToLegendary(): void {
    if (this.save === null) return;
    const item = this.selectedItem();
    if (item === null) return;
    const def = this.config.equipment.tryGet(item.defId);
    if (def === undefined || def.rarity !== 'gold') return;
    const recipe = this.recipe('upgrade');
    if (recipe === undefined || !this.pay(recipe.cost)) return;
    const candidates = this.config.equipment
      .all()
      .filter((entry) => entry.slot === def.slot && entry.rarity === 'legendary');
    if (candidates.length === 0) return;
    const rng = this.rngFor(`upgrade:${item.uid}`);
    const next = candidates[rng.int(candidates.length)];
    item.defId = next.id;
    item.legendaryEffectId = next.legendaryEffectId;
    item.affixes.length = Math.min(item.affixes.length, next.affixes.length);
    this.commit();
  }

  /** 传说宝石升级：rate=max(rateMin,rateBase-level*ratePerLevel)，失败累计保底。 */
  upgradeGem(uid: string): void {
    if (this.save === null) return;
    const gem = this.save.meta.legendaryGems.inventory.find((g) => g.uid === uid);
    if (gem === undefined) return;
    const def = this.config.legendaryGems.tryGet(gem.defId);
    if (def === undefined) return;
    const cost = legendaryGemCost(gem.level, def);
    if (!this.pay({ [def.materialId]: cost })) return;
    const rate = legendaryGemRate(gem.level, gem.pity, def);
    const rng = this.rngFor(`gem:${uid}:${gem.level}:${gem.pity}`);
    if (rng.next() < rate) {
      gem.level++;
      gem.pity = 0;
    } else {
      gem.pity += Math.ceil(def.pityBonus * 100);
    }
    this.commit();
  }

  private removeItem(uid: string): void {
    if (this.save === null) return;
    const items = this.save.meta.warehouse.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].uid === uid) {
        items.splice(i, 1);
        break;
      }
    }
    const loadouts = this.save.meta.loadouts;
    const generals = Object.keys(loadouts);
    for (let g = 0; g < generals.length; g++) {
      const slots = Object.keys(loadouts[generals[g]]);
      for (let s = 0; s < slots.length; s++) {
        if (loadouts[generals[g]][slots[s]] === uid) loadouts[generals[g]][slots[s]] = null;
      }
    }
    this.selectedUid = null;
  }

  private commit(): void {
    if (this.save !== null && this.onChange !== null) this.onChange(this.save);
    this.render();
  }

  /** 结算页调用：把一局成绩写入对应模式 Top10。 */
  static recordScore(save: SaveData, mode: string, generalId: string, score: number, at: number): void {
    const list = save.meta.leaderboards[mode] ?? (save.meta.leaderboards[mode] = []);
    list.push({ score: Math.max(0, Math.round(score)), mode, generalId, at });
    list.sort((a, b) => b.score - a.score || a.at - b.at);
    if (list.length > 10) list.length = 10;
  }

  private render(): void {
    if (this.save === null) return;
    this.panel.replaceChildren();
    this.tabs.length = 0;

    const header = document.createElement('header');
    header.className = 'panel__header';
    header.append(txt('局外养成', 'panel__title'));
    const close = btn('关闭');
    close.addEventListener('click', () => this.close());
    header.append(close);
    this.panel.append(header);

    const nav = document.createElement('nav');
    nav.className = 'tab-bar';
    const tabDefs: Array<[MetaTab, string]> = [
      ['cube', '卡奈魔盒'],
      ['gems', '传说宝石'],
      ['leaderboard', '排行榜'],
    ];
    for (let i = 0; i < tabDefs.length; i++) {
      const tab = btn(tabDefs[i][1], `tab ${this.tab === tabDefs[i][0] ? 'is-active' : ''}`);
      const target = tabDefs[i][0];
      tab.addEventListener('click', () => {
        this.tab = target;
        this.render();
      });
      this.tabs.push(tab);
      nav.append(tab);
    }
    this.panel.append(nav);

    const body = document.createElement('div');
    body.className = 'meta-body';
    if (this.tab === 'cube') this.renderCube(body);
    else if (this.tab === 'gems') this.renderGems(body);
    else this.renderLeaderboard(body);
    this.panel.append(body);
  }

  private renderCube(body: HTMLElement): void {
    if (this.save === null) return;
    const materials = document.createElement('div');
    materials.className = 'material-row';
    for (let i = 0; i < MATERIAL_DEFS.length; i++) {
      const def = MATERIAL_DEFS[i];
      materials.append(txt(`${def.name} ×${this.material(def.id)}`, 'chip'));
    }
    body.append(materials);

    const slots = document.createElement('div');
    slots.className = 'cube-slots';
    for (let i = 0; i < CUBE_SLOTS.length; i++) {
      const slot = CUBE_SLOTS[i];
      const effectId = this.save.meta.cube.slots[slot] ?? null;
      const effect = effectId === null ? null : LEGENDARY_EFFECT_DEFS.find((e) => e.id === effectId);
      const slotLabel = slot === 'weapon' ? '武器' : slot === 'armor' ? '护甲' : slot === 'jewelry' ? '首饰' : slot;
      const node = btn(`${slotLabel}：${effect !== undefined && effect !== null ? effect.name : '空'}`);
      if (effectId !== null && this.save.meta.cube.extracted.indexOf(effectId) >= 0) {
        node.addEventListener('click', () => {
          this.save!.meta.cube.slots[slot] = null;
          this.commit();
        });
      }
      slots.append(node);
    }
    body.append(slots);

    const list = document.createElement('div');
    list.className = 'meta-list meta-list--cube';
    const items = this.save.meta.warehouse.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const def = this.config.equipment.tryGet(item.defId);
      if (def === undefined) continue;
      const slotName = SLOT_DEFS.find((s) => s.id === def.slot)?.name ?? def.slot;
      const rarityName = findRarity(def.rarity).name;
      const effectName = item.legendaryEffectId === undefined
        ? ''
        : ` · ${LEGENDARY_EFFECT_DEFS.find((e) => e.id === item.legendaryEffectId)?.name ?? item.legendaryEffectId}`;
      const row = btn(`${rarityName}·${slotName}${effectName}`);
      if (item.uid === this.selectedUid) row.classList.add('is-selected');
      row.addEventListener('click', () => {
        this.selectedUid = item.uid;
        this.render();
      });
      list.append(row);
    }
    if (items.length === 0) {
      list.classList.add('is-empty');
      list.append(txt('暂无装备：战斗掉落会在结算后入库', 'hint'));
    }
    body.append(list);

    const actions = document.createElement('div');
    actions.className = 'action-row action-row--cube';
    const extract = btn('提取特效');
    extract.addEventListener('click', () => this.extract());
    const reroll = btn('重铸词缀');
    reroll.addEventListener('click', () => this.reroll(false));
    const rerollLock = btn('锁定首条重铸');
    rerollLock.addEventListener('click', () => this.reroll(true));
    const upgrade = btn('稀有升传奇');
    upgrade.addEventListener('click', () => this.upgradeToLegendary());
    actions.append(extract, reroll, rerollLock, upgrade);
    body.append(actions);

    const install = document.createElement('div');
    install.className = 'action-row action-row--install';
    for (let i = 0; i < LEGENDARY_EFFECT_DEFS.length; i++) {
      const effect = LEGENDARY_EFFECT_DEFS[i];
      if (this.save.meta.cube.extracted.indexOf(effect.id) < 0) continue;
      const node = btn(`装魔盒:${effect.name}`);
      node.addEventListener('click', () => {
        if (this.save === null) return;
        this.save.meta.cube.slots[effect.slotType === 'any' ? 'weapon' : effect.slotType] = effect.id;
        this.commit();
      });
      install.append(node);
    }
    body.append(install);
  }

  private renderGems(body: HTMLElement): void {
    if (this.save === null) return;
    const list = document.createElement('div');
    list.className = 'meta-list meta-list--gems';
    const gems = this.save.meta.legendaryGems.inventory;
    if (gems.length === 0) {
      list.classList.add('is-empty');
      list.append(txt('暂无传说宝石', 'hint'));
    }
    for (let i = 0; i < gems.length; i++) {
      const gem = gems[i];
      const def = this.config.legendaryGems.tryGet(gem.defId);
      const name = def !== undefined ? def.name : gem.defId;
      const rate = def !== undefined ? legendaryGemRate(gem.level, gem.pity, def) : 0;
      const row = document.createElement('div');
      row.className = 'gem-row';
      row.append(txt(`${name} Lv.${gem.level} · 成功率 ${(rate * 100).toFixed(0)}% · 保底 ${gem.pity}`));
      const up = btn('升级');
      up.addEventListener('click', () => this.upgradeGem(gem.uid));
      row.append(up);
      list.append(row);
    }
    body.append(list);
  }

  private renderLeaderboard(body: HTMLElement): void {
    if (this.save === null) return;
    const nav = document.createElement('div');
    nav.className = 'action-row action-row--modes';
    const modes = this.config.modes.all();
    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i];
      const node = btn(mode.name, `tab ${this.leaderboardMode === mode.id ? 'is-active' : ''}`);
      node.addEventListener('click', () => {
        this.leaderboardMode = mode.id;
        this.render();
      });
      nav.append(node);
    }
    body.append(nav);

    const list = document.createElement('ol');
    list.className = 'leaderboard';
    const entries = this.save.meta.leaderboards[this.leaderboardMode] ?? [];
    for (let i = 0; i < entries.length && i < 10; i++) {
      const entry = entries[i];
      const row = document.createElement('li');
      row.textContent = `${entry.score} · ${entry.generalId} · ${new Date(entry.at).toLocaleString()}`;
      list.append(row);
    }
    if (entries.length === 0) {
      body.classList.add('is-empty');
      body.append(txt('暂无记录', 'hint'));
    }
    body.append(list);
  }

  unmount(): void {
    this.close();
    this.overlay.remove();
  }
}
