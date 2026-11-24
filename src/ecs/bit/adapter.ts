/**
 * 唯一允许 import 'bitecs' 的文件（架构 §1.2 / §5.5）。
 *
 * §1.2 已核实的 bitECS 0.4.0 真实 API 结论（DESIGN.md 的 0.3.x 心智模型不适用）：
 *  1. core 中不存在 defineComponent / Types；组件是普通 SoA 对象，须自行 new Float32Array(CAP)，
 *     并在建世界后显式 registerComponents(world, comps)。旧 API 只在 bitecs/legacy。
 *  2. createWorld(...args)：第一个参数传 createEntityIndex() 可共享 eid 空间，object 作为 context；
 *     本适配器用 createWorld(createEntityIndex(), { label })。
 *  3. addComponent(world, eid, Comp) —— 参数顺序已由 0.3.x 的 world→Comp→eid 改为 world→eid→Comp。
 *  4. query(world, terms, asBuffer) 返回 Uint32Array；noCommit 可在迭代中避免提交删除。
 *  5. createRelation(options) / getRelationTargets(world, eid, rel) 可用，pair 组件在 addComponent 时自动注册。
 *  6. 0.4.0 没有 enableManualEntityRecycling / flushRemovedEntities。
 *     回收用 removeEntity(world, eid) + commitRemovals(world)，空闲 eid 由 EntityPool 维护。
 *  7. createEntityIndex() 默认 versioning === false，与「禁用 eid versioning」约束一致；
 *     withVersioning(bits) 才会开启，本适配器启动与 spawn 时均断言。
 *  8. bitECS 不管理组件存储容量：defineSoA 分配定长数组，spawn 断言 eid < CAP，
 *     warm-up 断言所有字段数组长度 == CAP。
 *
 * 锁定策略：package.json 固定 "bitecs": "0.4.0"；业务层禁止直接 import 'bitecs'。
 */
import * as bit from 'bitecs';
import type { World, EntityId, QueryTerm, Relation } from 'bitecs';
import { assert, CAP } from '../../core/Constants';
import type { Eid, SoAComponent } from './types';

/** 便于其它模块以类型方式引用 bitECS Relation，而无需直接 import 'bitecs' */
export type BitRelation<T> = Relation<T>;

/** 建世界后由 registerAll 填充的组件清单，warm-up 据此校验容量 */
export interface BattleWorld extends World<{ label: string }> {
  readonly index: ReturnType<typeof bit.createEntityIndex>;
  readonly components: SoAComponent[];
}

/** 断言失败码：ECS / CAP / eid 段（§6.4 的 2xxx） */
const ERR_VERSIONING = 2001;
const ERR_EID_OVER_CAP = 2002;
const ERR_WORLD_CONTEXT = 2010;

/**
 * 创建战斗世界：显式共享 EntityIndex，并写入自定义 context label。
 * createEntityIndex() 默认关闭 versioning；这里做启动断言。
 */
export function createBitWorld(label: string): BattleWorld {
  const index = bit.createEntityIndex();
  assert(index.versioning === false, ERR_VERSIONING, 'bitECS entity versioning 必须保持关闭');

  const base = bit.createWorld<{ label: string }>(index, { label });
  assert(base.label === label, ERR_WORLD_CONTEXT, 'createWorld 未正确写入 context.label');

  const world = Object.assign(base, {
    index,
    components: [] as SoAComponent[],
  }) as BattleWorld;
  return world;
}

/**
 * 注册全部组件（SoA / 标签）。关系组件是函数，其 pair 组件由 bitECS 在 addComponent 时按需注册。
 */
export function registerAll(world: BattleWorld, components: SoAComponent[]): void {
  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    assert(comp != null, ERR_WORLD_CONTEXT, 'registerAll 收到空组件');
    world.components.push(comp);
  }
  bit.registerComponents(world, components);
}

