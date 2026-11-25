/**
 * 战斗内容配置：技能 / 敌人 / 效果 / 8 位名将 BOSS / 6 阶段波次 / 双模式 / 掉落表。
 *
 * 事实来源：DESIGN.md §8.1 / §8.3，ARCHITECTURE.md §5.12。
 * 所有数值只由配置与 tick 决定，不随设备/画质变化（DESIGN §2.2 硬性约束）。
 */
import { EXP_CURVE } from '../core/Constants';
import type {
  ActionDef,
  ActionOp,
  BossDef,
  DropTableDef,
  EffectDef,
  EnemyDef,
  ModeDef,
  SkillDef,
  TriggerType,
  WaveStage,
} from './types';

/** 经验曲线：直接引用冻结常量（expToNext(L) = round(10+8L+0.8L²)）。 */
export function expToNext(level: number): number {
  return EXP_CURVE(level);
}
export { EXP_CURVE };

// ---------------------------------------------------------------------------
// 效果定义
// ---------------------------------------------------------------------------

interface EffectPart {
  op: ActionOp;
  params: readonly number[];
}

/** 把若干动作片段线性展开到 params，自动计算 paramRef/paramCount（零运行时查找的编译期数据）。 */
function mkEffect(id: string, trigger: TriggerType, parts: readonly EffectPart[]): EffectDef {
  const params: number[] = [];
  const actions: ActionDef[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const paramRef = params.length;
    for (let j = 0; j < part.params.length; j++) params.push(part.params[j]);
    actions.push({ op: part.op, paramRef, paramCount: part.params.length });
  }
  return { id, trigger, conditions: [], actions, params };
}

/** 效果表：每个技能对应一个 onCast 效果；另含通用 onHit/onKill 效果。 */
export const EFFECT_DEFS: readonly EffectDef[] = [
  // 普攻必须在施法瞬间结算：它是第一次伤害的来源。若留作 onHit，
  // 没有任何命中事件能启动链路，效果编译后永远等不到触发（无法击杀怪物）。
  mkEffect('eff_basic_attack', 'onCast', [{ op: 'damage', params: [24, 90, 1] }]),
  mkEffect('eff_sweeping_slash', 'onCast', [
    { op: 'area', params: [110, 0.2, 1.2] },
    { op: 'damage', params: [42, 110, 1] },
  ]),
  mkEffect('eff_war_cry', 'onCast', [
    { op: 'buffStat', params: [0, 0.15, 5] },
    { op: 'area', params: [140, 0.1, 1] },
  ]),
  mkEffect('eff_dragon_roar', 'onCast', [
    { op: 'area', params: [150, 0.35, 1] },
    { op: 'damage', params: [60, 150, 1] },
    { op: 'status', params: [1, 1.0, 0.5] },
  ]),
  mkEffect('eff_thunder_strike', 'onCast', [
    { op: 'spawnProjectile', params: [420, 1, 0] },
    { op: 'damage', params: [72, 130, 1] },
  ]),
  mkEffect('eff_spear_thrust', 'onHit', [
    { op: 'damage', params: [48, 160, 1] },
  ]),
  mkEffect('eff_tiger_charge', 'onCast', [
    { op: 'area', params: [90, 0.4, 1.4] },
    { op: 'damage', params: [55, 90, 1] },
  ]),
  mkEffect('eff_arrow_rain', 'onCast', [
    { op: 'spawnProjectile', params: [360, 12, 180] },
    { op: 'damage', params: [18, 240, 1] },
  ]),
  mkEffect('eff_moon_slash', 'onHit', [
    { op: 'damage', params: [50, 120, 1] },
  ]),
  mkEffect('eff_fire_wave', 'onCast', [
    { op: 'area', params: [130, 0.6, 1] },
    { op: 'damage', params: [36, 210, 1] },
    { op: 'status', params: [7, 2.0, 6] },
  ]),
  mkEffect('eff_fan_gust', 'onCast', [
    { op: 'area', params: [170, 0.5, 0.8] },
    { op: 'status', params: [2, 0.8, 0.3] },
  ]),
  mkEffect('eff_blade_dance', 'onCast', [
    { op: 'damage', params: [28, 100, 3] },
  ]),
  mkEffect('eff_whirlwind', 'onCast', [
    { op: 'area', params: [120, 0.8, 1.1] },
    { op: 'damage', params: [35, 120, 2] },
  ]),
  mkEffect('eff_chain_lightning', 'onHit', [
    { op: 'spawnProjectile', params: [500, 4, 90] },
    { op: 'damage', params: [40, 180, 1] },
  ]),
  mkEffect('eff_shadow_step', 'onCast', [
    { op: 'buffStat', params: [7, 0.4, 2] },
  ]),
  mkEffect('eff_soul_drain', 'onHit', [
    { op: 'damage', params: [44, 120, 1] },
    { op: 'heal', params: [12, 0, 0] },
  ]),
  mkEffect('eff_golden_shield', 'onCast', [
    { op: 'buffStat', params: [3, 60, 6] },
    { op: 'heal', params: [30, 0, 0] },
  ]),
  mkEffect('eff_ice_nova', 'onCast', [
    { op: 'area', params: [140, 0.8, 0.9] },
    { op: 'status', params: [3, 1.2, 0.6] },
    { op: 'damage', params: [45, 140, 1] },
  ]),
  mkEffect('eff_poison_cloud', 'onCast', [
    { op: 'area', params: [120, 3.0, 0.7] },
    { op: 'status', params: [4, 3.0, 8] },
  ]),
  mkEffect('eff_earthquake', 'onCast', [
    { op: 'area', params: [180, 0.5, 1.6] },
    { op: 'damage', params: [85, 180, 1] },
    { op: 'status', params: [5, 1.0, 0.4] },
  ]),
  mkEffect('eff_phoenix', 'onCast', [
    { op: 'summon', params: [1, 5.0, 0] },
    { op: 'area', params: [160, 0.7, 1.3] },
    { op: 'damage', params: [70, 160, 1] },
  ]),
  mkEffect('eff_web_trap', 'onCast', [
    { op: 'area', params: [130, 3.0, 0.5] },
    { op: 'status', params: [6, 2.0, 0.5] },
  ]),
  mkEffect('eff_heal_light', 'onCast', [
    { op: 'heal', params: [60, 0, 0] },
    { op: 'buffStat', params: [2, 0.1, 4] },
  ]),
  // 全局触发类效果
  mkEffect('eff_on_kill_lifesteal', 'onKill', [{ op: 'heal', params: [4, 0, 0] }]),
  mkEffect('eff_on_critical_burst', 'onCritical', [
    { op: 'spawnProjectile', params: [480, 1, 0] },
  ]),
] as const;

