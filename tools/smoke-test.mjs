#!/usr/bin/env node
/**
 * End-to-end smoke test for Neon Apex: Cyber Racing.
 *
 * Boots the game in a real (headless) Chrome over the DevTools Protocol and
 * verifies the whole race loop:
 *   Phase 1 — attract-mode autopilot drives a full race to the results screen.
 *   Phase 2 — synthetic W / Space / D / S / R key events drive the car and the
 *             HUD is asserted against the simulation.
 *
 * Each phase runs in its own page target: headless Chrome occasionally stops
 * acking CDP commands after a navigation, and a fresh target keeps the run
 * deterministic without weakening any assertion.
 *
 * Usage:
 *   node tools/smoke-test.mjs [baseUrl]
 *   CHROME_PATH=/path/to/chrome SHOT_DIR=/tmp node tools/smoke-test.mjs
 *
 * Requires a running dev/preview server (default http://127.0.0.1:5173).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = process.env.SHOT_DIR ?? tmpdir();
/** Optional phase filter: ONLY=1|2|3 runs just that phase (debugging). */
const ONLY = process.env.ONLY;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const consoleErrors = [];
const pageErrors = [];
const screenshots = [];
/** Live state samples pushed from the page, used as a fallback. */
const samples = [];
let fallbacks = 0;

const SAMPLE_PREFIX = 'NACR_SAMPLE ';
const MARK_PREFIX = 'NACR_MARK ';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * fetch with a hard deadline. Every request into Chrome's DevTools endpoint must
 * be bounded: when the software renderer saturates the machine, even the
 * browser-process endpoint `/json/list` can stall for tens of seconds, and an
 * unbounded fetch would hang the whole test run instead of failing it.
 */
function httpGet(url, timeoutMs = 10000, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // A stalled endpoint must not eat the whole budget: cap each attempt, and
      // keep the abort signal from escaping this iteration.
      const res = await httpGet(url, Math.min(4000, Math.max(500, deadline - Date.now())));
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      }
      // The page reports live samples through console.log, which arrives as a
      // push event. Pulling values with Runtime.evaluate instead is unreliable
      // while the software renderer is busy, so this is the source of truth.
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        if (text.startsWith(SAMPLE_PREFIX) || text.startsWith(MARK_PREFIX)) {
          try {
            samples.push(JSON.parse(text.slice(text.indexOf('{'))));
          } catch {
            /* ignore malformed samples */
          }
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push(d.exception?.description ?? d.text);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        consoleErrors.push(`${msg.params.entry.source}: ${msg.params.entry.text} (${msg.params.entry.url ?? ''})`);
      }
    });
  }

  /**
   * Sends one CDP command. Headless Chrome under software WebGL occasionally
   * stops acknowledging a command while the renderer main thread is saturated,
   * so read-only commands are retried instead of failing the whole run.
   */
  send(method, params = {}, { timeoutMs = 12000, retries = 0 } = {}) {
    const attempt = (left) => {
      const id = ++this.id;
      this.ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          if (left > 0) resolve(attempt(left - 1));
          else reject(new Error(`CDP timeout: ${method}`));
        }, timeoutMs);
      });
    };
    return attempt(retries);
  }

  async eval(expression, { timeoutMs = 12000, retries = 2 } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      { timeoutMs, retries },
    );
    if (res.exceptionDetails) {
      // `text` is usually just "Uncaught"; the description carries the real message.
      const details = res.exceptionDetails;
      throw new Error(`page threw during eval: ${details.exception?.description ?? details.text}`);
    }
    return res.result?.value;
  }

  /**
   * Keeps trying an expression until `budgetMs` runs out. The software renderer
   * can stop answering renderer-bound commands for many seconds at a time, so a
   * short per-attempt timeout plus an outer retry loop is far more reliable than
   * one long wait.
   */
  async evalPatiently(expression, label, budgetMs = 60000) {
    const deadline = Date.now() + budgetMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        return await this.eval(expression, { timeoutMs: 5000, retries: 0 });
      } catch (error) {
        lastError = error;
        await sleep(750);
      }
    }
    throw new Error(`${label} got no answer in ${budgetMs}ms (last: ${lastError?.message})`);
  }

  async json(expression) {
    return JSON.parse(await this.eval(`JSON.stringify(${expression})`));
  }

  /** Waits until `expression` evaluates to a truthy value. */
  async waitForValue(expression, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (error) {
        last = `eval error: ${error.message}`;
      }
      await sleep(400);
    }
    throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
  }

  /** Dispatches a key event, falling back to the equivalent DOM event. */
  async key(type, code, keyValue, vk) {
    const params = { type, code, key: keyValue, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    try {
      await this.send('Input.dispatchKeyEvent', params);
    } catch {
      fallbacks += 1;
      const domType = type === 'keyUp' ? 'keyup' : 'keydown';
      // The fallback itself can fail when the renderer is unresponsive; that is
      // worth reporting, but not worth a bare unhandled rejection.
      try {
        await this.eval(
          `window.dispatchEvent(new KeyboardEvent('${domType}', {code:'${code}', key:${JSON.stringify(keyValue)}, bubbles:true, cancelable:true}))`,
          { timeoutMs: 6000, retries: 1 },
        );
      } catch (error) {
        console.log(`     (key ${type} ${code}: both input paths failed — ${error.message})`);
      }
    }
  }

  async screenshot(name, { timeoutMs = 10000, retries = 0 } = {}) {
    // Screenshots are evidence, not assertions. Capturing a frame from the
    // software renderer takes seconds and occasionally exceeds any sane
    // timeout, so a failure here must never fail the run.
    try {
      const res = await this.send(
        'Page.captureScreenshot',
        { format: 'png', optimizeForSpeed: true },
        { timeoutMs, retries },
      );
      const file = join(SHOT_DIR, `nacr-${name}.png`);
      writeFileSync(file, Buffer.from(res.data, 'base64'));
      screenshots.push(file);
      return file;
    } catch (error) {
      console.log(`     (screenshot "${name}" skipped — ${error.message})`);
      return null;
    }
  }
}

