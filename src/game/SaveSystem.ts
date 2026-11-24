/**
 * 存档持久化：localStorage 读写、节流、容错、容量校验、只序列化本地玩家。
 *
 * 事实来源：ARCHITECTURE.md §5.9、DESIGN.md §10。
 * 所有写入 try/catch；超限 / QuotaExceededError 返回 false 并发出 NetEvent 事件。
 */
import { SAVE_KEY, SAVE_MAX_BYTES, SAVE_THROTTLE_MS } from '../core/Constants';
import { GameEventType } from '../ecs/bridge/enums';
import type { GameEventBus } from '../ecs/bridge/GameEventBus';
import { createDefaultSave, type SaveData } from './SaveData';

export type SaveStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** NetEvent 的 a 参数：存档失败子码。 */
const NET_SAVE_OVER_LIMIT = 1;
const NET_SAVE_QUOTA = 2;
const NET_SAVE_BAD_VERSION = 3;
const NET_SAVE_CORRUPT = 4;

/** 无 localStorage 环境（node 测试）下的内存降级存储。 */
function createMemoryStorage(): SaveStorage {
  const map = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
    removeItem(key: string): void {
      map.delete(key);
    },
  };
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** UTF-8 字节长度（中文武将名按 3 字节计），用于 80KB 上限校验。 */
function utf8ByteLength(value: string): number {
  if (textEncoder !== null) return textEncoder.encode(value).length;
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

function isQuotaExceeded(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number };
  return e.name === 'QuotaExceededError'
    || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || e.code === 22;
}

export class SaveSystem {
  private readonly storage: SaveStorage;
  private lastSaveAt = -Infinity;
  private _lastError: string | null = null;
  private localPlayerId = 0;
  private events: GameEventBus | null = null;

  constructor(storage?: SaveStorage) {
    if (storage !== undefined) {
      this.storage = storage;
    } else if (typeof localStorage !== 'undefined') {
      this.storage = localStorage;
    } else {
      this.storage = createMemoryStorage();
    }
  }

  get lastError(): string | null {
    return this._lastError;
  }

  /** 注入事件总线，用于把存档失败上报为 NetEvent（可选，不注入则静默记录 lastError）。 */
  setEventBus(bus: GameEventBus): void {
    this.events = bus;
  }

  /** 设置本地席位；save 时只保留该 playerId 的运行数据。 */
  setLocalPlayerId(playerId: number): void {
    this.localPlayerId = playerId;
  }

  private emitNetEvent(code: number): void {
    if (this.events !== null) this.events.emit(GameEventType.NetEvent, code, 0, 0);
  }

  /** 读取存档；版本不符 / JSON 损坏 / 结构异常 → 默认存档。 */
  load(): SaveData {
    this._lastError = null;
    try {
      const raw = this.storage.getItem(SAVE_KEY);
      if (raw === null || raw === '') return createDefaultSave();
      const parsed = JSON.parse(raw) as SaveData;
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) {
        this._lastError = '存档版本不匹配，已重置为新存档';
        this.emitNetEvent(NET_SAVE_BAD_VERSION);
        return createDefaultSave();
      }
      if (parsed.meta === null || typeof parsed.meta !== 'object'
        || parsed.perPlayerRunStats === null || typeof parsed.perPlayerRunStats !== 'object') {
        this._lastError = '存档结构损坏，已重置为新存档';
        this.emitNetEvent(NET_SAVE_CORRUPT);
        return createDefaultSave();
      }
      return parsed;
    } catch (err) {
      this._lastError = `存档读取失败：${err instanceof Error ? err.message : String(err)}`;
      this.emitNetEvent(NET_SAVE_CORRUPT);
      return createDefaultSave();
    }
  }

  /** 节流写入：SAVE_THROTTLE_MS 内重复调用返回 false（未写入，非错误）。 */
  save(data: SaveData): boolean {
    const now = Date.now();
    if (now - this.lastSaveAt < SAVE_THROTTLE_MS) return false;
    return this.saveNow(data);
  }

  /** 强制写入（结算 / 退出时调用）：容量校验 + 序列化 + try/catch。 */
  saveNow(data: SaveData): boolean {
    this._lastError = null;
    try {
      const payload = JSON.stringify(this.sanitizeForLocal(data));
      if (utf8ByteLength(payload) > SAVE_MAX_BYTES) {
        this._lastError = '存档超过容量上限，请拆解多余物品';
        this.emitNetEvent(NET_SAVE_OVER_LIMIT);
        return false;
      }
      this.storage.setItem(SAVE_KEY, payload);
      this.lastSaveAt = Date.now();
      return true;
    } catch (err) {
      if (isQuotaExceeded(err)) {
        this._lastError = '浏览器存储空间不足，请拆解多余物品';
        this.emitNetEvent(NET_SAVE_QUOTA);
      } else {
        this._lastError = `存档写入失败：${err instanceof Error ? err.message : String(err)}`;
      }
      return false;
    }
  }

  clear(): void {
    try {
      this.storage.removeItem(SAVE_KEY);
      this._lastError = null;
    } catch (err) {
      this._lastError = `存档清除失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 只保留本地玩家数据：meta 为玩家私有 profile 全量保留；
   * run 仅当 playerId == localPlayerId 时保留；perPlayerRunStats 仅保留本地席位列。
   */
  private sanitizeForLocal(data: SaveData): SaveData {
    const out: SaveData = {
      version: 1,
      meta: data.meta,
      perPlayerRunStats: {},
    };
    if (data.run !== undefined && data.run.playerId === this.localPlayerId) {
      out.run = data.run;
    }
    const seedKeys = Object.keys(data.perPlayerRunStats);
    const localKey = String(this.localPlayerId);
    for (let i = 0; i < seedKeys.length; i++) {
      const seed = seedKeys[i];
      const perPlayer = data.perPlayerRunStats[seed];
      const localStats = perPlayer[localKey];
      if (localStats !== undefined) {
        out.perPlayerRunStats[seed] = { [localKey]: localStats };
      }
    }
    return out;
  }
}