// ---------------------------------------------------------------------------
// 技能定义
// ---------------------------------------------------------------------------

function mkSkill(
  id: string,
  name: string,
  cooldown: number,
  range: number,
  damage: number,
  tags: readonly string[],
  effectId: string,
  projectile?: string,
): SkillDef {
  return { id, name, cooldown, range, damage, tags: [...tags], effectId, projectile, level: 1, cost: 0 };
}

export const SKILL_DEFS: readonly SkillDef[] = [
  mkSkill('basic_attack', '普攻', 0.55, 90, 24, ['melee', 'basic'], 'eff_basic_attack'),
  mkSkill('sweeping_slash', '横扫千军', 3.2, 110, 42, ['melee', 'slash', 'aoe'], 'eff_sweeping_slash'),
  mkSkill('war_cry', '战吼', 6.0, 140, 0, ['buff', 'shout'], 'eff_war_cry'),
  mkSkill('dragon_roar', '龙吟', 7.5, 150, 60, ['shout', 'aoe', 'stun'], 'eff_dragon_roar'),
  mkSkill('thunder_strike', '雷击', 5.0, 130, 72, ['lightning', 'projectile'], 'eff_thunder_strike', 'proj_bolt'),
  mkSkill('spear_thrust', '龙胆突刺', 3.8, 160, 48, ['spear', 'melee'], 'eff_spear_thrust'),
  mkSkill('tiger_charge', '虎冲', 6.5, 90, 55, ['charge', 'melee', 'aoe'], 'eff_tiger_charge'),
  mkSkill('arrow_rain', '箭雨', 8.0, 240, 18, ['arrow', 'aoe', 'projectile'], 'eff_arrow_rain', 'proj_arrow'),
  mkSkill('moon_slash', '月斩', 4.2, 120, 50, ['slash', 'melee'], 'eff_moon_slash'),
  mkSkill('fire_wave', '火浪', 6.0, 210, 36, ['fire', 'aoe', 'projectile'], 'eff_fire_wave', 'proj_fire'),
  mkSkill('fan_gust', '扇风', 5.5, 170, 20, ['wind', 'aoe', 'control'], 'eff_fan_gust'),
  mkSkill('blade_dance', '剑舞', 4.6, 100, 28, ['slash', 'melee', 'combo'], 'eff_blade_dance'),
  mkSkill('whirlwind', '旋风斩', 5.8, 120, 35, ['slash', 'aoe', 'melee'], 'eff_whirlwind'),
  mkSkill('chain_lightning', '连锁闪电', 5.2, 180, 40, ['lightning', 'projectile'], 'eff_chain_lightning', 'proj_bolt'),
  mkSkill('shadow_step', '影步', 7.0, 0, 0, ['mobility', 'buff'], 'eff_shadow_step'),
  mkSkill('soul_drain', '摄魂', 6.2, 120, 44, ['dark', 'lifeSteal'], 'eff_soul_drain'),
  mkSkill('golden_shield', '金盾', 12.0, 0, 0, ['shield', 'buff', 'heal'], 'eff_golden_shield'),
  mkSkill('ice_nova', '冰环', 7.2, 140, 45, ['ice', 'aoe', 'control'], 'eff_ice_nova'),
  mkSkill('poison_cloud', '毒雾', 8.5, 120, 12, ['poison', 'aoe', 'dot'], 'eff_poison_cloud'),
  mkSkill('earthquake', '地震', 9.0, 180, 85, ['earth', 'aoe', 'stun'], 'eff_earthquake'),
  mkSkill('phoenix', '凤凰', 14.0, 160, 70, ['fire', 'summon', 'aoe'], 'eff_phoenix'),
  mkSkill('web_trap', '罗网', 7.8, 130, 10, ['control', 'trap', 'aoe'], 'eff_web_trap'),
  mkSkill('heal_light', '治疗光', 10.0, 0, 0, ['heal', 'buff'], 'eff_heal_light'),
] as const;

