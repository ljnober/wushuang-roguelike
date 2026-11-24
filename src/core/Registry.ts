/**
 * 通用内容注册表（ARCHITECTURE §5.2）。
 *
 * all() 返回内部数组的只读视图以保证注册顺序稳定、零分配；
 * ids() 仅在非热路径调用，允许分配。
 */
import { WushuangError } from './Constants';

export interface RegistryItem {
  readonly id: string;
}

export class Registry<T extends RegistryItem> {
  private readonly items: T[] = [];
  private readonly index = new Map<string, number>();
  private _sealed = false;

  constructor(readonly namespace: string) {}

  register(item: T): this {
    if (this._sealed) {
      throw new WushuangError(1003, `Registry[${this.namespace}] 已封存，无法注册 ${item.id}`);
    }
    if (this.index.has(item.id)) {
      throw new WushuangError(1001, `Registry[${this.namespace}] 重复 id: ${item.id}`);
    }
    this.index.set(item.id, this.items.length);
    this.items.push(item);
    return this;
  }

  get(id: string): T {
    const i = this.index.get(id);
    if (i === undefined) {
      throw new WushuangError(1002, `Registry[${this.namespace}] 未找到 id: ${id}`);
    }
    return this.items[i];
  }

  tryGet(id: string): T | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.items[i];
  }

  all(): readonly T[] {
    return this.items;
  }

  ids(): readonly string[] {
    const out: string[] = new Array<string>(this.items.length);
    for (let i = 0; i < this.items.length; i++) {
      out[i] = this.items[i].id;
    }
    return out;
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** 返回问题列表，空数组表示通过。 */
  validate(): string[] {
    const problems: string[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (typeof item.id !== 'string' || item.id.length === 0) {
        problems.push(`Registry[${this.namespace}] 第 ${i} 项 id 为空`);
      }
      if (this.index.get(item.id) !== i) {
        problems.push(`Registry[${this.namespace}] id 索引不一致: ${item.id}`);
      }
    }
    return problems;
  }

  seal(): this {
    this._sealed = true;
    return this;
  }

  get sealed(): boolean {
    return this._sealed;
  }
}
