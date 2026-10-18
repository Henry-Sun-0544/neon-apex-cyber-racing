import './styles.css';
import { Game } from './game/Game';
import { CONFIG } from './game/Config';

/** Runtime errors are surfaced in the menu and in a global array for tests. */
const runtimeErrors: string[] = [];
(window as unknown as { __NACR_ERRORS__: string[] }).__NACR_ERRORS__ = runtimeErrors;

function reportError(message: string, error?: unknown): void {
  const text = error instanceof Error ? `${message}: ${error.message}` : message;
  runtimeErrors.push(text);
  console.error('[NA:CR]', text, error);
  const errorEl = document.getElementById('menu-error');
  if (errorEl) errorEl.textContent = text;
}

window.addEventListener('error', (event) => reportError('运行时错误', event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => reportError('异步错误', event.reason));

/**
 * Force the cheap render path. The game downgrades itself automatically when the
 * frame rate drops, but a software rasteriser (SwiftShader, used for headless
 * verification) needs the cheap path from the very first frame: a heavy scene
 * pins every CPU core and starves the rest of the browser, including DevTools.
 */
function applyLowFxPreset(): void {
  // Round 2 routes every expensive feature through the quality presets, so the
  // cheapest path is simply the "low" preset plus quartered particle pools.
  CONFIG.quality.default = 'low';
  CONFIG.particles.maxSparks = Math.ceil(CONFIG.particles.maxSparks / 4);
  CONFIG.particles.maxFlames = Math.ceil(CONFIG.particles.maxFlames / 4);
  CONFIG.particles.maxMotes = Math.ceil(CONFIG.particles.maxMotes / 4);
  CONFIG.particles.maxDust = Math.ceil(CONFIG.particles.maxDust / 4);
  console.info('[NA:CR] low-fx preset active (quality=low, quarter particle pools)');
}

function main(): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    reportError('找不到 #game-canvas 画布元素');
    return;
  }

  // URL flags are handy for demos and for the headless smoke test:
  //   ?autostart=1        skip the title screen
  //   ?nocount=1          skip the countdown (implies autostart)
  //   ?autopilot=1        attract mode: the AI drives the player car
  //   ?car=hellcat|gtr|modely|concept   garage pick (overrides localStorage)
  //   ?laps=N             shorter race for demos
  //   ?lowfx=1            cheap render preset for software GL (no bloom, 1x pixel
  //                       ratio, quarter particle pools); same as the automatic
  //                       performance fallback, forced up front
  const params = new URLSearchParams(window.location.search);
  const autostart = params.get('autostart') === '1' || params.get('nocount') === '1' || params.get('autopilot') === '1';
  if (params.get('lowfx') === '1') applyLowFxPreset();

  console.info('[NA:CR] boot start');
  try {
    const game = new Game(canvas, {
      autostart,
      skipCountdown: params.get('nocount') === '1',
      autopilot: params.get('autopilot') === '1',
      laps: Number(params.get('laps')) || undefined,
      car: params.get('car') ?? undefined,
      // Round 2: mode overrides, handy for demos and for the headless harness.
      style: params.get('style') ?? undefined,
      quality: params.get('lowfx') === '1' ? 'low' : (params.get('quality') ?? undefined),
      map: params.get('map') ?? undefined,
    });
    game.boot();
    console.info('[NA:CR] boot ok — world generated, render loop running');
  } catch (error) {
    reportError('初始化失败（WebGL 可能不可用）', error);
  }
}

main();
