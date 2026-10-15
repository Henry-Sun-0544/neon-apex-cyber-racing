import * as THREE from 'three';
import { AIVehicle } from './AIVehicle';
import { AIController, createProfiles, type AIProfile } from './AIController';
import { AudioManager } from './AudioManager';
import { City } from './City';
import { CollisionSystem } from './CollisionSystem';
import { CONFIG } from './Config';
import type { HudState } from './Types';
import { GameState, type RaceHooks, type Racer } from './GameState';
import { Input } from './Input';
import { ParticleSystem } from './ParticleSystem';
import { PlayerVehicle } from './PlayerVehicle';
import { SceneManager } from './SceneManager';
import { Track } from './Track';
import type { CollisionEvent } from './Types';
import { UIManager } from './UIManager';
import { clamp } from './Utils';
import { emptyInput, type VehicleInput } from './VehicleBase';

export interface GameOptions {
  /** Skips the start menu (used by automated smoke tests / quick play). */
  autostart?: boolean;
  /** Skips the 3-2-1 countdown (only meaningful together with autostart). */
  skipCountdown?: boolean;
  /** Attract mode: the player car is driven by the racing AI (demos / tests). */
  autopilot?: boolean;
  /** Lap override, handy for short demo races. */
  laps?: number;
}

/**
 * Top level game object: owns the world, the race director, input, audio,
 * UI and the frame loop. Everything else is a focused subsystem.
 */
export class Game {
  readonly sceneManager: SceneManager;
  readonly track: Track;
  readonly city: City;
  readonly particles = new ParticleSystem();
  readonly player = new PlayerVehicle();
  readonly ais: AIVehicle[] = [];
  readonly state: GameState;
  readonly audio = new AudioManager();
  readonly ui: UIManager;

