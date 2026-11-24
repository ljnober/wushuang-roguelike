/**
 * 战斗世界构建（架构 §2.1 #35 / §5.5）：建世界 → 注册组件 → warm-up 断言 → spawn 守卫。
 */
import { assert, CAP } from '../core/Constants';
import { createBitWorld, registerAll, spawn, type BattleWorld } from './bit/adapter';
import { ALL_COMPONENTS } from './bit/components';
import type { Eid } from './bit/types';

const ERR_VERSIONING = 2001;
const ERR_EID_OVER_CAP = 2002;
const ERR_WARMUP = 2003;

/**
 * warm-up：所有 SoA 字段数组长度必须等于 CAP，且组件清单与注册清单一致。
 * 标签组件没有字段，跳过字段校验。
 */
export function warmUpAssertions(world: BattleWorld): void {
  assert(
    world.index.versioning === false,
    ERR_VERSIONING,
    'warm-up: entity versioning 必须关闭',
  );
  assert(
    world.components.length === ALL_COMPONENTS.length,
    ERR_WARMUP,
    `warm-up: 已注册组件数 ${world.components.length} != ${ALL_COMPONENTS.length}`,
  );
  for (let i = 0; i < world.components.length; i++) {
    const comp = world.components[i];
    const fields = Object.keys(comp);
    for (let f = 0; f < fields.length; f++) {
      const fieldName = fields[f];
      const array = comp[fieldName];
      assert(
        array !== undefined && array.length === CAP,
        ERR_WARMUP,
        `warm-up: 字段 ${fieldName} 的长度必须为 CAP=${CAP}`,
      );
    }
  }
}

/** 创建并完成 warm-up 的战斗世界 */
export function createBattleWorld(label: string = 'battle'): BattleWorld {
  const world = createBitWorld(label);
  registerAll(world, ALL_COMPONENTS);
  warmUpAssertions(world);
  return world;
}

/** spawn 守卫：adapter.spawn 已断言一次，这里保留边界二次校验（生产构建不移除） */
export function spawnEntity(world: BattleWorld): Eid {
  const eid = spawn(world);
  assert(eid < CAP, ERR_EID_OVER_CAP, `spawn eid ${eid} 超出 CAP=${CAP}`);
  return eid;
}
