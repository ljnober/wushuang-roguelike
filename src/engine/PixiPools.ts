/**
 * 显示对象池（ARCHITECTURE §5.10 / DESIGN §9）。
 *
 * - eidToSlot / slotToEid 双向映射，O(1) 查找；
 * - 敌人按兵种纹理分组；弹幕使用 ParticleContainer + Particle 池；
 * - 掉落/特效使用普通 Sprite 池；低配模式弹幕切换为普通 Sprite 池；
 * - 热路径（setPosition/setVisual/snap）不分配对象、不查字符串表。
 */
import { Container, Particle, ParticleContainer, Sprite, Texture } from 'pixi.js';
import { CAP } from '../core/Constants';
import type { Eid } from '../ecs/bit/types';
import type { QualityLevel } from '../game/SaveData';
import type { Renderer } from './Renderer';

export type RenderKind = 'chibi' | 'bullet' | 'pickup' | 'effect';

interface SlotRecord {
  active: boolean;
  kind: RenderKind;
  textureKey: string;
  sprite: Sprite | null;
  particle: Particle | null;
  x: number;
  y: number;
  px: number;
  py: number;
  anim: number;
  flipX: boolean;
  tint: number;
  alpha: number;
  baseScale: number;
}

const DEFAULT_TEXTURE_KEY = 'white';

/** 渲染层的视觉尺寸：程序化纹理只有约 40px，按类型放大以适应现代屏幕。只影响绘制，不改游戏数值。 */
function baseScaleFor(kind: RenderKind, key: string): number {
  if (kind === 'chibi') return key.indexOf('boss') >= 0 ? 2.15 : 1.8;
  if (kind === 'bullet') return 1.45;
  if (kind === 'pickup') return 1.3;
  return 1.35;
}

/** 创建空槽记录（只在构造期批量分配，热路径复用）。 */
function makeSlot(): SlotRecord {
  return {
    active: false,
    kind: 'chibi',
    textureKey: DEFAULT_TEXTURE_KEY,
    sprite: null,
    particle: null,
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    anim: 0,
    flipX: false,
    tint: 0xffffff,
    alpha: 1,
    baseScale: 1,
  };
}

export class PixiPools {
  readonly eidToSlot: Int32Array;
  readonly slotToEid: Uint32Array;

  private readonly slots: SlotRecord[] = [];
  private readonly freeStack: Int32Array;
  private freeCount = 0;
  private readonly textures = new Map<string, Texture>();
  private readonly chibiLayers = new Map<string, Container>();
  private readonly pickupLayers = new Map<string, Container>();
  private readonly effectLayers = new Map<string, Container>();
  private readonly bulletParticleLayers = new Map<string, ParticleContainer>();
  private readonly bulletSpriteLayers = new Map<string, Container>();
  private readonly root: Container;
  private lowMode = false;
  private activeCountValue = 0;

  constructor(renderer: Renderer, capacity: number = CAP) {
    const cap = capacity > 0 ? Math.min(capacity, CAP) : CAP;
    this.eidToSlot = new Int32Array(cap);
    this.eidToSlot.fill(-1);
    this.slotToEid = new Uint32Array(cap);
    this.freeStack = new Int32Array(cap);

    for (let i = 0; i < cap; i++) {
      this.slots.push(makeSlot());
      this.freeStack[i] = cap - 1 - i;
    }
    this.freeCount = cap;

    this.root = new Container();
    this.root.label = 'PixiPools.root';
    renderer.stage.addChild(this.root);
    this.textures.set(DEFAULT_TEXTURE_KEY, Texture.WHITE);
    this.lowMode = renderer.quality === 'low';
  }

  /** 世界容器：Viewport 对它施加相机平移/缩放。 */
  getRoot(): Container {
    return this.root;
  }

  get activeCount(): number {
    return this.activeCountValue;
  }

  get capacity(): number {
    return this.slots.length;
  }

  get lowQualityMode(): boolean {
    return this.lowMode;
  }

  /** 注册纹理键；未注册的键回退 Texture.WHITE。 */
  registerTexture(key: string, texture: Texture): void {
    this.textures.set(key, texture);
  }

