/**
 * 虚拟摇杆 + 技能按钮（DESIGN §8.2 / ARCHITECTURE §5.6）。
 *
 * - 摇杆与每个技能按钮各自 setPointerCapture，支持多指并发；
 * - 技能拖动超过 12px 进入瞄准，松手释放；未拖动则朝最近敌人（aim=0,0）；
 * - 所有命中区 ≥44px、touch-action:none（样式见 style.css）。
 *
 * T03/S5 变更（仅表现层）：补充 aria-label 无障碍名称；className 一个字节未改
 * （appFlow.spec.ts 对 'skill-button touch-control' / 'joystick touch-control' 做逐字断言），
 * DOM 结构、pointer 行为与 FC-3 全部选择器逐字保持（3 个 data-skill、4 个 .skill-button.touch-control）。
 * 技能键可见内容改为矢量 SVG 图标（aria-label/title 用真实技能名），不再出现「技1/技2/技3」。
 */
import { dodgeIcon, fallbackSkillIcons, type SkillIconSpec } from '../art/SkillIconFactory';
import { InputButton } from '../ecs/components/view';

export type SkillHandler = (index: number, aimX: number, aimY: number) => void;
export type MoveHandler = (x: number, y: number) => void;
export type DodgeHandler = (aimX: number, aimY: number) => void;

interface PointerState {
  readonly type: 'joystick' | 'skill' | 'dodge';
  readonly index: number;
  readonly startX: number;
  readonly startY: number;
  dragging: boolean;
}

const DRAG_THRESHOLD = 12;

/** 把矢量图写入按钮；保留 className / data-skill / pointer 绑定，只替换可见内容。 */
function applySkillIcon(button: HTMLButtonElement, icon: SkillIconSpec): void {
  button.innerHTML = icon.svg;
  button.setAttribute('aria-label', icon.name);
  button.title = icon.name;
}

export class TouchControls {
  private readonly root: HTMLDivElement;
  private readonly joystick: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly aimLine: HTMLDivElement;
  private readonly skillButtons: HTMLButtonElement[] = [];
  private readonly dodgeButton: HTMLButtonElement;
  private readonly autoButton: HTMLButtonElement;
  private readonly pointers = new Map<number, PointerState>();

  private moveXValue = 0;
  private moveYValue = 0;
  private aimXValue = 0;
  private aimYValue = 0;
  private autoMode = true;
  private readonly keys = new Set<string>();

  onMove: MoveHandler | null = null;
  onAim: MoveHandler | null = null;
  onSkill: SkillHandler | null = null;
  onDodge: DodgeHandler | null = null;
  onAutoToggle: ((auto: boolean) => void) | null = null;

  constructor(private readonly host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-controls';

    this.joystick = document.createElement('div');
    this.joystick.className = 'joystick touch-control';
    this.knob = document.createElement('div');
    this.knob.className = 'joystick__knob';
    this.joystick.append(this.knob);

    const cluster = document.createElement('div');
    cluster.className = 'skill-cluster';
    const fallbackIcons = fallbackSkillIcons();
    for (let i = 0; i < 3; i++) {
      const button = document.createElement('button');
      // className 必须逐字为 'skill-button touch-control'：
      // tests/e2e/appFlow.spec.ts 用数组 toContain('skill-button touch-control') 精确断言。
      button.className = 'skill-button touch-control';
      button.type = 'button';
      button.dataset.skill = String(i);
      applySkillIcon(button, fallbackIcons[i] ?? fallbackIcons[0]);
      this.skillButtons.push(button);
      cluster.append(button);
    }
    this.dodgeButton = document.createElement('button');
    // 同上：闪避键也必须与技能键共用逐字相同的 className。
    this.dodgeButton.className = 'skill-button touch-control';
    this.dodgeButton.type = 'button';
    applySkillIcon(this.dodgeButton, dodgeIcon());
    cluster.append(this.dodgeButton);

    this.autoButton = document.createElement('button');
    this.autoButton.className = 'touch-control touch-control__auto';
    this.autoButton.type = 'button';
    this.autoButton.textContent = '自动';
    this.autoButton.setAttribute('aria-label', '自动战斗开关');
    cluster.append(this.autoButton);

    this.aimLine = document.createElement('div');
    this.aimLine.className = 'aim-line';
    this.aimLine.style.display = 'none';

    this.root.append(this.joystick, cluster, this.aimLine);
    this.host.append(this.root);

    this.bindPointer(this.joystick, 'joystick', 0);
    for (let i = 0; i < this.skillButtons.length; i++) {
      this.bindPointer(this.skillButtons[i], 'skill', i);
    }
    this.bindPointer(this.dodgeButton, 'dodge', 0);
    this.autoButton.addEventListener('click', () => this.toggleAuto());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
    if (!visible) this.reset();
  }