// ---------------------------------------------------------------------------
// 敌人定义
// ---------------------------------------------------------------------------

export const ENEMY_DEFS: readonly EnemyDef[] = [
  { id: 'huangjin', name: '黄巾兵', kind: 'melee', hp: 40, damage: 8, speed: 90, range: 24, attackRate: 1.0, radius: 12, exp: 1, color: 0xd4a017, behavior: 'chase' },
  { id: 'huangjin_archer', name: '黄巾弓兵', kind: 'ranged', hp: 30, damage: 10, speed: 80, range: 220, attackRate: 0.8, radius: 11, exp: 1, color: 0xcdaa5a, behavior: 'kite' },
  { id: 'huangjin_cavalry', name: '黄巾骑兵', kind: 'cavalry', hp: 90, damage: 16, speed: 180, range: 28, attackRate: 1.2, radius: 16, exp: 2, color: 0x8b0000, behavior: 'charge' },
  { id: 'elite_soldier', name: '精英战将', kind: 'elite', hp: 320, damage: 24, speed: 120, range: 30, attackRate: 1.4, radius: 18, exp: 10, color: 0xffd700, behavior: 'charger' },
  { id: 'boss_minion', name: 'BOSS 亲兵', kind: 'bossMinion', hp: 70, damage: 14, speed: 130, range: 26, attackRate: 1.3, radius: 13, exp: 1, color: 0x8e44ad, behavior: 'chase' },
  { id: 'boss_bodyguard', name: 'BOSS 卫队', kind: 'bossMinion', hp: 120, damage: 18, speed: 115, range: 28, attackRate: 1.1, radius: 14, exp: 2, color: 0x6a1b9a, behavior: 'guard' },
] as const;

// ---------------------------------------------------------------------------
// 8 位名将 BOSS（DESIGN §8.3）
// ---------------------------------------------------------------------------