  hasTexture(key: string): boolean {
    return this.textures.has(key);
  }

  private textureFor(key: string): Texture {
    return this.textures.get(key) ?? Texture.WHITE;
  }

  private groupFor(kind: RenderKind, key: string): Container {
    let group: Container | undefined;
    if (kind === 'chibi') {
      group = this.chibiLayers.get(key);
      if (group === undefined) {
        group = new Container();
        group.label = `chibi:${key}`;
        this.chibiLayers.set(key, group);
        this.root.addChild(group);
      }
    } else if (kind === 'pickup') {
      group = this.pickupLayers.get(key);
      if (group === undefined) {
        group = new Container();
        group.label = `pickup:${key}`;
        this.pickupLayers.set(key, group);
        this.root.addChild(group);
      }
    } else if (kind === 'effect') {
      group = this.effectLayers.get(key);
      if (group === undefined) {
        group = new Container();
        group.label = `effect:${key}`;
        this.effectLayers.set(key, group);
        this.root.addChild(group);
      }
    } else {
      group = this.lowMode ? this.spriteBulletGroup(key) : this.particleBulletGroup(key);
    }
    return group;
  }

  private particleBulletGroup(key: string): ParticleContainer {
    let group = this.bulletParticleLayers.get(key);
    if (group === undefined) {
      group = new ParticleContainer({
        dynamicProperties: {
          position: true,
          vertex: true,
          color: true,
          rotation: false,
          uvs: false,
        },
      });
      group.label = `bullet-particles:${key}`;
      this.bulletParticleLayers.set(key, group);
      this.root.addChild(group);
    }
    return group;
  }

  private spriteBulletGroup(key: string): Container {
    let group = this.bulletSpriteLayers.get(key);
    if (group === undefined) {
      group = new Container();
      group.label = `bullet-sprites:${key}`;
      this.bulletSpriteLayers.set(key, group);
      this.root.addChild(group);
    }
    return group;
  }

  /** 分配槽位；同一 eid 重复 acquire 返回已有槽位（纹理变化时重建显示对象）。 */
  acquire(kind: RenderKind, textureKey: string, eid: Eid): number {
    const existing = this.eidToSlot[eid] ?? -1;
    if (existing >= 0 && this.slots[existing].active) {
      const record = this.slots[existing];
      if (record.textureKey !== textureKey) {
        this.detach(record);
        this.attach(record, kind, textureKey);
      }
      return existing;
    }
    if (this.freeCount === 0) return -1;

    const slot = this.freeStack[--this.freeCount];
    const record = this.slots[slot];
    record.active = true;
    record.kind = kind;
    record.textureKey = textureKey;
    record.x = 0;
    record.y = 0;
    record.px = 0;
    record.py = 0;
    record.anim = 0;
    record.flipX = false;
    record.tint = 0xffffff;
    record.alpha = 1;
    record.baseScale = baseScaleFor(kind, textureKey);
    this.attach(record, kind, textureKey);

    this.eidToSlot[eid] = slot;
    this.slotToEid[slot] = eid;
    this.activeCountValue++;
    return slot;
  }

