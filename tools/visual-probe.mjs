#!/usr/bin/env node
/**
 * Visual diagnostics for Neon Apex: Cyber Racing.
 *
 * Captures the frame under a sequence of toggles and reports objective pixel
 * statistics (mean RGB / luminance / contrast), so a lighting or post-processing
 * regression can be bisected without eyeballing screenshots.
 *
 * Usage: node tools/visual-probe.mjs [baseUrl]
 *        STYLE=realistic MAP=openworld QUALITY=high node tools/visual-probe.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const PORT = Number(process.env.CDP_PORT ?? 9601);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.SHOT_DIR ?? '/tmp/nacr-probe';
const STYLE = process.env.STYLE ?? 'realistic';
const MAP = process.env.MAP ?? 'openworld';
const QUALITY = process.env.QUALITY ?? 'high';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal PNG decoder for 8-bit RGB/RGBA non-interlaced images (enough for CDP). */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error('unsupported bit depth');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = row[x];
      switch (filter) {
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          break;
      }
      cur[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Mean RGB, luminance and contrast over an optional vertical band. */
function stats(png, y0 = 0.32, y1 = 0.78) {
  const { width, height, channels, data } = png;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let lumSum = 0;
  let lumSq = 0;
  const values = [];
  for (let y = Math.floor(height * y0); y < Math.floor(height * y1); y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * channels;
      const pr = data[i];
      const pg = data[i + 1];
      const pb = data[i + 2];
      r += pr;
      g += pg;
      b += pb;
      const l = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
      lumSum += l;
      lumSq += l * l;
      if (values.length < 4096) values.push(l);
      n += 1;
    }
  }
  const mean = lumSum / n;
  const variance = Math.max(0, lumSq / n - mean * mean);
  return {
    rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
    luma: Math.round(mean),
    stdev: Math.round(Math.sqrt(variance)),
  };
}

/** Per-band breakdown: sky / horizon / ground. */
function bands(png) {
  return {
    sky: stats(png, 0.06, 0.26).luma,
    horizon: stats(png, 0.34, 0.52).luma,
    ground: stats(png, 0.62, 0.95).luma,
  };
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
  }
  static async launch() {
    const child = spawn(
      CHROME,
      [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        '--no-first-run',
        '--mute-audio',
        '--window-size=1280,720',
        `--user-data-dir=${mkdtempSync(join(tmpdir(), 'nacr-vis-'))}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    await sleep(1500);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const target = list.find((t) => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const page = new Page(ws);
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const pending = page.pending.get(msg.id);
        if (pending) {
          page.pending.delete(msg.id);
          msg.error ? pending.reject(new Error(JSON.stringify(msg.error))) : pending.resolve(msg.result);
        }
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        page.logs.push(`[${msg.params.type}] ` + (msg.params.args ?? []).map((a) => a.value ?? '').join(' ').slice(0, 160));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        page.logs.push('[EXC] ' + String(msg.params.exceptionDetails?.exception?.description ?? '').slice(0, 400));
      }
    });
    page.child = child;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    return page;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'eval error');
    return res.result?.value;
  }
  async capture(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const buffer = Buffer.from(res.data, 'base64');
    writeFileSync(join(OUT, `${name}.png`), buffer);
    const png2 = decodePng(buffer);
    return { ...stats(png2), ...bands(png2), path: join(OUT, `${name}.png`) };
  }
  kill() {
    try {
      this.ws.close();
      this.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

const page = await Page.launch();
await page.send('Page.navigate', {
  url: `${BASE}/?autostart=1&nocount=1&style=${STYLE}&map=${MAP}&quality=${QUALITY}`,
});
await sleep(13000);
for (let i = 0; i < 60; i++) {
  if (await page.evaluate('window.__NACR__ && __NACR__.phase === "racing"')) break;
  await sleep(500);
}
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
await sleep(6000);

const rows = [];
const record = (label, s) => {
  rows.push({ label, ...s });
  console.log(
    `  ${label.padEnd(24)} luma=${String(s.luma).padStart(3)} ctr=${String(s.stdev).padStart(3)}  sky=${String(s.sky).padStart(3)} horizon=${String(s.horizon).padStart(3)} ground=${String(s.ground).padStart(3)}  rgb=[${s.rgb.join(',')}]`,
  );
};

console.log(`\n=== visual probe: style=${STYLE} map=${MAP} quality=${QUALITY} ===`);
record('baseline (all on)', await page.capture('00-baseline'));
console.log('   postfx:', await page.evaluate('__NACR__.postFx'));
console.log('   scene :', JSON.stringify(await page.evaluate('__NACR__.sceneInfo()')));

const steps = [
  ['fx: no god rays', () => page.evaluate('__NACR__.fxOverride({godRays:false})')],
  ['fx: no bloom', () => page.evaluate('__NACR__.fxOverride({godRays:false,bloom:false})')],
  ['fx: no ssao', () => page.evaluate('__NACR__.fxOverride({godRays:false,bloom:false,ssao:false})')],
  ['fx: no grade', () => page.evaluate('__NACR__.fxOverride({godRays:false,bloom:false,ssao:false,colorGrade:false})')],
  ['render: no shadows', () => page.evaluate('__NACR__.debugRender({shadows:false})')],
  ['render: no env probe', () => page.evaluate('__NACR__.debugRender({environment:false})')],
];
for (const [label, run] of steps) {
  await run();
  await sleep(1400);
  record(label, await page.capture(`0${steps.indexOf(steps.find((s) => s[0] === label)) + 1}-${label.replace(/[^a-z0-9]+/gi, '-')}`));
}
console.log('\n  logs:', page.logs.slice(-6).join(' | '));
console.log(`\n  screenshots in ${OUT}`);
page.kill();
