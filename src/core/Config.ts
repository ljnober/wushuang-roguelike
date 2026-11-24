/**
 * 全局配置装配与校验（ARCHITECTURE §5.1 / §2.1 #12）。
 *
 * content pack 的具体注册由批次 A3 在 src/data/index.ts 完成，本模块只负责
 * 汇总 buildGameConfig()、统一 validateAll()，并在 loadConfig() 中把校验
 * 失败视为配置错误（1000）而不是静默降级。
 */
import { WushuangError } from './Constants';
import { buildGameConfig as buildFromPacks } from '../data/index';
import type { GameConfig } from '../data/types';

export { buildFromPacks as buildGameConfig };
export type { GameConfig };

interface NamedRegistryLike {
  validate(): string[];
  all(): readonly { readonly id: string }[];
}

function asRegistry(value: unknown): NamedRegistryLike | null {
  if (value && typeof (value as NamedRegistryLike).validate === 'function' &&
      typeof (value as NamedRegistryLike).all === 'function') {
    return value as NamedRegistryLike;
  }
  return null;
}

/** 汇总各注册表校验 + 关键数量下限检查；返回问题列表，空数组表示通过。 */
export function validateAll(config: GameConfig): string[] {
  const problems: string[] = [];

  const groups: ReadonlyArray<readonly [string, unknown]> = [
    ['generals', config.generals],
    ['enemies', config.enemies],
    ['skills', config.skills],
    ['effects', config.effects],
    ['equipment', config.equipment],
    ['bosses', config.bosses],
    ['gems', config.gems],
    ['legendaryGems', config.legendaryGems],
    ['cube', config.cube],
    ['stats', config.stats],
    ['modes', config.modes],
    ['drops', config.drops],
  ];

  for (let i = 0; i < groups.length; i++) {
    const name = groups[i][0];
    const registry = asRegistry(groups[i][1]);
    if (!registry) {
      problems.push(`[${name}] 注册表缺失`);
      continue;
    }
    const errors = registry.validate();
    for (let j = 0; j < errors.length; j++) {
      problems.push(`[${name}] ${errors[j]}`);
    }
  }

  const minimums: ReadonlyArray<readonly [string, number, number]> = [
    ['generals', config.generals ? config.generals.all().length : 0, 40],
    ['bosses', config.bosses ? config.bosses.all().length : 0, 8],
    ['legendaryGems', config.legendaryGems ? config.legendaryGems.all().length : 0, 6],
  ];
  for (let i = 0; i < minimums.length; i++) {
    const name = minimums[i][0];
    const actual = minimums[i][1];
    const expected = minimums[i][2];
    if (actual < expected) {
      problems.push(`[${name}] 数量 ${actual} < 要求 ${expected}`);
    }
  }

  if (!config.buckets || config.buckets.length === 0) {
    problems.push('[buckets] 乘区分桶为空');
  }
  if (!config.sourcePriority || config.sourcePriority.length === 0) {
    problems.push('[sourcePriority] 来源优先级链为空');
  }
  if (!config.waves || config.waves.length === 0) {
    problems.push('[waves] 波次表为空');
  }

  return problems;
}

/** 构建 + 校验；校验失败抛配置错误（1000），绝不带病启动。 */
export function loadConfig(): GameConfig {
  const config = buildFromPacks();
  const problems = validateAll(config);
  if (problems.length > 0) {
    throw new WushuangError(
      1000,
      `配置校验失败（${problems.length} 项）: ${problems.join('; ')}`,
    );
  }
  return config;
}
