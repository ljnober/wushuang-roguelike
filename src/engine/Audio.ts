/**
 * 程序化音效（DESIGN §7 / ARCHITECTURE §7 Q3）。
 *
 * 无外部素材：WebAudio 振荡器 + 一次性确定性噪声缓冲。
 * 无 AudioContext / 被浏览器策略阻止时静默降级，绝不抛给游戏循环。
 */
import { Rng } from '../core/Rng';

export type SfxKind = 'attack' | 'hit' | 'levelup' | 'pickup' | 'bossWarn';

interface ToneSpec {
  readonly type: OscillatorType;
  readonly from: number;
  readonly to: number;
  readonly duration: number;
  readonly volume: number;
  readonly noise: boolean;
}

const TONES: Record<SfxKind, ToneSpec> = {
  attack: { type: 'triangle', from: 420, to: 180, duration: 0.09, volume: 0.12, noise: false },
  hit: { type: 'square', from: 170, to: 70, duration: 0.12, volume: 0.14, noise: true },
  levelup: { type: 'sine', from: 520, to: 1040, duration: 0.36, volume: 0.18, noise: false },
  pickup: { type: 'sine', from: 680, to: 1180, duration: 0.11, volume: 0.10, noise: false },
  bossWarn: { type: 'sawtooth', from: 110, to: 165, duration: 0.7, volume: 0.16, noise: false },
};

const NOISE_SEED = 0x5f3759df;

export class Audio {
  private context: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabledValue = true;

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
    if (!enabled && this.context !== null) {
      void this.context.suspend().catch(() => undefined);
    } else if (enabled && this.context !== null) {
      void this.context.resume().catch(() => undefined);
    }
  }

  /** 在首次用户手势中调用，满足浏览器自动播放策略。 */
  unlock(): void {
    this.ensureContext();
  }

  private ensureContext(): AudioContext | null {
    if (this.context !== null) return this.context;
    if (typeof window === 'undefined') return null;
    try {
      const scope = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
      if (Ctor === undefined) return null;
      this.context = new Ctor();
      if (this.context.state === 'suspended') {
        void this.context.resume().catch(() => undefined);
      }
      return this.context;
    } catch {
      return null;
    }
  }

  /** 噪声缓冲用确定性 Rng 生成，全工程禁用 Math.random。 */
  private ensureNoise(ctx: AudioContext): AudioBuffer | null {
    if (this.noiseBuffer !== null) return this.noiseBuffer;
    try {
      const length = Math.floor(ctx.sampleRate * 0.4);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const channel = buffer.getChannelData(0);
      const rng = new Rng(NOISE_SEED);
      for (let i = 0; i < length; i++) channel[i] = rng.next() * 2 - 1;
      this.noiseBuffer = buffer;
      return buffer;
    } catch {
      return null;
    }
  }

  play(kind: SfxKind): void {
    if (!this.enabledValue) return;
    const ctx = this.ensureContext();
    if (ctx === null) return;
    const spec = TONES[kind];
    if (spec === undefined) return;

    try {
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(spec.volume, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);
      gain.connect(ctx.destination);

      const oscillator = ctx.createOscillator();
      oscillator.type = spec.type;
      oscillator.frequency.setValueAtTime(spec.from, now);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), now + spec.duration);
      oscillator.connect(gain);
      oscillator.start(now);
      oscillator.stop(now + spec.duration + 0.02);

      if (spec.noise) {
        const buffer = this.ensureNoise(ctx);
        if (buffer !== null) {
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          const noiseGain = ctx.createGain();
          noiseGain.gain.setValueAtTime(spec.volume * 0.4, now);
          noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
          source.connect(noiseGain);
          noiseGain.connect(ctx.destination);
          source.start(now);
          source.stop(now + 0.12);
        }
      }
    } catch {
      // 音频失败不能影响渲染或逻辑，静默降级。
    }
  }

  dispose(): void {
    if (this.context !== null) {
      void this.context.close().catch(() => undefined);
      this.context = null;
    }
    this.noiseBuffer = null;
  }
}
