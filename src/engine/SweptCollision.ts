/**
 * 线段扫掠碰撞纯函数（架构 §2.2 #53 / DESIGN §2.1）。
 *
 * 逻辑层每 tick 的位移线段为 [px,py] → [x,y]；碰撞只在该线段上求解一次，
 * 避免高速弹幕/骑兵穿透。本模块不依赖 ECS / bitECS / 任何可变全局状态，
 * 批次 C 的视口裁剪与命中测试可只读复用。
 *
 * 约束：零分配（调用方传入 out）、确定性、不使用 Math.random / 墙钟。
 */

/** 命中结果（调用方复用，函数不分配对象）。 */
export interface SweepHit {
  /** 命中时刻，归一化到 [0,1]；未命中保持调用方原值。 */
  t: number;
  /** 命中处由移动圆指向目标的单位法线（未命中不写入）。 */
  nx: number;
  ny: number;
}

const EPS = 1e-9;
const TAU = Math.PI * 2;
const LUT_SIZE = 1024;
const LUT_SCALE = LUT_SIZE / TAU;

/** 确定性三角查表：全工程关键角度统一走此表，避免平台 sin/cos 差异。 */
const SIN_TABLE = new Float32Array(LUT_SIZE);
for (let i = 0; i < LUT_SIZE; i++) {
  SIN_TABLE[i] = Math.sin((i * TAU) / LUT_SIZE);
}

/** 查表 sin，参数单位为弧度。 */
export function sinLut(angle: number): number {
  let idx = (angle * LUT_SCALE) | 0;
  idx = ((idx % LUT_SIZE) + LUT_SIZE) % LUT_SIZE;
  return SIN_TABLE[idx];
}

/** 查表 cos，参数单位为弧度。 */
export function cosLut(angle: number): number {
  return sinLut(angle + Math.PI * 0.5);
}

/**
 * 扫掠圆（移动）对静态圆：解 |p + t·d - c|² = (r + tr)²。
 * 起点已在目标内时返回 t=0，法线取起点到目标方向（重合时取 +x）。
 */
export function sweepCircleCircle(
  px: number,
  py: number,
  x: number,
  y: number,
  r: number,
  tx: number,
  ty: number,
  tr: number,
  out: SweepHit,
): boolean {
  const dx = x - px;
  const dy = y - py;
  const fx = px - tx;
  const fy = py - ty;
  const radius = r + tr;
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) {
    out.t = 0;
    const len = Math.sqrt(fx * fx + fy * fy);
    if (len > EPS) {
      out.nx = -fx / len;
      out.ny = -fy / len;
    } else {
      out.nx = 1;
      out.ny = 0;
    }
    return true;
  }
  const a = dx * dx + dy * dy;
  if (a <= EPS) {
    return false;
  }
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    return false;
  }
  const root = Math.sqrt(disc);
  const t = (-b - root) / (2 * a);
  if (t < 0 || t > 1) {
    return false;
  }
  out.t = t;
  const hx = fx + dx * t;
  const hy = fy + dy * t;
  const len = Math.sqrt(hx * hx + hy * hy);
  if (len > EPS) {
    out.nx = -hx / len;
    out.ny = -hy / len;
  } else {
    out.nx = 1;
    out.ny = 0;
  }
  return true;
}

/**
 * 扫掠圆（移动）对静态轴对齐矩形。用 Minkowski 膨胀把圆半径并入矩形，
 * 再对膨胀后的 AABB 做 slab 相交；法线取首次进入的轴。
 */
export function sweepCircleRect(
  px: number,
  py: number,
  x: number,
  y: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  out: SweepHit,
): boolean {
  const minX = rx - r;
  const minY = ry - r;
  const maxX = rx + rw + r;
  const maxY = ry + rh + r;
  const dx = x - px;
  const dy = y - py;

  let tMin = 0;
  let tMax = 1;
  let normalAxis = 0;
  let normalSign = 1;

  if (Math.abs(dx) <= EPS) {
    if (px < minX || px > maxX) {
      return false;
    }
  } else {
    let t1 = (minX - px) / dx;
    let t2 = (maxX - px) / dx;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      normalAxis = 0;
      normalSign = sign;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
    if (tMin > tMax) {
      return false;
    }
  }

  if (Math.abs(dy) <= EPS) {
    if (py < minY || py > maxY) {
      return false;
    }
  } else {
    let t1 = (minY - py) / dy;
    let t2 = (maxY - py) / dy;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      normalAxis = 1;
      normalSign = sign;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
    if (tMin > tMax) {
      return false;
    }
  }

  if (tMax < 0 || tMin > 1) {
    return false;
  }
  out.t = tMin < 0 ? 0 : tMin;
  out.nx = normalAxis === 0 ? normalSign : 0;
  out.ny = normalAxis === 1 ? normalSign : 0;
  return true;
}

/** 静态圆-矩形重叠判定（视口裁剪 / 命中测试复用，零分配）。 */
export function circleRectOverlap(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  const nearX = cx < rx ? rx : cx > rx + rw ? rx + rw : cx;
  const nearY = cy < ry ? ry : cy > ry + rh ? ry + rh : cy;
  const dx = cx - nearX;
  const dy = cy - nearY;
  return dx * dx + dy * dy <= r * r;
}

/** 点是否在矩形内（含边界），供 C 的视口裁剪只读复用。 */
export function pointInRect(px: number, py: number, rx: number, ry: number, rw: number, rh: number): boolean {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}