  setAutoMode(auto: boolean): void {
    this.autoMode = auto;
    this.autoButton.textContent = auto ? '自动' : '手动';
    this.autoButton.setAttribute('aria-pressed', auto ? 'true' : 'false');
  }

  /** 按当前武将技能槽刷新矢量图标；不再显示「技1/技2/技3」。 */
  setSkillIcons(icons: readonly SkillIconSpec[]): void {
    const fallback = fallbackSkillIcons();
    for (let i = 0; i < this.skillButtons.length; i++) {
      applySkillIcon(this.skillButtons[i], icons[i] ?? fallback[i] ?? fallback[0]);
    }
  }

  get auto(): boolean {
    return this.autoMode;
  }

  get move(): { x: number; y: number } {
    return { x: this.moveXValue, y: this.moveYValue };
  }

  get aim(): { x: number; y: number } {
    return { x: this.aimXValue, y: this.aimYValue };
  }

  /** 当前按住的按钮位掩码，与 InputCmd.buttons 共用定义。 */
  getButtons(): number {
    let mask = 0;
    this.pointers.forEach((state) => {
      if (state.type === 'dodge') mask |= InputButton.Dodge;
      else if (state.type === 'skill') mask |= 1 << (state.index + 1);
    });
    if (this.keys.has('j')) mask |= InputButton.Basic;
    if (this.keys.has('1')) mask |= InputButton.Skill1;
    if (this.keys.has('2')) mask |= InputButton.Skill2;
    if (this.keys.has('3')) mask |= InputButton.Skill3;
    if (this.keys.has(' ')) mask |= InputButton.Dodge;
    return mask;
  }

  private toggleAuto(): void {
    this.setAutoMode(!this.autoMode);
    if (this.onAutoToggle !== null) this.onAutoToggle(this.autoMode);
  }

  private bindPointer(element: HTMLElement, type: PointerState['type'], index: number): void {
    element.addEventListener('pointerdown', (event: PointerEvent) => {
      event.preventDefault();
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // 某些测试环境不支持 capture，退化为普通事件监听。
      }
      this.pointers.set(event.pointerId, {
        type,
        index,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
      });
      if (type === 'joystick') this.updateJoystick(event.clientX, event.clientY);
    });

    element.addEventListener('pointermove', (event: PointerEvent) => {
      const state = this.pointers.get(event.pointerId);
      if (state === undefined || state.type !== type) return;
      event.preventDefault();
      if (type === 'joystick') {
        this.updateJoystick(event.clientX, event.clientY);
        return;
      }
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (dx * dx + dy * dy <= DRAG_THRESHOLD * DRAG_THRESHOLD) {
        state.dragging = false;
        this.aimLine.style.display = 'none';
        return;
      }
      state.dragging = true;
      const length = Math.hypot(dx, dy) || 1;
      this.aimXValue = dx / length;
      this.aimYValue = dy / length;
      this.showAimLine(element, Math.atan2(dy, dx));
      if (this.onAim !== null) this.onAim(this.aimXValue, this.aimYValue);
    });

