/**
 * 局内角色状态面板（ARCH_RUN_STATUS.md §3.2）。
 *
 * 纯 DOM + BEM 的被动视图：只消费只读 RunStatusVM，不查询 ECS、不读墙钟、
 * 不做随机、不回写任何状态。四页内容在 open/update 时一次性全量渲染，
 * 页签仅切换 hidden，保证 E2E 的 [data-tab]/[data-slot]/[data-skill-slot] 始终可查。
 */
import type {
  EquipmentSlotVM,
  RunStatusVM,
  SkillVM,
  StatVM,
} from './types/RunStatusVM';

export type RunStatusTab = 'overview' | 'equipment' | 'skills' | 'stats';

export interface RunStatusPanelOptions {
  readonly host: HTMLElement;
  /** 关闭时回调（presentation 用于清键盘态/焦点归还）；可选。 */
  readonly onClose?: () => void;
}

const TABS: readonly RunStatusTab[] = ['overview', 'equipment', 'skills', 'stats'];

const TAB_LABELS: Readonly<Record<RunStatusTab, string>> = {
  overview: '总览',
  equipment: '装备',
  skills: '技能',
  stats: '数值',
};

/** 稀有度中文名（展示用，未收录 id 原样输出）。 */
const RARITY_LABELS: Readonly<Record<string, string>> = {
  common: '白',
  blue: '蓝',
  gold: '金',
  legendary: '传奇',
  ancient: '远古',
  primal: '太古',
};

/** 创建带类名的元素；text 为空时不写 textContent。 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text.length > 0) node.textContent = text;
  return node;
}

/**
 * 展示用数值格式化，与 runStatusVM.formatStatValue 同口径：
 * 百分比按 100 倍保留一位小数，普通值最多一位小数。
 */
function numberText(value: number, isPercent: boolean): string {
  const n = Number.isFinite(value) ? value : 0;
  if (isPercent) return `${Math.round(n * 1000) / 10}%`;
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1);
}

/** 一行「标签：值」。 */
function line(label: string, value: string): HTMLDivElement {
  const row = el('div', 'ws-status__line');
  row.append(el('span', 'ws-status__label', label), el('span', 'ws-status__value', value));
  return row;
}

export class RunStatusPanel {
  private readonly root: HTMLDivElement;
  private readonly pages: HTMLDivElement;
  private readonly tabButtons: HTMLButtonElement[] = [];
  private readonly pageNodes: HTMLDivElement[] = [];
  private currentTab: RunStatusTab = 'overview';
  private vm: RunStatusVM | null = null;
  private disposed = false;
  private readonly onClose?: () => void;