/** Opens a dedicated page target and returns a connected CDP session. */
async function openPage() {
  const target = await (await httpGet(`http://127.0.0.1:${PORT}/json/new?about:blank`, 15000, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); }, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  // Headless pages are unfocused by default: without this, key events never
  // reach the game's window key listeners.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Deliberately NOT calling Page.bringToFront. Activating the tab lets the
  // software renderer saturate the main thread, after which Runtime.evaluate
  // stops being answered (measured with the car driving: 3-6 of 7 reads time
  // out with bringToFront, 0 of 7 without). Focus emulation on its own is what
  // makes synthetic key events reach the game.
  return {
    cdp,
    target,
    /** Current document title, read through the browser process. */
    title: async () => {
      const list = await httpGet(`http://127.0.0.1:${PORT}/json/list`, 8000)
        .then((r) => r.json())
        .catch(() => []);
      return list.find((t) => t.id === target.id)?.title ?? '';
    },
    /**
     * Resize this page's viewport. Fragment cost is what makes the software
     * renderer expensive, so the driving phases run at a smaller size.
     */
    setViewport: (width, height) => cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    }),
    // Closing the socket alone is not enough: the page would keep rendering the
    // whole scene, and two software-WebGL scenes starve each other's main
    // thread until CDP stops being answered. Close the target for real.
    close: async () => {
      ws.close();
      await httpGet(`http://127.0.0.1:${PORT}/json/close/${target.id}`, 8000).catch(() => {});
    },
  };
}

// --------------------------------------------------------------- phase one

