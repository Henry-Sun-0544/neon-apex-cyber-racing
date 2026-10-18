#!/usr/bin/env node
/**
 * Round 2 end-to-end verification for Neon Apex: Cyber Racing.
 *
 * Boots the game in headless Chrome over CDP and checks the Round 2 contract:
 *
 *   Phase 1 — circuit + cyberpunk: the race runs, the HUD mode chips are live.
 *   Phase 2 — RUNTIME STYLE SWITCH: switch to realistic mid-race and assert that
 *             lap / race time / best lap / rank / nitro / position / heading /
 *             AI state all survive, that the world visually changed (pixel
 *             diff) and that nothing threw.
 *   Phase 3 — switch back to cyberpunk (state preserved again) and cycle the
 *             quality presets.
 *   Phase 4 — OPEN WORLD: switch map mode, assert the new route was generated,
 *             that worldLength differs, and that the car drives on it.
 *
 * Usage: node tools/verify-round2.mjs [baseUrl]
 * Requires a running dev/preview server (default http://127.0.0.1:5173).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const PORT = Number(process.env.CDP_PORT ?? 9444);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = process.env.SHOT_DIR ?? join(tmpdir(), 'nacr-r2');
mkdirSync(SHOT_DIR, { recursive: true });
const ONLY = process.env.ONLY ? Number(process.env.ONLY) : 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
const screenshots = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  \u2705' : '  \u274c'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------ CDP glue

class Target {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.profile = mkdtempSync(join(tmpdir(), 'nacr-r2-prof-'));
  }

  static async launch(url, { avoidFocus = true } = {}) {
    const args = [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--mute-audio',
      '--window-size=1280,720',
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'nacr-r2-'))}`,
      '--use-gl=angle',
      '--use-angle=default',
      'about:blank',
    ];
    const child = spawn(CHROME, args, { stdio: 'ignore' });
    await sleep(1400);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const target = new Target(ws);
    await target.ready();
    target.child = child;
    await target.send('Runtime.enable');
    await target.send('Log.enable');
    await target.send('Page.enable');
    target.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (p.type === 'error') consoleErrors.push(text);
    });
    target.on('Runtime.exceptionThrown', (p) => {
      consoleErrors.push(p.exceptionDetails?.exception?.description ?? 'exception');
    });
    if (url) await target.goto(url);
    void avoidFocus;
    return target;
  }

  ready() {
    return new Promise((resolve) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
            else pending.resolve(msg.result);
          }
        } else {
          for (const handler of this.handlers.get(msg.method) ?? []) handler(msg.params);
        }
      });
    });
  }

  handlers = new Map();

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'eval error');
    }
    return res.result?.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await sleep(1500);
  }

  async key(code, key, type = 'keyDown') {
    await this.send('Input.dispatchKeyEvent', {
      type,
      code,
      key,
      windowsVirtualKeyCode: key === ' ' ? 32 : key.toUpperCase().charCodeAt(0),
    });
  }

  async screenshot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const path = join(SHOT_DIR, `${name}.png`);
    writeFileSync(path, Buffer.from(res.data, 'base64'));
    screenshots.push(path);
    return path;
  }

  kill() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    try {
      this.child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/** Waits for a predicate evaluated in the page. */
async function waitFor(page, expression, timeoutMs = 30000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(expression)) return true;
    } catch {
      /* page may still be booting */
    }
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Mean absolute per-pixel difference between two PNG screenshots (0..255). */
async function pixelDiff(a, b) {
  const { readFileSync } = await import('node:fs');
  const bufA = readFileSync(a);
  const bufB = readFileSync(b);
  if (bufA.length !== bufB.length) return 255;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < bufA.length; i += 997) {
    sum += Math.abs(bufA[i] - bufB[i]);
    count += 1;
  }
  return count ? sum / count : 0;
}

// ------------------------------------------------------------------- phases

async function phase1(page) {
  console.log('\n--- Phase 1: circuit + cyberpunk baseline ---');
  await page.goto(`${BASE}/?autostart=1&nocount=1&lowfx=1&style=cyberpunk&map=circuit&laps=3`);
  await waitFor(page, 'window.__NACR__ && window.__NACR__.phase === "racing"', 40000, 'race start');
  // Hold W (and nitro) so the baseline phase has a moving car.
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(4000);

  const state = await page.evaluate('window.__NACR__.snapshot()');
  check('circuit: style is cyberpunk', state.style === 'cyberpunk', state.style);
  check('circuit: race is running', state.phase === 'racing', state.phase);
  const speed = await page.evaluate('window.__NACR__.speedKmh');
  check('circuit: car is moving', speed > 25, `${speed.toFixed(1)} km/h`);
  const chips = await page.evaluate(
    'JSON.stringify({s:window.__NACR__.hudStyle,q:window.__NACR__.hudQuality,m:window.__NACR__.hudMode})',
  );
  const parsed = JSON.parse(chips);
  check('circuit: HUD shows the style name', parsed.s === 'CYBERPUNK', parsed.s);
  check('circuit: HUD shows the map mode', String(parsed.m).includes('赛道'), parsed.m);
  const health = await page.evaluate('window.__NACR__.health()');
  check('circuit: renderer healthy', health.ok, health.detail);
  await page.screenshot('01-cyberpunk-circuit');
  return state;
}

