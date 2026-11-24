/**
 * Graphics v8 → Texture 的缓存工厂（ARCHITECTURE §5.10）。
 *
 * 所有战场纹理均在运行时程序化生成，无外部图片；相同 key 只生成一次。
 */
import { Container, Graphics, Texture } from 'pixi.js';
import type { Renderer } from './Renderer';

export type DrawFn = (g: Graphics) => void;

export class TextureFactory {
  private readonly cache = new Map<string, Texture>();

  constructor(private readonly renderer: Renderer) {}

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get size(): number {
    return this.cache.size;
  }

  /** 生成或读取缓存纹理；draw 只在首次调用。Container 也可作为绘制目标。 */
  get(key: string, draw: DrawFn, resolution?: number): Texture {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const graphics = new Graphics();
    draw(graphics);
    const texture = this.renderer.generateTexture(graphics as Container, resolution);
    graphics.destroy();
    this.cache.set(key, texture);
    return texture;
  }

  /** 复杂造型可先画进 Container 再生成。 */
  fromContainer(key: string, container: Container, resolution?: number): Texture {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const texture = this.renderer.generateTexture(container, resolution);
    this.cache.set(key, texture);
    return texture;
  }

  peek(key: string): Texture | undefined {
    return this.cache.get(key);
  }

  clear(): void {
    const textures = this.cache.values();
    for (const texture of textures) texture.destroy(true);
    this.cache.clear();
  }
}