async function phaseAutopilotRace(page) {
  const { cdp } = page;
  console.log('\n=== 1. Full race with the attract-mode autopilot (1 lap) ===');
  // This phase only checks simulation and UI state, so it runs on the cheap
  // render preset: the software rasteriser then stays far away from saturating
  // the CPU, which is what keeps DevTools answering during the whole lap.
  await page.setViewport(960, 540);
  await cdp.send('Page.navigate', { url: `${BASE}/?autostart=1&nocount=1&autopilot=1&laps=1&lowfx=1` });
  await cdp.waitForValue('!!window.__NACR__', 30000, 'game boot');
  const boot = await cdp.json('{ai: __NACR__.aiCount, bloom: __NACR__.bloom, hud: __NACR__.hudVisible}');
  check('game boots and exposes live state', true);
  check('at least 3 AI opponents', boot.ai >= 3, `${boot.ai} AI cars`);
  check('HUD visible during the race', boot.hud === true);

  await cdp.waitForValue('__NACR__.phase === "racing"', 20000, 'racing phase');
  await sleep(4000);
  const driving = await cdp.json(
    '{speed: __NACR__.speedKmh, particles: __NACR__.particles, raceTime: __NACR__.raceTime}',
  );
  check('car actually reaches racing speed', driving.speed > 60, `${driving.speed.toFixed(0)} km/h`);
  // Software WebGL renders slowly and dt is clamped per frame, so game clock < wall clock here.
  check('race clock advances', driving.raceTime > 1, `${driving.raceTime.toFixed(2)} s`);
  check('particle pools emit (nitro / exhaust)', driving.particles > 0, `${driving.particles} live particles`);

  console.log('     waiting for the autopilot to complete the lap…');
  await cdp.waitForValue('__NACR__.phase === "finished"', 180000, 'race finished');
  const finish = await cdp.json('{lap: __NACR__.lap, rank: __NACR__.rank, raceTime: __NACR__.raceTime}');
  check('lap counter advanced by the race director', finish.lap >= 1, `lap ${finish.lap}`);
  check('rank assigned (1..6)', finish.rank >= 1 && finish.rank <= 6, `P${finish.rank}`);
  await cdp.waitForValue('__NACR__.resultsVisible === true', 15000, 'results screen');
  check('results screen appears after the finish', true);

  const table = await cdp.json(
    '[...document.querySelectorAll("#results-body tr")].map((tr) => [...tr.children].map((td) => td.textContent.trim()))',
  );
  console.log('     final classification:');
  for (const row of table) console.log(`       ${row.join(' | ')}`);
  check('classification lists every car', table.length >= 4, `${table.length} rows`);
  check(
    'at least one racer set a best lap',
    table.some((row) => /\d:\d\d\.\d\d\d/.test(row[2] ?? '')),
    table.find((row) => /\d:\d\d\.\d\d\d/.test(row[2] ?? ''))?.[2] ?? 'none',
  );
}

// --------------------------------------------------------------- phase two