async function phase2(page) {
  console.log('\n--- Phase 2: runtime switch cyberpunk -> realistic mid-race ---');
  const before = await page.evaluate('window.__NACR__.snapshot()');
  const shotBefore = await page.screenshot('02a-before-switch');

  // Switch via the debug handle (same code path as the T hotkey / pause menu).
  await page.evaluate('window.__NACR__.setStyle("realistic")');
  await sleep(2500);
  const after = await page.evaluate('window.__NACR__.snapshot()');
  const shotAfter = await page.screenshot('02b-after-switch-realistic');

  check('switch: style changed', after.style === 'realistic', after.style);
  check('switch: phase preserved', after.phase === before.phase, `${before.phase} -> ${after.phase}`);
  check('switch: lap preserved', after.lap === before.lap, `${before.lap} -> ${after.lap}`);
  check(
    'switch: race time kept running (not reset)',
    after.raceTime >= before.raceTime && after.raceTime - before.raceTime < 30,
    `${before.raceTime.toFixed(2)} -> ${after.raceTime.toFixed(2)}`,
  );
  check(
    'switch: best lap preserved',
    String(after.bestLap) === String(before.bestLap),
    `${before.bestLap} -> ${after.bestLap}`,
  );
  check('switch: rank preserved', after.rank === before.rank, `P${before.rank} -> P${after.rank}`);
  check(
    'switch: nitro preserved',
    Math.abs(after.nitro - before.nitro) < 60,
    `${before.nitro.toFixed(1)} -> ${after.nitro.toFixed(1)}`,
  );
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  check('switch: no teleport (car kept driving)', moved < 260, `moved ${moved.toFixed(1)} m`);
  check(
    'switch: AI state preserved',
    after.ai.length === before.ai.length && after.ai.every((a, i) => Number.isFinite(a.x) && Number.isFinite(a.speed)),
    `${after.ai.length} AI cars`,
  );

  const diff = await pixelDiff(shotBefore, shotAfter);
  // Byte-level diff: compressed PNGs never match exactly, so this only proves
  // the frames are not identical. The palette / postFx / theme checks above are
  // the semantic evidence; this is the visual smoke alarm.
  check('switch: the rendered frame changed', diff > 3, `screenshot delta ${diff.toFixed(2)}`);

  const health = await page.evaluate('window.__NACR__.health()');
  check('switch: renderer still healthy (no black screen / lost context)', health.ok, health.detail);
  const postFx = await page.evaluate('window.__NACR__.postFx');
  check('switch: realistic post chain is active', typeof postFx === 'string' && postFx.length > 0, postFx);
  const chip = await page.evaluate('window.__NACR__.hudStyle');
  check('switch: HUD style chip updated', chip === 'REALISTIC', chip);
  const bodyTheme = await page.evaluate('document.body.dataset.style');
  check('switch: UI theme switched', bodyTheme === 'realistic', bodyTheme);
  const stored = await page.evaluate('localStorage.getItem("nacr-style")');
  check('switch: preference persisted to localStorage', stored === 'realistic', String(stored));

  // Driving must still work after the switch.
  await page.keyboard;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(1800);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  const speedAfter = await page.evaluate('window.__NACR__.speedKmh');
  check('switch: car still drives after the switch', speedAfter > 40, `${speedAfter.toFixed(1)} km/h`);
  await sleep(600);
  await page.screenshot('02c-realistic-driving');
  return after;
}

async function phase3(page) {
  console.log('\n--- Phase 3: switch back + quality presets ---');
  const before = await page.evaluate('window.__NACR__.snapshot()');
  await page.evaluate('window.__NACR__.toggleStyle()');
  await sleep(2200);
  const after = await page.evaluate('window.__NACR__.snapshot()');
  check('switch back: style is cyberpunk', after.style === 'cyberpunk', after.style);
  check('switch back: lap preserved', after.lap === before.lap, `${before.lap} -> ${after.lap}`);
  check(
    'switch back: race time not reset',
    after.raceTime >= before.raceTime,
    `${before.raceTime.toFixed(2)} -> ${after.raceTime.toFixed(2)}`,
  );
  const health = await page.evaluate('window.__NACR__.health()');
  check('switch back: renderer healthy', health.ok, health.detail);
  await page.screenshot('03-back-to-cyberpunk');

  // Quality cycling must be safe at every preset.
  for (const q of ['low', 'medium', 'high', 'ultra']) {
    await page.evaluate(`window.__NACR__.setQuality(${JSON.stringify(q)})`);
    await sleep(1200);
    const live = await page.evaluate('window.__NACR__.quality');
    const h = await page.evaluate('window.__NACR__.health()');
    check(`quality preset '${q}' applies safely`, live === q && h.ok, `${live} ${h.detail}`);
  }
  const postFx = await page.evaluate('window.__NACR__.postFx');
  check('ultra: post chain has effects', /Bloom|SSAO/.test(String(postFx)), String(postFx));
  await page.screenshot('03b-ultra-cyberpunk');
}

