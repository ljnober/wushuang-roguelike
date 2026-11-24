/**
 * 武将技能槽纯解析层（ARCHITECTURE_INCREMENTAL_2 §1.1 / §3.2 / §6.1）。
 *
 * 本模块只读 Registry：开局 / 换将时调用一次，产出预分配的不可变绑定表；
 * 运行期绝不调用，热路径零字符串查找。缺失 / 重复 / 悬空 effectId 一律
 * 走 assert() 抛 1xxx 配置错误，不静默降级。
 */
import { assert, SKILL_SLOT_COUNT } from '../core/Constants';
import type { GameConfig } from './types';

/** 错误码（1xxx 配置 / 注册域，与 Registry 既有 1001..1003 错开）。 */
const ERR_GENERAL_MISSING = 1004;
const ERR_SKILL_MISSING = 1005;
const ERR_SKILL_DUPLICATE = 1006;
const ERR_EFFECT_ID_MISSING = 1007;
const ERR_EFFECT_MISSING = 1008;
const ERR_SLOT_COUNT = 1009;
const ERR_BASIC_ATTACK = 1010;

/** 通用普攻不属于任何武将技能槽。 */
const BASIC_ATTACK_SKILL_ID = 'basic_attack';

/** 键位 → 武将技能 → 效果Id 的冻结绑定。 */
export interface SkillSlotBinding {
  /** 0..2，对应 general.skills[slot]。 */
  readonly slot: 0 | 1 | 2;
  /** CommandType.Skill.a，恒等于 slot（技1/技2/技3 → 0/1/2）。 */
  readonly commandA: number;
  /** 1 << commandA，与 InputCmd.buttons 位一致。 */
  readonly buttonBit: number;
  readonly skillId: string;
  readonly effectId: string;
}

/**
 * 纯解析：把某武将的 skills 表解析成三条槽位绑定。
 * 只读 config 的 Registry，不写任何运行时状态；非法配置直接 assert 失败。
 */
export function resolveSkillSlots(config: GameConfig, generalId: string): SkillSlotBinding[] {
  const general = config.generals.tryGet(generalId);
  assert(general !== undefined, ERR_GENERAL_MISSING, `未找到武将 id: ${generalId}`);
  const skills = general.skills;
  assert(
    skills.length === SKILL_SLOT_COUNT,
    ERR_SLOT_COUNT,
    `武将 ${generalId} 技能数应为 ${SKILL_SLOT_COUNT}，实际 ${skills.length}`,
  );

  const bindings: SkillSlotBinding[] = new Array<SkillSlotBinding>(SKILL_SLOT_COUNT);
  for (let i = 0; i < SKILL_SLOT_COUNT; i++) {
    const skillId = skills[i];
    assert(typeof skillId === 'string' && skillId.length > 0, ERR_SKILL_MISSING, `武将 ${generalId} 槽位 ${i} 技能 id 为空`);
    assert(
      skillId !== BASIC_ATTACK_SKILL_ID,
      ERR_BASIC_ATTACK,
      `武将 ${generalId} 不得把 ${BASIC_ATTACK_SKILL_ID} 放进技能表`,
    );
    for (let j = 0; j < i; j++) {
      assert(skills[j] !== skillId, ERR_SKILL_DUPLICATE, `武将 ${generalId} 技能重复: ${skillId}`);
    }
    const skill = config.skills.tryGet(skillId);
    assert(skill !== undefined, ERR_SKILL_MISSING, `武将 ${generalId} 引用了未注册技能: ${skillId}`);
    const effectId = skill.effectId ?? '';
    assert(effectId.length > 0, ERR_EFFECT_ID_MISSING, `技能 ${skillId} 缺少 effectId`);
    assert(config.effects.has(effectId), ERR_EFFECT_MISSING, `技能 ${skillId} 引用了未注册效果: ${effectId}`);
    bindings[i] = {
      slot: i as 0 | 1 | 2,
      commandA: i,
      buttonBit: 1 << i,
      skillId,
      effectId,
    };
  }
  return bindings;
}

/**
 * 内容完整性校验：返回全部问题（空数组表示通过），供 contentIntegrity.test.ts 使用。
 * 与 resolveSkillSlots 使用同一套规则，但逐项收集而非首错即抛。
 */
export function validateGeneralSkills(config: GameConfig): string[] {
  const problems: string[] = [];
  const generals = config.generals.all();
  for (let i = 0; i < generals.length; i++) {
    const general = generals[i];
    const prefix = `武将 ${general.id}`;
    const skills = general.skills;
    if (skills.length !== SKILL_SLOT_COUNT) {
      problems.push(`${prefix} 技能数应为 ${SKILL_SLOT_COUNT}，实际 ${skills.length}`);
    }
    const seen = new Set<string>();
    for (let slot = 0; slot < skills.length; slot++) {
      const skillId = skills[slot];
      if (typeof skillId !== 'string' || skillId.length === 0) {
        problems.push(`${prefix} 槽位 ${slot} 技能 id 为空`);
        continue;
      }
      if (skillId === BASIC_ATTACK_SKILL_ID) {
        problems.push(`${prefix} 不得包含通用普攻 ${BASIC_ATTACK_SKILL_ID}`);
      }
      if (seen.has(skillId)) {
        problems.push(`${prefix} 技能重复: ${skillId}`);
      } else {
        seen.add(skillId);
      }
      const skill = config.skills.tryGet(skillId);
      if (skill === undefined) {
        problems.push(`${prefix} 引用未注册技能: ${skillId}`);
        continue;
      }
      const effectId = skill.effectId ?? '';
      if (effectId.length === 0 || !config.effects.has(effectId)) {
        problems.push(`${prefix} 技能 ${skillId} 的 effectId 悬空: ${effectId}`);
      }
    }
  }
  return problems;
}
