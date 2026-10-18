#!/usr/bin/env node
/**
 * Feature verification for the Round 1 rework that the two existing suites do
 * not cover: garage car picks, reverse-from-standstill and slope physics.
 *
 * Usage: node tools/verify-features.mjs [baseUrl]
 * Requires a running dev/preview server (default http://127.0.0.1:5173).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const PORT = Number(process.env.CDP_PORT ?? 9613);
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? '\u2705' : '\u274c'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
};

let id = 0;
const pending = new Map();
let ws;
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((resolve, reject) => pending.set(i, { resolve, reject }));
};
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'eval error');
  return res.result?.value;
};
const key = async (type, code, keyName, vk) =>
  send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: vk });
const load = async (qs) => {
  await send('Page.navigate', { url: `${BASE}/?${qs}` });
  for (let i = 0; i < 90; i++) {
    if (await evaluate('window.__NACR__ && __NACR__.phase === "racing"').catch(() => false)) break;
    await sleep(500);
  }
  // Let the input listeners settle before synthesising keys (a keyDown fired
  // straight after the phase flip is sometimes lost).
  await sleep(1200);
};

const child = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--mute-audio',
    '--window-size=1280,720',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'nacr-feat-'))}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
await sleep(1500);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Page.enable');

console.log('--- 1. garage picks ---');
for (const car of ['hellcat', 'gtr', 'modely', 'concept']) {
  await load(`autostart=1&nocount=1&lowfx=1&car=${car}`);
  const applied = await evaluate('window.__NACR__.car');
  check(`garage: ?car=${car} applied`, applied === car, `handle=${applied}`);
  await key('keyDown', 'KeyW', 'w', 87);
  await sleep(900);
  const early = await evaluate('window.__NACR__.pos.speed');
  await sleep(2500);
  const late = await evaluate('window.__NACR__.pos.speed');
  await key('keyUp', 'KeyW', 'w', 87);
  check(
    `garage: ${car} accelerates`,
    late > early && late > 15,
    `${(early * 3.6).toFixed(0)} -> ${(late * 3.6).toFixed(0)} km/h`,
  );
}

console.log('--- 2. reverse from standstill ---');
await load('autostart=1&nocount=1&lowfx=1&car=concept');
// The grid parks the car; only throttle unparks it (slope hold). Tap W first,
// brake back to a stop, then measure the reverse.
await key('keyDown', 'KeyW', 'w', 87);
await sleep(700);
await key('keyUp', 'KeyW', 'w', 87);
await key('keyDown', 'KeyS', 's', 83);
for (let i = 0; i < 25; i++) {
  await sleep(250);
  const s = await evaluate('window.__NACR__.pos.speed');
  if (Math.abs(s) < 0.35) break;
}
await key('keyUp', 'KeyS', 's', 83);
await sleep(800);
const r0 = await evaluate('window.__NACR__.pos.speed');
await key('keyDown', 'KeyS', 's', 83);
await sleep(3000);
const r1 = await evaluate('window.__NACR__.pos.speed');
await key('keyUp', 'KeyS', 's', 83);
check(
  'reverse: holding S from standstill drives backwards',
  r1 < -0.4,
  `${(r0 * 3.6).toFixed(1)} -> ${(r1 * 3.6).toFixed(1)} km/h`,
);
await key('keyDown', 'KeyW', 'w', 87);
await sleep(1500);
const r2 = await evaluate('window.__NACR__.pos.speed');
await key('keyUp', 'KeyW', 'w', 87);
check('reverse: W recovers to forward', r2 > 1, `${(r2 * 3.6).toFixed(1)} km/h`);

console.log('--- 3. slope physics ---');
await load('autostart=1&nocount=1&lowfx=1&car=concept');
await key('keyDown', 'KeyW', 'w', 87);
let slope = 0;
for (let i = 0; i < 40; i++) {
  await sleep(700);
  slope = await evaluate('window.__NACR__.slope');
  if (Math.abs(slope) > 0.05) break;
}
await key('keyUp', 'KeyW', 'w', 87);
// Brake on the slope: release S while the car still creeps FORWARD (the
// 120 ms sample step overshoots zero into reverse if aimed lower).
await key('keyDown', 'KeyS', 's', 83);
for (let i = 0; i < 40; i++) {
  await sleep(120);
  const s = await evaluate('window.__NACR__.pos.speed');
  if (s < 0.6) break;
}
await key('keyUp', 'KeyS', 's', 83);
const parkedOnSlope = await evaluate('window.__NACR__.parked');
let minSpeed = 0;
for (let i = 0; i < 10; i++) {
  await sleep(300);
  minSpeed = Math.min(minSpeed, await evaluate('window.__NACR__.pos.speed'));
}
check('slope: car sits on a gradient for the test', Math.abs(slope) > 0.045, `slope=${slope.toFixed(3)}`);
check('slope: no auto-park on a slope', parkedOnSlope === false, `parked=${parkedOnSlope}`);
check(
  'slope: rolls back downhill when released',
  minSpeed < -0.25 && minSpeed > -6,
  `min=${(minSpeed * 3.6).toFixed(2)} km/h (a creep, not a launch)`,
);

// Flat ground: brake to rest, release, the standstill snap must keep it at 0.
let flatSlope = 0;
await key('keyDown', 'KeyW', 'w', 87);
for (let i = 0; i < 40; i++) {
  await sleep(700);
  flatSlope = await evaluate('window.__NACR__.slope');
  if (Math.abs(flatSlope) < 0.02) break;
}
await key('keyUp', 'KeyW', 'w', 87);
await key('keyDown', 'KeyS', 's', 83);
for (let i = 0; i < 60; i++) {
  await sleep(120);
  const s = await evaluate('window.__NACR__.pos.speed');
  if (s < 0.6) break;
}
await key('keyUp', 'KeyS', 's', 83);
await sleep(1500);
let lastAfter = 0;
for (let i = 0; i < 6; i++) {
  await sleep(300);
  lastAfter = Math.abs(await evaluate('window.__NACR__.pos.speed'));
}
check(
  'slope: stays parked on flat ground after the snap',
  Math.abs(flatSlope) < 0.03 && lastAfter < 0.2,
  `slope=${flatSlope.toFixed(3)} final|v|=${(lastAfter * 3.6).toFixed(2)} km/h`,
);

ws.close();
child.kill('SIGKILL');
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
