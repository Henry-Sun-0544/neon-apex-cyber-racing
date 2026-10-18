import * as THREE from 'three';
import { AIVehicle } from './AIVehicle';
import { AIController, createProfiles, type AIProfile } from './AIController';
import { AudioManager } from './AudioManager';
import { City } from './City';
import { CollisionSystem } from './CollisionSystem';
import { CONFIG, resolveCarPreset, type CarId } from './Config';
import { DebugOverlay } from './DebugOverlay';
import type { HudState } from './Types';
import { GameState, type RaceHooks, type Racer } from './GameState';
import { Input } from './Input';
import { ParticleSystem } from './ParticleSystem';
import { PlayerVehicle } from './PlayerVehicle';
import { QualityManager, type QualityPresetId } from './QualityManager';
import { SceneManager } from './SceneManager';
import { Track } from './Track';
import type { CollisionEvent } from './Types';
import { UIManager } from './UIManager';
import { clamp, formatTime } from './Utils';
import { emptyInput, type VehicleBase, type VehicleInput } from './VehicleBase';
import { StyleManager } from './styles/StyleManager';
import { detailForQuality, type VehicleDetail } from './VehicleFactory';
import { STYLE_META, type GameStyle, type GameStyleId } from './styles/GameStyle';
import { MAP_MODE_META, MapModeStore, type MapModeId } from './world/MapMode';
import type { RaceWorld } from './world/RaceWorld';
import { OpenWorld } from './world/OpenWorld';
import { WeatherStore, type WeatherState } from './world/WeatherState';
import { RealisticStyle } from './styles/RealisticStyle';

export interface GameOptions {
  /** Skips the start menu (used by automated smoke tests / quick play). */
  autostart?: boolean;
  /** Skips the 3-2-1 countdown (only meaningful together with autostart). */
  skipCountdown?: boolean;
  /** Attract mode: the player car is driven by the racing AI (demos / tests). */
  autopilot?: boolean;
  /** Lap override, handy for short demo races. */
  laps?: number;
  /** Garage pick for the player (?car= URL flag); falls back to localStorage. */
  car?: string;
  /** Style override (?style=cyberpunk|realistic). */
  style?: string;
  /** Quality override (?quality=low|medium|high|ultra). */
  quality?: string;
  /** Map-mode override (?map=circuit|openworld). */
  map?: string;
}

const QUALITY_IDS: QualityPresetId[] = ['low', 'medium', 'high', 'ultra'];

/**
 * Top level game object: owns the world, the race director, input, audio,
 * UI and the frame loop. Everything else is a focused subsystem.
 *
 * Round 2 added three orthogonal "modes" that can be changed at any time —
 * style (look), quality (budget) and map mode (circuit vs open world).
 * Switching the style never touches race state; switching the map mode swaps
 * the race route, so it restarts the current race (documented in the README).
 */
export class Game {
  readonly sceneManager: SceneManager;
  readonly quality: QualityManager;
  readonly styles: StyleManager;
  readonly particles = new ParticleSystem();
  /** Built in the constructor: it needs the scene manager's material library. */
  readonly player: PlayerVehicle;
  readonly ais: AIVehicle[] = [];
  readonly audio = new AudioManager();
  readonly ui: UIManager;
  readonly state: GameState;

  /** The race route used for lap logic, AI and collision. */
  world: RaceWorld;
  /** The circuit (Round 1) — built at boot, kept for instant switching. */
  private circuit: Track;
  private openWorld: OpenWorld | null = null;
  private city: City | null = null;
  private mapMode: MapModeId;

