/**
 * 纯渲染反馈层：敌人血条、伤害数字、命中/击杀碎片。
 *
 * 不读事件总线、不写 ECS、不参与确定性模拟；只根据上一渲染帧观察到的血量变化
 * 与实体存活状态生成短暂视觉元素。画质与性能只影响本层，不改变任何游戏性数值。
 */
import { Container, Graphics, Text } from 'pixi.js';
import { CAP } from '../core/Constants';
import { exists, has, query } from '../ecs/bit/adapter';
import { Culled, Dead, EnemyTag, Health, Position } from '../ecs/bit/components';
import type { BattleWorld } from '../ecs/bit/adapter';
import type { Eid } from '../ecs/bit/types';

interface FloatText {
  node: Text;
  life: number;
  maxLife: number;
  drift: number;
}

interface Burst {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  color: number;
  big: boolean;
}

const FLOAT_POOL_SIZE = 48;
const BURST_POOL_SIZE = 40;

export class BattleFxSystem {
  private readonly root = new Container();
  private readonly bars = new Graphics();
  private readonly sparks = new Graphics();
  private readonly floats: FloatText[] = [];
  private readonly idleFloats: Text[] = [];
  private readonly bursts: Burst[] = [];
  private readonly prevHp = new Float32Array(CAP);
  private readonly lastX = new Float32Array(CAP);
  private readonly lastY = new Float32Array(CAP);
  private readonly tracked = new Uint8Array(CAP);

  constructor(parent: Container) {
    this.root.label = 'BattleFx.root';
    this.root.addChild(this.sparks);
    this.root.addChild(this.bars);
    parent.addChild(this.root);
  }

  /** 世界重建时清空上一局的观察状态与所有漂浮文字。 */
  reset(): void {
    this.prevHp.fill(0);
    this.tracked.fill(0);
    this.bursts.length = 0;
    for (let i = 0; i < this.floats.length; i++) {
      this.floats[i].node.removeFromParent();
      this.idleFloats.push(this.floats[i].node);
    }
    this.floats.length = 0;
    this.bars.clear();
    this.sparks.clear();
  }

  dispose(): void {
    this.reset();
    this.root.removeFromParent();
    this.root.destroy({ children: true });
  }

  private acquireText(): Text {
    const reused = this.idleFloats.pop();
    if (reused !== undefined) return reused;
    return new Text({
      text: '',
      style: {
        fill: '#ffe9a8',
        fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
        fontSize: 18,
        fontWeight: '700',
        stroke: { color: '#2a1608', width: 3 },
      },
    });
  }

  private spawnFloat(x: number, y: number, amount: number, isPlayer: boolean): void {
    if (this.floats.length >= FLOAT_POOL_SIZE) return;
    const node = this.acquireText();
    node.text = `${Math.max(1, Math.round(amount))}`;
    node.style.fill = isPlayer ? '#ff8a80' : '#ffe9a8';
    node.anchor.set(0.5);
    node.position.set(x + 5, y - 58);
    node.alpha = 1;
    node.scale.set(1);
    this.root.addChild(node);
    this.floats.push({ node, life: 0.72, maxLife: 0.72, drift: (this.floats.length % 3) * 7 - 7 });
  }

  private spawnBurst(x: number, y: number, color: number, big: boolean): void {
    if (this.bursts.length >= BURST_POOL_SIZE) return;
    this.bursts.push({ x, y, life: big ? 0.55 : 0.32, maxLife: big ? 0.55 : 0.32, color, big });
  }

  run(world: BattleWorld | null, dt: number): void {
    if (world === null) return;
    const step = Math.min(0.05, Math.max(0, dt));

    const enemies = query(world, [EnemyTag, Health, Position]);
    this.bars.clear();
    for (let i = 0; i < enemies.length; i++) {
      const eid = enemies[i] as Eid;
      if (hasDeadOrCulled(world, eid)) continue;
      const cur = Math.max(0, Health.cur[eid]);
      const max = Math.max(1, Health.max[eid]);
      const x = Position.x[eid];
      const y = Position.y[eid];
      const boss = max > 240;
      const width = boss ? 68 : 42;
      const barY = y - (boss ? 78 : 64);
      this.bars.rect(x - width / 2, barY, width, 5).fill({ color: 0x120c08, alpha: 0.88 });
      const ratio = Math.max(0, Math.min(1, cur / max));
      if (ratio > 0) {
        this.bars.rect(x - width / 2, barY, width * ratio, 5).fill({
          color: boss ? 0xe8603f : ratio > 0.4 ? 0xd94b35 : 0xf0b13a,
          alpha: 0.96,
        });
      }
      if (this.tracked[eid] > 0 && cur < this.prevHp[eid]) {
        this.spawnFloat(x, y, this.prevHp[eid] - cur, false);
        this.spawnBurst(x, y - 30, 0xffd177, false);
      }
      this.prevHp[eid] = cur;
      this.lastX[eid] = x;
      this.lastY[eid] = y;
      this.tracked[eid] = 1;
    }

    // 死亡实体不会出现在 query 结果里：用上一帧观察状态补一次击杀碎片。
    for (let eid = 0; eid < CAP; eid++) {
      if (this.tracked[eid] === 0) continue;
      if (this.prevHp[eid] <= 0) {
        this.tracked[eid] = 0;
        continue;
      }
      const alive = existsEntity(world, eid as Eid) && !hasDeadOrCulled(world, eid as Eid);
      if (!alive) {
        this.spawnBurst(this.lastX[eid], this.lastY[eid] - 30, 0xff8a3d, true);
        this.tracked[eid] = 0;
      }
    }

    this.sparks.clear();
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.life -= step;
      if (burst.life <= 0) {
        this.bursts.splice(i, 1);
        continue;
      }
      const t = 1 - burst.life / burst.maxLife;
      const radius = (burst.big ? 20 : 11) * t;
      for (let k = 0; k < 6; k++) {
        const angle = (k / 6) * Math.PI * 2 + t;
        this.sparks
          .circle(burst.x + Math.cos(angle) * radius, burst.y + Math.sin(angle) * radius, 2.4 * (1 - t) + 0.8)
          .fill({ color: burst.color, alpha: Math.max(0, 1 - t) });
      }
    }

    for (let i = this.floats.length - 1; i >= 0; i--) {
      const item = this.floats[i];
      item.life -= step;
      if (item.life <= 0) {
        item.node.removeFromParent();
        this.idleFloats.push(item.node);
        this.floats.splice(i, 1);
        continue;
      }
      const t = 1 - item.life / item.maxLife;
      item.node.y -= (34 + t * 18) * step;
      item.node.x += item.drift * step;
      item.node.alpha = Math.max(0, 1 - t * t);
      item.node.scale.set(1 + t * 0.18);
    }
  }
}

function hasDeadOrCulled(world: BattleWorld, eid: Eid): boolean {
  return has(world, eid, Dead) || has(world, eid, Culled);
}

function existsEntity(world: BattleWorld, eid: Eid): boolean {
  return exists(world, eid);
}
