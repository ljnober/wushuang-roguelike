/**
 * 实体池（架构 §5.6）。
 *
 * bitECS 0.4.0 的 EntityIndex 自身已带空闲 eid 回收（versioning 关闭时复用同一 eid），
 * 本池再用一个空闲栈显式记录「已 release、可复用」的 eid，并在 acquire 时与 bitECS
 * 实际返回的 eid 对齐：两者的复用顺序可能不同，故以 bitECS 返回的 eid 为唯一真值。
 */
import { assert, CAP, EFFECT_ENTITY_BASE } from '../../core/Constants';
import {
  add,
  recycle,
  spawn,
  type BattleWorld,
} from '../bit/adapter';
import type { Eid } from '../bit/types';
import {
  ActiveEffect,
  ChildOf,
  EffectOwner,
  EffectTag,
  effectMask,
} from '../bit/components';

const ERR_POOL_RANGE = 2005;
const ERR_EID_OVER_CAP = 2002;

export class EntityPool {
  /** 已释放、可被复用的 eid 栈 */
  private readonly free: Eid[] = [];
  /** 当前从本池取出且尚未释放的实体数 */
  private liveCount = 0;

  constructor(
    protected readonly world: BattleWorld,
    readonly base: number,
    readonly capacity: number,
  ) {
    assert(
      base >= 0 && capacity > 0 && base < CAP,
      ERR_POOL_RANGE,
      `实体池区间非法: base=${base}, capacity=${capacity}`,
    );
  }

  /**
   * 取一个 eid：优先复用空闲栈；否则在 bitECS 中新建。
   * 断言 eid < CAP（生产构建也保留该断言，静默越界会破坏确定性）。
   */
  acquire(): Eid {
    let eid: Eid;
    if (this.free.length > 0) {
      const wanted = this.free.pop() as Eid;
      eid = spawn(this.world);
      if (eid !== wanted) {
        // bitECS 内部空闲顺序与本池栈顺序不一致：保留 wanted，移除实际取到的 eid。
        this.free.push(wanted);
        const idx = this.free.indexOf(eid);
        if (idx >= 0) {
          this.free.splice(idx, 1);
        }
      }
    } else {
      eid = spawn(this.world);
    }
    assert(eid < CAP, ERR_EID_OVER_CAP, `eid ${eid} 超出 CAP=${CAP}`);
    this.liveCount++;
    return eid;
  }

  /** 回收：先 recycle(world,eid)，再把 eid 压回空闲栈。调用方负责清理组件数据。 */
  release(eid: Eid): void {
    assert(eid >= 0 && eid < CAP, ERR_EID_OVER_CAP, `release 非法 eid=${eid}`);
    recycle(this.world, eid);
    if (this.free.indexOf(eid) < 0) {
      this.free.push(eid);
    }
    if (this.liveCount > 0) {
      this.liveCount--;
    }
  }

  /** 还能分配多少实体（线性段剩余 + 已回收数量） */
  get available(): number {
    return Math.max(0, this.capacity - this.liveCount);
  }

  /** 当前池中活跃实体数 */
  get inUse(): number {
    return this.liveCount;
  }
}

/** 效果逻辑实体专用池，预留段起点 EFFECT_ENTITY_BASE（设计 §3 / 架构 §5.6） */
export class EffectEntityPool extends EntityPool {
  constructor(world: BattleWorld) {
    super(world, EFFECT_ENTITY_BASE, CAP - EFFECT_ENTITY_BASE);
  }

  /**
   * 编译一个效果主实体：填充 ActiveEffect、挂 EffectTag / EffectOwner 关系，
   * 触发掩码清零（具体触发位由 EffectCompileSystem 按 EffectDef 设置）。
   */
  compile(effectCfgId: number, owner: Eid): Eid {
    const eid = this.acquire();
    add(this.world, eid, EffectTag);
    add(this.world, eid, ActiveEffect);
    add(this.world, eid, effectMask);
    add(this.world, eid, EffectOwner(owner));
    ActiveEffect.defId[eid] = effectCfgId;
    ActiveEffect.state[eid] = 0;
    ActiveEffect.elapsed[eid] = 0;
    ActiveEffect.cd[eid] = 0;
    effectMask.value[eid] = 0;
    return eid;
  }

  /** 给效果实体挂子实体（Condition / Action），供编译层使用 */
  attachChild(parent: Eid, child: Eid): void {
    add(this.world, child, ChildOf(parent));
  }
}
