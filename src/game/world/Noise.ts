/**
 * Deterministic procedural noise used by the terrain, biome and texture
 * generators. Everything is seeded, so a given world seed always produces the
 * same island (important for reproducible smoke tests and for the road network
 * agreeing with the terrain).
 */

/** xorshift32 PRNG — fast, seedable and good enough for generation work. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}

/** Hash-based 2D gradient noise (Perlin-style, no lattice allocation). */
export function makeNoise2D(seed: number): (x: number, y: number) => number {
  const perm = new Uint8Array(512);
  const rand = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i]!;
    p[i] = p[j]!;
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;

  const grad = (hash: number, x: number, y: number): number => {
    switch (hash & 7) {
      case 0:
        return x + y;
      case 1:
        return x - y;
      case 2:
        return -x + y;
      case 3:
        return -x - y;
      case 4:
        return x;
      case 5:
        return -x;
      case 6:
        return y;
      default:
        return -y;
    }
  };
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

  return (x: number, y: number): number => {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[xi]! + yi]!;
    const ab = perm[perm[xi]! + yi + 1]!;
    const ba = perm[perm[xi + 1]! + yi]!;
    const bb = perm[perm[xi + 1]! + yi + 1]!;
    const x1 = grad(aa, xf, yf) * (1 - u) + grad(ba, xf - 1, yf) * u;
    const x2 = grad(ab, xf, yf - 1) * (1 - u) + grad(bb, xf - 1, yf - 1) * u;
    return (x1 * (1 - v) + x2 * v) * 0.5 + 0.5; // 0..1
  };
}

/** Fractal brownian motion over any 0..1 noise function. */
export function fbm2(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves = 5,
  lacunarity = 2.03,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal — the classic recipe for mountain ridges. Returns 0..1
 * with sharp crests instead of the soft hills plain fBm produces.
 */
export function ridged2(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves = 5,
  lacunarity = 2.07,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise(x * freq, y * freq) * 2 - 1);
    n *= n;
    n *= weight;
    weight = Math.max(0, Math.min(1, n * 2));
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Domain-warped fBm: gives terrain natural, non-blobby shapes. */
export function warpedFbm(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  warp = 0.6,
  octaves = 5,
): number {
  const wx = fbm2(noise, x + 5.2, y + 1.3, 3) - 0.5;
  const wy = fbm2(noise, x + 9.7, y + 7.1, 3) - 0.5;
  return fbm2(noise, x + wx * warp, y + wy * warp, octaves);
}

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
