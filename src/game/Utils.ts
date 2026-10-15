/** Small maths / formatting helpers shared across the game modules. */

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential smoothing. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-rate * dt));

export const randRange = (min: number, max: number): number => min + Math.random() * (max - min);

export const randInt = (min: number, max: number): number => Math.floor(randRange(min, max + 1));

export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

/** Wrap a value into [0, range). */
export const wrap = (v: number, range: number): number => ((v % range) + range) % range;

/** Shortest signed delta between two angles (radians). */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** Format seconds as m:ss.mmm — or a `--:--.---` placeholder when null. */
export const formatTime = (seconds: number | null | undefined, withMillis = true): string => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--.---';
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  const ss = s.toString().padStart(2, '0');
  if (!withMillis) return `${m}:${ss}`;
  return `${m}:${ss}.${ms.toString().padStart(3, '0')}`;
};

/** Ordinal-ish position label, e.g. 1 -> "P1". */
export const positionLabel = (pos: number): string => `P${pos}`;

/** Deterministic pseudo random generator (mulberry32) for reproducible city layouts. */
export const makeRng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