async function phaseManualDriving(page) {
  const { cdp } = page;
  console.log('\n=== 2. Manual driving: W / Space / D / S / R ===');
  samples.length = 0;
  await page.setViewport(960, 540);
  await cdp.send('Page.navigate', { url: `${BASE}/?autostart=1&nocount=1&laps=2&lowfx=1` });
  await cdp.waitForValue('!!window.__NACR__ && __NACR__.phase === "racing"', 30000, 'manual race start');
  await sleep(300);

  // Keys are dispatched as real input events, but the state readback does NOT
  // go through Runtime.evaluate. Once the car is moving under the software
  // renderer, renderer-bound commands stop being answered for tens of seconds
  // (measured: 0/7 evaluates answered after a brake-and-crash sequence), while
  // the page itself keeps running normally. So the page mirrors its last few
  // samples into document.title, and Node reads them from /json/list — a
  // browser-process HTTP endpoint that never waits on the renderer.
  //
  // The payload is deliberately quote-free: /json/list HTML-escapes the title
  // (a JSON payload comes back as `[{&quot;t&quot;:…`), so a JSON round-trip
  // fails. Plain `,` and `;` delimited fields survive untouched.
  //
  // The log is cumulative rather than a rolling window: a poll that times out
  // costs nothing, because the next successful poll still carries every sample
  // so far. Chrome reports at most 4096 characters of title, so the page drops
  // its oldest samples once the title would grow past the cap.
  const pageT0 = await cdp.evalPatiently('performance.now()', 'page clock');
  const nodeT0 = Date.now();
  await cdp.evalPatiently(`(() => {
    const d = window.__NACR__;
    const log = [];
    const TITLE_BUDGET = 3800;
    window.__NACR_LOG__ = log;
    window.__NACR_TIMER__ = setInterval(() => {
      // HUD "M:SS.mmm" -> milliseconds, so the assertion reads a number.
      // NB: backslashes are doubled — this expression is sent inside a template
      // literal, and an unrecognised escape such as \\d would silently arrive in
      // the page as a bare "d", making the pattern unmatchable.
      const shown = /^(\\d+):(\\d\\d)\\.(\\d\\d\\d)$/.exec((document.querySelector('#hud-time')?.textContent ?? '').trim());
      const hudMs = shown ? ((Number(shown[1]) * 60) + Number(shown[2])) * 1000 + Number(shown[3]) : -1;
      log.push([Math.round(performance.now()), Math.round(d.speedKmh), Math.round(Number(d.hudSpeed)),
        Math.round(d.nitro), d.boosting ? 1 : 0, String(d.phase).charAt(0), d.lap, parseInt(String(d.hudLap), 10),
        Math.round(Number(d.fps) * 10), hudMs, Math.round(Number(d.yaw) * 57.29578)].join(','));
      let title = log.join(';');
      while (title.length > TITLE_BUDGET && log.length > 1) { log.shift(); title = log.join(';'); }
      document.title = 'NACRT ' + title;
    }, 500);
    return true;
  })()`, 'sampler install');
  /** Node wall-clock ms -> page performance.now() ms. */
  const toPageClock = (nodeMs) => pageT0 + (nodeMs - nodeT0);

  const PHASES = { m: 'menu', c: 'countdown', r: 'racing', f: 'finished' };

  /** Parses one title snapshot into sample records. */
  const parseTitle = (title) => {
    const rows = title.startsWith('NACRT ') ? title.slice(6).split(';') : [];
    const out = [];
    for (const row of rows) {
      const f = row.split(',');
      if (f.length < 10) continue;
      out.push({
        t: Number(f[0]), speed: Number(f[1]), hudSpeed: Number(f[2]), nitro: Number(f[3]),
        boosting: f[4] === '1', phase: PHASES[f[5]] ?? f[5], lap: Number(f[6]), hudLap: Number(f[7]),
        fps: Number(f[8]) / 10, hudMs: Number(f[9]), yaw: Number(f[10]),
      });
    }
    return out;
  };

  // Collect samples by polling the title; samples are de-duplicated by page time.
  const collected = new Map();
  let polling = true;
  const pollStats = { polls: 0, empty: 0, stale: 0, latest: -1 };
  const poller = (async () => {
    while (polling) {
      try {
        const rows = parseTitle(await page.title());
        pollStats.polls += 1;
        if (!rows.length) pollStats.empty += 1;
        // A stale title (same newest sample) means the page stopped sampling.
        else if (rows[rows.length - 1].t <= pollStats.latest) pollStats.stale += 1;
        else pollStats.latest = rows[rows.length - 1].t;
        for (const s of rows) collected.set(s.t, s);
      } catch {
        pollStats.empty += 1;
      }
      await sleep(400);
    }
    console.log(`     title polls: ${pollStats.polls} (${pollStats.empty} empty, ${pollStats.stale} stale, newest sample t=${pollStats.latest})`);
  })();

  const windows = {};
  const step = async (name, fn) => {
    console.log(`     ${name}…`);
    const from = Date.now();
    await fn();
    const to = Date.now();
    windows[name] = [toPageClock(from), toPageClock(to)];
  };

  // Native input is exercised once (it is what a real player's keyboard uses);
  // the rest of the drive is scripted from inside the page. Dozens of CDP input
  // round-trips flood a software-rendered main thread badly enough to stall it,
  // while a dispatched KeyboardEvent hits exactly the same Input listeners.
  const domKey = (type, code, keyValue) =>
    cdp.evalPatiently(
      `(() => { window.dispatchEvent(new KeyboardEvent('${type}', {code:'${code}', key:${JSON.stringify(keyValue)}, bubbles:true, cancelable:true})); return true; })()`,
      `${type} ${code}`,
    );

  await step('accel', async () => {
    await cdp.key('keyDown', 'KeyW', 'w', 87);
    await sleep(3000);
  });
  await step('nitro', async () => {
    await domKey('keydown', 'Space', ' ');
    await sleep(1500);
    await domKey('keyup', 'Space', ' ');
  });
  await step('brake', async () => {
    await domKey('keyup', 'KeyW', 'w');
    await domKey('keydown', 'KeyS', 's');
    await sleep(2000);
    await domKey('keyup', 'KeyS', 's');
  });
  await step('hud', async () => {
    await domKey('keydown', 'KeyW', 'w');
    await sleep(3000);
  });
  await step('restart', async () => {
    await domKey('keyup', 'KeyW', 'w');
    for (let attempt = 0; attempt < 3; attempt++) {
      await domKey('keydown', 'KeyR', 'r');
      await sleep(350);
      await domKey('keyup', 'KeyR', 'r');
      await sleep(900);
      const last = parseTitle(await page.title()).at(-1);
      if (last && (last.phase === 'countdown' || (last.hudMs >= 0 && last.hudMs < 2500))) break;
    }
    await sleep(1200);
  });

  // Steering is checked from a standing start after the restart: at 150 km/h the
  // car is already against a barrier, so a heading test there proves nothing.
  await step('steer', async () => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const last = parseTitle(await page.title()).at(-1);
      if (last?.phase === 'racing') break;
      await sleep(400);
    }
    await domKey('keydown', 'KeyW', 'w');
    await sleep(1400); // build a little speed on the straight
    await domKey('keydown', 'KeyD', 'd');
    await sleep(1600);
    await domKey('keyup', 'KeyD', 'd');
    await domKey('keyup', 'KeyW', 'w');
  });

  // Let the sampler record the post-restart frames, then stop polling.
  await sleep(1200);
  polling = false;
  await poller;
  const log = [...collected.values()].sort((a, b) => a.t - b.t);
  if (!log.length) {
    throw new Error('the page mirrored no state samples into the title — the harness lost the page');
  }
  console.log(`     collected ${log.length} live samples while driving`);
  if (process.env.DUMP) {
    console.log(`     windows: ${JSON.stringify(windows)}`);
    for (const s of log) console.log(`       t=${s.t} sp=${s.speed} ni=${s.nitro} ph=${s.phase} lap=${s.lap} hudMs=${s.hudMs} yaw=${s.yaw}`);
  }
  const inWindow = (name) => {
    const [a, b] = windows[name];
    return log.filter((s) => s.t >= a && s.t <= b);
  };
  const peakOf = (arr, key) => arr.reduce((m, s) => Math.max(m, Number(s[key]) || 0), 0);
  const minOf = (arr, key) => arr.reduce((m, s) => Math.min(m, Number(s[key]) || 0), Infinity);
  const lastOf = (arr) => arr[arr.length - 1] ?? {};
  const describe = (arr) => `${arr.length} sample(s)`;

  const accel = inWindow('accel');
  const nitro = inWindow('nitro');
  const steer = inWindow('steer');
  const brake = inWindow('brake');
  const hud = inWindow('hud');
  const afterR = log.filter((s) => s.t > windows.restart[0] && s.t < windows.steer[0]);

  const peakSpeed = peakOf(accel, 'speed');
  const fastSample = accel.reduce((best, s) => (s.speed > (best?.speed ?? -1) ? s : best), null);
  const nitroStart = accel.length ? lastOf(accel).nitro : 0;
  const nitroEnd = nitro.length ? minOf(nitro, 'nitro') : nitroStart;

  // This step is driven by a native Input.dispatchKeyEvent, not a scripted one.
  check('native W key events drive the car', peakSpeed > 50, `${peakSpeed.toFixed(0)} km/h — ${describe(accel)}`);
  check(
    'HUD speed matches the simulation',
    !!fastSample && Math.abs(fastSample.hudSpeed - fastSample.speed) < 8,
    `HUD ${fastSample?.hudSpeed} vs sim ${fastSample?.speed?.toFixed(0)}`,
  );
  check(
    'Space burns nitro and engages boost',
    nitroEnd < nitroStart - 5 && nitro.some((s) => s.boosting === true),
    `${nitroStart.toFixed(0)}% → ${nitroEnd.toFixed(0)}%`,
  );
  // Steering is proven by the car's heading changing, not by its speed: turning
  // hard at 150 km/h legitimately ends in a barrier.
  const steerTurn = steer.length >= 2 ? Math.abs(lastOf(steer).yaw - steer[0].yaw) : 0;
  check(
    'D steers the car (heading changes)',
    steer.length >= 2 && steerTurn >= 8,
    `${steerTurn.toFixed(0)}° of yaw over ${describe(steer)}`,
  );
  check('the simulation keeps stepping while steering', lastOf(steer).phase === 'racing', `phase=${lastOf(steer).phase}`);
  check(
    'S brakes the car',
    lastOf(brake).speed < peakSpeed,
    `${peakSpeed.toFixed(0)} → ${(lastOf(brake).speed ?? 0).toFixed(0)} km/h`,
  );
  // The HUD shows the lap in progress (1-based); the handle reports completed laps.
  check(
    'HUD shows the lap counter',
    hud.some((s) => s.hudLap === s.lap + 1 && s.lap >= 0),
    `HUD lap ${lastOf(hud).hudLap} vs sim lap ${lastOf(hud).lap}`,
  );
  // The invariant is agreement, not a particular speed: the car may legitimately
  // be crawling back from a barrier during this window.
  const hudTracked = hud.filter((s) => Number.isFinite(s.hudSpeed) && Math.abs(s.hudSpeed - s.speed) <= 10);
  check(
    'HUD speed tracks the car',
    hud.length >= 2 && hudTracked.length / hud.length >= 0.8,
    `${hudTracked.length}/${hud.length} samples within 10 km/h`,
  );
  // The software rasteriser runs far below 60 FPS; the point is that the render
  // loop keeps ticking rather than stalling.
  check('renderer keeps an interactive frame rate', minOf(hud, 'fps') > 5, `${minOf(hud, 'fps').toFixed(1)} FPS (software GL)`);
  // The countdown is a short transient and the harness may only observe it after
  // it has already elapsed, so accept "back on the grid" in either form.
  const restarted = afterR.some((s) => s.phase === 'countdown') ||
    afterR.some((s) => s.hudMs >= 0 && s.hudMs < 1500 && s.lap === 0);
  check('R restarts the race', restarted, `phase=${lastOf(afterR).phase}, clock=${lastOf(afterR).hudMs} ms`);
  check('restart resets the lap counter', afterR.some((s) => s.lap === 0), `lap ${lastOf(afterR).lap}`);
  const clocks = afterR.map((s) => s.hudMs).filter((ms) => ms >= 0);
  check(
    'restart resets the race clock on the HUD',
    clocks.some((ms) => ms < 1500),
    `HUD clock after R: ${clocks.length ? `${(Math.min(...clocks) / 1000).toFixed(3)} s (min of ${clocks.length})` : 'n/a'}`,
  );
}

