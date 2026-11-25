/**
 * 技能说明 formatter 单测（ARCH_RUN_STATUS.md §3.4 冻结契约）。
 *
 * 锁定三件事：纯函数输出无 NaN/undefined；伤害系数口径 ×1.3^(level-1)；
 * formatLevelUpDescription 与 presentation.showLevelUp 现值文案一致。
 * 只用全局 describe / it / expect（vite.config.ts globals:true）。
 */
import { SKILL_DEFS } from '../combat';
import {
  formatLevelUpDescription,
  formatSkillDescription,
  sourceKindLabel,
} from '../skillDescription';
import type { SkillDef } from '../types';

/** 独立重算 showLevelUp 现值（presentation.ts:331-343），避免同义复用被测实现。 */
function legacyLevelUpText(skill: SkillDef, level: number): string {
  return `技能等级 ${level} · 伤害 ×${Math.pow(1.3, level - 1).toFixed(2)} · ${skill.tags.join(' · ')}`;
}

function expectCleanText(text: string): void {
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toMatch(/NaN|undefined|Infinity/);
}

describe('技能说明 formatter：纯函数与冻结口径', () => {
  const attackSkill = SKILL_DEFS.find((s) => s.id === 'sweeping_slash') as SkillDef;

  it('formatSkillDescription 三段输出齐全，且无 NaN / undefined', () => {
    const out = formatSkillDescription(attackSkill, 3, 4);
    expectCleanText(out.description);
    expectCleanText(out.nextLevelGain);
    expect(out.currentLevel).toBe(3);
    expect(Number.isFinite(out.currentLevel)).toBe(true);
  });

  it('nextLevel=null 时 nextLevelGain 固定为 —', () => {
    const out = formatSkillDescription(attackSkill, 9, null);
    expect(out.currentLevel).toBe(9);
    expect(out.nextLevelGain).toBe('—');
    expectCleanText(out.description);
  });

  it.each([1, 2, 3])('伤害系数按 1.3^(level-1) 口径展示（level=%i）', (level) => {
    // 实现尚未落地时本用例用于锁定 1.00 / 1.30 / 1.69 三档，不允许自行改口径。
    const out = formatSkillDescription(attackSkill, level, level + 1);
    const factor = Math.pow(1.3, level - 1).toFixed(2);
    expect(`${out.description}${out.nextLevelGain}`).toContain(factor);
    expect(out.nextLevelGain).toContain('0.04');
  });

  it('formatLevelUpDescription 与 showLevelUp 现值文案逐字一致', () => {
    for (const id of ['sweeping_slash', 'thunder_strike']) {
      const skill = SKILL_DEFS.find((s) => s.id === id) as SkillDef;
      for (const level of [1, 3, 5]) {
        expect(formatLevelUpDescription(skill, level)).toBe(legacyLevelUpText(skill, level));
      }
    }
  });

  it('静态 description 存在时优先展示，同一输入重复调用结果一致', () => {
    const staticSkill: SkillDef = { ...attackSkill, description: '横扫前方敌群' };
    expect(formatSkillDescription(staticSkill, 2, 3).description).toBe('横扫前方敌群');
    const a = formatSkillDescription(attackSkill, 2, 3);
    const b = formatSkillDescription(attackSkill, 2, 3);
    expect(a).toEqual(b);
  });

  it('sourceKindLabel 覆盖 9 类来源，越界统一为 未知', () => {
    expect(sourceKindLabel(0)).toBe('基础');
    const labels = ['基础', '词缀', '宝石', '套装', '传奇', '魔盒', '技能', '传说宝石', 'Buff'];
    for (let kind = 0; kind < labels.length; kind++) {
      expect(sourceKindLabel(kind)).toBe(labels[kind]);
    }
    expect(sourceKindLabel(-1)).toBe('未知');
    expect(sourceKindLabel(labels.length)).toBe('未知');
    expect(sourceKindLabel(9999)).toBe('未知');
  });

  it('SKILL_DEFS 全部技能（≥22 条）均可格式化且输出非空中文', () => {
    // 冻结口径要求覆盖全部技能；当前配置表实际为 23 条（含 basic_attack）。
    expect(SKILL_DEFS.length).toBeGreaterThanOrEqual(22);
    for (const skill of SKILL_DEFS) {
      const out = formatSkillDescription(skill, 1, 2);
      expectCleanText(out.description);
      expectCleanText(out.nextLevelGain);
      expect(out.description, `${skill.id} 说明应含中文`).toMatch(/[\u4e00-\u9fa5]/);
      expect(out.currentLevel).toBe(1);
      expectCleanText(formatLevelUpDescription(skill, 2));
    }
  });
});