  private readonly input = new Input();
  private collision: CollisionSystem;
  private readonly debug: DebugOverlay;
  private debugRoster: VehicleBase[];
  private lastTime = 0;
  private elapsed = 0;
  private running = false;
  private paused = false;
  private fps = 60;
  private fpsTimer = 0;
  private fpsFrames = 0;
  private hudTimer = 0;
  private mapTimer = 0;
  private chipTimer = 0;
  private audioCooldown = 0;
  private finishDelay = -1;
  private goDisplayTimer = 0;
  private lastCountdownInt = -1;
  private readonly options: GameOptions;
  /** Vehicle detail rank derived from the active quality preset. */
  private detail: VehicleDetail;
  /** Attract-mode driver used when `options.autopilot` is set. */
  private autopilot: AIController | null = null;
  /** Garage pick currently applied to the player car. */
  private currentCarId: CarId = 'concept';
  private weatherPreference: WeatherState = 'auto';
  /** True while a style/quality/map switch is being applied. */
  private switching = false;
  private readonly tmpVec = new THREE.Vector3();
  private readonly rivalBuffer: Array<{ position: THREE.Vector3; progress: number }> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: GameOptions = {},
  ) {
    this.options = options;
    if (options.laps && options.laps > 0) CONFIG.race.laps = Math.floor(options.laps);
    this.currentCarId = resolveCarPreset(options.car ?? localStorage.getItem('nacr-car')).id;

    // ------------------------------------------------------------ modes
    this.quality = new QualityManager(this.resolveQuality(options.quality));
    this.detail = detailForQuality(this.quality.settings);
    const styleId = this.resolveStyle(options.style);
    this.styles = new StyleManager(styleId);
    this.mapMode = this.resolveMapMode(options.map);
    this.weatherPreference = WeatherStore.load();

    // ------------------------------------------------------------- world
    this.sceneManager = new SceneManager(canvas, this.quality, this.styles.current);
    // The circuit is always built: it is the default mode and the rollback
    // target if the open world ever fails to generate.
    this.circuit = new Track();
    this.world = this.circuit;
    this.city = new City(this.circuit);
    this.sceneManager.scene.add(this.circuit.group, this.city.group, this.particles.group);

    this.particles.setWeatherTextures(this.sceneManager.materials.rainStreak(), this.sceneManager.materials.softDot());
    this.applyWeatherToStyle();

    // ------------------------------------------------------------ racers
    // The player car is built here (not as a field initialiser) because the
    // high-detail body needs the scene manager's material library.
    this.player = new PlayerVehicle(this.detail, this.sceneManager.materials);
    this.applyCarPreset(this.currentCarId);
    this.sceneManager.scene.add(this.player.object);
    const profiles = createProfiles(CONFIG.race.aiCount);
    for (const profile of profiles) {
      const ai = new AIVehicle(profile, this.world, this.detail, this.sceneManager.materials, this.styles.id);
      this.ais.push(ai);
      this.sceneManager.scene.add(ai.object);
    }
    this.collision = new CollisionSystem(this.worldCollisionBoxes());
    this.debugRoster = [this.player, ...this.ais];
    this.debug = new DebugOverlay(this.worldCollisionBoxes(), this.world, this.debugRoster);
    this.sceneManager.scene.add(this.debug.group);
    this.state = new GameState(this.world, this.player, this.ais);
    if (options.autopilot) {
      const profile: AIProfile = {
        name: 'AUTOPILOT',
        bodyColor: 0x1b2340,
        accentColor: CONFIG.colors.cyan,
        carId: 'concept',
        speedScale: 1.0,
        laneBias: 0,
        wobble: 1.1,
        phase: 0.7,
        mistakeChance: 0.015,
        nitroSkill: 0.85,
      };
      this.autopilot = new AIController(profile, this.world);
    }

    // ----------------------------------------------------------------- UI
    this.ui = new UIManager(
      {
        onStart: () => void this.startRace(),
        onRestart: () => this.restart(),
        onMenu: () => this.backToMenu(),
        onMuteToggle: (muted) => this.audio.setMuted(muted),
        onVolumeChange: (volume) => this.audio.setVolume(volume),
        onSelectCar: (id) => this.selectCar(id),
        onSelectStyle: (id) => this.setStyle(id),
        onSelectQuality: (id) => this.setQuality(id),
        onSelectMap: (id) => this.setMapMode(id),
        onSelectWeather: (id) => this.setWeather(id),
        onResume: () => this.setPaused(false),
      },
      this.world,
    );
    this.ui.setMuted(false);
    this.ui.setGarageSelection(this.currentCarId);

    // ------------------------------------------------------- mode wiring
    this.ui.setSelections({
      style: this.styles.id,
      quality: this.quality.presetId,
      map: this.mapMode,
      weather: this.weatherPreference,
    });
    this.quality.onChange = () => this.onQualityChanged();
    this.applyWorldTheme(this.styles.id);
    this.applyUiTheme(this.styles.id);
    this.ui.setQualityChip(this.quality.presetLabel, false, '');
    // Build the open world immediately when it is the persisted default, so the
    // first race does not start on a "generating world" veil.
    if (this.mapMode === 'openworld') this.installMapMode('openworld');

    this.state.resetToGrid();
    this.snapCameraToPlayer();
    this.exposeDebugHandle();
  }

  // ------------------------------------------------------------- helpers

  private resolveQuality(urlValue?: string): QualityPresetId {
    const candidate = (urlValue ?? localStorage.getItem('nacr-quality')) as QualityPresetId | null;
    if (candidate && QUALITY_IDS.includes(candidate)) return candidate;
    return CONFIG.quality.default;
  }

  private resolveStyle(urlValue?: string): GameStyleId {
    if (urlValue === 'cyberpunk' || urlValue === 'realistic') return urlValue;
    return StyleManager.loadPreference(CONFIG.style.default);
  }

  private resolveMapMode(urlValue?: string): MapModeId {
    if (urlValue === 'circuit' || urlValue === 'openworld') return urlValue;
    return MapModeStore.load(CONFIG.map.default);
  }

  private worldCollisionBoxes() {
    if (this.mapMode === 'openworld' && this.openWorld) {
      return [...this.openWorld.collisionBoxes, ...(this.city?.collisionBoxes ?? [])];
    }
    return this.city?.collisionBoxes ?? [];
  }

  // ------------------------------------------------------------------ boot

  /** Starts the render loop and either shows the menu or drops into a race. */
  boot(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.lastTime = performance.now();
    this.ui.showMenu();
    this.ui.showHud(false);
    this.ui.hideLoading();
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
    this.audio.updateEngine(0, 0, false);
  };

  /**
   * Hidden-tab guard: the simulation is paused while the tab is in the
   * background so a long alt-tab cannot run the race clock away. Window blur is
   * deliberately NOT used — it would fire for DevTools and for automation.
   */
  private readonly onVisibility = (): void => {
    if (!document.hidden) return;
    if (this.state.phase === 'racing' || this.state.phase === 'countdown') this.setPaused(true);
  };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.ui.setError('WebGL context lost — please refresh the page.');
  };

  // --------------------------------------------------------------- control

  /** Starts the countdown and the soundtrack (must be called from a gesture). */
  async startRace(): Promise<void> {
    if (this.switching) return;
    try {
      await this.audio.init();
      this.audio.setVolume(this.ui.volume);
      this.audio.setStyle(this.styles.id);
      this.audio.startMusic();
      this.audio.startEngine();
      this.audio.playUi(true);
    } catch (error) {
      console.warn('[NA:CR] audio unavailable', error);
      this.ui.setHint('音频不可用（浏览器策略），游戏仍可正常游玩。');
    }
    this.setPaused(false);
    this.ui.hideMenu();
    this.ui.hideResults();
    this.ui.showHud(true);
    this.ui.showCountdown(true);
    this.lastCountdownInt = -1;
    this.goDisplayTimer = 0;
    this.finishDelay = -1;
    this.state.startCountdown();
    this.snapCameraToPlayer();
    this.ui.updateHud(this.hudState());
  }

  /** Full race restart (grid reset + countdown). */
  restart(): void {
    if (this.switching) return;
    this.particles.reset();
    this.setPaused(false);
    this.ui.hideResults();
    this.ui.showHud(true);
    void this.startRace();
  }

  /** Back to the title screen; the world keeps rendering behind the menu. */
  backToMenu(): void {
    this.state.phase = 'menu';
    this.setPaused(false);
    this.state.resetToGrid();
    this.particles.reset();
    this.ui.showMenu();
    this.ui.showHud(false);
    this.ui.hideResults();
    this.ui.hideCountdown();
    this.snapCameraToPlayer();
    this.audio.updateEngine(0, 0, false);
  }

  /** Pause / resume without losing a single frame of race state. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.ui.showPause(paused);
    if (paused) {
      this.ui.setPauseState(this.pauseSummary());
      this.audio.updateEngine(0, 0, false);
    }
  }

  private pauseSummary(): string {
    const snap = this.state.playerSnapshot();
    const style = STYLE_META[this.styles.id];
    return [
      `风格 <b>${style.short}</b> · 画质 <b>${this.quality.presetLabel}</b> · 地图 <b>${MAP_MODE_META[this.mapMode].short}</b>`,
      `圈数 <b>${snap.lap}/${this.state.totalLaps}</b> · 名次 <b>P${snap.rank}</b> · 总时间 <b>${formatTime(snap.raceTime)}</b>`,
      `本圈 <b>${formatTime(snap.lapTime)}</b> · 最佳圈速 <b>${formatTime(snap.bestLap)}</b> · 氮气 <b>${Math.round(this.player.nitro)}%</b>`,
    ].join('<br>');
  }

  private snapCameraToPlayer(): void {
    this.sceneManager.snapTo({
      position: this.player.position,
      yaw: this.player.yaw,
      speed: this.player.speed,
      boosting: false,
    });
  }

  // ---------------------------------------------------------------- garage

  /** Applies a garage preset's looks + physics to the player car. */
  private applyCarPreset(id: CarId): void {
    const preset = resolveCarPreset(id);
    this.currentCarId = preset.id;
    this.player.setStyle({
      bodyColor: preset.bodyColor,
      accentColor: preset.accentColor,
      isPlayer: true,
      chassis: preset.chassis,
      theme: this.styles.id,
    });
    this.player.tune(preset.stats);
  }

  /** Garage selection from the menu card (keeps the menu-orbit preview live). */
  selectCar(id: CarId): void {
    this.applyCarPreset(id);
    localStorage.setItem('nacr-car', this.currentCarId);
    this.ui.setGarageSelection(this.currentCarId);
    this.audio.playUi(true);
  }

  // ------------------------------------------------------- mode switching

  /**
   * Switches the game style at any time — from the start menu, the pause menu,
   * a hotkey or the settings panel.
   *
   * Only presentation is rebuilt (sky, lights, fog, materials, post FX, car
   * skins, UI theme). Lap count, timers, nitro, positions, velocities, AI state
   * and the checkpoint/pad tables are never touched, so a mid-race switch is
   * seamless. A failure rolls back to the previous style.
   */
  setStyle(id: GameStyleId): void {
    if (this.switching || id === this.styles.id) return;
    const meta = STYLE_META[id];
    this.switching = true;
    this.ui.showLoading(`正在切换到${id === 'realistic' ? '真实风格' : '赛博朋克风格'}…`, `SWITCHING TO ${meta.short} · 保留比赛状态`);
    // Yield one frame so the veil is actually painted before the heavy work.
    requestAnimationFrame(() => {
      try {
        this.styles.safeSwitch(
          StyleManager.create(id),
          (style) => this.installStyle(style),
          (style) => this.installStyle(style),
        );
        this.applyWeatherToStyle();
        this.ui.setSelections({ style: id });
        this.audio.setStyle(id);
        this.ui.toast(`${meta.name} 已启用 · 状态已保留`, 1600);
        console.info(`[NA:CR] 风格切换 → ${meta.short} (圈数/计时/氮气/名次均保留)`);
      } catch (error) {
        this.ui.toast('风格切换失败，已回滚到上一个可用风格', 2600);
        this.ui.setError(`风格切换失败: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.switching = false;
        this.ui.hideLoading();
        // Refresh the HUD immediately so the style chip never lags behind.
        this.ui.updateHud(this.hudState());
      }
    });
  }

  /** Applies one style instance to every presentation-level consumer. */
  private installStyle(style: GameStyle): void {
    this.sceneManager.applyStyle(style);
    this.applyWorldTheme(style.id);
    this.applyUiTheme(style.id);
    for (const vehicle of [this.player, ...this.ais]) vehicle.setTheme(style.id);
    this.quality.resetDegradation();
    this.ui.setQualityChip(this.quality.presetLabel, false, '');
  }

  /** Cycles the style (T hotkey). */
  toggleStyle(): void {
    this.setStyle(this.styles.nextId());
  }

  /** Switches the quality preset (menu, pause menu or the Y hotkey). */
  setQuality(id: QualityPresetId): void {
    if (this.switching || id === this.quality.presetId) return;
    this.quality.setPreset(id);
    localStorage.setItem('nacr-quality', id);
    this.ui.setSelections({ quality: id });
    this.ui.toast(`画质预设：${this.quality.presetLabel}`, 1400);
  }

  /** Called by QualityManager whenever the effective budget changes. */
  private onQualityChanged(): void {
    this.sceneManager.applyQuality();
    const detail = detailForQuality(this.quality.settings);
    if (detail !== this.detail) {
      this.detail = detail;
      for (const vehicle of [this.player, ...this.ais]) vehicle.setDetail(detail, this.sceneManager.materials);
    }
    if (this.styles.current instanceof RealisticStyle) {
      this.styles.current.setQuality(this.quality.settings);
    }
    this.ui.setQualityChip(this.quality.presetLabel, this.quality.autoDegraded, this.quality.degradeLabel);
    if (this.quality.autoDegraded) {
      this.ui.toast(`性能不足，自动降级：${this.quality.degradeLabel}`, 2200);
    }
  }

  /** Cycles the quality preset (Y hotkey). */
  cycleQuality(): void {
    const next = this.quality.cyclePreset(1);
    localStorage.setItem('nacr-quality', next);
    this.ui.setSelections({ quality: next });
    this.ui.toast(`画质预设：${this.quality.presetLabel}`, 1400);
  }

  /** Weather preference (realistic style only; remembered for later). */
  setWeather(id: WeatherState): void {
    this.weatherPreference = id;
    WeatherStore.save(id);
    this.ui.setSelections({ weather: id });
    if (this.styles.current instanceof RealisticStyle) {
      const style = this.styles.current;
      if (id === 'auto') {
        style.setWeather('clear', true);
        this.ui.toast('天气：自动（随比赛变化）', 1400);
      } else {
        style.setWeather(id, true);
        this.ui.toast(`天气：${style.weatherLabel}`, 1400);
      }
    } else {
      this.ui.toast('天气属于真实风格，切换风格后生效', 1800);
    }
    this.sceneManager.refreshStyleFx();
  }

  /** Pushes the persisted weather preference into the realistic style. */
  private applyWeatherToStyle(): void {
    if (this.styles.current instanceof RealisticStyle && this.weatherPreference !== 'auto') {
      this.styles.current.setWeather(this.weatherPreference, true);
    }
  }

  /**
   * Switches between the closed circuit and the open-world road network.
   *
   * The map mode decides the race route itself, so the race is restarted on the
   * new route (documented behaviour). Style and quality are untouched.
   */
  setMapMode(id: MapModeId): void {
    if (this.switching || id === this.mapMode) return;
    this.ui.setSelections({ map: id });
    const label = MAP_MODE_META[id];
    this.ui.showLoading(
      `正在生成${id === 'openworld' ? '开放世界' : '赛道'}…`,
      `BUILDING ${label.short} · 首次生成需要几秒`,
    );
    const wasRacing = this.state.phase !== 'menu';
    this.switching = true;
    requestAnimationFrame(() => {
      try {
        this.installMapMode(id);
        localStorage.setItem('nacr-mapmode', id);
        this.ui.toast(`${label.name} 已就绪`, 1600);
      } catch (error) {
        console.error('[NA:CR] 地图模式切换失败，回滚到赛道模式', error);
        this.ui.setError(`开放世界生成失败: ${error instanceof Error ? error.message : String(error)}`);
        this.installMapMode('circuit');
        this.ui.setSelections({ map: 'circuit' });
      } finally {
        this.switching = false;
        this.ui.hideLoading();
        // The new route has new lap geometry: restart on it (never mid-switch,
        // which would be suppressed by the `switching` guard in startRace()).
        if (wasRacing) void this.startRace();
        this.ui.updateHud(this.hudState());
      }
    });
  }

  /** Builds (or reuses) the requested world and re-wires every consumer. */
  private installMapMode(id: MapModeId): void {
    if (id === 'openworld' && !this.openWorld) {
      this.openWorld = new OpenWorld(this.quality, this.sceneManager.materials, this.styles.id);
      this.sceneManager.scene.add(this.openWorld.group);
    }
    const previous = this.world;
    if (id === 'openworld' && this.openWorld) {
      this.world = this.openWorld;
      // The cyberpunk city belongs to the circuit; the open world brings its own.
      if (this.city) this.city.group.visible = false;
      this.openWorld.group.visible = true;
    } else {
      this.world = this.circuit;
      if (this.city) this.city.group.visible = true;
      if (this.openWorld) this.openWorld.group.visible = false;
    }
    this.mapMode = id;

    // Re-wire the systems that cache a world reference.
    this.collision = new CollisionSystem(this.worldCollisionBoxes());
    this.debug.setWorld(this.world, this.worldCollisionBoxes());
    for (const ai of this.ais) ai.setWorld(this.world);
    if (this.autopilot) this.autopilot = new AIController(this.autopilot.profile, this.world);
    this.state.setWorld(this.world);
    this.ui.rebuildMinimap(this.world);
    this.ui.setMapLabel(this.world.label, id);
    this.applyWorldTheme(this.styles.id);

    // Park everyone on the new grid; the caller restarts the countdown.
    this.state.resetToGrid();
    this.snapCameraToPlayer();
    void previous;
  }

  // ------------------------------------------------------------- theming

  /** Re-themes the active world graph (materials + neon furniture). */
  private applyWorldTheme(theme: GameStyleId): void {
    const materials = this.sceneManager.materials;
    materials.applyTheme(this.world.group, theme);
    if (this.openWorld && this.openWorld !== this.world) materials.applyTheme(this.openWorld.group, theme);
    if (this.city) materials.applyTheme(this.city.group, theme);
    // Clear-coat / glass / tread upgrades belong to the realistic style only.
    if (this.openWorld) this.openWorld.setTheme(theme, materials);
  }

  /** Pushes the style palette into the DOM (theme class + minimap + chips). */
  private applyUiTheme(theme: GameStyleId): void {
    const palette = this.styles.current.palette;
    document.body.dataset.style = theme;
    this.ui.setMinimapTheme({
      track: palette.minimapTrack,
      accent: palette.minimapAccent,
      road: theme === 'realistic' ? 'rgba(200,214,228,0.22)' : 'rgba(160,92,255,0.20)',
      backdrop: palette.minimapBackdrop,
    });
    this.ui.setStyleChip(STYLE_META[theme].short, theme);
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

    // The world keeps streaming even behind the menu or while paused, so a
    // style/map switch never lands on an empty scene.
    this.world.update(dt, this.elapsed, this.sceneManager.camera.position);
    if (this.openWorld && this.openWorld !== this.world) this.openWorld.update(dt, this.elapsed, this.sceneManager.camera.position);

    if (this.paused) {
      this.sceneManager.updateMenuCamera(dt, this.player.position, this.elapsed);
      this.debug.update(this.debugRoster);
      return;
    }

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

    if (!this.city || this.city.group.visible) this.city?.update(dt, this.elapsed);
    this.particles.update(dt, this.sceneManager.camera.position);
    this.debug.update(this.debugRoster);
    this.particles.updateAmbientDust(dt, this.sceneManager.camera.position, this.player.speed / this.player.topSpeed);

    // Keep the HUD mode chips fresh, and push the style's weather into the
    // particle layer and the rain ambience (cheap, 5 Hz).
    this.chipTimer -= dt;
    if (this.chipTimer <= 0) {
      this.chipTimer = 0.25;
      this.ui.setQualityChip(this.quality.presetLabel, this.quality.autoDegraded, this.quality.degradeLabel);
      this.syncWeather();
    }
  }

  /** Mirrors the active style's precipitation into particles + audio. */
  private syncWeather(): void {
    const style = this.styles.current;
    if (style.rain > 0.03) this.particles.setPrecipitation('rain', style.rain);
    else if (style.snow > 0.03) this.particles.setPrecipitation('snow', style.snow);
    else this.particles.setPrecipitation('none', 0);
    this.audio.setRain(Math.max(style.rain, style.snow * 0.15));
  }

  private handleHotkeys(): void {
    if (this.input.wasPressed('KeyM')) {
      const muted = this.audio.toggleMuted();
      this.ui.setMuted(muted);
      this.audio.playUi(!muted);
      this.ui.toast(muted ? '静音 ON' : '静音 OFF', 900);
    }
    if (this.input.wasPressed('KeyC')) {
      this.sceneManager.toggleCameraMode();
      this.audio.playUi(true);
    }
    if (this.input.wasPressed('KeyB')) {
      this.debug.setVisible(!this.debug.isVisible);
      this.ui.toast(this.debug.isVisible ? 'DEBUG 碰撞线框 ON' : 'DEBUG 碰撞线框 OFF', 1000);
      this.audio.playUi(true);
    }
    // Round 2 hotkeys.
    if (this.input.wasPressed('KeyT')) this.toggleStyle();
    if (this.input.wasPressed('KeyY')) this.cycleQuality();
    if (this.input.wasPressed('KeyP')) {
      if (this.state.phase === 'racing' || this.state.phase === 'countdown') this.setPaused(!this.paused);
    }
    if (this.input.wasPressed('KeyR')) {
      if (this.state.phase === 'racing' || this.state.phase === 'finished' || this.state.phase === 'countdown') this.restart();
    }
    if (this.input.wasPressed('Escape')) {
      if (this.ui.resultsVisible) this.backToMenu();
      else if (this.state.phase !== 'menu') this.setPaused(!this.paused);
    }
  }

  /** Slow orbit around the parked grid behind the start menu. */
  private updateMenu(dt: number): void {
    this.sceneManager.updateMenuCamera(dt, this.player.position, this.elapsed);
  }

  private updateCountdown(dt: number): void {
    const hold = emptyInput();
    this.player.update(dt, hold, this.world, this.particles);
    this.collision.resolve(this.player, this.world, this.ais, dt);
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
      this.goDisplayTimer = 0.9;
    }
  }

  private updateRacing(dt: number): void {
    const input: VehicleInput = this.autopilot
      ? this.autopilotInput(dt)
      : {
          throttle: this.input.throttle,
          brake: this.input.brake,
          steer: this.input.steer,
          nitro: this.input.nitro && this.state.phase === 'racing',
        };

    const wasNitro = this.player.nitroActive;
    this.player.update(dt, input, this.world, this.particles);
    if (!wasNitro && this.player.nitroActive) this.audio.playNitro();
    if (this.player.padPicked) {
      this.audio.playBoostPad();
      this.ui.toast('BOOST PAD', 900);
    }

    for (const ai of this.ais) this.updateAI(ai, dt, null);

    // ------------------------------------------------------ collisions
    const allVehicles = [this.player, ...this.ais];
    this.handleEvents(this.collision.resolve(this.player, this.world, allVehicles, dt), true);
    for (const ai of this.ais) {
      this.handleEvents(this.collision.resolve(ai, this.world, allVehicles, dt), false);
    }
    // Open-world traffic acts as extra dynamic obstacles.
    if (this.openWorld && this.world === this.openWorld) {
      this.handleEvents(this.openWorld.resolveTraffic(this.player, dt), true);
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
      Math.abs(this.player.speed) / this.player.topSpeed,
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
      totalLength: this.world.totalLength,
      rivals: this.rivalBuffer,
    });
  }

  private updateAI(ai: AIVehicle, dt: number, forcedInput: VehicleInput | null): void {
    if (forcedInput) {
      ai.step(dt, forcedInput);
      return;
    }
    this.rivalBuffer.length = 0;
    for (const racer of this.state.racers) {
      if (racer.vehicle === ai) continue;
      this.rivalBuffer.push({ position: racer.vehicle.position, progress: racer.raceDistance });
    }
    const self = this.state.racers.find((r) => r.vehicle === ai);
    ai.update(dt, this.world, this.particles, {
      elapsed: this.elapsed,
      selfProgress: self?.raceDistance ?? 0,
      playerProgress: this.state.player.raceDistance,
      totalLength: this.world.totalLength,
      rivals: this.rivalBuffer,
    });
  }

  private updateCamera(dt: number): void {
    const speedRatio = clamp(Math.abs(this.player.speed) / this.player.topSpeed, 0, 1.4);
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
    const samples = this.world.samples;
    const sample = samples[Math.max(0, Math.min(samples.length - 1, player.vehicle.hintIndex))]!;
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
    const dots = this.state.racers.map((racer) => ({
      x: racer.vehicle.position.x,
      z: racer.vehicle.position.z,
      color: racer.isPlayer ? (this.styles.id === 'realistic' ? '#ff8a3d' : '#24f0ff') : `#${racer.vehicle.accent.getHexString()}`,
      isPlayer: racer.isPlayer,
    }));
    if (this.openWorld && this.world === this.openWorld) {
      for (const car of this.openWorld.trafficPositions) {
        dots.push({ x: car.x, z: car.z, color: 'rgba(220,230,240,0.75)', isPlayer: false });
      }
    }
    return dots;
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
      get lap() {
        return gameRef.state.player.lap;
      },
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
      get postFx() {
        return gameRef.sceneManager.postProcessingSummary;
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
        return gameRef.ui.resultsVisible;
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
      get debug() {
        return gameRef.debug.isVisible;
      },
      get car() {
        return gameRef.currentCarId;
      },
      // ---------------------------------------------------- Round 2 handles
      get style() {
        return gameRef.styles.id;
      },
      get styleName() {
        return STYLE_META[gameRef.styles.id].short;
      },
      get quality() {
        return gameRef.quality.presetId;
      },
      get qualityDegraded() {
        return gameRef.quality.autoDegraded;
      },
      get mapMode() {
        return gameRef.mapMode;
      },
      get paused() {
        return gameRef.paused;
      },
      get worldLength() {
        return gameRef.world.totalLength;
      },
      get worldId() {
        return gameRef.world.id;
      },
      get hudStyle() {
        return document.getElementById('hud-style')!.textContent;
      },
      get hudQuality() {
        return document.getElementById('hud-quality')!.textContent;
      },
      get hudMode() {
        return document.getElementById('hud-mode')!.textContent;
      },
      get throttle() {
        return gameRef.input.throttle;
      },
      get parked() {
        return gameRef.player.parked;
      },
      get slope() {
        return gameRef.player.slopeAlong;
      },
      get pos() {
        return {
          x: gameRef.player.position.x,
          y: gameRef.player.position.y,
          z: gameRef.player.position.z,
          yaw: gameRef.player.yaw,
          speed: gameRef.player.speed,
        };
      },
      /** Snapshot used by the style-switch regression test. */
      snapshot() {
        return {
          style: gameRef.styles.id,
          phase: gameRef.state.phase,
          lap: gameRef.state.player.lap,
          raceTime: gameRef.state.raceTime,
          lapTime: gameRef.state.raceTime - gameRef.state.player.lapStartTime,
          bestLap: gameRef.state.player.bestLap,
          rank: gameRef.state.player.rank,
          nitro: gameRef.player.nitro,
          speed: gameRef.player.speed,
          x: gameRef.player.position.x,
          y: gameRef.player.position.y,
          z: gameRef.player.position.z,
          yaw: gameRef.player.yaw,
          ai: gameRef.ais.map((ai) => ({ x: ai.position.x, z: ai.position.z, speed: ai.speed })),
        };
      },
      /**
       * Worst angle (degrees) between a boost pad's chevron direction and the
       * route tangent — kept as a getter so the Round 1 smoke test keeps
       * working unchanged.
       */
      get padMisalignmentDeg(): number {
        let worst = 0;
        const arrow = new THREE.Vector3();
        for (const pad of gameRef.world.boostPads) {
          arrow.set(0, 1, 0).applyQuaternion(pad.mesh.quaternion);
          const tangent = gameRef.world.frameAt(pad.distance).tangent;
          worst = Math.max(worst, Math.acos(clamp(arrow.dot(tangent), -1, 1)));
        }
        return THREE.MathUtils.radToDeg(worst);
      },
      // ------------------------------------------------------- controllers
      /** Debug: toggle the environment probe / shadow maps. */
      debugRender: (opts: { shadows?: boolean; environment?: boolean }) => {
        const sm = gameRef.sceneManager;
        if (opts.shadows !== undefined) {
          sm.renderer.shadowMap.enabled = opts.shadows;
          sm.scene.traverse((o) => {
            const l = o as THREE.DirectionalLight;
            if (l.isDirectionalLight) l.castShadow = opts.shadows ?? false;
          });
        }
        if (opts.environment === false) sm.scene.environment = null;
        return true;
      },
      /** Debug: override individual post-fx switches (bisecting visual issues). */
      fxOverride: (partial: Record<string, unknown>) => {
        gameRef.sceneManager.post.setFx(partial as never);
        return gameRef.sceneManager.postProcessingSummary;
      },
      restart: () => gameRef.restart(),
      start: () => void gameRef.startRace(),
      setStyle: (id: GameStyleId) => gameRef.setStyle(id),
      toggleStyle: () => gameRef.toggleStyle(),
      setQuality: (id: QualityPresetId) => gameRef.setQuality(id),
      setMapMode: (id: MapModeId) => gameRef.setMapMode(id),
      setWeather: (id: WeatherState) => gameRef.setWeather(id),
      pause: (on: boolean) => gameRef.setPaused(on),
      /** Render/diagnostic summary (fog, background, camera, post FX). */
      sceneInfo() {
        const sm = gameRef.sceneManager;
        const fog = sm.scene.fog as THREE.FogExp2 | null;
        const bg = sm.scene.background;
        const cam = sm.camera;
        return {
          fog: fog ? `#${fog.color.getHexString()} d=${fog.density.toFixed(5)}` : 'none',
          background: bg instanceof THREE.Color ? `#${bg.getHexString()}` : String(bg),
          environment: !!sm.scene.environment,
          sceneChildren: sm.scene.children.length,
          camera: [cam.position.x, cam.position.y, cam.position.z].map((v) => Math.round(v)),
          cameraDir: cam.getWorldDirection(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)),
          sunElevation: +(gameRef.sceneManager.style.sunDirection()?.y ?? 0).toFixed(3),
          clock: gameRef.sceneManager.style.clock,
          exposure: +sm.renderer.toneMappingExposure.toFixed(3),
          lights: (() => {
            const seen = new Map<string, number>();
            const out: Record<string, number> = {};
            sm.scene.traverse((o) => {
              const l = o as THREE.Light;
              if (!l.isLight) return;
              const base = `${l.type}:${l.name || 'anon'}`;
              const n = seen.get(base) ?? 0;
              seen.set(base, n + 1);
              out[n === 0 ? base : `${base}#${n}`] = +l.intensity.toFixed(2);
            });
            return out;
          })(),
          postFx: sm.postProcessingSummary,
          worldVisible: gameRef.world.group.visible,
        };
      },
      /**
       * Debug: dump visible meshes near the player whose material colour or
       * emissive passes a filter (used to hunt stray neon objects in realistic
       * mode). `filter` is `(r, g, b, emissive) => boolean` evaluated per channel
       * value in 0..1; omit it to list every named mesh in range.
       */
      sceneDump(radius = 140, filter?: (r: number, g: number, b: number, emissive: boolean) => boolean) {
        const origin = gameRef.player.position;
        const out: Array<Record<string, unknown>> = [];
        gameRef.sceneManager.scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh || !mesh.visible || !mesh.name) return;
          const dist = mesh.position.distanceTo ? mesh.position.distanceTo(origin) : 0;
          const world = mesh.getWorldPosition(new THREE.Vector3());
          const d = world.distanceTo(origin);
          if (d > radius && dist > radius) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            const std = m as THREE.MeshStandardMaterial & THREE.MeshBasicMaterial;
            const sources: Array<'color' | 'emissive'> = [];
            if (std.color && filter?.(std.color.r, std.color.g, std.color.b, false)) sources.push('color');
            if (std.emissive && std.emissiveIntensity !== 0 && filter?.(std.emissive.r, std.emissive.g, std.emissive.b, true))
              sources.push('emissive');
            if (!filter || sources.length) {
              out.push({
                name: mesh.name,
                type: mesh.type,
                instanced: (mesh as THREE.InstancedMesh).isInstancedMesh === true,
                dist: +d.toFixed(1),
                world: world.toArray().map((v) => +v.toFixed(1)),
                color: std.color ? `#${std.color.getHexString()}` : null,
                emissive: std.emissive ? `#${std.emissive.getHexString()}` : null,
                emissiveIntensity: std.emissiveIntensity ?? null,
                matched: sources,
              });
            }
          }
        });
        return out.slice(0, 80);
      },
      /** Health probe used by the smoke test after every switch. */
      health(): { ok: boolean; detail: string } {
        const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
        const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
        const controlsOk = Number.isFinite(gameRef.player.position.x) && Number.isFinite(gameRef.player.speed);
        const sceneOk = gameRef.sceneManager.scene.children.length > 0;
        return {
          ok: !!gl && controlsOk && sceneOk && !gl.isContextLost(),
          detail: `gl=${!!gl} ctxLost=${gl ? gl.isContextLost() : 'n/a'} controls=${controlsOk} children=${gameRef.sceneManager.scene.children.length}`,
        };
      },
    };
  }
}
