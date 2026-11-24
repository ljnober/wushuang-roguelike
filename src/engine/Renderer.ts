/**
 * PixiJS v8 渲染器封装（ARCHITECTURE §5.10 / DESIGN §9）。
 *
 * 关键点：
 * - v8 使用 `app.canvas`，不存在 `app.view`；
 * - 渲染循环由 App 的 RAF 驱动（autoStart:false），本类暴露 render() 供注册槽调用；
 * - 画质只影响分辨率/纹理精度，**不改变任何游戏性参数**；
 * - GPU 上下文创建失败时降级为 headless 渲染器，逻辑 tick 绝不因此中断。
 */
import { Application, Container, Texture } from 'pixi.js';
import { WushuangError } from '../core/Constants';
import type { QualityLevel } from '../game/SaveData';

const ERR_RENDERER_CREATE = 5001;
const ERR_RENDERER_DESTROY = 5002;

/** 依档位解析设备像素比；低配固定 1，其余跟随设备。 */
function resolveResolution(quality: QualityLevel): number {
  if (quality === 'low') return 1;
  const dpr = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
  return dpr > 0 ? dpr : 1;
}

export class Renderer {
  private pixiApp: Application | null = null;
  private qualityValue: QualityLevel;
  private headlessValue: boolean;

  /** v8: app.canvas（无 app.view）。 */
  readonly canvas: HTMLCanvasElement;
  /** 显示树根，PixiPools 把分层容器挂到这里。 */
  readonly stage: Container;

  private constructor(app: Application | null, quality: QualityLevel) {
    this.pixiApp = app;
    this.qualityValue = quality;
    this.headlessValue = app === null;
    if (app !== null) {
      this.canvas = app.canvas;
      this.stage = app.stage;
      this.stage.sortableChildren = false;
    } else {
      const canvas =
        typeof document !== 'undefined'
          ? document.createElement('canvas')
          : ({ width: 1, height: 1 } as HTMLCanvasElement);
      this.canvas = canvas;
      this.stage = new Container();
      this.stage.label = 'Renderer.headlessStage';
    }
  }

  /**
   * 创建渲染器。优先 WebGPU → WebGL；任何上下文失败均降级 headless 而不抛给 App。
   */
  static async create(host: HTMLElement, quality: QualityLevel): Promise<Renderer> {
    try {
      const app = new Application();
      await app.init({
        preference: ['webgpu', 'webgl'],
        resizeTo: host,
        resolution: resolveResolution(quality),
        autoDensity: true,
        autoStart: false,
        antialias: quality !== 'low',
        backgroundAlpha: 0,
      });
      return new Renderer(app, quality);
    } catch (error: unknown) {
      if (typeof console !== 'undefined') {
        console.warn('[Renderer] GPU 上下文不可用，降级 headless', error);
      }
      return Renderer.headless(quality);
    }
  }

  /** 显式构造无 GPU 渲染器（测试/受限环境）。 */
  static headless(quality: QualityLevel = 'low'): Renderer {
    return new Renderer(null, quality);
  }

  get headless(): boolean {
    return this.headlessValue;
  }

  get quality(): QualityLevel {
    return this.qualityValue;
  }

  get pixi(): Application | null {
    return this.pixiApp;
  }

  get screenWidth(): number {
    return this.pixiApp !== null ? this.pixiApp.screen.width : this.canvas.width;
  }

  get screenHeight(): number {
    return this.pixiApp !== null ? this.pixiApp.screen.height : this.canvas.height;
  }

  /** 纹理生成使用的分辨率：低配 1x，其它档位跟随设备像素比。 */
  get textureResolution(): number {
    return this.qualityValue === 'low' ? 1 : Math.min(resolveResolution(this.qualityValue), 2);
  }

  /** 只调整渲染参数：分辨率与抗锯齿；不触碰任何游戏逻辑数值。 */
  setQuality(quality: QualityLevel): void {
    if (quality === this.qualityValue) return;
    this.qualityValue = quality;
    const app = this.pixiApp;
    if (app === null) return;
    try {
      app.renderer.resolution = resolveResolution(quality);
      const resize = (app as unknown as { resize?: () => void }).resize;
      if (typeof resize === 'function') resize.call(app);
    } catch (error: unknown) {
      throw new WushuangError(ERR_RENDERER_CREATE, `Renderer.setQuality 失败: ${String(error)}`);
    }
  }

  /** v8 签名：renderer.generateTexture({ target, resolution })。 */
  generateTexture(target: Container, resolution?: number): Texture {
    if (this.pixiApp === null) return Texture.WHITE;
    return this.pixiApp.renderer.generateTexture({
      target,
      resolution: resolution ?? this.textureResolution,
      antialias: this.qualityValue !== 'low',
    });
  }

  /** 由注册槽在每帧末尾调用；headless 下为空操作。 */
  render(): void {
    if (this.pixiApp !== null) this.pixiApp.render();
  }

  resize(width: number, height: number): void {
    if (this.pixiApp !== null) this.pixiApp.renderer.resize(width, height);
  }

  destroy(): void {
    if (this.pixiApp === null) return;
    try {
      this.pixiApp.destroy(true, { children: true });
    } catch (error: unknown) {
      throw new WushuangError(ERR_RENDERER_DESTROY, `Renderer.destroy 失败: ${String(error)}`);
    } finally {
      this.pixiApp = null;
    }
  }
}
