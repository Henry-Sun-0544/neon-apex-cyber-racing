import { CONFIG, type RaceResult } from './Config';
import type { HudState } from './Types';
import type { Track } from './Track';
import { formatTime } from './Utils';

export interface UICallbacks {
  onStart: () => void;
  onRestart: () => void;
  onMenu: () => void;
  onMuteToggle: (muted: boolean) => void;
  onVolumeChange: (volume: number) => void;
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
 * Tiny top-down track map rendered on a 2D canvas: the loop outline, the
 * speed pads, the start line and every car as a coloured dot.
 */
class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly outline: Array<[number, number]> = [];
  private readonly pads: Array<[number, number]> = [];
  private readonly start: [number, number];
  private readonly size: number;
  private readonly scale: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly pad = 16;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    track: Track,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.size = canvas.width;
    const raw = track.minimapPoints;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < raw.length; i += 3) {
      minX = Math.min(minX, raw[i]!);
      maxX = Math.max(maxX, raw[i]!);
      minZ = Math.min(minZ, raw[i + 2]!);
      maxZ = Math.max(maxZ, raw[i + 2]!);
    }
    this.minX = minX;
    this.minZ = minZ;
    this.scale = (this.size - this.pad * 2) / Math.max(maxX - minX, maxZ - minZ);
    for (let i = 0; i < raw.length; i += 3) this.outline.push(this.project(raw[i]!, raw[i + 2]!));
    for (const p of track.boostPads) {
      const f = track.frameAt(p.distance);
      const pos = f.pos.clone().addScaledVector(f.side, p.lateral);
      this.pads.push(this.project(pos.x, pos.z));
    }
    const startFrame = track.frameAt(0);
    this.start = this.project(startFrame.pos.x, startFrame.pos.z);
  }

  /** World XZ -> canvas XY. */
  private project(x: number, z: number): [number, number] {
    return [this.pad + (x - this.minX) * this.scale, this.pad + (z - this.minZ) * this.scale];
  }

  draw(dots: MinimapDot[]): void {
    const { ctx, size } = this;
    ctx.clearRect(0, 0, size, size);

    // Track ribbon
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(36,240,255,0.22)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    this.outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,47,185,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Speed pads
    ctx.fillStyle = 'rgba(182,255,58,0.95)';
    for (const [x, y] of this.pads) {
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Start line
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.start[0] - 4, this.start[1] - 4);
    ctx.lineTo(this.start[0] + 4, this.start[1] + 4);
    ctx.stroke();

    // Cars
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

/** All DOM plumbing: menus, HUD, countdown, results, toasts and the map. */
export class UIManager {
  private readonly menu = el<HTMLDivElement>('menu');
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
  private readonly menuError = el<HTMLParagraphElement>('menu-error');
  private readonly menuHint = el<HTMLParagraphElement>('menu-hint');
  private readonly btnMute = el<HTMLButtonElement>('btn-mute');
  private readonly volumeSlider = el<HTMLInputElement>('volume');
  private readonly minimap: Minimap;
  private toastTimer = 0;

  constructor(
    private readonly callbacks: UICallbacks,
    track: Track,
  ) {
    this.minimap = new Minimap(el<HTMLCanvasElement>('minimap'), track);
    el<HTMLSpanElement>('menu-laps').textContent = String(CONFIG.race.laps);
    el<HTMLSpanElement>('menu-ai').textContent = String(CONFIG.race.aiCount);
    this.volumeSlider.value = String(Math.round(CONFIG.audio.masterVolume * 100));

    el<HTMLButtonElement>('btn-start').addEventListener('click', () => this.callbacks.onStart());
    el<HTMLButtonElement>('btn-restart').addEventListener('click', () => this.callbacks.onRestart());
    el<HTMLButtonElement>('btn-menu').addEventListener('click', () => this.callbacks.onMenu());
    this.btnMute.addEventListener('click', () => {
      const muted = this.btnMute.getAttribute('aria-pressed') !== 'true';
      this.setMuted(muted);
      this.callbacks.onMuteToggle(muted);
    });
    this.volumeSlider.addEventListener('input', () => {
      this.callbacks.onVolumeChange(Number(this.volumeSlider.value) / 100);
    });
  }

  // ------------------------------------------------------------- screens

  showMenu(): void {
    this.menu.classList.remove('hidden');
    this.hud.classList.add('hidden');
    this.results.classList.add('hidden');
    this.countdown.classList.add('hidden');
  }

  hideMenu(): void {
    this.menu.classList.add('hidden');
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
    // Restart the pop animation.
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

  /** Exposes the volume slider value (used when the UI is the source of truth). */
  get volume(): number {
    return Number(this.volumeSlider.value) / 100;
  }
}
