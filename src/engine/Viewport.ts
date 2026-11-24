/**
 * 相机 / 视口（ARCHITECTURE §5.10）。
 *
 * 只服务于渲染：跟随玩家、世界↔屏幕变换、视口裁剪矩形。
 * 平滑系数固定，不读取墙钟、不影响任何逻辑系统；Culled 仅跳过绘制。
 */
import type { Container } from 'pixi.js';

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

const FOLLOW_LERP = 0.18;
const SNAP_DISTANCE = 480;

export class Viewport {
  private cameraX = 0;
  private cameraY = 0;
  private targetX = 0;
  private targetY = 0;
  private viewW = 1280;
  private viewH = 720;
  private zoomValue = 1;
  private margin = 96;
  private initialized = false;

  /** 世界坐标视口矩形，ViewportSystem 每帧刷新。 */
  readonly rect: ViewRect = { x: 0, y: 0, w: 1, h: 1 };

  constructor(width: number = 1280, height: number = 720, zoom: number = 1) {
    this.setSize(width, height);
    this.setZoom(zoom);
  }

  setSize(width: number, height: number): void {
    this.viewW = Math.max(1, width);
    this.viewH = Math.max(1, height);
    this.refreshRect();
  }

  setZoom(zoom: number): void {
    this.zoomValue = zoom > 0.25 && zoom < 4 ? zoom : 1;
    this.refreshRect();
  }

  get zoom(): number {
    return this.zoomValue;
  }

  get width(): number {
    return this.viewW;
  }

  get height(): number {
    return this.viewH;
  }

  get centerX(): number {
    return this.cameraX;
  }

  get centerY(): number {
    return this.cameraY;
  }

  setMargin(margin: number): void {
    this.margin = Math.max(0, margin);
    this.refreshRect();
  }

  /** 设置跟随目标；首次跟随或瞬移时直接吸附。 */
  follow(x: number, y: number, snap: boolean = false): void {
    this.targetX = x;
    this.targetY = y;
    if (!this.initialized || snap) {
      this.cameraX = x;
      this.cameraY = y;
      this.initialized = true;
    }
  }

  /** 每渲染帧调用一次；大位移直接吸附，避免长距离拖影。 */
  update(): void {
    if (!this.initialized) return;
    const dx = this.targetX - this.cameraX;
    const dy = this.targetY - this.cameraY;
    if (dx * dx + dy * dy > SNAP_DISTANCE * SNAP_DISTANCE) {
      this.cameraX = this.targetX;
      this.cameraY = this.targetY;
    } else {
      this.cameraX += dx * FOLLOW_LERP;
      this.cameraY += dy * FOLLOW_LERP;
    }
    this.refreshRect();
  }

  private refreshRect(): void {
    const halfW = this.viewW / (2 * this.zoomValue) + this.margin;
    const halfH = this.viewH / (2 * this.zoomValue) + this.margin;
    this.rect.x = this.cameraX - halfW;
    this.rect.y = this.cameraY - halfH;
    this.rect.w = halfW * 2;
    this.rect.h = halfH * 2;
  }

  worldToScreenX(x: number): number {
    return (x - this.cameraX) * this.zoomValue + this.viewW / 2;
  }

  worldToScreenY(y: number): number {
    return (y - this.cameraY) * this.zoomValue + this.viewH / 2;
  }

  screenToWorldX(x: number): number {
    return (x - this.viewW / 2) / this.zoomValue + this.cameraX;
  }

  screenToWorldY(y: number): number {
    return (y - this.viewH / 2) / this.zoomValue + this.cameraY;
  }

  /** 写入调用方预分配对象，热路径零分配。 */
  project(out: ScreenPoint, x: number, y: number): ScreenPoint {
    out.x = this.worldToScreenX(x);
    out.y = this.worldToScreenY(y);
    return out;
  }

  contains(x: number, y: number, padding: number = 0): boolean {
    return (
      x >= this.rect.x - padding &&
      x <= this.rect.x + this.rect.w + padding &&
      y >= this.rect.y - padding &&
      y <= this.rect.y + this.rect.h + padding
    );
  }

  /** 把世界容器变换为当前相机；PixiPools.root 挂到 renderer.stage 后调用。 */
  applyTo(container: Container): void {
    container.scale.set(this.zoomValue);
    container.position.set(
      this.viewW / 2 - this.cameraX * this.zoomValue,
      this.viewH / 2 - this.cameraY * this.zoomValue,
    );
  }

  reset(): void {
    this.initialized = false;
    this.cameraX = 0;
    this.cameraY = 0;
    this.targetX = 0;
    this.targetY = 0;
    this.refreshRect();
  }
}
