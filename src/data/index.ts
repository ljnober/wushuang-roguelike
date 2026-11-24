/**
 * 内容装配入口：把所有 content pack 注册进 Registry，组装成 GameConfig。
 *
 * 事实来源：ARCHITECTURE.md §2.1 #15、§5.12。
 * 只读依赖 core/Registry；不依赖控制源 / 存档 / 战斗系统，避免循环。
 */
import { Registry } from '../core/Registry';
import { BOSS_DEFS, DROP_TABLE_DEFS, EFFECT_DEFS, ENEMY_DEFS, MODE_DEFS, SKILL_DEFS, WAVE_STAGES } from './combat';
import { CUBE_RECIPE_DEFS, EQUIPMENT_DEFS, GEM_DEFS, LEGENDARY_GEM_DEFS } from './equipment';
import { GENERAL_DEFS } from './generals';
import { BUCKETS, SOURCE_PRIORITY, STAT_DEFS } from './stats';
import type { GameConfig } from './types';

/**
 * 构建一份全新的 GameConfig（每次调用生成独立 Registry，便于测试隔离）。
 * 新增内容只需在对应 content pack 追加配置条目，无需改动本函数。
 */
export function buildGameConfig(): GameConfig {
  const config: GameConfig = {
    generals: new Registry('generals'),
    enemies: new Registry('enemies'),
    skills: new Registry('skills'),
    effects: new Registry('effects'),
    equipment: new Registry('equipment'),
    bosses: new Registry('bosses'),
    gems: new Registry('gems'),
    legendaryGems: new Registry('legendaryGems'),
    cube: new Registry('cube'),
    stats: new Registry('stats'),
    waves: [...WAVE_STAGES],
    modes: new Registry('modes'),
    drops: new Registry('drops'),
    buckets: BUCKETS,
    sourcePriority: SOURCE_PRIORITY,
  };

  for (let i = 0; i < GENERAL_DEFS.length; i++) config.generals.register(GENERAL_DEFS[i]);
  for (let i = 0; i < ENEMY_DEFS.length; i++) config.enemies.register(ENEMY_DEFS[i]);
  for (let i = 0; i < SKILL_DEFS.length; i++) config.skills.register(SKILL_DEFS[i]);
  for (let i = 0; i < EFFECT_DEFS.length; i++) config.effects.register(EFFECT_DEFS[i]);
  for (let i = 0; i < EQUIPMENT_DEFS.length; i++) config.equipment.register(EQUIPMENT_DEFS[i]);
  for (let i = 0; i < BOSS_DEFS.length; i++) config.bosses.register(BOSS_DEFS[i]);
  for (let i = 0; i < GEM_DEFS.length; i++) config.gems.register(GEM_DEFS[i]);
  for (let i = 0; i < LEGENDARY_GEM_DEFS.length; i++) config.legendaryGems.register(LEGENDARY_GEM_DEFS[i]);
  for (let i = 0; i < CUBE_RECIPE_DEFS.length; i++) config.cube.register(CUBE_RECIPE_DEFS[i]);
  for (let i = 0; i < STAT_DEFS.length; i++) config.stats.register(STAT_DEFS[i]);
  for (let i = 0; i < MODE_DEFS.length; i++) config.modes.register(MODE_DEFS[i]);
  for (let i = 0; i < DROP_TABLE_DEFS.length; i++) config.drops.register(DROP_TABLE_DEFS[i]);

  return config;
}
