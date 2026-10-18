import { CONFIG } from './Config';
import { clamp } from './Utils';

/**
 * Web Audio engine: a fully procedural synthwave soundtrack (bass, pad,
 * kick/clap/hat, arpeggio) plus every gameplay sound effect.
 *
 * Nothing is loaded from disk — all voices are oscillators and generated noise
 * buffers, so the game ships without a single audio asset.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  /** Shared pluck echo (one delay line for the whole session, never rebuilt). */
  private pluckDelay: DelayNode | null = null;
  private pluckFeedback: GainNode | null = null;

  /** Engine drone nodes (created with the first race). */
  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private engineRunning = false;

  /** Sequencer state. */
  private schedulerId: number | null = null;
  private nextNoteTime = 0;
  private step = 0;
  private musicPlaying = false;

  private volume = CONFIG.audio.masterVolume;
  private muted = false;
  private started = false;

  /**
   * Round 2 audio styles.
   *  - cyberpunk: the synthwave sequencer (Round 1) plus a neon pad.
   *  - realistic: a procedural city ambience bed (traffic rumble, air, rain)
   *    and no sequenced music, matching the realistic presentation.
   */
  private styleId: 'cyberpunk' | 'realistic' = 'cyberpunk';
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientAir: AudioBufferSourceNode | null = null;
  private ambientGain: GainNode | null = null;
  private rainSource: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private ambientPlaying = false;
  /** Last requested precipitation amount (0..1) for the rain layer. */
  private rainAmount = 0;

  // --------------------------------------------------------------- lifecycle

  /** Must be called from a user gesture (click) to satisfy autoplay policies. */
  async init(): Promise<void> {
    if (this.ctx) {
      // Never await resume(): Chrome keeps an AudioContext suspended until a
      // user gesture, and awaiting it here would stall any restart that is not
      // triggered by a click (R hotkey, map-mode switch, automated harness).
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {
          /* still suspended: the game keeps running silently */
        });
      }
      return;
    }
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.24;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(compressor);
    compressor.connect(ctx.destination);

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.55;
    this.musicGain.connect(this.master);

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = 0.9;
    this.sfxGain.connect(this.master);

    this.noiseBuffer = this.createNoiseBuffer(ctx);
    // A gentle master fade-in avoids a click on the very first note.
    this.master.gain.setValueAtTime(0, ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(this.muted ? 0 : this.volume, ctx.currentTime + 0.4);
    this.started = true;
  }

  get isStarted(): boolean {
    return this.started;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    if (this.master && this.ctx && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  getVolume(): number {
    return this.volume;
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * Detach a finished voice from the graph once it has played. Nodes that are
   * merely stopped stay connected and keep burning audio-thread time; over a
   * long session (the music alone spawns ~40 voices per second) that adds up to
   * a permanently blocked main thread, so every one-shot voice calls this.
   */
  private autoRelease(source: AudioScheduledSourceNode, ...extra: AudioNode[]): void {
    source.onended = () => {
      try {
        source.disconnect();
      } catch {
        /* already detached */
      }
      for (const node of extra) {
        try {
          node.disconnect();
        } catch {
          /* already detached */
        }
      }
    };
  }

  // ------------------------------------------------------------------ music

  /** Chord progression in A minor: Am - F - C - G (synthwave staple). */
  private static readonly PROGRESSION: number[][] = [
    [110.0, 130.81, 164.81], // A2  C3  E3
    [87.31, 130.81, 174.61], // F2  C3  F3
    [130.81, 164.81, 196.0], // C3  E3  G3
    [98.0, 146.83, 196.0], // G2  D3  G3
  ];

  /** Switches the whole audio identity (called on every style change). */
  setStyle(style: 'cyberpunk' | 'realistic'): void {
    if (this.styleId === style) return;
    this.styleId = style;
    if (!this.ctx) return;
    if (style === 'realistic') {
      this.stopMusic();
      this.startAmbient();
    } else {
      this.stopAmbient();
      this.startMusic();
    }
  }

  get style(): 'cyberpunk' | 'realistic' {
    return this.styleId;
  }

  startMusic(): void {
    if (this.styleId === 'realistic') {
      this.startAmbient();
      return;
    }
    if (!this.ctx || !this.musicGain || this.musicPlaying) return;
    this.musicPlaying = true;
    this.step = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.08;
    this.schedulerId = window.setInterval(() => this.scheduler(), 25);
  }

  stopMusic(): void {
    this.musicPlaying = false;
    if (this.schedulerId !== null) {
      window.clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
  }

  /**
   * Procedural city ambience: a filtered noise "rumble" bed, a thin air layer
   * and a rain hiss whose level follows the realistic style's precipitation.
   * This replaces the synthwave loop in realistic mode.
   */
  startAmbient(): void {
    if (!this.ctx || !this.master || !this.noiseBuffer || this.ambientPlaying) return;
    const ctx = this.ctx;
    this.ambientPlaying = true;

    this.ambientGain = ctx.createGain();
    this.ambientGain.gain.value = 0.0;
    this.ambientGain.connect(this.master);
    // Fade in so switching styles mid-race never clicks.
    this.ambientGain.gain.setTargetAtTime(0.5, ctx.currentTime, 0.8);

    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noiseBuffer;
    rumble.loop = true;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 320;
    lowpass.Q.value = 0.6;
    rumble.connect(lowpass).connect(this.ambientGain);
    rumble.start();
    this.ambientSource = rumble;

    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuffer;
    air.loop = true;
    air.playbackRate.value = 0.83;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1500;
    band.Q.value = 0.5;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.11;
    air.connect(band).connect(airGain).connect(this.ambientGain);
    air.start();
    this.ambientAir = air;

    const rain = ctx.createBufferSource();
    rain.buffer = this.noiseBuffer;
    rain.loop = true;
    rain.playbackRate.value = 1.31;
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 1100;
    const rainG = ctx.createGain();
    rainG.gain.value = 0;
    rain.connect(high).connect(rainG).connect(this.ambientGain);
    rain.start();
    this.rainSource = rain;
    this.rainGain = rainG;
    this.setRain(this.rainAmount);

    // Release the nodes when the page unloads.
    this.ambientNodes = [rumble, air, rain, lowpass, band, airGain, high, rainG, this.ambientGain];
  }

  private ambientNodes: AudioNode[] = [];

  stopAmbient(): void {
    if (!this.ambientPlaying) return;
    this.ambientPlaying = false;
    const ctx = this.ctx;
    if (ctx && this.ambientGain) this.ambientGain.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    const sources = [this.ambientSource, this.ambientAir, this.rainSource];
    for (const src of sources) {
      try {
        src?.stop(ctx ? ctx.currentTime + 0.6 : 0);
      } catch {
        /* already stopped */
      }
    }
    // Fully detach after the fade so no node stays in the graph.
    window.setTimeout(() => {
      for (const node of this.ambientNodes) {
        try {
          node.disconnect();
        } catch {
          /* ignore */
        }
      }
      this.ambientNodes = [];
    }, 800);
    this.ambientSource = null;
    this.ambientAir = null;
    this.rainSource = null;
    this.rainGain = null;
    this.ambientGain = null;
  }

  /** Rain loudness (0..1) driven by the realistic style's weather. */
  setRain(amount: number): void {
    this.rainAmount = clamp(amount, 0, 1);
    if (this.rainGain && this.ctx) {
      this.rainGain.gain.setTargetAtTime(this.rainAmount * 0.16, this.ctx.currentTime, 0.4);
    }
  }

  private get stepDuration(): number {
    // 16th notes at the configured BPM.
    return 60 / CONFIG.audio.bpm / 4;
  }

  /** Look-ahead scheduler: keeps ~150 ms of music queued. */
  private scheduler(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicPlaying) return;
    const now = ctx.currentTime;
    // Never try to make up for missed musical time. If the main thread stalls for
    // a moment (a heavy frame, a shader compile, GC), the naive version queues
    // every skipped 16th note at once — hundreds of nodes in one synchronous
    // block — which lengthens the very stall that caused it and can lock the tab
    // up for good. Dropping the missed notes keeps node creation bounded.
    if (this.nextNoteTime < now) this.nextNoteTime = now + 0.05;
    const horizon = now + 0.15;
    let guard = 0;
    while (this.nextNoteTime < horizon && guard++ < 8) {
      this.scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += this.stepDuration;
      this.step = (this.step + 1) % 64; // 4 bars of 16 steps
    }
  }

  private scheduleStep(step: number, time: number): void {
    const bar = Math.floor(step / 16);
    const beat = step % 16;
    const chord = AudioManager.PROGRESSION[bar % AudioManager.PROGRESSION.length]!;
    const root = chord[0]!;

    // --- kick: four on the floor with a pickup
    if (beat % 4 === 0 || beat === 14) this.kick(time);
    // --- clap on 2 and 4
    if (beat === 4 || beat === 12) this.clap(time);
    // --- hats on every 8th, accented off-beats
    if (beat % 2 === 0) this.hat(time, beat % 4 === 2 ? 0.22 : 0.12);

    // --- bass: driving 8ths with an octave jump
    if (beat % 2 === 0) {
      const octave = beat % 8 === 6 ? 2 : 1;
      this.bass(time, root * octave, this.stepDuration * 1.6);
    }
    // --- pad at the start of every bar
    if (beat === 0) this.pad(time, chord, this.stepDuration * 16);
    // --- arpeggio on 16ths (every other step for a classic pluck feel)
    if (beat % 2 === 1) {
      const note = chord[(step + bar) % chord.length]! * 4;
      this.pluck(time, note);
    }
  }

  private kick(time: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.14);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(1.0, time + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.34);
    osc.connect(gain).connect(this.musicGain!);
    this.autoRelease(osc, gain);
    osc.start(time);
    osc.stop(time + 0.4);
  }

  private clap(time: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.42, time + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
    src.connect(filter).connect(gain).connect(this.musicGain!);
    this.autoRelease(src, filter, gain);
    src.start(time);
    src.stop(time + 0.3);
  }

  private hat(time: number, level: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(level, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    src.connect(filter).connect(gain).connect(this.musicGain!);
    this.autoRelease(src, filter, gain);
    src.start(time);
    src.stop(time + 0.1);
  }

  private bass(time: number, freq: number, duration: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(220, time);
    filter.frequency.linearRampToValueAtTime(900, time + 0.04);
    filter.frequency.exponentialRampToValueAtTime(160, time + duration);
    filter.Q.value = 6;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.34, time + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(filter).connect(gain).connect(this.musicGain!);
    this.autoRelease(osc, filter, gain);
    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  private pad(time: number, chord: number[], duration: number): void {
    const ctx = this.ctx!;
    for (const note of chord) {
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = note * 2;
        osc.detune.value = detune;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(500, time);
        filter.frequency.linearRampToValueAtTime(1500, time + duration * 0.5);
        filter.frequency.linearRampToValueAtTime(700, time + duration);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.linearRampToValueAtTime(0.055, time + duration * 0.35);
        gain.gain.linearRampToValueAtTime(0.0001, time + duration);
        osc.connect(filter).connect(gain).connect(this.musicGain!);
        this.autoRelease(osc, filter, gain);
        osc.start(time);
        osc.stop(time + duration + 0.1);
      }
    }
  }

  /**
   * One shared delay line gives every pluck its neon shimmer. Building a fresh
   * Delay + feedback loop per note would leave an active cycle in the graph
   * forever (a stopped oscillator cannot break a cycle it no longer feeds).
   */
  private ensurePluckChain(): { delay: DelayNode; feedback: GainNode } {
    const ctx = this.ctx!;
    if (!this.pluckDelay || !this.pluckFeedback) {
      this.pluckDelay = ctx.createDelay(0.5);
      this.pluckDelay.delayTime.value = this.stepDuration * 3;
      this.pluckFeedback = ctx.createGain();
      this.pluckFeedback.gain.value = 0.3;
      this.pluckDelay.connect(this.pluckFeedback);
      this.pluckFeedback.connect(this.pluckDelay);
      this.pluckDelay.connect(this.musicGain!);
    }
    return { delay: this.pluckDelay, feedback: this.pluckFeedback };
  }

  private pluck(time: number, freq: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = clamp(freq, 200, 2400);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.09, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
    const { delay } = this.ensurePluckChain();
    const send = ctx.createGain();
    send.gain.value = 0.5;
    osc.connect(gain);
    gain.connect(this.musicGain!);
    gain.connect(send).connect(delay);
    this.autoRelease(osc, gain, send);
    osc.start(time);
    osc.stop(time + 0.24);
  }

  // ------------------------------------------------------------------- SFX

  /** Countdown blip; the final "GO" is brighter and longer. */
  playCountdown(isGo: boolean): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const time = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = isGo ? 'square' : 'triangle';
    osc.frequency.setValueAtTime(isGo ? 880 : 520, time);
    if (isGo) osc.frequency.exponentialRampToValueAtTime(1320, time + 0.18);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(isGo ? 0.32 : 0.24, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + (isGo ? 0.6 : 0.25));
    osc.connect(gain).connect(this.sfxGain);
    this.autoRelease(osc, gain);
    osc.start(time);
    osc.stop(time + 0.7);
  }

  /** Nitro ignition whoosh. */
  playNitro(): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const time = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.1;
    filter.frequency.setValueAtTime(400, time);
    filter.frequency.exponentialRampToValueAtTime(4200, time + 0.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.3, time + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.6);
    src.connect(filter).connect(gain).connect(this.sfxGain);
    this.autoRelease(src, filter, gain);
    src.start(time);
    src.stop(time + 0.7);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, time);
    osc.frequency.exponentialRampToValueAtTime(320, time + 0.35);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, time);
    og.gain.linearRampToValueAtTime(0.18, time + 0.04);
    og.gain.exponentialRampToValueAtTime(0.0001, time + 0.45);
    osc.connect(og).connect(this.sfxGain);
    this.autoRelease(osc, og);
    osc.start(time);
    osc.stop(time + 0.5);
  }

  /** Impact crunch; `strength` 0..1 scales level and brightness. */
  playCrash(strength: number): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const time = ctx.currentTime;
    const s = clamp(strength, 0.1, 1);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900 + s * 2200;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.12 + s * 0.34, time + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18 + s * 0.3);
    src.connect(filter).connect(gain).connect(this.sfxGain);
    this.autoRelease(src, filter, gain);
    src.start(time);
    src.stop(time + 0.6);

    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(160, time);
    thud.frequency.exponentialRampToValueAtTime(48, time + 0.22);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, time);
    tg.gain.linearRampToValueAtTime(0.16 + s * 0.3, time + 0.008);
    tg.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
    thud.connect(tg).connect(this.sfxGain);
    this.autoRelease(thud, tg);
    thud.start(time);
    thud.stop(time + 0.34);
  }

  /** Speed pad zap. */
  playBoostPad(): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const time = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(360, time);
    osc.frequency.exponentialRampToValueAtTime(1500, time + 0.22);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.22, time + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
    osc.connect(gain).connect(this.sfxGain);
    this.autoRelease(osc, gain);
    osc.start(time);
    osc.stop(time + 0.34);
  }

  /** Lap chime; `isBest` plays a brighter arpeggio. */
  playLap(isBest: boolean): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const notes = isBest ? [880, 1174, 1568] : [660, 880];
    notes.forEach((freq, i) => {
      const time = ctx.currentTime + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.linearRampToValueAtTime(0.2, time + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
      osc.connect(gain).connect(this.sfxGain!);
      this.autoRelease(osc, gain);
      osc.start(time);
      osc.stop(time + 0.34);
    });
  }

  /** Race finish fanfare. */
  playFinish(): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const chord = [523.25, 659.25, 783.99, 1046.5];
    chord.forEach((freq, i) => {
      const time = ctx.currentTime + i * 0.12;
      const osc = ctx.createOscillator();
      osc.type = i === chord.length - 1 ? 'square' : 'sawtooth';
      osc.frequency.value = freq;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 3200;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.linearRampToValueAtTime(0.16, time + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.1);
      osc.connect(filter).connect(gain).connect(this.sfxGain!);
      this.autoRelease(osc, filter, gain);
      osc.start(time);
      osc.stop(time + 1.2);
    });
  }

  /** Generic UI blip. */
  playUi(up = true): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const time = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(up ? 620 : 420, time);
    osc.frequency.exponentialRampToValueAtTime(up ? 940 : 260, time + 0.1);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.1, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
    osc.connect(gain).connect(this.sfxGain);
    this.autoRelease(osc, gain);
    osc.start(time);
    osc.stop(time + 0.2);
  }

  // ---------------------------------------------------------------- engine

  /** Continuous engine + wind bed, driven by speed and throttle. */
  startEngine(): void {
    if (!this.ctx || !this.sfxGain || this.engineRunning) return;
    const ctx = this.ctx;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 4;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0001;
    this.engineFilter.connect(this.engineGain).connect(this.sfxGain);

    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 60;
    this.engineOsc.connect(this.engineFilter);

    this.engineSub = ctx.createOscillator();
    this.engineSub.type = 'square';
    this.engineSub.frequency.value = 30;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.4;
    this.engineSub.connect(subGain).connect(this.engineFilter);

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 700;
    windFilter.Q.value = 0.6;
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = this.noiseBuffer;
    this.windSource.loop = true;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0001;
    this.windSource.connect(windFilter).connect(this.windGain).connect(this.sfxGain);

    this.engineOsc.start();
    this.engineSub.start();
    this.windSource.start();
    this.engineRunning = true;
  }

  /** Called every frame while driving. */
  updateEngine(speedRatio: number, throttle: number, boosting: boolean): void {
    if (!this.ctx || !this.engineRunning || !this.engineOsc || !this.engineGain) return;
    const t = this.ctx.currentTime;
    const ratio = clamp(speedRatio, 0, 1.4);
    const targetFreq = 52 + ratio * 260 + (boosting ? 34 : 0) + throttle * 14;
    this.engineOsc.frequency.setTargetAtTime(targetFreq, t, 0.06);
    this.engineSub?.frequency.setTargetAtTime(targetFreq * 0.5, t, 0.06);
    this.engineFilter?.frequency.setTargetAtTime(500 + ratio * 2600 + throttle * 400, t, 0.08);
    this.engineGain.gain.setTargetAtTime(0.035 + ratio * 0.075 + throttle * 0.03, t, 0.1);
    this.windGain?.gain.setTargetAtTime(ratio * ratio * 0.075, t, 0.15);
  }

  stopEngine(): void {
    if (!this.engineRunning) return;
    try {
      this.engineOsc?.stop();
      this.engineSub?.stop();
      this.windSource?.stop();
    } catch {
      /* nodes may already be stopped — safe to ignore */
    }
    this.engineOsc = null;
    this.engineSub = null;
    this.windSource = null;
    this.engineRunning = false;
  }
}