  constructor(options: RunStatusPanelOptions) {
    this.onClose = options.onClose;
    this.root = el('div', 'overlay ws-status');
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', '角色状态');

    const header = el('div', 'ws-status__header');
    header.append(el('h2', 'ws-status__title', '角色状态'));
    const tabs = el('div', 'ws-status__tabs');
    for (let i = 0; i < TABS.length; i++) {
      const tab = TABS[i];
      const button = el('button', 'ws-status__tab', TAB_LABELS[tab]);
      button.type = 'button';
      button.dataset.tab = tab;
      button.addEventListener('click', () => this.setTab(tab));
      this.tabButtons.push(button);
      tabs.append(button);
    }
    const closeButton = el('button', 'ws-status__close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '关闭角色状态');
    closeButton.addEventListener('click', () => this.close());
    header.append(tabs, closeButton);

    this.pages = el('div', 'ws-status__pages');
    for (let i = 0; i < TABS.length; i++) {
      const page = el('div', `ws-status__page ws-status__page--${TABS[i]}`);
      page.hidden = TABS[i] !== this.currentTab;
      this.pageNodes.push(page);
      this.pages.append(page);
    }
    // 复用既有 .panel 视觉基线（背景/边框/内边距/滚动），本类只负责结构与数据。
    const panel = el('div', 'panel ws-status__panel');
    panel.append(header, this.pages);
    this.root.append(panel);
    options.host.append(this.root);
    this.applyTabVisibility();
  }

  /** 当前是否显示（= overlay 未 hidden）。 */
  get visible(): boolean {
    return !this.disposed && !this.root.hasAttribute('hidden');
  }

  /** 当前激活页，默认 'overview'。 */
  get tab(): RunStatusTab {
    return this.currentTab;
  }

  /** 首次/重新打开：保留上次页签并渲染最新 vm。 */
  open(vm: RunStatusVM): void {
    if (this.disposed) return;
    this.vm = vm;
    this.render(vm);
    this.root.hidden = false;
    this.applyTabVisibility();
  }

  /** 面板可见时按新 vm 全量刷新内容；P0 允许整体重建子节点。 */
  update(vm: RunStatusVM): void {
    if (this.disposed || !this.visible) return;
    this.vm = vm;
    this.render(vm);
  }

  /** 切换页签；仅在已 open 后有效。 */
  setTab(tab: RunStatusTab): void {
    if (this.disposed || !this.visible || this.vm === null) return;
    this.currentTab = tab;
    this.applyTabVisibility();
  }

  /** 关闭面板并触发 onClose（若提供）。重复调用安全。 */
  close(): void {
    if (this.disposed || !this.visible) return;
    this.root.hidden = true;
    this.onClose?.();
  }

  /** 卸载 DOM 与事件监听；幂等。 */
  unmount(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vm = null;
    this.root.remove();
  }

  /** 四页全量渲染：隐藏页也有完整 DOM，保证数据属性可查询。 */
  private render(vm: RunStatusVM): void {
    this.renderOverview(vm, this.pageNodes[0]);
    this.renderEquipment(vm.equipment, this.pageNodes[1]);
    this.renderSkills(vm.skills, this.pageNodes[2]);
    this.renderStats(vm.stats, this.pageNodes[3]);
  }

  private renderOverview(vm: RunStatusVM, page: HTMLDivElement): void {
    page.replaceChildren();
    const o = vm.overview;
    page.append(
      line('武将', o.generalName),
      line('等级', `Lv.${Math.max(1, Math.floor(o.level))}`),
      line('经验', `${Math.floor(o.exp)} / ${Math.floor(o.expNext)}`),
      line('生命', `${Math.ceil(o.hp)} / ${Math.ceil(o.maxHp)}`),
      line('攻击力', numberText(o.atk, false)),
      line('护甲', numberText(o.armor, false)),
      line('暴击率', numberText(o.crit, true)),
      line('时长', `${Math.floor(o.elapsedSec)} 秒`),
      line('击杀', String(Math.floor(o.kills))),
      line('积分', String(Math.floor(o.score))),
      line('操作', vm.controlMode === 'auto' ? '自动' : '手动'),
    );
  }

  private renderEquipment(slots: readonly EquipmentSlotVM[], page: HTMLDivElement): void {
    page.replaceChildren();
    const grid = el('div', 'ws-status__slot-grid');
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const card = el('div', slot.occupied ? 'ws-status__slot' : 'ws-status__slot ws-status__slot--empty');
      card.dataset.slot = slot.slotId;
      card.append(
        el('div', 'ws-status__slot-name', slot.slotName),
        el('div', 'ws-status__slot-item', slot.occupied ? slot.name : '空'),
      );
      if (!slot.occupied) {
        grid.append(card);
        continue;
      }
      card.append(el('div', 'ws-status__slot-rarity', RARITY_LABELS[slot.rarity ?? ''] ?? (slot.rarity ?? '')));
      for (let a = 0; a < slot.affixes.length; a++) {
        card.append(el('div', 'ws-status__affix', slot.affixes[a].label));
      }
      card.append(el('div', 'ws-status__sockets', `孔 ${slot.gems.length}/${slot.sockets}`));
      for (let g = 0; g < slot.gems.length; g++) {
        const gem = slot.gems[g];
        card.append(el('div', 'ws-status__gem', `${gem.name} · ${gem.statLabel}`));
      }
      grid.append(card);
    }
    page.append(grid);
  }

  private renderSkills(skills: readonly SkillVM[], page: HTMLDivElement): void {
    page.replaceChildren();
    const grid = el('div', 'ws-status__skill-grid');
    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i];
      const card = el('div', 'ws-status__skill');
      card.dataset.skillSlot = String(skill.slot);
      card.append(
        el('div', 'ws-status__skill-name', `${skill.name} Lv.${skill.level}`),
        el('div', 'ws-status__skill-desc', skill.description),
        el('div', 'ws-status__skill-gain', skill.nextLevelGain),
        el(
          'div',
          'ws-status__skill-meta',
          `冷却 ${skill.cooldown.toFixed(1)}s · 射程 ${skill.range} · ${skill.tags.join('、')}`,
        ),
      );
      grid.append(card);
    }
    page.append(grid);
  }

  private renderStats(stats: readonly StatVM[], page: HTMLDivElement): void {
    page.replaceChildren();
    const list = el('div', 'ws-status__stat-list');
    for (let i = 0; i < stats.length; i++) {
      const stat = stats[i];
      const row = el('div', 'ws-status__stat');
      row.append(
        el('span', 'ws-status__stat-name', stat.name),
        el('span', 'ws-status__stat-value', numberText(stat.current, stat.isPercent)),
      );
      if (stat.breakdown !== null) {
        const details = el('div', 'ws-status__breakdown');
        const bySource = stat.breakdown.bySource;
        for (let k = 0; k < bySource.length; k++) {
          const source = bySource[k];
          details.append(
            el('span', 'ws-status__source', `${source.sourceName} ${numberText(source.value, stat.isPercent)}`),
          );
        }
        row.append(details);
      }
      list.append(row);
    }
    page.append(list);
  }

  /** 页签 aria / 样式与页面 hidden 同步。 */
  private applyTabVisibility(): void {
    for (let i = 0; i < TABS.length; i++) {
      const active = TABS[i] === this.currentTab;
      this.tabButtons[i].classList.toggle('is-active', active);
      this.tabButtons[i].setAttribute('aria-selected', active ? 'true' : 'false');
      this.pageNodes[i].hidden = !active;
    }
  }
}
