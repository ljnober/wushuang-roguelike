// @vitest-environment jsdom
/**
 * 局内角色状态面板 DOM 单测（ARCH_RUN_STATUS.md §3.2 冻结 API）。
 *
 * T03 面板实现落地后，本文件即其验收关卡：构造 / open / setTab / close /
 * unmount 全链路，以及 13 槽、3 技能、来源中文名的 DOM 呈现。
 * 只用全局 describe / it / expect / vi（vite.config.ts globals:true）。
 */
import { SLOT_DEFS } from '../../data/equipment';
import { STAT_DEFS } from '../../data/stats';
import { RunStatusPanel } from '../RunStatusPanel';
import type { EquipmentSlotVM, RunStatusVM, SkillVM, StatVM } from '../types/RunStatusVM';

const SKILL_NAMES = ['横扫千军', '战吼', '龙吟'];

/** 最小但字段填满的合法 VM：13 槽装备 / 3 技能 / 14 属性。 */
function makeVM(): RunStatusVM {
  const equipment: EquipmentSlotVM[] = SLOT_DEFS.map((def, i) => (i === 0 ? {
    slotId: def.id,
    slotName: def.name,
    occupied: true,
    name: '青龙偃月刀',
    rarity: 'legendary',
    affixes: [{ statId: 'atk', label: '攻击力 +5.2', value: 5.2, isPercent: false }],
    sockets: 1,
    gems: [{ defId: 'gem_red_t1', name: '红色1级 攻击力', kind: 'red', tier: 1, statLabel: '攻击力 +3' }],
  } : {
    slotId: def.id,
    slotName: def.name,
    occupied: false,
    name: '',
    rarity: null,
    affixes: [],
    sockets: 0,
    gems: [],
  }));
  const skills: SkillVM[] = SKILL_NAMES.map((name, slot) => ({
    slot: slot as 0 | 1 | 2,
    skillId: `test_skill_${slot}`,
    name,
    level: slot + 1,
    description: `${name}说明：对身前敌人造成伤害`,
    nextLevelGain: slot === 2 ? '—' : `下一级：伤害 ×${Math.pow(1.3, slot).toFixed(2)}（+0.04）`,
    tags: ['melee', 'aoe'],
    cooldown: 3.2 + slot,
    range: 110,
  }));
  const coreIds = new Set(['atk', 'maxHp', 'crit', 'armor']);
  const stats: StatVM[] = STAT_DEFS.map((def) => ({
    statId: def.id,
    name: def.name,
    current: def.default,
    isPercent: def.isPercent,
    breakdown: coreIds.has(def.id) ? {
      final: def.default,
      bySource: [
        { sourceKind: 0, sourceName: '基础', value: def.default },
        { sourceKind: 1, sourceName: '词缀', value: 5.2 },
        { sourceKind: 2, sourceName: '宝石', value: 3 },
        { sourceKind: 3, sourceName: '套装', value: 2 },
      ],
      buckets: [1, 1, 1, 1, 1, 1],
    } : null,
  }));
  return {
    overview: {
      playerId: 0,
      generalName: '关羽',
      level: 3,
      exp: 12,
      expNext: 20,
      hp: 100,
      maxHp: 120,
      atk: 29.2,
      armor: 8,
      crit: 0.09,
      elapsedSec: 42,
      kills: 33,
      score: 1200,
    },
    equipment,
    skills,
    stats,
    controlMode: 'manual',
    localPlayerId: 0,
    generalId: 'guan_yu',
  };
}

describe('RunStatusPanel：DOM 生命周期与四页呈现', () => {
  let host: HTMLDivElement;
  let onClose: () => void;
  let panel: RunStatusPanel;
  let root: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    onClose = vi.fn<() => void>();
    panel = new RunStatusPanel({ host, onClose });
    const mounted = host.querySelector('.overlay.ws-status');
    expect(mounted).not.toBeNull();
    root = mounted as HTMLElement;
  });

  afterEach(() => {
    panel.unmount();
    host.remove();
  });

  it('constructor 挂载 .overlay.ws-status 到 host，默认 hidden 且 visible=false', () => {
    expect(root).toBe(host.querySelector('.overlay.ws-status'));
    expect(root.hasAttribute('hidden')).toBe(true);
    expect(panel.visible).toBe(false);
    expect(panel.tab).toBe('overview');
  });

  it('open(vm) 显示面板并渲染四个 data-tab、13 槽、3 技能槽', () => {
    panel.open(makeVM());

    expect(panel.visible).toBe(true);
    expect(root.hasAttribute('hidden')).toBe(false);
    const tabs = Array.from(root.querySelectorAll('[data-tab]'))
      .map((el) => el.getAttribute('data-tab'))
      .sort();
    expect(tabs).toEqual(['equipment', 'overview', 'skills', 'stats']);
    expect(root.querySelectorAll('[data-slot]')).toHaveLength(13);
    expect(root.querySelectorAll('[data-skill-slot]')).toHaveLength(3);
  });

  it('装备页显示已装备名与空槽「空」占位', () => {
    panel.open(makeVM());
    panel.setTab('equipment');

    const slotTexts = Array.from(root.querySelectorAll('[data-slot]'))
      .map((el) => el.textContent ?? '');
    expect(slotTexts.some((text) => text.includes('青龙偃月刀'))).toBe(true);
    expect(slotTexts.some((text) => text.includes('空'))).toBe(true);
  });

  it('技能页显示 description 与 nextLevelGain', () => {
    const vm = makeVM();
    panel.open(vm);
    panel.setTab('skills');

    const skillText = Array.from(root.querySelectorAll('[data-skill-slot]'))
      .map((el) => el.textContent ?? '')
      .join(' | ');
    expect(skillText).toContain(vm.skills[0].description);
    expect(skillText).toContain(vm.skills[0].nextLevelGain);
  });

  it('数值页核心 4 项显示来源中文名', () => {
    panel.open(makeVM());
    panel.setTab('stats');

    const text = root.textContent ?? '';
    for (const name of ['基础', '词缀', '宝石', '套装']) {
      expect(text, `来源 ${name} 应在数值页可见`).toContain(name);
    }
  });

  it('setTab(skills) 切页后 tab=skills 且技能面板可见', () => {
    panel.open(makeVM());
    panel.setTab('skills');

    expect(panel.tab).toBe('skills');
    const slots = root.querySelectorAll('[data-skill-slot]');
    expect(slots).toHaveLength(3);
    for (const slot of slots) {
      expect(slot.closest('[hidden]'), '技能卡不应位于隐藏容器内').toBeNull();
    }
  });

  it('close() 隐藏面板并只触发一次 onClose，重复 close 幂等', () => {
    panel.open(makeVM());
    panel.close();

    expect(panel.visible).toBe(false);
    expect(root.hasAttribute('hidden')).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    panel.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('unmount() 移除 DOM 且幂等', () => {
    panel.open(makeVM());
    panel.unmount();

    expect(host.querySelector('.overlay.ws-status')).toBeNull();
    panel.unmount();
    expect(host.querySelector('.overlay.ws-status')).toBeNull();
  });
});
