// @vitest-environment jsdom
/**
 * QA2 移动端验证（DESIGN §8.2 / PRD 移动端验收）：
 *  - TouchControls 在 jsdom 中生成摇杆、3 技能键、闪避键、自动键；
 *  - 每个触控控件在 pointerdown 时各自调用 setPointerCapture（多指）；
 *  - 技能拖动 >12px 进入瞄准并在松手时回调归一化方向；
 *  - style.css / presentation.ts 中存在 safe-area-inset 与 touch-action:none；
 *  - 命中区下限 --ws-hit-min = 44px 且 apply 到 button/.touch-control。
 *
 * 使用全局 describe/it/expect（vite.config.ts globals:true），不加载第二份 runner。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TouchControls } from '../ui/TouchControls';

function cssOf(relative: string): string {
  const url = new URL(relative, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

/** jsdom 未实现 PointerEvent，构造带 pointerId/坐标的 pointer 事件。 */
function pointer(type: string, pointerId: number, clientX: number, clientY: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

describe('移动端触控 DOM 与命中区', () => {
  it('生成摇杆 + 3 技能键 + 闪避键 + 自动键', () => {
    // Arrange
    const host = document.createElement('div');
    document.body.append(host);

    // Act
    const touch = new TouchControls(host);

    // Assert
    const root = host.querySelector('.touch-controls') as HTMLDivElement;
    expect(root).not.toBeNull();
    expect(root.querySelectorAll('.joystick.touch-control').length).toBe(1);
    expect(root.querySelectorAll('.joystick__knob').length).toBe(1);
    expect(root.querySelectorAll('.skill-button.touch-control').length).toBe(4); // 3 技能 + 闪避
    expect(root.querySelectorAll('.skill-button[data-skill]').length).toBe(3);
    expect(root.querySelectorAll('.touch-control__auto').length).toBe(1);
    // 初始隐藏，进入战斗后由 BattleScene 置为可见。
    expect(root.style.display).toBe('none');
    touch.unmount();
    host.remove();
  });

  it('摇杆与各技能键在 pointerdown 时各自 setPointerCapture', () => {
    // Arrange：为每个元素注入 spy（jsdom 未实现原生 capture）。
    const host = document.createElement('div');
    document.body.append(host);
    const touch = new TouchControls(host);
    const captured: Array<{ cls: string; pointerId: number }> = [];
    const controls = Array.from(host.querySelectorAll<HTMLElement>('.touch-control'));
    controls.forEach((node, index) => {
      (node as HTMLElement & { setPointerCapture(id: number): void }).setPointerCapture = function (
        id: number,
      ): void {
        captured.push({ cls: this.className, pointerId: id });
      };
      node.dispatchEvent(pointer('pointerdown', index + 1, 100, 100));
    });

    // Assert：DESIGN §8.2 要求摇杆与各技能键（含闪避）各自捕获自己的 pointerId；
    // 自动键是 click 切换，不走 pointer capture，故不计入。
    const joystickCaptures = captured.filter((c) => c.cls.indexOf('joystick') >= 0);
    const skillCaptures = captured.filter((c) => c.cls.indexOf('skill-button') >= 0);
    expect(joystickCaptures.length).toBeGreaterThanOrEqual(1);
    expect(skillCaptures.length).toBeGreaterThanOrEqual(4);
    expect(new Set(captured.map((c) => c.pointerId)).size).toBe(controls.length - 1);
    touch.unmount();
    host.remove();
  });

  it('技能拖动超过 12px 进入瞄准，松手回调携带归一化方向', () => {
    // Arrange
    const host = document.createElement('div');
    document.body.append(host);
    const touch = new TouchControls(host);
    const skills: Array<{ index: number; aimX: number; aimY: number }> = [];
    touch.onSkill = (index, aimX, aimY) => skills.push({ index, aimX, aimY });
    const button = host.querySelector('.skill-button[data-skill="0"]') as HTMLButtonElement;

    // Act：按下 → 拖动 30px（>12px 阈值）→ 松手。
    button.dispatchEvent(pointer('pointerdown', 7, 100, 100));
    button.dispatchEvent(pointer('pointermove', 7, 130, 100));
    button.dispatchEvent(pointer('pointerup', 7, 130, 100));

    // Assert：释放时回调携带 +x 方向、索引 0。
    expect(skills.length).toBe(1);
    expect(skills[0].index).toBe(0);
    expect(skills[0].aimX).toBeCloseTo(1, 5);
    expect(skills[0].aimY).toBeCloseTo(0, 5);
    touch.unmount();
    host.remove();
  });

  it('自动模式切换回调正确', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const touch = new TouchControls(host);
    const toggles: boolean[] = [];
    touch.onAutoToggle = (auto) => toggles.push(auto);
    const auto = host.querySelector('.touch-control__auto') as HTMLButtonElement;

    auto.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(touch.auto).toBe(false);
    expect(toggles).toEqual([false]);
    auto.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(touch.auto).toBe(true);
    expect(toggles).toEqual([false, true]);
    touch.unmount();
    host.remove();
  });
});

describe('移动端样式：命中区 / safe-area / touch-action', () => {
  const styleCss = cssOf('../style.css');

  it('命中区下限为 44px 并应用到 button 与 .touch-control', () => {
    expect(styleCss).toMatch(/--ws-hit-min\s*:\s*44px/);
    // 选择器为分组写法：.hit-target, button, .hud button, .touch-control { ... }
    expect(styleCss).toMatch(
      /\.hit-target,\s*button,\s*\.hud button,\s*\.touch-control\s*\{[^}]*min-width:\s*var\(--ws-hit-min\)[^}]*min-height:\s*var\(--ws-hit-min\)/s,
    );
    expect(styleCss).toMatch(/\.joystick\s*\{[^}]*width:\s*132px/s);
  });

  it('body/canvas/button 均设置 touch-action:none', () => {
    expect(styleCss).toMatch(/body\s*\{[^}]*touch-action:\s*none/s);
    expect(styleCss).toMatch(/canvas\s*\{[^}]*touch-action:\s*none/s);
    expect(styleCss).toMatch(/\.touch-control\s*\{[^}]*touch-action:\s*none/s);
  });

  it('HUD/覆盖层/摇杆使用 safe-area-inset 适配刘海屏', () => {
    expect(styleCss).toMatch(/\.hud\s*\{[^}]*env\(safe-area-inset-top/s);
    expect(styleCss).toMatch(/\.overlay\s*\{[^}]*env\(safe-area-inset-/s);
    // presentation.ts 注入的控制条样式同样处理左右/底部安全区。
    const presentation = cssOf('../registration/presentation.ts');
    expect(presentation).toMatch(/\.touch-controls \.joystick\{[^}]*env\(safe-area-inset-left/s);
    expect(presentation).toMatch(/\.touch-controls \.skill-cluster\{[^}]*env\(safe-area-inset-right/s);
  });
});