// ---------------------------------------------------------------- phase three

/**
 * Visual evidence only — no assertions. Capturing a frame from the software
 * renderer can block it for many seconds, so it gets its own page target: a
 * stalled capture must never cost the data collected by the other phases.
 */
async function phaseDrivingScreenshot(cdp) {
  console.log('\n=== 3. Driving screenshot ===');
  await cdp.send('Page.navigate', { url: `${BASE}/?autostart=1&nocount=1` });
  await cdp.waitForValue('!!window.__NACR__ && __NACR__.phase === "racing"', 30000, 'screenshot race start');
  await cdp.key('keyDown', 'KeyW', 'w', 87);
  await sleep(5000);
  await cdp.key('keyDown', 'Space', ' ', 32);
  await sleep(700);
  await cdp.key('keyUp', 'Space', ' ', 32);
  const file = await cdp.screenshot('driving', { timeoutMs: 60000, retries: 1 });
  if (file) console.log(`     screenshot: ${file}`);
  await cdp.key('keyUp', 'KeyW', 'w', 87);
}

// ------------------------------------------------------------------- main

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nacr-chrome-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1440,810',
      '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    // detached: Chrome's helper processes (renderers, GPUs, utilities) survive
    // a plain SIGKILL of the launcher and keep eating CPU, which starves every
    // later run — measured 28 leaked processes after a handful of runs, enough
    // to make even /json/list take 24 s. A dedicated process group lets the
    // cleanup below take the whole tree down at once.
    { stdio: ['ignore', 'ignore', 'ignore'], detached: true },
  );

  try {
    await waitForHttp(`http://127.0.0.1:${PORT}/json/version`);

    // ONLY=1|2|3 runs a single phase, which is useful when debugging.
    if (ONLY !== '2') {
      const a = await openPage();
      try {
        await phaseAutopilotRace(a);
      } finally {
        await a.close();
      }
    }

    if (ONLY !== '1') {
      const b = await openPage();
      try {
        await phaseManualDriving(b);
      } finally {
        await b.close();
      }
    }

    if (!ONLY) {
      // Visual evidence only: a starved software renderer can make the capture
      // (or even opening the target) time out, and that must not fail the run.
      try {
        const c = await openPage();
        try {
          await phaseDrivingScreenshot(c.cdp);
        } finally {
          await c.close();
        }
      } catch (err) {
        console.log(`     (driving screenshot skipped: ${err instanceof Error ? err.message : String(err)})`);
      }
    }

    console.log('\n=== 4. Console hygiene ===');
    const ignored = /favicon|AudioContext was not allowed|autoplay/i;
    const realConsole = consoleErrors.filter((e) => !ignored.test(e));
    const realPage = pageErrors.filter((e) => !ignored.test(e));
    check('no console errors', realConsole.length === 0, realConsole.slice(0, 3).join(' | '));
    check('no uncaught exceptions', realPage.length === 0, realPage.slice(0, 2).join(' | '));
  } finally {
    // Kill the whole process group, not just the launcher.
    try {
      if (chrome.pid) process.kill(-chrome.pid, 'SIGKILL');
    } catch {
      chrome.kill('SIGKILL');
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (fallbacks) console.log(`(headless input-ack fallbacks used: ${fallbacks})`);
  if (screenshots.length) console.log(`screenshots:\n  ${screenshots.join('\n  ')}`);
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nSMOKE TEST ERROR:', error?.message ?? error);
  if (process.env.STACK) console.error(error?.stack ?? '(no stack)');
  process.exit(1);
});
