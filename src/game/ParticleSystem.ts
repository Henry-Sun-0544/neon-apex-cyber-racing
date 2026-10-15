import * as THREE from 'three';
import { CONFIG } from './Config';
import { createGlowTexture } from './CarModel';
import { clamp } from './Utils';

type PoolKind = 'sparks' | 'flames' | 'motes' | 'dust';

interface Pool {
  kind: PoolKind;
  count: number;
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  drag: number;
  gravity: number;
  /** Particle budget consumed in a round-robin fashion (object pooling). */
  cursor: number;
  live: number;
}

const PARTICLE_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;
  attribute float aAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    float a = tex.a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * tex.rgb, a);
  }
`;

/**
 * Single object-pooled particle system driving every effect in the game:
 * nitro flames, collision sparks, speed-pad motes and ambient city dust.
 *
 * All four pools share one shader program; buffers are allocated once and
 * recycled round-robin, so the game never allocates during a race.
 */
export class ParticleSystem {
  readonly group = new THREE.Group();
  private readonly pools: Record<PoolKind, Pool>;
  private readonly material: THREE.ShaderMaterial;
  private readonly glowTexture: THREE.CanvasTexture;
  private dustAccumulator = 0;
  private readonly tmp = new THREE.Vector3();

  constructor() {
    this.glowTexture = createGlowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.glowTexture } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    this.pools = {
      sparks: this.createPool('sparks', CONFIG.particles.maxSparks, 1.6, CONFIG.particles.gravity * 0.6),
      flames: this.createPool('flames', CONFIG.particles.maxFlames, 2.4, 4),
      motes: this.createPool('motes', CONFIG.particles.maxMotes, 1.3, -3),
      dust: this.createPool('dust', CONFIG.particles.maxDust, 0.35, 0.15),
    };
  }

  private createPool(kind: PoolKind, count: number, drag: number, gravity: number): Pool {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Park unused particles far below the world with zero size.
      positions[i * 3 + 1] = -9999;
      alphas[i] = 0;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    geometry.setDrawRange(0, count);
    const points = new THREE.Points(geometry, this.material);
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.group.add(points);
    return {
      kind,
      count,
      points,
      geometry,
      positions,
      colors,
      sizes,
      vel: new Float32Array(count * 3),
      life: new Float32Array(count),
      maxLife: new Float32Array(count),
      drag,
      gravity,
      cursor: 0,
      live: 0,
    };
  }

  /**
   * Spawns one particle from a pool (recycles the oldest slot when full).
   * Returns the slot index so callers can keep emitting from a stream.
   */
  private spawn(
    pool: Pool,
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    color: THREE.Color,
  ): number {
    const i = pool.cursor;
    pool.cursor = (pool.cursor + 1) % pool.count;
    pool.positions[i * 3] = px;
    pool.positions[i * 3 + 1] = py;
    pool.positions[i * 3 + 2] = pz;
    pool.vel[i * 3] = vx;
    pool.vel[i * 3 + 1] = vy;
    pool.vel[i * 3 + 2] = vz;
    pool.life[i] = life;
    pool.maxLife[i] = life;
    pool.sizes[i] = size;
    pool.colors[i * 3] = color.r;
    pool.colors[i * 3 + 1] = color.g;
    pool.colors[i * 3 + 2] = color.b;
    this.writeAlpha(pool, i, 1);
    return i;
  }

  private writeAlpha(pool: Pool, i: number, value: number): void {
    const attr = pool.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    attr.array[i] = value;
  }

  // ------------------------------------------------------------- emitters

  /** Collision sparks: hot cone along the surface normal. */
  emitSparks(point: THREE.Vector3Like, normal: THREE.Vector3Like, strength: number, count = 22): void {
    const pool = this.pools.sparks;
    const s = clamp(strength, 0.15, 1);
    const n = Math.round(count * (0.4 + s));
    for (let i = 0; i < n; i++) {
      const spread = 3.4;
      const vx = normal.x * (2 + Math.random() * 7 * s) + (Math.random() - 0.5) * spread;
      const vy = normal.y * (1 + Math.random() * 4 * s) + Math.random() * 4.5 * s;
      const vz = normal.z * (2 + Math.random() * 7 * s) + (Math.random() - 0.5) * spread;
      const color = new THREE.Color().setHSL(0.09 + Math.random() * 0.06, 1, 0.55 + Math.random() * 0.3);
      this.spawn(pool, point.x, point.y + 0.2, point.z, vx, vy, vz, 0.35 + Math.random() * 0.55, 0.22 + Math.random() * 0.2, color);
    }
  }

  /** Nitro / exhaust flame stream out of a nozzle. */
  emitFlame(point: THREE.Vector3, backward: THREE.Vector3, intensity: number, dt: number, accent: THREE.Color): void {
    const pool = this.pools.flames;
    const rate = 90 * intensity;
    const n = Math.max(1, Math.round(rate * dt));
    for (let i = 0; i < n; i++) {
      const jitter = 0.35;
      const vx = backward.x * (7 + Math.random() * 9 * intensity) + (Math.random() - 0.5) * jitter;
      const vy = backward.y * 3 + (Math.random() - 0.2) * 0.9;
      const vz = backward.z * (7 + Math.random() * 9 * intensity) + (Math.random() - 0.5) * jitter;
      const color = accent.clone().lerp(new THREE.Color(0xffffff), Math.random() * 0.45);
      this.spawn(
        pool,
        point.x + (Math.random() - 0.5) * 0.24,
        point.y + (Math.random() - 0.5) * 0.24,
        point.z + (Math.random() - 0.5) * 0.24,
        vx,
        vy,
        vz,
        0.16 + Math.random() * 0.26,
        0.34 + Math.random() * 0.6 * intensity,
        color,
      );
    }
  }

  /** Speed pad burst: motes rising in the pad's forward direction. */
  emitBoostBurst(point: THREE.Vector3, forward: THREE.Vector3, count = 46): void {
    const pool = this.pools.motes;
    for (let i = 0; i < count; i++) {
      const vx = forward.x * (4 + Math.random() * 14) + (Math.random() - 0.5) * 6;
      const vy = 2 + Math.random() * 9;
      const vz = forward.z * (4 + Math.random() * 14) + (Math.random() - 0.5) * 6;
      const color = new THREE.Color().setHSL(0.24 + Math.random() * 0.14, 1, 0.62);
      this.spawn(
        pool,
        point.x + (Math.random() - 0.5) * 7,
        point.y + 0.3,
        point.z + (Math.random() - 0.5) * 7,
        vx,
        vy,
        vz,
        0.7 + Math.random() * 0.8,
        0.38 + Math.random() * 0.5,
        color,
      );
    }
  }

  /** Continuous rise of light motes on speed pads (called every frame). */
  emitBoostIdle(point: THREE.Vector3, forward: THREE.Vector3, dt: number): void {
    if (Math.random() > dt * 26) return;
    const pool = this.pools.motes;
    const color = new THREE.Color().setHSL(0.26, 1, 0.6);
    this.spawn(
      pool,
      point.x + (Math.random() - 0.5) * 6,
      point.y + 0.25,
      point.z + (Math.random() - 0.5) * 6,
      forward.x * 1.5,
      1.6 + Math.random() * 2.4,
      forward.z * 1.5,
      0.6 + Math.random() * 0.7,
      0.3 + Math.random() * 0.35,
      color,
    );
  }

  /**
   * Ambient floating dust: emitted in a box around the camera and wrapped
   * when it drifts out, giving a cheap volumetric feel.
   */
  updateAmbientDust(dt: number, center: THREE.Vector3, moving: number): void {
    const pool = this.pools.dust;
    this.dustAccumulator += dt * (22 + moving * 30);
    const half = 60;
    const attr = pool.geometry.getAttribute('position') as THREE.BufferAttribute;
    while (this.dustAccumulator >= 1) {
      this.dustAccumulator -= 1;
      const color = new THREE.Color().setHSL(0.55 + Math.random() * 0.2, 0.7, 0.55 + Math.random() * 0.3);
      this.spawn(
        pool,
        center.x + (Math.random() - 0.5) * half * 2,
        center.y + (Math.random() - 0.3) * 26,
        center.z + (Math.random() - 0.5) * half * 2,
        (Math.random() - 0.5) * 1.4,
        Math.random() * 0.8,
        (Math.random() - 0.5) * 1.4,
        3.5 + Math.random() * 4,
        0.16 + Math.random() * 0.26,
        color,
      );
    }
    // Wrap dust around the travelling camera so the field follows the player.
    for (let i = 0; i < pool.count; i++) {
      if (pool.life[i]! <= 0) continue;
      const ix = i * 3;
      let x = pool.positions[ix]! - center.x;
      let y = pool.positions[ix + 1]! - center.y;
      let z = pool.positions[ix + 2]! - center.z;
      if (x > half) pool.positions[ix] = center.x - half;
      else if (x < -half) pool.positions[ix] = center.x + half;
      if (z > half) pool.positions[ix + 2] = center.z - half;
      else if (z < -half) pool.positions[ix + 2] = center.z + half;
      if (y > 30) pool.positions[ix + 1] = center.y - 22;
      else if (y < -22) pool.positions[ix + 1] = center.y + 28;
      attr.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- update

  update(dt: number): void {
    for (const key of Object.keys(this.pools) as PoolKind[]) {
      const pool = this.pools[key];
      const posAttr = pool.geometry.getAttribute('position') as THREE.BufferAttribute;
      const colAttr = pool.geometry.getAttribute('aColor') as THREE.BufferAttribute;
      const sizeAttr = pool.geometry.getAttribute('aSize') as THREE.BufferAttribute;
      const alphaAttr = pool.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
      const damping = Math.exp(-pool.drag * dt);

      let liveCount = 0;
      for (let i = 0; i < pool.count; i++) {
        if (pool.life[i]! <= 0) {
          if (alphaAttr.array[i]! !== 0) {
            alphaAttr.array[i] = 0;
            sizeAttr.array[i] = 0;
          }
          continue;
        }
        liveCount++;
        const ix = i * 3;
        pool.life[i] = pool.life[i]! - dt;
        if (pool.life[i]! <= 0) {
          alphaAttr.array[i] = 0;
          sizeAttr.array[i] = 0;
          pool.positions[ix + 1] = -9999;
          continue;
        }
        pool.vel[ix] = pool.vel[ix]! * damping;
        pool.vel[ix + 1] = pool.vel[ix + 1]! * damping + pool.gravity * dt;
        pool.vel[ix + 2] = pool.vel[ix + 2]! * damping;
        pool.positions[ix] = pool.positions[ix]! + pool.vel[ix]! * dt;
        pool.positions[ix + 1] = pool.positions[ix + 1]! + pool.vel[ix + 1]! * dt;
        pool.positions[ix + 2] = pool.positions[ix + 2]! + pool.vel[ix + 2]! * dt;

        const t = pool.life[i]! / pool.maxLife[i]!;
        alphaAttr.array[i] = Math.min(1, t * 1.6);
        // Flames shrink as they die, sparks stay crisp, dust fades slowly.
        if (key === 'flames') sizeAttr.array[i] = pool.sizes[i]! * (0.35 + t * 0.8);
        else if (key === 'dust') sizeAttr.array[i] = pool.sizes[i]! * (0.6 + t * 0.4);
        else sizeAttr.array[i] = pool.sizes[i]!;
      }
      pool.live = liveCount;
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
    }
    void this.tmp;
  }

  /** Kill every particle (used on race restart). */
  reset(): void {
    for (const key of Object.keys(this.pools) as PoolKind[]) {
      const pool = this.pools[key];
      pool.life.fill(0);
      const alphaAttr = pool.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
      const sizeAttr = pool.geometry.getAttribute('aSize') as THREE.BufferAttribute;
      (alphaAttr.array as Float32Array).fill(0);
      (sizeAttr.array as Float32Array).fill(0);
      alphaAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      for (let i = 0; i < pool.count; i++) pool.positions[i * 3 + 1] = -9999;
      pool.cursor = 0;
    }
  }

  /** Total live particle count (debug / HUD). */
  get liveCount(): number {
    let total = 0;
    for (const key of Object.keys(this.pools) as PoolKind[]) total += this.pools[key].live;
    return total;
  }
}
