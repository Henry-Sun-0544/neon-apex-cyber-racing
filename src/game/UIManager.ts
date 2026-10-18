import { CONFIG, GARAGE, type CarId, type RaceResult } from './Config';
import type { HudState } from './Types';
import { MAP_MODE_IDS, MAP_MODE_META, type MapModeId } from './world/MapMode';
import type { RaceWorld } from './world/RaceWorld';
import { GAME_STYLE_IDS, STYLE_META, type GameStyleId } from './styles/GameStyle';
import { QUALITY_PRESET_IDS, type QualityPresetId } from './QualityManager';
import { WEATHER_META, WEATHER_STATES, type WeatherState } from './world/WeatherState';
import { formatTime } from './Utils';

export interface UICallbacks {
  onStart: () => void;
  onRestart: () => void;
  onMenu: () => void;
  onMuteToggle: (muted: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onSelectCar: (id: CarId) => void;
  onSelectStyle: (id: GameStyleId) => void;
  onSelectQuality: (id: QualityPresetId) => void;
  onSelectMap: (id: MapModeId) => void;
  onSelectWeather: (id: WeatherState) => void;
  onResume: () => void;
}

/** A dot drawn on the track map. */
export interface MinimapDot {
  x: number;
  z: number;
  color: string;
  isPlayer: boolean;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`[NA:CR] missing DOM element #${id}`);
  return found as T;
}

/**
 * Tiny top-down map rendered on a 2D canvas: the race-route outline, the speed
 * pads, the start line, every car as a dot and — in open-world mode — the side
 * roads of the network as a faint underlay. Works for both map modes because it
 * only reads the `RaceWorld` interface.
 */
