/**
 * 升级三选一 + auto/manual 切换（DESIGN §8.2 / ARCHITECTURE §5.7）。
 *
 * 选牌来自配置中的 skills Registry，用确定性 Rng 派生，无 Math.random。
 * DOM 弹窗不进 ECS；选择回调由 presentation 转成命令/状态写入。
 */
import { Rng } from '../core/Rng';
import type { GameConfig } from '../data/types';

export interface LevelUpChoice {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly level: number;
  readonly tags: readonly string[];
}

export type CardPickHandler = (choice: LevelUpChoice) => void;

/** 从技能配置中确定性地抽取 count 张互不相同的升级卡。 */
export function pickChoices(config: GameConfig, seed: number, tick: number, count: number = 3): LevelUpChoice[] {
  const skills = config.skills.all();
  const rng = Rng.derive(seed, 0, tick, 0x5a17);
  const total = skills.length;
  const pickCount = Math.min(count, total);
  const chosen: number[] = [];
  let guard = 0;
  while (chosen.length < pickCount && guard < total * 4) {
    const index = rng.int(total);
    let duplicate = false;
    for (let i = 0; i < chosen.length; i++) {
      if (chosen[i] === index) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) chosen.push(index);
    guard++;
  }

  const out: LevelUpChoice[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const def = skills[chosen[i]];
    out.push({
      id: def.id,
      name: def.name,
      description: `伤害 ${def.damage} · 冷却 ${def.cooldown.toFixed(1)}s · 射程 ${def.range}`,
      level: def.level + 1,
      tags: def.tags,
    });
  }
  return out;
}

export class CardsAndLevelUp {
  private readonly overlay: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly grid: HTMLDivElement;
  private readonly autoButton: HTMLButtonElement;
  private handler: CardPickHandler | null = null;
  private autoMode = true;
  private autoChange: ((auto: boolean) => void) | null = null;

  constructor(private readonly host: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay ws-levelup';
    this.overlay.hidden = true;

    this.panel = document.createElement('div');
    this.panel.className = 'panel';

    this.title = document.createElement('h2');
    this.title.textContent = '升级 · 三选一';
    this.grid = document.createElement('div');
    this.grid.className = 'card-grid';

    const row = document.createElement('div');
    row.className = 'panel__row';
    this.autoButton = document.createElement('button');
    this.autoButton.type = 'button';
    this.autoButton.textContent = '技能：自动';
    this.autoButton.addEventListener('click', () => {
      this.setAutoMode(!this.autoMode);
      if (this.autoChange !== null) this.autoChange(this.autoMode);
    });
    row.append(this.autoButton);

    this.panel.append(this.title, this.grid, row);
    this.overlay.append(this.panel);
    this.host.append(this.overlay);
    this.setAutoMode(true);
  }

  get visible(): boolean {
    return !this.overlay.hidden;
  }

  get auto(): boolean {
    return this.autoMode;
  }

  set onAutoModeChange(handler: ((auto: boolean) => void) | null) {
    this.autoChange = handler;
  }

  setAutoMode(auto: boolean): void {
    this.autoMode = auto;
    this.autoButton.textContent = auto ? '技能：自动' : '技能：手动';
    this.autoButton.setAttribute('aria-pressed', auto ? 'true' : 'false');
  }

  /** 展示三选一；重复调用会替换上一次的卡片与回调。 */
  show(choices: readonly LevelUpChoice[], onPick: CardPickHandler): void {
    this.handler = onPick;
    this.grid.replaceChildren();
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      const card = document.createElement('button');
      card.className = 'card';
      card.type = 'button';
      card.dataset.cardId = choice.id;

      const level = document.createElement('span');
      level.className = 'card__level';
      level.textContent = `Lv.${choice.level}`;
      const name = document.createElement('strong');
      name.className = 'card__name';
      name.textContent = choice.name;
      const desc = document.createElement('span');
      desc.className = 'card__desc';
      desc.textContent = choice.description;
      const tags = document.createElement('span');
      tags.className = 'card__tags';
      tags.textContent = choice.tags.join(' · ');
      card.append(level, name, desc, tags);
      card.addEventListener('click', () => {
        const handler = this.handler;
        this.hide();
        if (handler !== null) handler(choice);
      });
      this.grid.append(card);
    }
    this.overlay.hidden = false;
  }

  hide(): void {
    this.overlay.hidden = true;
    this.handler = null;
  }

  unmount(): void {
    this.hide();
    this.overlay.remove();
  }
}