/** 生成新实体。eid 由 bitECS EntityIndex 分配；versioning 关闭时回收后可复用同一 eid。 */
export function spawn(world: BattleWorld): Eid {
  const eid = bit.addEntity(world);
  assert(eid < CAP, ERR_EID_OVER_CAP, `eid ${eid} 超出 CAP=${CAP}`);
  assert(world.index.versioning === false, ERR_VERSIONING, 'spawn 时 versioning 必须保持关闭');
  return eid;
}

/** 立即从世界移除实体并提交查询侧的延迟移除 */
export function recycle(world: BattleWorld, eid: Eid): void {
  bit.removeEntity(world, eid as EntityId);
  bit.commitRemovals(world);
}

/** 挂载组件（0.4.0 参数顺序：world → eid → comp） */
export function add(
  world: BattleWorld,
  eid: Eid,
  comp: SoAComponent | Relation<unknown>,
): void {
  bit.addComponent(world, eid as EntityId, comp);
}

/** 卸载组件 */
export function remove(world: BattleWorld, eid: Eid, comp: SoAComponent): void {
  bit.removeComponent(world, eid as EntityId, comp);
}

/** 组件是否存在 */
export function has(world: BattleWorld, eid: Eid, comp: SoAComponent): boolean {
  return bit.hasComponent(world, eid as EntityId, comp);
}

/**
 * 关系函数作为查询项时，bitECS 0.4.0 只匹配「关系函数本身」这个组件引用，
 * 而实体上挂的是 rel(target) 生成的 pair 组件，因此裸关系项永远匹配不到实体。
 * 这里统一转成 wildcard pair 项 rel('*')（addComponent 会同时挂 Pair(rel, Wildcard)）。
 * 没有关系项时直接返回原数组，热路径零分配。
 */
function normalizeQueryTerms(terms: QueryTerm[]): QueryTerm[] {
  let converted: QueryTerm[] | null = null;
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (typeof term === 'function' && bit.isRelation(term)) {
      if (converted === null) {
        converted = terms.slice();
      }
      converted[i] = (term as Relation<unknown>)('*') as QueryTerm;
    }
  }
  return converted ?? terms;
}

/** 查询（缓冲为 Uint32Array，零分配复用查询内部缓冲） */
export function query(world: BattleWorld, terms: QueryTerm[]): Readonly<Uint32Array> {
  return bit.query(world, normalizeQueryTerms(terms), bit.asBuffer) as Readonly<Uint32Array>;
}

/** 查询且不提交延迟删除（用于遍历中可能触发移除的场景） */
export function queryNoCommit(world: BattleWorld, terms: QueryTerm[]): Readonly<Uint32Array> {
  return bit.query(
    world,
    normalizeQueryTerms(terms),
    bit.asBuffer,
    bit.noCommit,
  ) as Readonly<Uint32Array>;
}

/** 提交查询侧的延迟移除 */
export function commit(world: BattleWorld): void {
  bit.commitRemovals(world);
}

/** 实体是否仍存活 */
export function exists(world: BattleWorld, eid: Eid): boolean {
  return bit.entityExists(world, eid as EntityId);
}

/**
 * 关系组件工厂。T 建议取 SoAComponent，使 rel(target) 的返回值可直接传给 add()。
 * exclusive / autoRemoveSubject 为 bitECS 0.4.0 原生选项。
 */
export function defineRelation<T>(opts?: {
  store?: () => T;
  exclusive?: boolean;
  autoRemoveSubject?: boolean;
}): Relation<T> {
  if (opts === undefined) {
    return bit.createRelation<T>();
  }
  return bit.createRelation<T>({
    store: opts.store,
    exclusive: opts.exclusive,
    autoRemoveSubject: opts.autoRemoveSubject,
  });
}

/** 读取某实体上该关系的所有 target eid */
export function targets(world: BattleWorld, eid: Eid, rel: Relation<unknown>): number[] {
  return bit.getRelationTargets(world, eid as EntityId, rel);
}
