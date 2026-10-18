import * as THREE from 'three';
import type { QualityManager } from './QualityManager';

/**
 * Procedural PBR material library.
 *
 * Everything here is generated on a 2D canvas at boot / on first use: asphalt
 * with puddles and tyre polish, concrete, glass, brushed metal, car paint with
 * a clear-coat flake layer, tyre tread, water normals, cloud alpha and the
 * terrain detail set. Nothing is loaded from disk, so the build stays assetless
 * (design brief: no external models / textures / audio).
 *
 * The library is also the single place that knows how to *re-theme* the
 * Round 1 meshes: `applyTheme()` walks the existing circuit/city graph and
 * transforms every material in place (cached so the cyberpunk look can be
 * restored exactly). That is what makes a runtime style switch cheap: no
 * geometry is rebuilt, only materials are swapped.
 */

export type StyleThemeId = 'cyberpunk' | 'realistic';

export interface PbrBundle {
  map: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  aoMap: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
}

// ------------------------------------------------------------------ helpers

/** Tiny deterministic PRNG so a texture looks the same on every boot. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** 2D value noise sampled on a wrap-friendly lattice. */
function makeValueNoise(seed: number): (x: number, y: number) => number {
  const rand = rng(seed);
  const size = 256;
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (x: number, y: number): number => grid[(y & 255) * size + (x & 255)]!;
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

/** Fractal brownian motion over the value noise. */
function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves = 4, lac = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/** Converts a grayscale height canvas into a tangent-space normal map. */
function heightToNormal(source: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const src = source.getContext('2d')!.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const lum = (x: number, y: number): number => {
    const ix = ((y + h) % h) * w + ((x + w) % w);
    return src[ix * 4]! / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * w + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len) * 0.5 * 255 + 127;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function canvas(size: number, height = size): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  return { c, ctx: c.getContext('2d')! };
}

/** Wraps a canvas in a repeating texture honouring the quality anisotropy. */
function texture(
  c: HTMLCanvasElement,
  opts: { srgb?: boolean; repeat?: [number, number]; anisotropy?: number; linear?: boolean } = {},
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  tex.anisotropy = opts.anisotropy ?? 4;
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (!opts.linear) {
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
  }
  tex.needsUpdate = true;
  return tex;
}

// -------------------------------------------------------------- the library

export class MaterialLibrary {
  private cache = new Map<string, unknown>();
  private textures: THREE.Texture[] = [];
  private materials: THREE.Material[] = [];
  private size: number;
  private aniso: number;
  /** True while the realistic theme is applied to the Round 1 graphs. */
  private themed = false;

  constructor(private quality: QualityManager) {
    this.size = this.pickSize();
    this.aniso = quality.settings.anisotropy;
  }

  private pickSize(): number {
    return Math.max(128, Math.min(1024, this.quality.settings.textureSize));
  }

  /** Re-reads the quality budget; call after a preset change. */
  refresh(): void {
    this.size = this.pickSize();
    this.aniso = this.quality.settings.anisotropy;
  }

  private memo<T>(key: string, factory: () => T): T {
    const hit = this.cache.get(key);
    if (hit) return hit as T;
    const value = factory();
    this.cache.set(key, value);
    return value;
  }

  private keep<T extends THREE.Texture>(tex: T): T {
    this.textures.push(tex);
    return tex;
  }

  private keepMat<T extends THREE.Material>(mat: T): T {
    // Library materials are shared between many meshes (all cars share one tyre
    // material, for instance), so disposal must never take them down with a
    // single mesh. `disposeCarModel` checks this flag.
    mat.userData.__shared = true;
    this.materials.push(mat);
    return mat;
  }

  // ------------------------------------------------------------ generators

  /** Weather-worn asphalt: aggregate speckle, patches, cracks, polished wheel tracks, puddles. */
  asphalt(): PbrBundle {
    return this.memo('asphalt', () => {
      const s = this.size;
      const noise = makeValueNoise(4711);
      const { c, ctx } = canvas(s);
      const img = ctx.createImageData(s, s);
      const height = canvas(s);
      const hImg = height.ctx.createImageData(s, s);
      const rough = canvas(s);
      const rImg = rough.ctx.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const u = (x / s) * 8;
          const v = (y / s) * 8;
          const grain = fbm(noise, u * 6, v * 6, 4);
          const patch = fbm(noise, u * 1.2 + 30, v * 1.2 + 12, 3);
          const base = 26 + grain * 30 + patch * 24;
          const i = (y * s + x) * 4;
          img.data[i] = base * 0.94;
          img.data[i + 1] = base * 0.96;
          img.data[i + 2] = base * 1.04;
          img.data[i + 3] = 255;
          const hh = grain * 190 + patch * 40;
          hImg.data[i] = hh;
          hImg.data[i + 1] = hh;
          hImg.data[i + 2] = hh;
          hImg.data[i + 3] = 255;
          // Wheel tracks dry/polish faster than the crown of the road.
          const track = Math.exp(-Math.pow((x / s - 0.5) * 7, 2));
          const wet = 0.42 + track * 0.24 + fbm(noise, u * 2 + 70, v * 2 + 5, 3) * 0.3;
          const rr = Math.max(0, Math.min(1, wet)) * 255;
          rImg.data[i] = rr;
          rImg.data[i + 1] = rr;
          rImg.data[i + 2] = rr;
          rImg.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      height.ctx.putImageData(hImg, 0, 0);
      rough.ctx.putImageData(rImg, 0, 0);

      // Cracks.
      const rand = rng(99);
      ctx.strokeStyle = 'rgba(8,8,10,0.85)';
      for (let k = 0; k < Math.round(s / 22); k++) {
        ctx.lineWidth = 1 + rand() * 1.6;
        let x = rand() * s;
        let y = rand() * s;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let seg = 0; seg < 5; seg++) {
          x += (rand() - 0.5) * s * 0.12;
          y += (rand() - 0.5) * s * 0.12;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // Standing water: darker, smoother blobs.
      for (let k = 0; k < Math.round(s / 12); k++) {
        const px = rand() * s;
        const py = rand() * s;
        const r = s * (0.02 + rand() * 0.075);
        const g = ctx.createRadialGradient(px, py, 0, px, py, r);
        g.addColorStop(0, 'rgba(12,16,24,0.85)');
        g.addColorStop(0.7, 'rgba(16,20,28,0.45)');
        g.addColorStop(1, 'rgba(20,24,32,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        const rg = rough.ctx.createRadialGradient(px, py, 0, px, py, r);
        rg.addColorStop(0, 'rgba(10,10,10,0.95)');
        rg.addColorStop(1, 'rgba(10,10,10,0)');
        rough.ctx.fillStyle = rg;
        rough.ctx.beginPath();
        rough.ctx.arc(px, py, r, 0, Math.PI * 2);
        rough.ctx.fill();
      }

      return {
        map: this.keep(texture(c, { srgb: true, anisotropy: this.aniso })),
        roughnessMap: this.keep(texture(rough.c, { srgb: false, anisotropy: this.aniso })),
        normalMap: this.keep(texture(heightToNormal(height.c, 2.4), { srgb: false, anisotropy: this.aniso })),
        metalnessMap: null,
        aoMap: null,
        emissiveMap: null,
      };
    });
  }

  /** Concrete / pavement slab with expansion joints. */
  concrete(): PbrBundle {
    return this.memo('concrete', () => {
      const s = this.size;
      const noise = makeValueNoise(8123);
      const { c, ctx } = canvas(s);
      const height = canvas(s);
      const img = ctx.createImageData(s, s);
      const hImg = height.ctx.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const n = fbm(noise, (x / s) * 10, (y / s) * 10, 4);
          const stain = fbm(noise, (x / s) * 2 + 40, (y / s) * 2 + 9, 3);
          const base = 118 + n * 40 - stain * 30;
          const i = (y * s + x) * 4;
          img.data[i] = base;
          img.data[i + 1] = base * 0.99;
          img.data[i + 2] = base * 0.95;
          img.data[i + 3] = 255;
          const hh = n * 200;
          hImg.data[i] = hh;
          hImg.data[i + 1] = hh;
          hImg.data[i + 2] = hh;
          hImg.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      height.ctx.putImageData(hImg, 0, 0);
      // Joints.
      const cells = 4;
      const step = s / cells;
      ctx.strokeStyle = 'rgba(60,60,62,0.9)';
      ctx.lineWidth = Math.max(1, s / 256);
      for (let i = 0; i <= cells; i++) {
        ctx.beginPath();
        ctx.moveTo(i * step, 0);
        ctx.lineTo(i * step, s);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * step);
        ctx.lineTo(s, i * step);
        ctx.stroke();
      }
      return {
        map: this.keep(texture(c, { srgb: true, anisotropy: this.aniso })),
        roughnessMap: null,
        normalMap: this.keep(texture(heightToNormal(height.c, 1.6), { srgb: false, anisotropy: this.aniso })),
        metalnessMap: null,
        aoMap: null,
        emissiveMap: null,
      };
    });
  }

  /** Realistic building facade: window grid with an emissive "lights on" mask. */
  facade(): { map: THREE.Texture; emissiveMap: THREE.Texture; normalMap: THREE.Texture } {
    return this.memo('facade', () => {
      const s = this.size;
      const { c, ctx } = canvas(s);
      const em = canvas(s);
      const height = canvas(s);
      ctx.fillStyle = '#8e8b84';
      ctx.fillRect(0, 0, s, s);
      height.ctx.fillStyle = '#b4b4b4';
      height.ctx.fillRect(0, 0, s, s);
      em.ctx.fillStyle = '#000000';
      em.ctx.fillRect(0, 0, s, s);
      const cols = 10;
      const rows = 14;
      const cw = s / cols;
      const ch = s / rows;
      const rand = rng(5150);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const px = x * cw + cw * 0.16;
          const py = y * ch + ch * 0.18;
          const w = cw * 0.68;
          const h = ch * 0.5;
          // Recessed window: darker in albedo, lower in height.
          const shade = 40 + rand() * 26;
          ctx.fillStyle = `rgb(${shade},${shade + 4},${shade + 10})`;
          ctx.fillRect(px, py, w, h);
          height.ctx.fillStyle = '#3a3a3a';
          height.ctx.fillRect(px, py, w, h);
          // Sill.
          ctx.fillStyle = 'rgba(255,255,255,0.16)';
          ctx.fillRect(px, py + h, w, Math.max(1, ch * 0.05));
          if (rand() < 0.45) {
            const warm = 150 + rand() * 105;
            em.ctx.fillStyle = `rgb(${Math.round(warm)},${Math.round(warm * 0.82)},${Math.round(warm * 0.58)})`;
            em.ctx.fillRect(px, py, w, h);
          }
        }
      }
      // Vertical concrete piers.
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      for (let x = 0; x <= cols; x++) ctx.fillRect(x * cw - cw * 0.05, 0, cw * 0.1, s);
      return {
        map: this.keep(texture(c, { srgb: true, repeat: [1, 1], anisotropy: this.aniso })),
        emissiveMap: this.keep(texture(em.c, { srgb: true, anisotropy: this.aniso })),
        normalMap: this.keep(texture(heightToNormal(height.c, 2.2), { srgb: false, anisotropy: this.aniso })),
      };
    });
  }

  /** Brushed / painted metal used for guard rails, poles and bridge steel. */
  metal(): PbrBundle {
    return this.memo('metal', () => {
      const s = Math.min(this.size, 512);
      const noise = makeValueNoise(2024);
      const { c, ctx } = canvas(s);
      const rough = canvas(s);
      const img = ctx.createImageData(s, s);
      const rImg = rough.ctx.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const n = fbm(noise, x / s * 3, y / s * 40, 3);
          const base = 150 + n * 60;
          const i = (y * s + x) * 4;
          img.data[i] = base;
          img.data[i + 1] = base;
          img.data[i + 2] = base * 1.03;
          img.data[i + 3] = 255;
          const rr = 70 + n * 90;
          rImg.data[i] = rr;
          rImg.data[i + 1] = rr;
          rImg.data[i + 2] = rr;
          rImg.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      rough.ctx.putImageData(rImg, 0, 0);
      return {
        map: this.keep(texture(c, { srgb: true, anisotropy: this.aniso })),
        roughnessMap: this.keep(texture(rough.c, { srgb: false, anisotropy: this.aniso })),
        normalMap: null,
        metalnessMap: null,
        aoMap: null,
        emissiveMap: null,
      };
    });
  }

  /** Terrain detail: neutral albedo with a strong normal + roughness break-up. */
  terrainDetail(): { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture } {
    return this.memo('terrain', () => {
      const s = this.size;
      const noise = makeValueNoise(777);
      const { c, ctx } = canvas(s);
      const height = canvas(s);
      const rough = canvas(s);
      const img = ctx.createImageData(s, s);
      const hImg = height.ctx.createImageData(s, s);
      const rImg = rough.ctx.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const n = fbm(noise, (x / s) * 14, (y / s) * 14, 5);
          const m = fbm(noise, (x / s) * 45 + 8, (y / s) * 45 + 3, 3);
          const v = 165 + n * 70 + m * 20;
          const i = (y * s + x) * 4;
          img.data[i] = v;
          img.data[i + 1] = v;
          img.data[i + 2] = v;
          img.data[i + 3] = 255;
          const hh = n * 210 + m * 45;
          hImg.data[i] = hh;
          hImg.data[i + 1] = hh;
          hImg.data[i + 2] = hh;
          hImg.data[i + 3] = 255;
          const rr = 150 + n * 90;
          rImg.data[i] = rr;
          rImg.data[i + 1] = rr;
          rImg.data[i + 2] = rr;
          rImg.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      height.ctx.putImageData(hImg, 0, 0);
      rough.ctx.putImageData(rImg, 0, 0);
      return {
        map: this.keep(texture(c, { srgb: true, anisotropy: this.aniso })),
        normalMap: this.keep(texture(heightToNormal(height.c, 3.0), { srgb: false, anisotropy: this.aniso })),
        roughnessMap: this.keep(texture(rough.c, { srgb: false, anisotropy: this.aniso })),
      };
    });
  }

  /** Tyre tread with circumferential grooves + shoulder blocks. */
  tyre(): { map: THREE.Texture; normalMap: THREE.Texture } {
    return this.memo('tyre', () => {
      const s = Math.min(this.size, 512);
      const { c, ctx } = canvas(s);
      const height = canvas(s);
      ctx.fillStyle = '#131316';
      ctx.fillRect(0, 0, s, s);
      height.ctx.fillStyle = '#e0e0e0';
      height.ctx.fillRect(0, 0, s, s);
      const rand = rng(31337);
      // Longitudinal grooves.
      for (const u of [0.22, 0.46, 0.7]) {
        ctx.fillStyle = '#050506';
        ctx.fillRect(u * s, 0, s * 0.055, s);
        height.ctx.fillStyle = '#101010';
        height.ctx.fillRect(u * s, 0, s * 0.055, s);
      }
      // Diagonal tread blocks.
      ctx.fillStyle = 'rgba(5,5,6,0.85)';
      height.ctx.fillStyle = '#1a1a1a';
      for (let i = -s; i < s * 2; i += s * 0.11) {
        ctx.save();
        ctx.translate(i, 0);
        ctx.rotate(0.32);
        ctx.fillRect(0, -s, s * 0.03, s * 3);
        ctx.restore();
        height.ctx.save();
        height.ctx.translate(i, 0);
        height.ctx.rotate(0.32);
        height.ctx.fillRect(0, -s, s * 0.03, s * 3);
        height.ctx.restore();
      }
      // Rubber speckle.
      for (let i = 0; i < s * 6; i++) {
        const g = 20 + rand() * 26;
        ctx.fillStyle = `rgba(${g},${g},${g + 2},0.5)`;
        ctx.fillRect(rand() * s, rand() * s, 1.4, 1.4);
      }
      return {
        map: this.keep(texture(c, { srgb: true, repeat: [1, 1], anisotropy: this.aniso })),
        normalMap: this.keep(texture(heightToNormal(height.c, 2.6), { srgb: false, anisotropy: this.aniso })),
      };
    });
  }

  /** Animated water normal map (two scrolling layers are done in the shader). */
  waterNormal(): THREE.Texture {
    return this.memo('water', () => {
      const s = Math.min(this.size, 512);
      const noise = makeValueNoise(606);
      const height = canvas(s);
      const img = height.ctx.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const n = fbm(noise, (x / s) * 6, (y / s) * 6, 4);
          const i = (y * s + x) * 4;
          const v = n * 255;
          img.data[i] = v;
          img.data[i + 1] = v;
          img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
      }
      height.ctx.putImageData(img, 0, 0);
      return this.keep(texture(heightToNormal(height.c, 1.2), { srgb: false, anisotropy: this.aniso }));
    });
  }

  /** Alpha-only soft cloud puff used by the sky cloud layer. */
  cloudAlpha(): THREE.Texture {
    return this.memo('cloud', () => {
      const s = 512;
      const noise = makeValueNoise(1212);
      const { c, ctx } = canvas(s, s / 2);
      const img = ctx.createImageData(s, s / 2);
      for (let y = 0; y < s / 2; y++) {
        for (let x = 0; x < s; x++) {
          const n = fbm(noise, (x / s) * 5, (y / (s / 2)) * 3, 5);
          const a = Math.max(0, Math.min(1, (n - 0.42) * 3.2));
          const i = (y * s + x) * 4;
          img.data[i] = 255;
          img.data[i + 1] = 255;
          img.data[i + 2] = 255;
          img.data[i + 3] = a * 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      const tex = this.keep(texture(c, { srgb: true, anisotropy: this.aniso }));
      tex.wrapT = THREE.ClampToEdgeWrapping;
      return tex;
    });
  }

  /** Vertical rain streak sprite. */
  rainStreak(): THREE.Texture {
    return this.memo('rain', () => {
      const { c, ctx } = canvas(32, 128);
      const g = ctx.createLinearGradient(0, 0, 0, 128);
      g.addColorStop(0, 'rgba(210,232,255,0)');
      g.addColorStop(0.35, 'rgba(210,232,255,0.85)');
      g.addColorStop(1, 'rgba(210,232,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(12, 0, 8, 128);
      return this.keep(texture(c, { srgb: true, anisotropy: 1 }));
    });
  }

  /** Soft round sprite (snow / dust / smoke). */
  softDot(): THREE.Texture {
    return this.memo('softdot', () => {
      const { c, ctx } = canvas(64);
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      return this.keep(texture(c, { srgb: true, anisotropy: 1 }));
    });
  }

  // ------------------------------------------------------- material makers

  /** Wet, sun-baked asphalt for the realistic road surface. */
  asphaltMaterial(wet = 0.55): THREE.MeshStandardMaterial {
    const b = this.asphalt();
    const mat = new THREE.MeshStandardMaterial({
      map: b.map,
      normalMap: b.normalMap,
      roughnessMap: b.roughnessMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      color: 0xb9bcc2,
      roughness: 1,
      metalness: 0.04,
      envMapIntensity: 0.85,
      dithering: true,
    });
    mat.userData.wet = wet;
    return this.keepMat(mat);
  }

  /** Concrete for pavements, piers, tunnels and bridge parapets. */
  concreteMaterial(color = 0x9b9b96): THREE.MeshStandardMaterial {
    const b = this.concrete();
    return this.keepMat(
      new THREE.MeshStandardMaterial({
        map: b.map,
        normalMap: b.normalMap,
        normalScale: new THREE.Vector2(0.6, 0.6),
        color,
        roughness: 0.92,
        metalness: 0.03,
        envMapIntensity: 0.9,
      }),
    );
  }

  metalMaterial(color = 0xb6bac4, roughness = 0.42): THREE.MeshStandardMaterial {
    const b = this.metal();
    return this.keepMat(
      new THREE.MeshStandardMaterial({
        map: b.map,
        roughnessMap: b.roughnessMap,
        color,
        metalness: 0.94,
        roughness,
        envMapIntensity: 1.15,
      }),
    );
  }

  /** Car paint: physical material with a clear coat + procedural flake normal. */
  carPaint(color: number): THREE.MeshPhysicalMaterial {
    const b = this.metal();
    const mat = new THREE.MeshPhysicalMaterial({
      color,
      metalness: 0.62,
      roughness: 0.26,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      normalMap: b.normalMap,
      envMapIntensity: 1.25,
      sheen: 0.3,
      sheenColor: new THREE.Color(0x222226),
    });
    return this.keepMat(mat);
  }

  glassMaterial(tint = 0x0a0f16): THREE.MeshPhysicalMaterial {
    return this.keepMat(
      new THREE.MeshPhysicalMaterial({
        color: tint,
        metalness: 0.1,
        roughness: 0.05,
        transmission: 0.55,
        thickness: 0.35,
        transparent: true,
        opacity: 0.62,
        ior: 1.45,
        envMapIntensity: 1.4,
        side: THREE.DoubleSide,
      }),
    );
  }

  tyreMaterial(): THREE.MeshStandardMaterial {
    const t = this.tyre();
    return this.keepMat(
      new THREE.MeshStandardMaterial({
        map: t.map,
        normalMap: t.normalMap,
        normalScale: new THREE.Vector2(1.1, 1.1),
        color: 0x232328,
        roughness: 0.94,
        metalness: 0.02,
      }),
    );
  }

  /** Building shell for the realistic city. */
  facadeMaterial(tint = 0xffffff): THREE.MeshStandardMaterial {
    const f = this.facade();
    return this.keepMat(
      new THREE.MeshStandardMaterial({
        map: f.map,
        emissiveMap: f.emissiveMap,
        normalMap: f.normalMap,
        normalScale: new THREE.Vector2(0.55, 0.55),
        color: tint,
        emissive: new THREE.Color(0xffd7a3),
        emissiveIntensity: 0.0,
        roughness: 0.78,
        metalness: 0.08,
        envMapIntensity: 0.8,
      }),
    );
  }

  /** Emissive-only material (lamp lenses, signs, brake lights). */
  emissiveMaterial(color: number): THREE.MeshBasicMaterial {
    return this.keepMat(new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  }

  // ----------------------------------------------------------- re-theming

  /** Names that the theme pass treats as cyberpunk-only neon furniture. */
  private static readonly NEON_NAMES = new Set(['neon-strip', 'holo', 'neon-pylon', 'neon-sign']);

  /**
   * Meshes whose material is *swapped* for a realistic PBR surface (and restored
   * on the way back). `road` and `ground` are the Round 1 big surfaces; the
   * tower shells carry a neon window texture that has no place in daylight.
   */
  private static readonly SURFACE_SWAPS = new Set(['road', 'ground', 'city-tower', 'city-crown']);

  /**
   * Applies a theme to an existing object graph (the Round 1 circuit + city).
   *
   * The first call caches each material's original properties in
   * `userData.__nacrBase`, so alternating themes is lossless and cheap — no
   * geometry is rebuilt and no gameplay state is touched.
   *
   * Rules
   *  - `road` / `ground` swap to real PBR surfaces (cached original restored).
   *  - Cyberpunk neon furniture (`neon-strip` / `holo` / `neon-pylon`) is hidden
   *    in realistic mode: unlit neon strips look like rendering errors in
   *    daylight.
   *  - Boost pads keep their full additive punch in both themes (gameplay cue).
   *  - Every MeshStandardMaterial is desaturated and de-emissived, and city
   *    point lights are dimmed to a realistic level.
   */
  applyTheme(root: THREE.Object3D, theme: StyleThemeId): void {
    const realistic = theme === 'realistic';
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (MaterialLibrary.NEON_NAMES.has(mesh.name)) {
        mesh.visible = !realistic;
        return;
      }
      if (MaterialLibrary.SURFACE_SWAPS.has(mesh.name)) {
        const original = mesh.userData.__nacrMat as THREE.Material | THREE.Material[] | undefined;
        if (!original) mesh.userData.__nacrMat = mesh.material;
        if (realistic) {
          mesh.material = this.retainedSurface(mesh.name);
        } else if (original) {
          mesh.material = original;
        }
        return;
      }
      // The gate is a Group: its posts/bar are unnamed child meshes.
      const parentName = mesh.parent?.name ?? '';
      if (mesh.name === 'checkpoint-gate' || parentName === 'checkpoint-gate') {
        // Race furniture stays visible in both styles, but a neon gate reads as
        // a track marshal gantry in daylight — so desaturate it much harder
        // than the generic furniture (0.62 leaves it visibly pink).
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) this.themeMaterial(m, realistic, true, realistic ? 0.9 : 0.62);
        return;
      }
      const isBoostPad = mesh.name === 'boost-pad';
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m) continue;
        this.themeMaterial(m, realistic, isBoostPad);
      }
    });
    root.traverse((obj) => {
      const light = obj as THREE.PointLight;
      if (!light.isPointLight) return;
      const base = light.userData.__nacrBaseIntensity as number | undefined;
      if (base === undefined) light.userData.__nacrBaseIntensity = light.intensity;
      const reference = (light.userData.__nacrBaseIntensity as number) ?? light.intensity;
      light.intensity = realistic ? reference * 0.1 : reference;
    });
    this.themed = realistic;
  }

  /** PBR surface retained per mesh name so repeated switches reuse one material. */
  private readonly retainedSurfaces = new Map<string, THREE.Material>();

  private retainedSurface(name: string): THREE.Material {
    const hit = this.retainedSurfaces.get(name);
    if (hit) return hit;
    let mat: THREE.Material;
    if (name === 'city-tower') {
      // A real concrete/glass facade with warm "lights on" windows.
      const facade = this.facade();
      mat = this.keepMat(
        new THREE.MeshStandardMaterial({
          map: facade.map,
          emissiveMap: facade.emissiveMap,
          normalMap: facade.normalMap,
          normalScale: new THREE.Vector2(0.5, 0.5),
          color: 0xd6d2c9,
          emissive: new THREE.Color(0xffd2a0),
          emissiveIntensity: 0.25,
          roughness: 0.82,
          metalness: 0.06,
          envMapIntensity: 0.7,
        }),
      );
      const repeats = Math.max(1, Math.round(26 / 8));
      const map = (mat as THREE.MeshStandardMaterial).map;
      if (map) map.repeat.set(repeats, repeats);
      const uvScale = (mat as THREE.MeshStandardMaterial).emissiveMap;
      if (uvScale) uvScale.repeat.set(repeats, repeats);
      this.retainedSurfaces.set(name, mat);
      return mat;
    }
    if (name === 'city-crown') {
      const crown = this.concreteMaterial(0x8e8a82);
      this.retainedSurfaces.set(name, crown);
      return crown;
    }
    if (name === 'road') {
      // The ribbon's own UVs already run 0..1 across the width and repeat every
      // 26 m along the length, so no texture repeat override is needed.
      mat = this.asphaltMaterial();
    } else {
      // The city floor is a single 2.6 km quad: tile the detail set hard.
      const detail = this.terrainDetail();
      const tile = (tex: THREE.Texture | null, times: number): THREE.Texture | null => {
        if (!tex) return null;
        const clone = tex.clone();
        clone.wrapS = THREE.RepeatWrapping;
        clone.wrapT = THREE.RepeatWrapping;
        clone.repeat.set(times, times);
        clone.needsUpdate = true;
        this.textures.push(clone);
        return clone;
      };
      mat = this.keepMat(
        new THREE.MeshStandardMaterial({
          map: tile(detail.map, 190),
          normalMap: tile(detail.normalMap, 190),
          roughnessMap: tile(detail.roughnessMap, 190),
          color: 0x6f6d66,
          roughness: 0.95,
          metalness: 0.02,
          envMapIntensity: 0.7,
        }),
      );
    }
    this.retainedSurfaces.set(name, mat);
    return mat;
  }

  get isRealisticTheme(): boolean {
    return this.themed;
  }

  private themeMaterial(m: THREE.Material, realistic: boolean, isBoostPad = false, desatStrength = 0.62): void {
    interface Base {
      color?: number;
      emissive?: number;
      emissiveIntensity?: number;
      roughness?: number;
      metalness?: number;
      envMapIntensity?: number;
      opacity?: number;
      toneMapped?: boolean;
    }
    let base = m.userData.__nacrBase as Base | undefined;
    if (!base) {
      const any = m as THREE.MeshStandardMaterial & THREE.MeshBasicMaterial;
      base = {
        color: any.color ? any.color.getHex() : undefined,
        emissive: any.emissive ? any.emissive.getHex() : undefined,
        emissiveIntensity: any.emissiveIntensity,
        roughness: any.roughness,
        metalness: any.metalness,
        envMapIntensity: any.envMapIntensity,
        opacity: any.opacity,
        toneMapped: any.toneMapped,
      };
      m.userData.__nacrBase = base;
      m.userData.__nacrWasAdditive = m.blending === THREE.AdditiveBlending;
    }
    const any = m as THREE.MeshStandardMaterial & THREE.MeshBasicMaterial;
    const wasAdditive = m.userData.__nacrWasAdditive === true;

    if (!realistic) {
      // ------------------------------------------------ restore cyberpunk
      if (base.color !== undefined && any.color) any.color.setHex(base.color);
      if (base.emissive !== undefined && any.emissive) any.emissive.setHex(base.emissive);
      if (base.emissiveIntensity !== undefined) any.emissiveIntensity = base.emissiveIntensity;
      if (base.roughness !== undefined) any.roughness = base.roughness;
      if (base.metalness !== undefined) any.metalness = base.metalness;
      if (base.envMapIntensity !== undefined) any.envMapIntensity = base.envMapIntensity;
      if (base.opacity !== undefined) any.opacity = base.opacity;
      if (base.toneMapped !== undefined) any.toneMapped = base.toneMapped;
      m.needsUpdate = true;
      return;
    }

    // ---------------------------------------------------- realistic grade
    if (isBoostPad) {
      // Boost pads stay a gameplay cue in daylight, but neon magenta run
      // through the desaturator below reads as a washed-out pink error slab.
      // Repaint them as amber road markings at full strength instead.
      if (any.color) any.color.setHex(0xe8a34d);
      if (any.emissive) any.emissive.setHex(0xffb45e);
      if (base.emissiveIntensity !== undefined && any.emissiveIntensity !== undefined) {
        any.emissiveIntensity = Math.max(0.55, base.emissiveIntensity * 0.6);
      }
      if (any.opacity !== undefined) any.opacity = Math.max(0.75, base.opacity ?? 1);
      m.needsUpdate = true;
      return;
    }
    if (any.color) {
      const c = new THREE.Color(base.color ?? 0xffffff);
      const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      // Desaturate towards luminance and lift out of the neon palette.
      c.lerp(new THREE.Color(l, l, l), desatStrength);
      c.multiplyScalar(1.06);
      any.color.copy(c);
    }
    if (any.emissive) {
      const e = new THREE.Color(base.emissive ?? 0x000000);
      const baseGlow = 0.2126 * e.r + 0.7152 * e.g + 0.0722 * e.b;
      if (baseGlow > 0.02) {
        // A genuinely emissive neon surface: warm it up (city window glow) but
        // keep only a whisper of intensity — a full-strength glow turns road
        // skirts and pillars into luminous orange walls in daylight.
        e.lerp(new THREE.Color(0xffd9a8), Math.max(0.7, desatStrength));
        any.emissive.copy(e);
        if (base.emissiveIntensity !== undefined && any.emissiveIntensity !== undefined) {
          any.emissiveIntensity = Math.min(base.emissiveIntensity * 0.35, 0.3);
        }
      }
      // Base emissive black: leave it black. The old code lent every material
      // 0.7 × warm emissive, making even the checkered start line glow.
    }
    if (base.roughness !== undefined && any.roughness !== undefined) {
      any.roughness = Math.min(1, base.roughness * 0.85 + 0.12);
    }
    if (base.metalness !== undefined && any.metalness !== undefined) {
      any.metalness = base.metalness * 0.72;
    }
    if (any.envMapIntensity !== undefined) any.envMapIntensity = Math.max(1, base.envMapIntensity ?? 1);
    if (wasAdditive && any.opacity !== undefined && !isBoostPad) {
      any.opacity = Math.max(0.05, (base.opacity ?? 1) * 0.15);
    }
    m.needsUpdate = true;
  }

  dispose(): void {
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
    for (const m of this.retainedSurfaces.values()) m.dispose();
    this.retainedSurfaces.clear();
    this.textures = [];
    this.materials = [];
    this.cache.clear();
  }
}
