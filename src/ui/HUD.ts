/**
 * 战斗 HUD（ARCHITECTURE §5.10 / DESIGN §9）。
 *
 * 纯 DOM，不进 ECS；数据由 RenderSystems.HUDSystem（10Hz）与 render 回调推送。
 * 只在数值变化时写 DOM，避免每帧布局抖动。
 */
import { GameEventType } from '../ecs/bridge/enums';
import type { GameEvent } from '../ecs/bridge/GameEventBus';
import type { HUDLike } from '../ecs/systems/RenderSystems';
import { has, query } from '../ecs/bit/adapter';
import { Health, PlayerTag, Position } from '../ecs/bit/components';
import type { BattleWorld } from '../ecs/bit/adapter';
import type { Eid } from '../ecs/bit/types';

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

function readNumber(source: unknown, key: string): number {
  if (source === null || source === undefined || typeof source !== 'object') return 0;
  const table = source as Record<string, unknown>;
  const value = table[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class HUD implements HUDLike {
  private readonly root: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly hpText: HTMLSpanElement;
  private readonly expFill: HTMLDivElement;
  private readonly levelText: HTMLSpanElement;
  private readonly timeText: HTMLSpanElement;
  private readonly killText: HTMLSpanElement;
  private readonly scoreText: HTMLSpanElement;
  private readonly bossBanner: HTMLDivElement;
  private readonly toastBox: HTMLDivElement;

  private kills = 0;
  private level = 1;
  private exp = 0;
  private expNext = 10;
  private score = 0;
  private lastHp = -1;
  private lastMaxHp = -1;
  private lastExp = -1;
  private lastLevel = -1;
  private lastTime = -1;
  private lastKills = -1;
  private lastScore = -1;
  private bossWarningUntil = 0;
  private readonly playerTerms = [Position, PlayerTag];

  constructor(private readonly host: HTMLElement) {
    this.root = el('div', 'hud');
    this.root.dataset.hud = 'battle';

    const top = el('div', 'hud__row');
    const left = el('div', 'hud__panel');
    const hpLine = el('div', 'hud__line');
    hpLine.append(el('span', 'hud__label', '生命 '));
    this.hpText = el('span', 'hud__value', '120 / 120');
    hpLine.append(this.hpText);
    const hpBar = el('div', 'hud__bar');
    this.hpFill = el('div', 'hud__bar-fill');
    hpBar.append(this.hpFill);
    const expBar = el('div', 'hud__bar hud__bar--exp');
    this.expFill = el('div', 'hud__bar-fill hud__bar-fill--exp');
    expBar.append(this.expFill);
    this.levelText = el('span', 'hud__value', 'Lv.1');
    left.append(hpLine, hpBar, expBar, this.levelText);

    const right = el('div', 'hud__panel');
    this.timeText = el('div', 'hud__value', '00:00');
    this.killText = el('div', 'hud__value', '击杀 0');
    this.scoreText = el('div', 'hud__value', '积分 0');
    right.append(this.timeText, this.killText, this.scoreText);
    top.append(left, right);

    const bottom = el('div', 'hud__row hud__row--bottom');
    this.bossBanner = el('div', 'hud__panel hud__boss-warn', '');
    this.bossBanner.style.display = 'none';
    this.toastBox = el('div', 'hud__toasts');
    bottom.append(this.toastBox, this.bossBanner);

    this.root.append(top, bottom);
    this.host.append(this.root);
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /** 由 presentation 的 render 回调调用：从 ECS/会话同步连续量。 */
  updateFromWorld(world: BattleWorld | null, session: unknown): void {
    if (world !== null) {
      const players = query(world, this.playerTerms);
      if (players.length > 0) {
        const eid = players[0] as Eid;
        if (has(world, eid, Health)) {
          this.setHealth(Health.cur[eid], Health.max[eid]);
        }
      }
    }
    const elapsedTicks = readNumber(session, 'elapsedTicks');
    const elapsed = elapsedTicks > 0
      ? elapsedTicks / Math.max(1, readNumber(session, 'tickRate'))
      : readNumber(session, 'elapsed');
    this.setTime(elapsed);
    // 会话未提供这些字段时保持事件累计值，避免每帧用 0 覆盖 Kill/LevelUp 事件的结果。
    const sessionKills = readNumber(session, 'kills');
    if (sessionKills > 0) this.setKills(sessionKills);
    const sessionLevel = readNumber(session, 'level');
    if (sessionLevel > 0) {
      this.setLevel(sessionLevel, readNumber(session, 'exp'), readNumber(session, 'expNext'));
    }
    const sessionScore = readNumber(session, 'score');
    if (sessionScore > 0) this.setScore(sessionScore);
    if (this.bossWarningUntil > 0 && Date.now() >= this.bossWarningUntil) {
      this.bossWarningUntil = 0;
      this.bossBanner.style.display = 'none';
    }
  }

  setHealth(cur: number, max: number): void {
    if (cur === this.lastHp && max === this.lastMaxHp) return;
    this.lastHp = cur;
    this.lastMaxHp = max;
    const safeMax = max > 0 ? max : 1;
    const ratio = Math.max(0, Math.min(1, cur / safeMax));
    this.hpFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    this.hpText.textContent = `${Math.ceil(cur)} / ${Math.ceil(max)}`;
  }

  setExp(exp: number, next: number, level: number): void {
    if (exp !== this.lastExp) {
      this.lastExp = exp;
      const ratio = next > 0 ? Math.max(0, Math.min(1, exp / next)) : 0;
      this.expFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    }
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      this.levelText.textContent = `Lv.${Math.max(1, Math.floor(level))}`;
    }
    this.exp = exp;
    this.expNext = next;
    this.level = level;
  }

  /** 等级/经验统一入口：updateFromWorld 与 LevelUp 事件共用。 */
  setLevel(level: number, exp: number, next: number): void {
    this.setExp(exp, next, level);
  }

  setTime(seconds: number): void {
    const sec = Math.max(0, Math.floor(seconds));
    if (sec === this.lastTime) return;
    this.lastTime = sec;
    const mm = Math.floor(sec / 60).toString().padStart(2, '0');
    const ss = (sec % 60).toString().padStart(2, '0');
    this.timeText.textContent = `${mm}:${ss}`;
  }

  setKills(kills: number): void {
    const value = Math.max(0, Math.floor(kills));
    if (value === this.lastKills) return;
    this.kills = value;
    this.lastKills = value;
    this.killText.textContent = `击杀 ${value}`;
  }

  setScore(score: number): void {
    const value = Math.max(0, Math.floor(score));
    if (value === this.lastScore) return;
    this.score = value;
    this.lastScore = value;
    this.scoreText.textContent = `积分 ${value}`;
  }

  showBossWarning(name: string, durationSec: number = 3): void {
    this.bossBanner.textContent = `⚔ BOSS 预警：${name}`;
    this.bossBanner.style.display = '';
    this.bossWarningUntil = Date.now() + Math.max(0.5, durationSec) * 1000;
  }

  toast(text: string): void {
    const node = el('div', 'hud__toast', text);
    this.toastBox.append(node);
    window.setTimeout(() => node.remove(), 2200);
    while (this.toastBox.childElementCount > 4) {
      this.toastBox.firstElementChild?.remove();
    }
  }

  /** HUDLike 契约：消费 GameEventBus 的节流事件。 */
  onEvent(event: GameEvent): void {
    switch (event.type) {
      case GameEventType.Kill:
        // Kill 事件的 b 是击杀者 eid、c 是伤害值，都不是击杀数：
        // 每次事件固定 +1，避免影子玩家(eid 2/3)把计数加成 2/3。
        this.setKills(this.kills + 1);
        break;
      case GameEventType.LevelUp:
        this.setLevel(
          Math.round(event.a),
          event.c > 0 ? event.c : 0,
          event.b > 0 ? event.b : this.expNext,
        );
        this.toast(`升级！Lv.${Math.round(event.a)}`);
        break;
      case GameEventType.BossWarn:
        this.showBossWarning(`阶段 ${Math.round(event.a)}`, event.b > 0 ? event.b : 4);
        break;
      case GameEventType.BossPhase:
        this.toast(`BOSS 进入第 ${Math.round(event.a)} 阶段`);
        break;
      case GameEventType.Equip:
        this.toast('装备已更新');
        break;
      case GameEventType.GemSocket:
        this.toast('宝石镶嵌成功');
        break;
      case GameEventType.CubeResult:
        this.toast('卡奈魔盒：操作完成');
        break;
      case GameEventType.Victory:
        this.showBossWarning('胜利！', 6);
        break;
      case GameEventType.Defeat:
      case GameEventType.Death:
        this.showBossWarning('战败', 6);
        break;
      default:
        break;
    }
  }

  /** 供结算面板读取当前展示值（只读快照，不修改任何状态）。 */
  snapshot(): { kills: number; level: number; score: number; elapsed: number } {
    return {
      kills: this.kills,
      level: this.level,
      score: this.score,
      elapsed: this.lastTime >= 0 ? this.lastTime : 0,
    };
  }

  reset(): void {
    this.kills = 0;
    this.level = 1;
    this.exp = 0;
    this.expNext = 10;
    this.score = 0;
    this.lastHp = -1;
    this.lastMaxHp = -1;
    this.lastExp = -1;
    this.lastLevel = -1;
    this.lastTime = -1;
    this.lastKills = -1;
    this.lastScore = -1;
    this.bossWarningUntil = 0;
    this.bossBanner.style.display = 'none';
    this.toastBox.replaceChildren();
    this.setHealth(0, 1);
    this.setLevel(1, 0, 10);
    this.setTime(0);
    this.setKills(0);
    this.setScore(0);
  }

  unmount(): void {
    this.root.remove();
  }
}