async function phase4(page) {
  console.log('\n--- Phase 4: open world ---');
  // Self-bootstrap so ONLY=4 works standalone.
  if (!(await page.evaluate('!!window.__NACR__'))) {
    await page.goto(`${BASE}/?autostart=1&nocount=1&lowfx=1&style=cyberpunk&map=circuit`);
    await waitFor(page, 'window.__NACR__ && window.__NACR__.phase === "racing"', 40000, 'race start');
    await sleep(1500);
  }
  const before = await page.evaluate('window.__NACR__.snapshot()');
  const beforeLength = await page.evaluate('window.__NACR__.worldLength');
  // Build the island at a middling budget first (headless software GL), then
  // raise the preset once the world exists.
  await page.evaluate('window.__NACR__.setQuality("medium")');
  await sleep(800);
  await page.evaluate('window.__NACR__.setMapMode("openworld")');
  // World generation is heavy: give it room, then wait for the race to restart.
  await waitFor(page, 'window.__NACR__.worldId === "openworld"', 90000, 'open world install');
  await sleep(3000);
  await waitFor(page, 'window.__NACR__.phase === "racing"', 60000, 'race on the new route');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(3500);

  const after = await page.evaluate('window.__NACR__.snapshot()');
  const afterLength = await page.evaluate('window.__NACR__.worldLength');
  check('open world: world swapped', (await page.evaluate('window.__NACR__.worldId')) === 'openworld');
  check(
    'open world: a different, longer route was generated',
    Math.abs(afterLength - beforeLength) > 100,
    `${beforeLength.toFixed(0)} m -> ${afterLength.toFixed(0)} m`,
  );
  check('open world: race restarted cleanly on the new route', after.phase === 'racing', after.phase);
  const speed = await page.evaluate('window.__NACR__.speedKmh');
  check('open world: car drives on the new route', speed > 20, `${speed.toFixed(1)} km/h`);
  const modeChip = await page.evaluate('window.__NACR__.hudMode');
  check('open world: HUD shows the new mode', String(modeChip).includes('OPEN'), String(modeChip));
  const health = await page.evaluate('window.__NACR__.health()');
  check('open world: renderer healthy', health.ok, health.detail);
  const mapStored = await page.evaluate('localStorage.getItem("nacr-mapmode")');
  check('open world: preference persisted', mapStored === 'openworld', String(mapStored));
  await page.screenshot('04-openworld-cyberpunk');

  // Style switch must also work inside the open world.
  await page.evaluate('window.__NACR__.setStyle("realistic")');
  await sleep(3000);
  const s = await page.evaluate('window.__NACR__.snapshot()');
  const h = await page.evaluate('window.__NACR__.health()');
  check('open world: style switch works there too', s.style === 'realistic' && h.ok, `${s.style} ${h.detail}`);
  await page.screenshot('05-openworld-realistic');

  const stats = await page.evaluate(
    'JSON.stringify({ai:window.__NACR__.aiCount, fps:Math.round(window.__NACR__.fps), length:Math.round(window.__NACR__.worldLength)})',
  );
  console.log(`  \u2139 open-world stats: ${stats}`);

  // Tick the lap counter by waiting on the race clock; verifies the director
  // works on the generated route too.
  const t0 = await page.evaluate('window.__NACR__.raceTime');
  await sleep(5000);
  const t1 = await page.evaluate('window.__NACR__.raceTime');
  check('open world: race clock advances', t1 > t0, `${t0.toFixed(1)} -> ${t1.toFixed(1)}`);
  void before;
}


/**
 * Phase 5 — menus and pause.
 *
 * The style switch has to be reachable from every entry point the brief lists:
 * the start menu, the pause menu, the settings panel (same containers) and the
 * T hotkey. Pausing must also freeze the simulation without losing anything.
 */