class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly outline: Array<[number, number]> = [];
  private readonly roads: Array<Array<[number, number]>> = [];
  private readonly pads: Array<[number, number]> = [];
  private readonly start: [number, number];
  private readonly size: number;
  private readonly scale: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly pad = 16;
  /** Palette hook so the map follows the active style. */
  trackColor = 'rgba(36,240,255,0.22)';
  accentColor = 'rgba(255,47,185,0.85)';
  roadColor = 'rgba(160,190,220,0.18)';
  backdrop = 'rgba(6,3,18,0.55)';

  constructor(
    canvas: HTMLCanvasElement,
    world: RaceWorld,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.size = canvas.width;
    const raw = world.minimapPoints;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const consider = (x: number, z: number): void => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    };
    for (let i = 0; i < raw.length; i += 3) consider(raw[i]!, raw[i + 2]!);
    for (const road of world.minimapRoads ?? []) {
      for (let i = 0; i < road.length; i += 3) consider(road[i]!, road[i + 2]!);
    }
    this.minX = minX;
    this.minZ = minZ;
    this.scale = (this.size - this.pad * 2) / Math.max(1, Math.max(maxX - minX, maxZ - minZ));
    for (let i = 0; i < raw.length; i += 3) this.outline.push(this.project(raw[i]!, raw[i + 2]!));
    for (const road of world.minimapRoads ?? []) {
      const line: Array<[number, number]> = [];
      for (let i = 0; i < road.length; i += 3) line.push(this.project(road[i]!, road[i + 2]!));
      this.roads.push(line);
    }
    for (const p of world.boostPads) {
      const f = world.frameAt(p.distance);
      const pos = f.pos.clone().addScaledVector(f.side, p.lateral);
      this.pads.push(this.project(pos.x, pos.z));
    }
    const startFrame = world.frameAt(0);
    this.start = this.project(startFrame.pos.x, startFrame.pos.z);
  }

  /** World XZ -> canvas XY. */
  private project(x: number, z: number): [number, number] {
    return [this.pad + (x - this.minX) * this.scale, this.pad + (z - this.minZ) * this.scale];
  }

  draw(dots: MinimapDot[]): void {
    const { ctx, size } = this;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = this.backdrop;
    ctx.fillRect(0, 0, size, size);

    // Side roads (open world) as a faint underlay.
    if (this.roads.length) {
      ctx.strokeStyle = this.roadColor;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      for (const line of this.roads) {
        if (line.length < 2) continue;
        ctx.beginPath();
        line.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
      }
    }

    // Race route ribbon.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.trackColor;
    ctx.lineWidth = 9;
    ctx.beginPath();
    this.outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = this.accentColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Speed pads.
    ctx.fillStyle = 'rgba(182,255,58,0.95)';
    for (const [x, y] of this.pads) {
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Start line.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.start[0] - 4, this.start[1] - 4);
    ctx.lineTo(this.start[0] + 4, this.start[1] + 4);
    ctx.stroke();

    // Cars.
    for (const dot of dots) {
      const [x, y] = this.project(dot.x, dot.z);
      ctx.beginPath();
      ctx.fillStyle = dot.color;
      ctx.arc(x, y, dot.isPlayer ? 4.4 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (dot.isPlayer) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
  }
}

/** One-line description of what each quality preset buys. */
const QUALITY_SHORT: Record<QualityPresetId, string> = {
  low: '流畅优先',
  medium: '阴影 1024 · SMAA',
  high: 'SSAO · 阴影 2048 · 体积光',
  ultra: 'SSR · DoF · 阴影 3072 · 2K 贴图',
};

/**
 * All DOM plumbing: menus (start + pause), HUD, countdown, results, toasts,
 * the mode pickers and the style-switch loading veil.
 */
export class UIManager {
  private readonly menu = el<HTMLDivElement>('menu');
  private readonly pause = el<HTMLDivElement>('pause');
  private readonly hud = el<HTMLDivElement>('hud');
  private readonly countdown = el<HTMLDivElement>('countdown');
  private readonly countdownNum = el<HTMLDivElement>('countdown-num');
  private readonly countdownSub = el<HTMLDivElement>('countdown-sub');
  private readonly results = el<HTMLDivElement>('results');
  private readonly resultsBody = el<HTMLTableSectionElement>('results-body');
  private readonly resultsStats = el<HTMLDivElement>('results-stats');
  private readonly resultPos = el<HTMLDivElement>('result-pos');
  private readonly resultMsg = el<HTMLDivElement>('result-msg');
  private readonly hudPosition = el<HTMLDivElement>('hud-position');
  private readonly hudLap = el<HTMLDivElement>('hud-lap');
  private readonly hudTime = el<HTMLDivElement>('hud-time');
  private readonly hudLapTime = el<HTMLDivElement>('hud-lap-time');
  private readonly hudBest = el<HTMLDivElement>('hud-best-lap');
  private readonly hudSpeed = el<HTMLDivElement>('hud-speed');
  private readonly hudNitroFill = el<HTMLDivElement>('hud-nitro-fill');
  private readonly hudNitroPct = el<HTMLDivElement>('hud-nitro-pct');
  private readonly hudBoost = el<HTMLDivElement>('hud-boost');
  private readonly hudToast = el<HTMLDivElement>('hud-toast');
  private readonly hudWrongWay = el<HTMLDivElement>('hud-wrongway');
  private readonly hudFps = el<HTMLDivElement>('hud-fps');
  private readonly hudStyle = el<HTMLSpanElement>('hud-style');
  private readonly hudQuality = el<HTMLSpanElement>('hud-quality');
  private readonly hudMode = el<HTMLSpanElement>('hud-mode');
  private readonly hudDegraded = el<HTMLSpanElement>('hud-degraded');
  private readonly menuError = el<HTMLParagraphElement>('menu-error');
  private readonly menuHint = el<HTMLParagraphElement>('menu-hint');
  private readonly menuModeNote = el<HTMLLIElement>('menu-mode-note');
  private readonly minimapTitle = el<HTMLDivElement>('minimap-title');
  private readonly btnMute = el<HTMLButtonElement>('btn-mute');
  private readonly volumeSlider = el<HTMLInputElement>('volume');
  private readonly pauseState = el<HTMLDivElement>('pause-state');
  private readonly loading = el<HTMLDivElement>('loading');
  private readonly loadingText = el<HTMLDivElement>('loading-text');
  private readonly loadingSub = el<HTMLDivElement>('loading-sub');
  private readonly garage: HTMLDivElement;
  private minimap: Minimap;
  private toastTimer = 0;
  private readonly selection = {
    style: CONFIG.style.default as GameStyleId,
    quality: CONFIG.quality.default as QualityPresetId,
    map: CONFIG.map.default as MapModeId,
    weather: 'auto' as WeatherState,
  };

  constructor(
    private readonly callbacks: UICallbacks,
    world: RaceWorld,
  ) {
    this.minimap = new Minimap(el<HTMLCanvasElement>('minimap'), world);
    this.garage = el<HTMLDivElement>('menu-garage');
    this.buildGarage();
    el<HTMLSpanElement>('menu-laps').textContent = String(CONFIG.race.laps);
    el<HTMLSpanElement>('menu-ai').textContent = String(CONFIG.race.aiCount);
    this.volumeSlider.value = String(Math.round(CONFIG.audio.masterVolume * 100));

    el<HTMLButtonElement>('btn-start').addEventListener('click', () => this.callbacks.onStart());
    el<HTMLButtonElement>('btn-restart').addEventListener('click', () => this.callbacks.onRestart());
    el<HTMLButtonElement>('btn-menu').addEventListener('click', () => this.callbacks.onMenu());
    el<HTMLButtonElement>('btn-resume').addEventListener('click', () => this.callbacks.onResume());
    el<HTMLButtonElement>('btn-pause-restart').addEventListener('click', () => this.callbacks.onRestart());
    el<HTMLButtonElement>('btn-pause-menu').addEventListener('click', () => this.callbacks.onMenu());
    this.btnMute.addEventListener('click', () => {
      const muted = this.btnMute.getAttribute('aria-pressed') !== 'true';
      this.setMuted(muted);
      this.callbacks.onMuteToggle(muted);
    });
    this.volumeSlider.addEventListener('input', () => {
      this.callbacks.onVolumeChange(Number(this.volumeSlider.value) / 100);
    });

    this.buildOptionGroups();
  }

  // --------------------------------------------------------- option groups

  /**
   * Every `[data-group]` container in the document (start menu *and* pause
   * menu) is filled with the same button set and kept in sync, so the player
   * can change style/quality/map/weather from wherever they happen to be.
   */
  private buildOptionGroups(): void {
    const groups: Array<{ group: string; items: Array<{ id: string; label: string; sub?: string }> }> = [
      {
        group: 'style',
        items: GAME_STYLE_IDS.map((id) => ({
          id,
          label: STYLE_META[id].name.split(' ')[0]!,
          sub: STYLE_META[id].tagline,
        })),
      },
      {
        group: 'quality',
        items: QUALITY_PRESET_IDS.map((id) => ({
          id,
          label: id.toUpperCase(),
          sub: QUALITY_SHORT[id],
        })),
      },
      {
        group: 'map',
        items: MAP_MODE_IDS.map((id) => ({
          id,
          label: MAP_MODE_META[id].name.split(' ')[0]!,
          sub: MAP_MODE_META[id].tagline,
        })),
      },
      {
        group: 'weather',
        items: WEATHER_STATES.filter((w) => w !== 'auto').map((id) => ({
          id,
          label: WEATHER_META[id].name,
        })),
      },
    ];

    for (const { group, items } of groups) {
      for (const container of document.querySelectorAll<HTMLDivElement>(`[data-group="${group}"]`)) {
        container.innerHTML = '';
        for (const item of items) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'option-btn';
          button.dataset.value = item.id;
          button.innerHTML = `${item.label}${item.sub ? `<small>${item.sub}</small>` : ''}`;
          button.addEventListener('click', () => this.selectGroup(group, item.id));
          container.appendChild(button);
        }
      }
    }
    this.syncOptionGroups();
  }

  private selectGroup(group: string, id: string): void {
    switch (group) {
      case 'style':
        this.callbacks.onSelectStyle(id as GameStyleId);
        break;
      case 'quality':
        this.callbacks.onSelectQuality(id as QualityPresetId);
        break;
      case 'map':
        this.callbacks.onSelectMap(id as MapModeId);
        break;
      case 'weather':
        this.callbacks.onSelectWeather(id as WeatherState);
        break;
      default:
        break;
    }
  }

  /** Visually marks the active value in every option row. */
  private syncOptionGroups(): void {
    const values: Record<string, string> = {
      style: this.selection.style,
      quality: this.selection.quality,
      map: this.selection.map,
      weather: this.selection.weather,
    };
    for (const [group, value] of Object.entries(values)) {
      for (const button of document.querySelectorAll<HTMLButtonElement>(`[data-group="${group}"] .option-btn`)) {
        button.classList.toggle('selected', button.dataset.value === value);
      }
    }
  }

  /** Called by Game whenever a mode value changes (menu, hotkey or pause). */
  setSelections(next: Partial<{ style: GameStyleId; quality: QualityPresetId; map: MapModeId; weather: WeatherState }>): void {
    Object.assign(this.selection, next);
    this.syncOptionGroups();
  }

  // ------------------------------------------------------------- screens

  /** Builds the garage card row; stat bars are normalised against the field. */
  private buildGarage(): void {
    const fastest = Math.max(...GARAGE.map((p) => p.stats.maxSpeed ?? CONFIG.car.maxSpeed));
    const strongest = Math.max(...GARAGE.map((p) => p.stats.accel ?? CONFIG.car.accel));
    const grippiest = Math.max(...GARAGE.map((p) => p.stats.grip ?? CONFIG.car.grip));
    for (const preset of GARAGE) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'garage-card';
      card.dataset.car = preset.id;
      card.addEventListener('click', () => this.callbacks.onSelectCar(preset.id));
      const speed = Math.round(((preset.stats.maxSpeed ?? CONFIG.car.maxSpeed) * 3.6) / 4) * 4;
      const bar = (v: number, max: number) => `<i style="width:${Math.round((v / max) * 100)}%"></i>`;
      card.innerHTML = `
        <div class="garage-name">${preset.name}</div>
        <div class="garage-tag">${preset.tagline} · ${speed} km/h</div>
        <div class="garage-stat"><span>极速</span><div class="garage-bar">${bar(preset.stats.maxSpeed ?? CONFIG.car.maxSpeed, fastest)}</div></div>
        <div class="garage-stat"><span>加速</span><div class="garage-bar">${bar(preset.stats.accel ?? CONFIG.car.accel, strongest)}</div></div>
        <div class="garage-stat"><span>抓地</span><div class="garage-bar">${bar(preset.stats.grip ?? CONFIG.car.grip, grippiest)}</div></div>`;
      this.garage.appendChild(card);
    }
  }

  /** Highlights the selected garage card. */
  setGarageSelection(id: CarId): void {
    for (const card of this.garage.children) {
      (card as HTMLElement).classList.toggle('selected', (card as HTMLElement).dataset.car === id);
    }
  }

  /** Rebuilds the minimap projection (map-mode switch). */
  rebuildMinimap(world: RaceWorld): void {
    this.minimap = new Minimap(el<HTMLCanvasElement>('minimap'), world);
  }

  /** Applies the style palette to the minimap colours. */
  setMinimapTheme(theme: { track: string; accent: string; road: string; backdrop: string }): void {
    this.minimap.trackColor = theme.track;
    this.minimap.accentColor = theme.accent;
    this.minimap.roadColor = theme.road;
    this.minimap.backdrop = theme.backdrop;
  }

  setMapLabel(label: string, mode: MapModeId): void {
    this.minimapTitle.textContent = label;
    this.hudMode.textContent = mode === 'openworld' ? 'OPEN WORLD / 开放世界' : 'CIRCUIT / 赛道';
    this.menuModeNote.textContent =
      mode === 'openworld' ? '当前模式：开放世界（城市 · 山路 · 隧道 · 大桥）' : '当前模式：闭环赛道';
  }

  showMenu(): void {
    this.menu.classList.remove('hidden');
    this.pause.classList.add('hidden');
    this.hud.classList.add('hidden');
    this.results.classList.add('hidden');
    this.countdown.classList.add('hidden');
  }

  hideMenu(): void {
    this.menu.classList.add('hidden');
  }

  showPause(visible: boolean): void {
    this.pause.classList.toggle('hidden', !visible);
  }

  get pauseVisible(): boolean {
    return !this.pause.classList.contains('hidden');
  }

  /** Refresh the state summary shown inside the pause menu. */
  setPauseState(text: string): void {
    this.pauseState.innerHTML = text;
  }

  showHud(visible: boolean): void {
    this.hud.classList.toggle('hidden', !visible);
    this.hud.setAttribute('aria-hidden', String(!visible));
  }

  showCountdown(visible: boolean): void {
    this.countdown.classList.toggle('hidden', !visible);
  }

  /** Updates the big countdown number ("3", "2", "1", "GO!"). */
  setCountdown(text: string, sub: string, isGo: boolean): void {
    if (this.countdownNum.textContent === text && this.countdownSub.textContent === sub) return;
    this.countdownNum.textContent = text;
    this.countdownNum.classList.toggle('go', isGo);
    this.countdownSub.textContent = sub;
    this.countdownNum.style.animation = 'none';
    void this.countdownNum.offsetWidth;
    this.countdownNum.style.animation = '';
  }

  setMuted(muted: boolean): void {
    this.btnMute.textContent = muted ? '🔇 SOUND OFF' : '🔊 SOUND ON';
    this.btnMute.setAttribute('aria-pressed', String(muted));
  }

  setError(message: string): void {
    this.menuError.textContent = message;
  }

  setHint(message: string): void {
    this.menuHint.textContent = message;
  }

  // ------------------------------------------------------ loading veil

  /** Shows the style-switch / world-build veil with a bilingual message. */
  showLoading(text: string, sub: string): void {
    this.loadingText.textContent = text;
    this.loadingSub.textContent = sub;
    this.loading.classList.remove('hidden');
  }

  hideLoading(): void {
    this.loading.classList.add('hidden');
  }

  // --------------------------------------------------------- style chips

  setStyleChip(name: string, theme: GameStyleId): void {
    this.hudStyle.textContent = name;
    this.hudStyle.dataset.theme = theme;
  }

  setQualityChip(label: string, autoDegraded: boolean, degradeLabel: string): void {
    this.hudQuality.textContent = label;
    this.hudDegraded.classList.toggle('hidden', !autoDegraded);
    if (autoDegraded) this.hudDegraded.textContent = `AUTO ↓ ${degradeLabel}`;
  }

  // ----------------------------------------------------------------- HUD

  /** Push a fresh snapshot into the HUD (called ~20x per second). */
  updateHud(state: HudState): void {
    const racers = state.totalRacers;
    this.hudPosition.innerHTML = `${state.position}<span class="hud-sub">/${racers}</span>`;
    this.hudLap.innerHTML = `${state.lap}<span class="hud-sub">/${state.totalLaps}</span>`;
    this.hudTime.textContent = formatTime(state.raceTime);
    this.hudLapTime.textContent = formatTime(state.lapTime);
    this.hudBest.textContent = formatTime(state.bestLap);
    this.hudSpeed.textContent = String(Math.round(state.speedKmh));
    const nitro = Math.max(0, Math.min(100, state.nitro));
    this.hudNitroFill.style.width = `${nitro}%`;
    this.hudNitroPct.textContent = `${Math.round(nitro)}%`;
    this.hudNitroFill.classList.toggle('draining', state.nitroActive);
    this.hudBoost.classList.toggle('active', state.boosting && !state.nitroActive);
    this.hudWrongWay.classList.toggle('hidden', !state.wrongWay);
    this.hudFps.textContent = `${state.fps.toFixed(0)} FPS`;
  }

  /** Big centre-screen message (e.g. FINAL LAP). */
  toast(text: string, duration = 2000): void {
    this.hudToast.textContent = text;
    this.hudToast.classList.add('show');
    this.toastTimer = duration / 1000;
  }

  tickToast(dt: number): void {
    if (this.toastTimer <= 0) return;
    this.toastTimer -= dt;
    if (this.toastTimer <= 0) this.hudToast.classList.remove('show');
  }

  /** Red vignette flash on a hard hit. */
  damageFlash(): void {
    this.hud.classList.remove('damage');
    void this.hud.offsetWidth;
    this.hud.classList.add('damage');
  }

  drawMinimap(dots: MinimapDot[]): void {
    this.minimap.draw(dots);
  }

  // ------------------------------------------------------------- results

  showResults(result: RaceResult): void {
    const player = result.racers.find((r) => r.isPlayer);
    const position = player?.position ?? result.playerPosition;
    this.resultPos.textContent = `P${position}`;
    const won = position === 1;
    this.resultMsg.textContent = won ? 'VICTORY / 冠军' : position <= 3 ? 'PODIUM / 登上领奖台' : 'RACE COMPLETE / 完成比赛';

    this.resultsBody.innerHTML = result.racers
      .map((racer) => {
        const cls = racer.isPlayer ? ' class="is-player"' : '';
        const best = formatTime(racer.bestLap);
        const total = racer.finished ? formatTime(racer.totalTime) : 'DNF';
        return `<tr${cls}><td class="rank-cell">${racer.position}</td><td>${racer.name}</td><td>${best}</td><td>${total}</td></tr>`;
      })
      .join('');

    const bestLap = formatTime(result.playerBestLap);
    const totalTime = formatTime(result.playerTotalTime);
    this.resultsStats.innerHTML = `LAPS <b>${result.laps}</b> &nbsp;·&nbsp; BEST LAP <b>${bestLap}</b> &nbsp;·&nbsp; TOTAL <b>${totalTime}</b>`;
    this.results.classList.remove('hidden');
  }

  hideResults(): void {
    this.results.classList.add('hidden');
  }

  hideCountdown(): void {
    this.countdown.classList.add('hidden');
  }

  get resultsVisible(): boolean {
    return !this.results.classList.contains('hidden');
  }

  /** Exposes the volume slider value (used when the UI is the source of truth). */
  get volume(): number {
    return Number(this.volumeSlider.value) / 100;
  }
}