    const release = (event: PointerEvent): void => {
      const state = this.pointers.get(event.pointerId);
      if (state === undefined || state.type !== type) return;
      try {
        element.releasePointerCapture(event.pointerId);
      } catch {
        // 已释放时忽略。
      }
      this.pointers.delete(event.pointerId);
      if (type === 'joystick') {
        this.moveXValue = 0;
        this.moveYValue = 0;
        this.knob.style.transform = 'translate(-50%, -50%)';
        if (this.onMove !== null) this.onMove(0, 0);
      } else {
        const aimX = state.dragging ? this.aimXValue : 0;
        const aimY = state.dragging ? this.aimYValue : 0;
        if (type === 'dodge') {
          if (this.onDodge !== null) this.onDodge(aimX, aimY);
        } else if (this.onSkill !== null) {
          this.onSkill(state.index, aimX, aimY);
        }
        this.aimXValue = 0;
        this.aimYValue = 0;
        this.aimLine.style.display = 'none';
      }
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
  }

  private updateJoystick(clientX: number, clientY: number): void {
    const rect = this.joystick.getBoundingClientRect();
    const radius = Math.max(1, rect.width / 2 - 28);
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const length = Math.hypot(dx, dy);
    if (length > radius && length > 0) {
      dx = (dx / length) * radius;
      dy = (dy / length) * radius;
    }
    this.knob.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px))`;
    this.moveXValue = radius > 0 ? dx / radius : 0;
    this.moveYValue = radius > 0 ? dy / radius : 0;
    if (this.onMove !== null) this.onMove(this.moveXValue, this.moveYValue);
  }

  private showAimLine(anchor: HTMLElement, angle: number): void {
    const rect = anchor.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    this.aimLine.style.left = `${rect.left - rootRect.left + rect.width / 2}px`;
    this.aimLine.style.top = `${rect.top - rootRect.top + rect.height / 2}px`;
    this.aimLine.style.width = '72px';
    this.aimLine.style.transformOrigin = '0 50%';
    this.aimLine.style.transform = `rotate(${angle.toFixed(3)}rad)`;
    this.aimLine.style.display = '';
  }

  /** 方向键归一化为等价 WASD；其余键原样返回（入参已小写）。 */
  private normalizeKey(key: string): string {
    if (key === 'arrowleft') return 'a';
    if (key === 'arrowright') return 'd';
    if (key === 'arrowup') return 'w';
    if (key === 'arrowdown') return 's';
    return key;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const raw = event.key.toLowerCase();
    const key = this.normalizeKey(raw);
    // 方向键默认会滚动页面；归一化后统一抑制，WASD 不受影响。
    if (key !== raw) event.preventDefault();
    this.keys.add(key);
    if (key === 'a' || key === 'd' || key === 'w' || key === 's') this.emitKeyboardMove();
    if (key === 'k') this.toggleAuto();
    if (key === '1' || key === '2' || key === '3') {
      const index = Number(key) - 1;
      if (this.onSkill !== null) this.onSkill(index, 0, 0);
    }
    if (key === ' ') {
      event.preventDefault();
      if (this.onDodge !== null) this.onDodge(0, 0);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const raw = event.key.toLowerCase();
    const key = this.normalizeKey(raw);
    if (key !== raw) event.preventDefault();
    this.keys.delete(key);
    if (['a', 'd', 'w', 's'].includes(key)) this.emitKeyboardMove();
  };

  private emitKeyboardMove(): void {
    const x = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0);
    const y = (this.keys.has('s') ? 1 : 0) - (this.keys.has('w') ? 1 : 0);
    const length = Math.hypot(x, y) || 1;
    this.moveXValue = x / length;
    this.moveYValue = y / length;
    if (this.onMove !== null) this.onMove(this.moveXValue, this.moveYValue);
  }

  private reset(): void {
    this.pointers.clear();
    this.moveXValue = 0;
    this.moveYValue = 0;
    this.aimXValue = 0;
    this.aimYValue = 0;
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.aimLine.style.display = 'none';
  }

  unmount(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.reset();
    this.root.remove();
  }
}