  private attach(record: SlotRecord, kind: RenderKind, key: string): void {
    const texture = this.textureFor(key);
    record.kind = kind;
    record.textureKey = key;
    if (kind === 'bullet' && !this.lowMode) {
      const particle = new Particle({
        texture,
        anchorX: 0.5,
        anchorY: 0.5,
        scaleX: record.baseScale,
        scaleY: record.baseScale,
      });
      particle.tint = record.tint;
      particle.alpha = record.alpha;
      particle.x = record.x;
      particle.y = record.y;
      record.particle = particle;
      record.sprite = null;
      this.particleBulletGroup(key).addParticle(particle);
      return;
    }

    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, kind === 'chibi' ? 0.82 : 0.5);
    sprite.scale.set(record.baseScale * (record.flipX ? -1 : 1), record.baseScale);
    sprite.tint = record.tint;
    sprite.alpha = record.alpha;
    sprite.position.set(record.x, record.y);
    record.sprite = sprite;
    record.particle = null;
    this.groupFor(kind, key).addChild(sprite);
  }

  private detach(record: SlotRecord): void {
    if (record.sprite !== null) {
      record.sprite.removeFromParent();
      record.sprite.destroy();
      record.sprite = null;
    }
    if (record.particle !== null) {
      this.bulletParticleLayers.get(record.textureKey)?.removeParticle(record.particle);
      record.particle = null;
    }
  }

  /** 释放槽位并回收显示对象；重复释放安全。 */
  release(slot: number): void {
    if (slot < 0 || slot >= this.slots.length) return;
    const record = this.slots[slot];
    if (!record.active) return;
    const eid = this.slotToEid[slot];
    if (eid < this.eidToSlot.length && this.eidToSlot[eid] === slot) {
      this.eidToSlot[eid] = -1;
    }
    this.detach(record);
    record.active = false;
    record.textureKey = DEFAULT_TEXTURE_KEY;
    record.x = 0;
    record.y = 0;
    record.px = 0;
    record.py = 0;
    this.slotToEid[slot] = 0;
    this.freeStack[this.freeCount++] = slot;
    this.activeCountValue--;
  }

  releaseAll(): void {
    for (let slot = 0; slot < this.slots.length; slot++) {
      if (this.slots[slot].active) this.release(slot);
    }
  }

  getSlot(eid: Eid): number {
    return this.eidToSlot[eid] ?? -1;
  }

  /** 写入由 RenderSyncSystem 已插值好的世界坐标。 */
  setPosition(slot: number, x: number, y: number): void {
    const record = this.slots[slot];
    if (record === undefined || !record.active) return;
    record.px = record.x;
    record.py = record.y;
    record.x = x;
    record.y = y;
    if (record.sprite !== null) record.sprite.position.set(x, y);
    if (record.particle !== null) {
      record.particle.x = x;
      record.particle.y = y;
    }
  }

  /** anim 以帧号驱动轻微呼吸缩放；flipX 只改渲染缩放，不影响朝向逻辑。 */
  setVisual(slot: number, anim: number, flipX: boolean, tint: number, alpha: number): void {
    const record = this.slots[slot];
    if (record === undefined || !record.active) return;
    record.anim = anim;
    record.flipX = flipX;
    record.tint = tint;
    record.alpha = alpha;

    const bob = 1 + ((anim | 0) % 2) * 0.04;
    const sx = record.baseScale * (flipX ? -1 : 1);
    const sy = record.baseScale * bob;
    if (record.sprite !== null) {
      record.sprite.scale.set(sx, sy);
      record.sprite.tint = tint;
      record.sprite.alpha = alpha;
    }
    if (record.particle !== null) {
      record.particle.scaleX = sx;
      record.particle.scaleY = sy;
      record.particle.tint = tint;
      record.particle.alpha = alpha;
    }
  }

  /** snapInterpolation：清掉本槽的插值前值。 */
  snap(slot: number): void {
    const record = this.slots[slot];
    if (record === undefined || !record.active) return;
    record.px = record.x;
    record.py = record.y;
  }

  /** 画质切换：仅在渲染层把弹幕 Particle ↔ Sprite 互换，不改任何实体数据。 */
  setQuality(quality: QualityLevel): void {
    const nextLow = quality === 'low';
    if (nextLow === this.lowMode) return;
    for (let slot = 0; slot < this.slots.length; slot++) {
      const record = this.slots[slot];
      if (!record.active || record.kind !== 'bullet') continue;
      this.detach(record);
    }
    this.lowMode = nextLow;
    for (let slot = 0; slot < this.slots.length; slot++) {
      const record = this.slots[slot];
      if (!record.active || record.kind !== 'bullet') continue;
      this.attach(record, 'bullet', record.textureKey);
      this.setPosition(slot, record.x, record.y);
      this.setVisual(slot, record.anim, record.flipX, record.tint, record.alpha);
    }
  }

  destroy(): void {
    this.releaseAll();
    this.root.removeFromParent();
    this.root.destroy({ children: true });
    this.textures.clear();
    this.chibiLayers.clear();
    this.pickupLayers.clear();
    this.effectLayers.clear();
    this.bulletParticleLayers.clear();
    this.bulletSpriteLayers.clear();
  }
}