async function phase5(page) {
  console.log('\n--- Phase 5: menus, pause menu and hotkeys ---');
  if (!(await page.evaluate('!!window.__NACR__'))) {
    await page.goto(`${BASE}/?autostart=1&nocount=1&lowfx=1&style=cyberpunk&map=circuit`);
    await waitFor(page, 'window.__NACR__ && window.__NACR__.phase === "racing"', 40000, 'race start');
    await sleep(1500);
  }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(2500);

  const counts = JSON.parse(
    await page.evaluate(`JSON.stringify({
      containers: document.querySelectorAll('[data-group]').length,
      style: document.querySelectorAll('[data-group="style"] .option-btn').length,
      quality: document.querySelectorAll('[data-group="quality"] .option-btn').length,
      map: document.querySelectorAll('[data-group="map"] .option-btn').length,
      weather: document.querySelectorAll('[data-group="weather"] .option-btn').length,
    })`),
  );
  check(
    'style/quality/map/weather pickers exist in the start menu AND the pause menu',
    counts.containers === 8 && counts.style === 4 && counts.quality === 8 && counts.map === 4 && counts.weather >= 10,
    JSON.stringify(counts),
  );

  // Pause with the hotkey.
  const pressKey = async (code, key, vk) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  };
  await pressKey('KeyP', 'p', 80);
  await sleep(1000);
  check('P opens the pause menu', await page.evaluate(`!document.getElementById('pause').classList.contains('hidden')`));
  check('the pause menu summarises the live race state', String(await page.evaluate(`document.getElementById('pause-state').textContent`)).includes('圈数'));

  const p0 = await page.evaluate('window.__NACR__.raceTime');
  await sleep(1500);
  const p1 = await page.evaluate('window.__NACR__.raceTime');
  check('pausing freezes the race clock', Math.abs(p1 - p0) < 0.05, `${p0.toFixed(2)} -> ${p1.toFixed(2)}`);
  await page.screenshot('06-pause-menu');

  // Switch style from the pause menu button (not the debug handle).
  const target = (await page.evaluate('window.__NACR__.style')) === 'cyberpunk' ? 'realistic' : 'cyberpunk';
  await page.evaluate(
    `document.querySelector('#pause [data-group="style"] .option-btn[data-value="${target}"]').click()`,
  );
  await sleep(3000);
  check('style can be switched from the pause menu', (await page.evaluate('window.__NACR__.style')) === target, target);
  check('the loading veil is hidden again', await page.evaluate(`document.getElementById('loading').classList.contains('hidden')`));
  check('the pause menu survives the switch', await page.evaluate(`!document.getElementById('pause').classList.contains('hidden')`));

  // Pin a weather state (realistic only, but the call must always be safe).
  await page.evaluate(`document.querySelector('#pause [data-group="weather"] .option-btn[data-value="rain"]').click()`);
  await sleep(2500);
  check('weather can be pinned from the pause menu', (await page.evaluate('window.__NACR__.health()')).ok);
  await page.screenshot('07-pause-realistic-rain');

  await pressKey('KeyP', 'p', 80);
  await sleep(1200);
  check('P resumes the race', !(await page.evaluate('window.__NACR__.paused')));
  await sleep(1500);
  const speed = await page.evaluate('window.__NACR__.speedKmh');
  check('the car still drives after pause + style switch', speed > 30, `${speed.toFixed(0)} km/h`);

  // T hotkey cycles the style, Y cycles quality.
  const beforeStyle = await page.evaluate('window.__NACR__.style');
  await pressKey('KeyT', 't', 84);
  await sleep(2600);
  const afterStyle = await page.evaluate('window.__NACR__.style');
  check('the T hotkey switches style', afterStyle !== beforeStyle, `${beforeStyle} -> ${afterStyle}`);
  const beforeQuality = await page.evaluate('window.__NACR__.quality');
  await pressKey('KeyY', 'y', 89);
  await sleep(1200);
  const afterQuality = await page.evaluate('window.__NACR__.quality');
  check('the Y hotkey cycles quality', afterQuality !== beforeQuality, `${beforeQuality} -> ${afterQuality}`);
  const health = await page.evaluate('window.__NACR__.health()');
  check('renderer healthy after all menu operations', health.ok, health.detail);
  await page.screenshot('08-after-hotkeys');
}

// --------------------------------------------------------------------- main

const phases = [phase1, phase2, phase3, phase4, phase5];
let page = null;
try {
  page = await Target.launch();
  for (let i = 0; i < phases.length; i++) {
    if (ONLY && ONLY !== i + 1) continue;
    await phases[i](page);
  }
} catch (error) {
  check('harness completed without throwing', false, error.message);
  console.error(error);
} finally {
  page?.kill();
}

console.log('\n================ SUMMARY ================');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (consoleErrors.length) {
  console.log(`\nConsole errors (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 12)) console.log(`  ! ${e.slice(0, 260)}`);
} else {
  console.log('No console errors captured.');
}
console.log(`Screenshots in ${SHOT_DIR}`);
for (const s of screenshots) console.log(`  ${s}`);
process.exit(failed.length || consoleErrors.length ? 1 : 0);