export const BOSS_DEFS: readonly BossDef[] = [
  {
    id: 'boss_lvbu',
    phases: [
      { hpThreshold: 1.0, skills: [
        { id: 'lvbu_cleave', telegraph: 0.8, pattern: 'frontal_arc_120', counter: 'dodge_behind' },
        { id: 'lvbu_leap', telegraph: 1.0, pattern: 'ground_circle_aoe', counter: 'move_out' },
      ] },
      { hpThreshold: 0.6, skills: [
        { id: 'lvbu_sweep', telegraph: 0.6, pattern: 'rotating_arc', counter: 'iframe_or_jump' },
        { id: 'lvbu_summon', telegraph: 1.2, pattern: 'summon_minions', counter: 'kill_minions' },
      ] },
      { hpThreshold: 0.3, skills: [
        { id: 'lvbu_rage', telegraph: 0.5, pattern: 'radial_bullets_16', counter: 'gap_dodge' },
        { id: 'lvbu_charge', telegraph: 0.9, pattern: 'line_charge', counter: 'side_step' },
      ] },
    ],
  },
  {
    id: 'boss_zhangjiao',
    phases: [
      { hpThreshold: 1.0, skills: [
        { id: 'zj_lightning', telegraph: 1.1, pattern: 'targeted_strike', counter: 'keep_moving' },
        { id: 'zj_talisman', telegraph: 1.4, pattern: 'tracking_projectiles', counter: 'circle_strafe' },
      ] },
      { hpThreshold: 0.6, skills: [
        { id: 'zj_storm', telegraph: 1.6, pattern: 'random_ground_zones', counter: 'read_ground' },
        { id: 'zj_summon', telegraph: 1.2, pattern: 'summon_minions', counter: 'kill_minions' },
      ] },
      { hpThreshold: 0.3, skills: [
        { id: 'zj_heal', telegraph: 1.8, pattern: 'self_buff_shield', counter: 'burst_damage' },
        { id: 'zj_thunder', telegraph: 0.7, pattern: 'radial_bullets_12', counter: 'gap_dodge' },
      ] },
    ],
  },
  {
    id: 'boss_caocao',
    phases: [
      { hpThreshold: 1.0, skills: [
        { id: 'cc_sword_wave', telegraph: 0.9, pattern: 'frontal_wave', counter: 'side_step' },
        { id: 'cc_command', telegraph: 1.3, pattern: 'summon_bodyguard', counter: 'focus_boss' },
      ] },
      { hpThreshold: 0.6, skills: [
        { id: 'cc_cross', telegraph: 1.0, pattern: 'crossing_lines', counter: 'stand_in_quadrant' },
        { id: 'cc_retreat', telegraph: 1.5, pattern: 'reposition_blink', counter: 'track_position' },
      ] },
      { hpThreshold: 0.3, skills: [
        { id: 'cc_rage', telegraph: 0.6, pattern: 'expanding_ring', counter: 'dash_through_gap' },
        { id: 'cc_execute', telegraph: 1.1, pattern: 'targeted_strike', counter: 'keep_moving' },
      ] },
    ],
  },
  {
    id: 'boss_guanyu',
    phases: [
      { hpThreshold: 1.0, skills: [
        { id: 'gy_cleave', telegraph: 0.9, pattern: 'frontal_arc_180', counter: 'dodge_behind' },
        { id: 'gy_dash', telegraph: 1.0, pattern: 'line_charge', counter: 'side_step' },
      ] },
      { hpThreshold: 0.6, skills: [
        { id: 'gy_whirl', telegraph: 0.7, pattern: 'rotating_arc', counter: 'move_out' },
        { id: 'gy_roar', telegraph: 1.4, pattern: 'cone_knockback', counter: 'approach_from_side' },
      ] },
      { hpThreshold: 0.3, skills: [
        { id: 'gy_blade_wave', telegraph: 0.6, pattern: 'radial_bullets_8', counter: 'gap_dodge' },
        { id: 'gy_rush', telegraph: 0.8, pattern: 'repeated_charge', counter: 'circle_strafe' },
      ] },
    ],
  },
  {
    id: 'boss_zhouyu',
    phases: [
      { hpThreshold: 1.0, skills: [
        { id: 'zy_fire_wave', telegraph: 1.2, pattern: 'frontal_cone_fire', counter: 'flank' },
        { id: 'zy_arrow', telegraph: 1.0, pattern: 'arrow_volley', counter: 'keep_moving' },
      ] },
      { hpThreshold: 0.6, skills: [
        { id: 'zy_burn', telegraph: 1.5, pattern: 'random_ground_zones', counter: 'read_ground' },
        { id: 'zy_wind', telegraph: 1.3, pattern: 'push_wind_lane', counter: 'side_step' },
      ] },
      { hpThreshold: 0.3, skills: [
        { id: 'zy_inferno', telegraph: 1.8, pattern: 'expanding_fire_ring', counter: 'dash_through_gap' },
        { id: 'zy_volley', telegraph: 0.7, pattern: 'radial_bullets_16', counter: 'gap_dodge' },
      ] },
    ],
  },
  {
    id: 'boss_zhaoyun',
    phases: [
      { hpThreshold: 1.0, skills: [
        { id: 'zy_spear', telegraph: 0.7, pattern: 'frontal_thrust', counter: 'side_step' },
        { id: 'zy_dash', telegraph: 0.9, pattern: 'line_charge', counter: 'dodge_behind' },
      ] },
      { hpThreshold: 0.6, skills: [
        { id: 'zy_whirl', telegraph: 0.6, pattern: 'rotating_arc', counter: 'move_out' },
        { id: 'zy_sweep', telegraph: 1.0, pattern: 'ground_circle_aoe', counter: 'move_out' },
      ] },
      { hpThreshold: 0.3, skills: [
        { id: 'zy_rain', telegraph: 0.8, pattern: 'radial_bullets_12', counter: 'gap_dodge' },
        { id: 'zy_mirror', telegraph: 1.1, pattern: 'afterimage_clones', counter: 'track_real' },
      ] },
    ],
  },
  {
    id: 'boss_dianwei',
    phases: [
      { hpThreshold: 1.0, skills: [
        { id: 'dw_slam', telegraph: 1.1, pattern: 'ground_circle_aoe', counter: 'move_out' },
        { id: 'dw_swing', telegraph: 0.8, pattern: 'frontal_arc_120', counter: 'dodge_behind' },
      ] },
      { hpThreshold: 0.6, skills: [
        { id: 'dw_quake', telegraph: 1.4, pattern: 'expanding_ring', counter: 'jump_or_iframe' },
        { id: 'dw_charge', telegraph: 1.0, pattern: 'line_charge', counter: 'side_step' },
      ] },
      { hpThreshold: 0.3, skills: [
        { id: 'dw_frenzy', telegraph: 0.5, pattern: 'rapid_multi_hit', counter: 'keep_distance' },
        { id: 'dw_quake2', telegraph: 1.2, pattern: 'random_ground_zones', counter: 'read_ground' },
      ] },
    ],
  },
  {
    id: 'boss_diaochan',
    phases: [
      { hpThreshold: 1.0, skills: [
        { id: 'dc_charm', telegraph: 1.2, pattern: 'targeted_confusion', counter: 'break_line_of_sight' },
        { id: 'dc_blades', telegraph: 0.7, pattern: 'boomerang_projectiles', counter: 'circle_strafe' },
      ] },
      { hpThreshold: 0.6, skills: [
        { id: 'dc_dance', telegraph: 1.0, pattern: 'rotating_bullet_spiral', counter: 'gap_dodge' },
        { id: 'dc_summon', telegraph: 1.3, pattern: 'summon_guards', counter: 'kill_minions' },
      ] },
      { hpThreshold: 0.3, skills: [
        { id: 'dc_seduce', telegraph: 1.5, pattern: 'cone_charm', counter: 'flank' },
        { id: 'dc_flurry', telegraph: 0.6, pattern: 'radial_bullets_16', counter: 'keep_moving' },
      ] },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// 8 分钟六阶段波次表（DESIGN §8.1）
// ---------------------------------------------------------------------------

export const WAVE_STAGES: readonly WaveStage[] = [
  { id: 'wave_1_familiar', startSec: 0, endSec: 60, spawnRateStart: 2, spawnRateEnd: 2, cap: 60, enemies: ['huangjin'], elitesAt: [] },
  { id: 'wave_2_archer', startSec: 60, endSec: 150, spawnRateStart: 3, spawnRateEnd: 5, cap: 120, enemies: ['huangjin', 'huangjin_archer'], elitesAt: [120] },
  { id: 'wave_3_cavalry', startSec: 150, endSec: 240, spawnRateStart: 5, spawnRateEnd: 8, cap: 180, enemies: ['huangjin', 'huangjin_archer', 'huangjin_cavalry'], elitesAt: [180, 210] },
  { id: 'wave_4_mixed', startSec: 240, endSec: 330, spawnRateStart: 8, spawnRateEnd: 12, cap: 240, enemies: ['huangjin', 'huangjin_archer', 'huangjin_cavalry'], elitesAt: [270, 300, 300] },
  { id: 'wave_5_saturation', startSec: 330, endSec: 420, spawnRateStart: 12, spawnRateEnd: 18, cap: 300, enemies: ['huangjin', 'huangjin_archer', 'huangjin_cavalry'], elitesAt: [345, 375, 405] },
  { id: 'wave_6_boss', startSec: 420, endSec: 480, spawnRateStart: 4, spawnRateEnd: 6, cap: 200, enemies: ['boss_minion', 'boss_bodyguard'], elitesAt: [420] },
] as const;

/** BOSS 登场提前预警秒数（BossSystem 在 415s 发 BossWarn）。 */
export const BOSS_WARN_LEAD_SEC = 5;

// ---------------------------------------------------------------------------
// 双模式（DESIGN §8.1）
// ---------------------------------------------------------------------------

export const MODE_DEFS: readonly ModeDef[] = [
  {
    id: 'campaign_8min',
    name: '八分钟无双',
    durationSec: 480,
    unlockAfterFirstBoss: false,
    bossAtSec: 420,
    scoreFormula: 'campaign',
  },
  {
    id: 'endless',
    name: '无尽征程',
    durationSec: 0,
    unlockAfterFirstBoss: true,
    bossAtSec: 300,
    scoreFormula: 'endless',
    endless: {
      hpBase: 1,
      hpLinear: 0.12,
      hpQuad: 0.03,
      dmgBase: 1,
      dmgLinear: 0.06,
      spawnBase: 6,
      spawnLinear: 4,
      spawnCap: 40,
      eliteEverySec: 120,
      bossEverySec: 300,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// 掉落表（材料 id 见 equipment.ts MATERIAL_DEFS）
// ---------------------------------------------------------------------------

export const DROP_TABLE_DEFS: readonly DropTableDef[] = [
  {
    id: 'drop_common',
    entries: [
      { itemId: 'essence', weight: 62, minQty: 1, maxQty: 2 },
      // 普通怪也掉白/蓝装：让「刷怪 → 掉装备 → 换装」闭环在第一分钟就能被玩家感知。
      { itemId: 'equipment_common', weight: 8, minQty: 1, maxQty: 1 },
      { itemId: 'equipment_blue', weight: 2, minQty: 1, maxQty: 1 },
      { itemId: 'gem_red_t1', weight: 10, minQty: 1, maxQty: 1 },
      { itemId: 'gem_blue_t1', weight: 10, minQty: 1, maxQty: 1 },
      { itemId: 'gem_yellow_t1', weight: 5, minQty: 1, maxQty: 1 },
      { itemId: 'gem_green_t1', weight: 5, minQty: 1, maxQty: 1 },
    ],
    pity: 0,
    smartLoot: false,
  },
  {
    id: 'drop_elite',
    entries: [
      { itemId: 'soul', weight: 50, minQty: 1, maxQty: 3 },
      { itemId: 'equipment_gold', weight: 30, minQty: 1, maxQty: 1 },
      { itemId: 'equipment_legendary', weight: 8, minQty: 1, maxQty: 1 },
      { itemId: 'gem_red_t3', weight: 12, minQty: 1, maxQty: 1 },
    ],
    pity: 12,
    smartLoot: true,
  },
  {
    id: 'drop_boss',
    entries: [
      { itemId: 'bossToken', weight: 40, minQty: 1, maxQty: 2 },
      { itemId: 'equipment_legendary', weight: 35, minQty: 1, maxQty: 1 },
      { itemId: 'soul', weight: 25, minQty: 3, maxQty: 6 },
    ],
    pity: 4,
    smartLoot: true,
  },
] as const;
