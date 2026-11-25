/**
 * 技能矢量图标工厂回归（DESIGN §8.2）。
 *
 * 覆盖：全部技能都能产出完整 SVG、同标签技能图形一致、按武将绑定解析图标、
 * 文案不再出现「技1/技2/技3」数字标号。使用全局 describe/it/expect。
 */
import { buildGameConfig } from '../../data/index';
import { SKILL_DEFS } from '../../data/combat';
import {
  dodgeIcon,
  fallbackSkillIcons,
  skillArchetypeOf,
  skillIconFor,
  skillIconsForGeneral,
} from '../SkillIconFactory';

const config = buildGameConfig();

describe('技能矢量图标工厂', () => {
  it('全部技能配置都产出合法 SVG，且不含数字标号', () => {
    expect(SKILL_DEFS.length).toBeGreaterThan(0);
    for (let i = 0; i < SKILL_DEFS.length; i++) {
      const skill = SKILL_DEFS[i];
      const icon = skillIconFor(skill);
      expect(icon.name).toBe(skill.name);
      expect(icon.svg.startsWith('<svg')).toBe(true);
      expect(icon.svg.endsWith('</svg>')).toBe(true);
      expect(icon.svg).toContain('stroke="currentColor"');
      expect(icon.svg).toContain('<path');
      expect(icon.svg).not.toMatch(/技\s*[123]/);
      expect(skillArchetypeOf(skill)).not.toBe('default');
    }
  });

  it('按武将解析出 3 个真实技能图标，名称与技能表一致', () => {
    const generals = config.generals.all();
    expect(generals.length).toBe(40);
    for (let i = 0; i < generals.length; i++) {
      const general = generals[i];
      const icons = skillIconsForGeneral(config, general.id);
      expect(icons.length, `${general.id} 应有 3 个技能图标`).toBe(3);
      for (let slot = 0; slot < 3; slot++) {
        expect(icons[slot].name).toBe(config.skills.tryGet(general.skills[slot])?.name);
        expect(icons[slot].svg.startsWith('<svg')).toBe(true);
      }
    }
  });

  it('不同技能原型使用不同矢量图，非法输入安全回退', () => {
    const slash = skillIconFor(SKILL_DEFS.find((s) => s.id === 'sweeping_slash'));
    const lightning = skillIconFor(SKILL_DEFS.find((s) => s.id === 'thunder_strike'));
    const shield = skillIconFor(SKILL_DEFS.find((s) => s.id === 'golden_shield'));
    expect(slash.svg).not.toBe(lightning.svg);
    expect(lightning.svg).not.toBe(shield.svg);
    expect(skillIconFor(undefined).svg).toContain('<path');
    expect(fallbackSkillIcons().length).toBe(3);
    expect(dodgeIcon().name).toBe('闪避');
    expect(dodgeIcon().svg).toContain('<path');
  });

  it('非法武将 id 回退通用图标而不抛异常', () => {
    expect(() => skillIconsForGeneral(config, '__nope__')).not.toThrow();
    expect(skillIconsForGeneral(config, '__nope__')).toHaveLength(3);
  });
});