  private readonly input = new Input();
  private readonly collision: CollisionSystem;
  private lastTime = 0;
  private elapsed = 0;
  private running = false;
  private fps = 60;
  private fpsTimer = 0;
  private fpsFrames = 0;
  private hudTimer = 0;
  private mapTimer = 0;
  private audioCooldown = 0;
  private finishDelay = -1;
  private goDisplayTimer = 0;
  private lastCountdownInt = -1;
  private readonly options: GameOptions;
  /** Attract-mode driver used when `options.autopilot` is set. */
  private autopilot: AIController | null = null;
  private readonly tmpVec = new THREE.Vector3();
  private readonly rivalBuffer: Array<{ position: THREE.Vector3; progress: number }> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: GameOptions = {},
  ) {
    this.options = options;
    if (options.laps && options.laps > 0) CONFIG.race.laps = Math.floor(options.laps);

    // ------------------------------------------------------------- world
    this.sceneManager = new SceneManager(canvas);
    this.track = new Track();
    this.city = new City(this.track);
    this.sceneManager.scene.add(this.track.group, this.city.group, this.particles.group);

    // ------------------------------------------------------------ racers
    this.sceneManager.scene.add(this.player.object);
    const profiles = createProfiles(CONFIG.race.aiCount);
    for (const profile of profiles) {
      const ai = new AIVehicle(profile, this.track);
      this.ais.push(ai);
      this.sceneManager.scene.add(ai.object);
    }
    this.collision = new CollisionSystem(this.city.collisionBoxes);
    this.state = new GameState(this.track, this.player, this.ais);
    if (options.autopilot) {
      const profile: AIProfile = {
        name: 'AUTOPILOT',
        bodyColor: 0x1b2340,
        accentColor: CONFIG.colors.cyan,
        speedScale: 1.0,
        laneBias: 0,
        wobble: 1.1,
        phase: 0.7,
        mistakeChance: 0.015,
        nitroSkill: 0.85,
      };
      this.autopilot = new AIController(profile, this.track);
    }

    // ----------------------------------------------------------------- UI
    this.ui = new UIManager(
      {
        onStart: () => void this.startRace(),
        onRestart: () => this.restart(),
        onMenu: () => this.backToMenu(),
        onMuteToggle: (muted) => this.audio.setMuted(muted),
        onVolumeChange: (volume) => this.audio.setVolume(volume),
      },
      this.track,
    );
    this.ui.setMuted(false);

    this.state.resetToGrid();
    this.snapCameraToPlayer();
    this.exposeDebugHandle();
  }

  // ------------------------------------------------------------------ boot

  /** Starts the render loop and either shows the menu or drops into a race. */
  boot(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.lastTime = performance.now();
    this.ui.showMenu();
    this.ui.showHud(false);
    if (this.options.autostart) {
      void this.startRace().then(() => {
        if (this.options.skipCountdown) {
          this.state.countdown = 0;
          this.state.phase = 'racing';
          this.ui.hideCountdown();
        }
      });
    }
    requestAnimationFrame(this.tick);
  }

  private readonly onResize = (): void => this.sceneManager.resize();

  private readonly onBlur = (): void => {
    // Avoid an audio drone while the window is in the background.
    this.audio.updateEngine(0, 0, false);
  };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.ui.setError('WebGL context lost — please refresh the page.');
  };

  // --------------------------------------------------------------- control

  /** Starts the countdown and the soundtrack (must be called from a gesture). */
  async startRace(): Promise<void> {
    try {
      await this.audio.init();
      this.audio.setVolume(this.ui.volume);
      this.audio.startMusic();
      this.audio.startEngine();
      this.audio.playUi(true);
    } catch (error) {
      console.warn('[NA:CR] audio unavailable', error);
      this.ui.setHint('音频不可用（浏览器策略），游戏仍可正常游玩。');
    }
    this.ui.hideMenu();
    this.ui.hideResults();
    this.ui.showHud(true);
    this.ui.showCountdown(true);
    this.lastCountdownInt = -1;
    this.goDisplayTimer = 0;
    this.finishDelay = -1;
    this.state.startCountdown();
    this.snapCameraToPlayer();
    // The HUD is only refreshed on racing frames, so paint it here too: a
    // restart would otherwise leave the previous race's clock on screen for
    // the whole countdown.
    this.ui.updateHud(this.hudState());
  }

  /** Full race restart (grid reset + countdown). */
  restart(): void {
    this.particles.reset();
    this.ui.hideResults();
    this.ui.showHud(true);
    void this.startRace();
  }

  /** Back to the title screen; the world keeps rendering behind the menu. */
  backToMenu(): void {
    this.state.phase = 'menu';
    this.state.resetToGrid();
    this.particles.reset();
    this.ui.showMenu();
    this.ui.showHud(false);
    this.ui.hideResults();
    this.ui.hideCountdown();
    this.snapCameraToPlayer();
    this.audio.updateEngine(0, 0, false);
  }

  private snapCameraToPlayer(): void {
    this.sceneManager.snapTo({
      position: this.player.position,
      yaw: this.player.yaw,
      speed: this.player.speed,
      boosting: false,
    });
  }

  // ------------------------------------------------------------- main loop

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.tick);
    const dt = clamp((now - this.lastTime) / 1000, 0, 1 / 20);
    this.lastTime = now;
    this.elapsed += dt;
    this.updateFps(dt);
    this.update(dt);
    this.sceneManager.render(dt);
    this.input.update();
  };

  private updateFps(dt: number): void {
    this.fpsTimer += dt;
    this.fpsFrames += 1;
    if (this.fpsTimer >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTimer;
      this.fpsTimer = 0;
      this.fpsFrames = 0;
    }
  }

  private update(dt: number): void {
    this.audioCooldown = Math.max(0, this.audioCooldown - dt);
    this.handleHotkeys();
    this.ui.tickToast(dt);

    switch (this.state.phase) {
      case 'menu':
        this.updateMenu(dt);
        break;
      case 'countdown':
        this.updateCountdown(dt);
        break;
      default:
        this.updateRacing(dt);
        break;
    }

    this.city.update(dt, this.elapsed);
    this.particles.update(dt);
    this.particles.updateAmbientDust(dt, this.sceneManager.camera.position, this.player.speed / CONFIG.car.maxSpeed);
  }

  private handleHotkeys(): void {
    if (this.input.wasPressed('KeyM')) {
      const muted = this.audio.toggleMuted();
      this.ui.setMuted(muted);
      this.audio.playUi(!muted);
    }
    if (this.input.wasPressed('KeyC')) {
      this.sceneManager.toggleCameraMode();
      this.audio.playUi(true);
    }
    if (this.input.wasPressed('KeyR')) {
      if (this.state.phase === 'racing' || this.state.phase === 'finished' || this.state.phase === 'countdown') this.restart();
    }
    if (this.input.wasPressed('Escape') && this.state.phase !== 'menu') {
      this.backToMenu();
    }
  }

  /** Slow orbit around the parked grid behind the start menu. */
  private updateMenu(dt: number): void {
    this.sceneManager.updateMenuCamera(dt, this.player.position, this.elapsed);
  }

  private updateCountdown(dt: number): void {
    const hold = emptyInput();
    this.player.update(dt, hold, this.track, this.particles);
    this.collision.resolve(this.player, this.track, this.ais, dt);
    for (const ai of this.ais) {
      this.updateAI(ai, dt, hold);
    }

    const value = this.state.countdown;
    const intValue = Math.ceil(value);
    if (intValue !== this.lastCountdownInt) {
      this.lastCountdownInt = intValue;
      if (intValue > 0) {
        this.ui.setCountdown(String(intValue), 'GET READY / 准备', false);
        this.audio.playCountdown(false);
      }
    }
    if (value <= 0 && this.goDisplayTimer === 0) {
      this.goDisplayTimer = 0.001;
      this.ui.setCountdown('GO!', 'FULL THROTTLE / 全速', true);
      this.audio.playCountdown(true);
    }

    this.state.update(dt, this.raceHooks());
    this.updateCamera(dt);

    if (this.state.phase === 'racing') {
      // The number is already gone, keep the GO! flash for a moment.
      this.goDisplayTimer = 0.9;
    }
  }

  private updateRacing(dt: number): void {
    const input: VehicleInput = this.autopilot ? this.autopilotInput(dt) : {
      throttle: this.input.throttle,
      brake: this.input.brake,
      steer: this.input.steer,
      nitro: this.input.nitro && this.state.phase === 'racing',
    };

    const wasNitro = this.player.nitroActive;
    this.player.update(dt, input, this.track, this.particles);
    if (!wasNitro && this.player.nitroActive) this.audio.playNitro();
    if (this.player.padPicked) {
      this.audio.playBoostPad();
      this.ui.toast('BOOST PAD', 900);
    }

    for (const ai of this.ais) this.updateAI(ai, dt, null);

    // ------------------------------------------------------ collisions
    const allVehicles = [this.player, ...this.ais];
    this.handleEvents(this.collision.resolve(this.player, this.track, allVehicles, dt), true);
    for (const ai of this.ais) {
      this.handleEvents(this.collision.resolve(ai, this.track, allVehicles, dt), false);
    }

    // ------------------------------------------------------ race director
    this.state.update(dt, this.raceHooks());

    // --------------------------------------------------------------- HUD
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.05;
      this.ui.updateHud(this.hudState());
    }
    this.mapTimer -= dt;
    if (this.mapTimer <= 0) {
      this.mapTimer = 0.08;
      this.ui.drawMinimap(this.minimapDots());
    }

    this.audio.updateEngine(
      Math.abs(this.player.speed) / CONFIG.car.maxSpeed,
      input.throttle,
      this.player.boosting,
    );
    this.updateCamera(dt);

    // --------------------------------------------------------- GO! flash
    if (this.goDisplayTimer > 0) {
      this.goDisplayTimer -= dt;
      if (this.goDisplayTimer <= 0) this.ui.hideCountdown();
    }

    // ------------------------------------------------------ race finished
    if (this.state.phase === 'finished' && this.finishDelay < 0) {
      this.finishDelay = 1.8;
      this.audio.playFinish();
    }
    if (this.finishDelay > 0) {
      this.finishDelay -= dt;
      if (this.finishDelay <= 0) {
        this.ui.showResults(this.state.results());
        this.audio.updateEngine(0, 0, false);
      }
    }
  }

  /** Attract-mode input for the player car (see GameOptions.autopilot). */
  private autopilotInput(dt: number): VehicleInput {
    this.rivalBuffer.length = 0;
    for (const racer of this.state.racers) {
      if (racer.isPlayer) continue;
      this.rivalBuffer.push({ position: racer.vehicle.position, progress: racer.raceDistance });
    }
    const self = this.state.player;
    return this.autopilot!.update(dt, this.player, {
      elapsed: this.elapsed,
      selfProgress: self.raceDistance,
      playerProgress: self.raceDistance,
      totalLength: this.track.totalLength,
      rivals: this.rivalBuffer,
    });
  }

  private updateAI(ai: AIVehicle, dt: number, forcedInput: VehicleInput | null): void {
    if (forcedInput) {
      // Countdown: hold position.
      ai.step(dt, forcedInput);
      return;
    }
    this.rivalBuffer.length = 0;
    for (const racer of this.state.racers) {
      if (racer.vehicle === ai) continue;
      this.rivalBuffer.push({ position: racer.vehicle.position, progress: racer.raceDistance });
    }
    const self = this.state.racers.find((r) => r.vehicle === ai);
    ai.update(dt, this.track, this.particles, {
      elapsed: this.elapsed,
      selfProgress: self?.raceDistance ?? 0,
      playerProgress: this.state.player.raceDistance,
      totalLength: this.track.totalLength,
      rivals: this.rivalBuffer,
    });
  }

  private updateCamera(dt: number): void {
    const speedRatio = clamp(Math.abs(this.player.speed) / CONFIG.car.maxSpeed, 0, 1.4);
    this.sceneManager.updateCamera(
      dt,
      {
        position: this.player.position,
        yaw: this.player.yaw,
        speed: this.player.speed,
        boosting: this.player.boosting,
      },
      speedRatio,
    );
  }

  /** Sparks, shake and audio for a batch of contacts. */
  private handleEvents(events: CollisionEvent[], isPlayer: boolean): void {
    for (const event of events) {
      this.particles.emitSparks(event.point, event.normal, event.strength, isPlayer ? 26 : 9);
      if (isPlayer) {
        this.sceneManager.addShake(event.strength * 0.8);
        if (event.strength > 0.35) this.ui.damageFlash();
        if (this.audioCooldown <= 0 && event.strength > 0.14) {
          this.audio.playCrash(event.strength);
          this.audioCooldown = 0.12;
        }
      } else if (event.strength > 0.4 && this.audioCooldown <= 0) {
        const distance = this.sceneManager.camera.position.distanceTo(
          this.tmpVec.set(event.point.x, event.point.y, event.point.z),
        );
        if (distance < 55) {
          this.audio.playCrash(event.strength * 0.4);
          this.audioCooldown = 0.18;
        }
      }
    }
  }

  private raceHooks(): RaceHooks {
    return {
      onLap: (racer: Racer, _lapTime: number, isBest: boolean) => {
        if (!racer.isPlayer) return;
        this.audio.playLap(isBest);
        if (isBest && racer.lap > 1) this.ui.toast('NEW BEST LAP', 1600);
        else if (racer.lap < this.state.totalLaps) this.ui.toast(`LAP ${racer.lap + 1}/${this.state.totalLaps}`, 1400);
      },
      onLapStarted: (racer: Racer) => {
        if (!racer.isPlayer) return;
        if (racer.lap === this.state.totalLaps - 1) this.ui.toast('FINAL LAP / 最后一圈', 2000);
      },
      onFinish: (racer: Racer) => {
        if (racer.isPlayer) this.ui.toast('FINISH / 冲线', 2000);
      },
    };
  }

  private hudState(): HudState {
    const snapshot = this.state.playerSnapshot();
    const player = this.state.player;
    // The car keeps its last projected sample index, so the tangent lookup is O(1).
    const sample = this.track.samples[Math.max(0, Math.min(this.track.samples.length - 1, player.vehicle.hintIndex))]!;
    const forward = this.player.forwardVector();
    const wrongWay = this.player.speed > 3 && forward.dot(sample.tangent) < -0.35;
    return {
      speedKmh: Math.abs(this.player.speed) * 3.6,
      position: snapshot.rank,
      totalRacers: this.state.racers.length,
      lap: snapshot.lap,
      totalLaps: this.state.totalLaps,
      raceTime: snapshot.raceTime,
      lapTime: snapshot.lapTime,
      bestLap: snapshot.bestLap,
      nitro: this.player.nitro,
      nitroActive: this.player.nitroActive,
      boosting: this.player.boosting,
      wrongWay,
      fps: this.fps,
    };
  }

  private minimapDots(): Array<{ x: number; z: number; color: string; isPlayer: boolean }> {
    return this.state.racers.map((racer) => ({
      x: racer.vehicle.position.x,
      z: racer.vehicle.position.z,
      color: racer.isPlayer ? '#24f0ff' : `#${racer.vehicle.accent.getHexString()}`,
      isPlayer: racer.isPlayer,
    }));
  }

  /** Lightweight handle used by automated smoke tests and the console. */
  private exposeDebugHandle(): void {
    const gameRef = this;
    (window as unknown as { __NACR__: unknown }).__NACR__ = {
      get phase() {
        return gameRef.state.phase;
      },
      get speedKmh() {
        return Math.abs(gameRef.player.speed) * 3.6;
      },
      /** Laps *completed*; the HUD shows the 1-based lap in progress. */
      get lap() {
        return gameRef.state.player.lap;
      },
      /** Heading in radians (0 = +Z); used by the harness to verify steering. */
      get yaw() {
        return gameRef.player.yaw;
      },
      get rank() {
        return gameRef.state.player.rank;
      },
      get raceTime() {
        return gameRef.state.raceTime;
      },
      get aiCount() {
        return gameRef.ais.length;
      },
      get particles() {
        return gameRef.particles.liveCount;
      },
      get bloom() {
        return gameRef.sceneManager.postProcessingActive;
      },
      get fps() {
        return gameRef.fps;
      },
      get nitro() {
        return gameRef.player.nitro;
      },
      get boosting() {
        return gameRef.player.boosting;
      },
      get resultsVisible() {
        return !document.getElementById('results')!.classList.contains('hidden');
      },
      get hudVisible() {
        return !document.getElementById('hud')!.classList.contains('hidden');
      },
      get hudSpeed() {
        return document.getElementById('hud-speed')!.textContent;
      },
      get hudLap() {
        return document.getElementById('hud-lap')!.textContent;
      },
      get aiProgress() {
        return gameRef.ais.map((ai) => Math.round(ai.position.length()));
      },
      /**
       * Worst angle (degrees) between a boost pad's chevron direction (its
       * texture-up axis) and the track tangent under it — ~0 when every pad
       * points down the road. Regression guard for pad placement.
       */
      get padMisalignmentDeg(): number {
        let worst = 0;
        const arrow = new THREE.Vector3();
        for (const pad of gameRef.track.boostPads) {
          arrow.set(0, 1, 0).applyQuaternion(pad.mesh.quaternion);
          const tangent = gameRef.track.frameAt(pad.distance).tangent;
          worst = Math.max(worst, Math.acos(clamp(arrow.dot(tangent), -1, 1)));
        }
        return THREE.MathUtils.radToDeg(worst);
      },
      restart: () => gameRef.restart(),
      start: () => void gameRef.startRace(),
    };
  }
}
