import * as THREE from 'three';
import type { MaterialLibrary } from '../MaterialLibrary';
import type { QualityManager } from '../QualityManager';
import { CONFIG } from '../Config';
import { BiomeSystem, TERRAIN_SHAPE } from './BiomeSystem';
import { fbm2, makeNoise2D, mix, ridged2, smoothstep, warpedFbm } from './Noise';

/** A road surface probe used to cut the roads into the terrain. */
export interface CorridorProvider {
  /**
   * Nearest road information at a world XZ position.
   * `y` is the road surface height, `distance` the lateral distance to the
   * centre line, `tunnel` true inside a tunnel (where the terrain is NOT cut).
   */
  corridorAt(x: number, z: number): { distance: number; y: number; tunnel: boolean } | null;
}

/** One resident terrain chunk. */
interface Chunk {
  key: string;
  mesh: THREE.Mesh;
  scatter: THREE.Group;
  /** Chunk centre, used for distance culling. */
  cx: number;
  cz: number;
}

const CHUNK_KEY = (ix: number, iz: number): string => `${ix},${iz}`;

/**
 * Streaming height-field terrain.
 *
 * The height field is a pure function of world position (logical resolution
 * 1024x1024 as specified by the brief — it is evaluated on demand rather than
 * stored), and it is *cut by the roads*: every vertex inside a road corridor is
 * blended towards the road surface, with a shoulder transition, so bridges and
 * cuts appear automatically wherever the network runs.
 *
 * Only the chunks around the camera are meshed, which keeps a 4.8 km island at a
 * few hundred thousand triangles instead of tens of millions.
 */
export class TerrainSystem {
  readonly group = new THREE.Group();
  /** Ocean surface (animated normals + environment reflection, no extra pass). */
  private ocean: THREE.Mesh | null = null;

  private readonly chunks = new Map<string, Chunk>();
  private readonly heightNoise = makeNoise2D(913377);
  private readonly ridgeNoise = makeNoise2D(5150);
  private readonly coastNoise = makeNoise2D(31337);
  private readonly urbanNoise = makeNoise2D(6060);
  private readonly material: THREE.MeshStandardMaterial;
  private readonly waterMaterial: THREE.MeshStandardMaterial;
  private readonly detailMaps: { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture };
  private readonly chunkSize: number;
  private readonly segments: number;
  private readonly viewDistance: number;
  /** Cached height field rows: the mesher re-samples shared edges. */
  private readonly heightCache = new Map<number, number>();
  /** Road corridor cache, cleared whenever the network changes. */
  private readonly corridorCache = new Map<number, number>();
  private readonly tmpColor = new THREE.Color();

  constructor(
    private readonly quality: QualityManager,
    readonly biomes: BiomeSystem,
    private readonly materials: MaterialLibrary,
    corridor: CorridorProvider | null,
  ) {
    this.corridor = corridor
    this.group.name = 'terrain';
    const settings = quality.settings;
    this.chunkSize = settings.terrainChunkSize;
    this.viewDistance = settings.terrainViewDistance;
    this.segments = Math.max(8, Math.round(CONFIG.world.chunkSegments * (1 - Math.min(0.6, settings.lodBias * 0.3))));

    const detail = materials.terrainDetail();
    const tile = (tex: THREE.Texture | null, times: number): THREE.Texture | null => {
      if (!tex) return null;
      const clone = tex.clone();
      clone.wrapS = THREE.RepeatWrapping;
      clone.wrapT = THREE.RepeatWrapping;
      clone.repeat.set(times, times);
      clone.needsUpdate = true;
      return clone;
    };
    const repeats = Math.max(4, Math.round(this.chunkSize / 12));
    this.detailMaps = {
      map: tile(detail.map, repeats)!,
      normalMap: tile(detail.normalMap, repeats)!,
      roughnessMap: tile(detail.roughnessMap, repeats)!,
    };
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.detailMaps.map,
      normalMap: this.detailMaps.normalMap,
      roughnessMap: this.detailMaps.roughnessMap,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 0.95,
      metalness: 0.02,
      envMapIntensity: 0.7,
      dithering: true,
    });

    /*
     * Water: a rough, mostly dielectric surface. A near-mirror ocean (low
     * roughness, high metalness, full IBL) reflects the whole HDR sky and turns
     * the lower half of the frame into a white sheet, so the reflection is kept
     * broad and dim while still picking up the sky colour.
     */
    this.waterMaterial = new THREE.MeshStandardMaterial({
      color: 0x14313f,
      roughness: 0.34,
      metalness: 0.08,
      normalMap: materials.waterNormal(),
      normalScale: new THREE.Vector2(0.5, 0.5),
      envMapIntensity: 0.45,
      transparent: true,
      opacity: 0.94,
    });
    this.waterMaterial.normalMap!.wrapS = THREE.RepeatWrapping;
    this.waterMaterial.normalMap!.wrapT = THREE.RepeatWrapping;
    this.waterMaterial.normalMap!.repeat.set(60, 60);

    this.buildOcean();
  }

  /** Attaches the road network once it exists (breaks the build cycle). */
  setCorridor(corridor: CorridorProvider | null): void {
    this.corridor = corridor;
    this.invalidateCorridor();
    // Existing chunks were meshed without the cut: drop them so the streaming
    // pass rebuilds them over the new road corridor.
    for (const chunk of this.chunks.values()) {
      this.group.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      this.group.remove(chunk.scatter);
    }
    this.chunks.clear();
  }

  // ------------------------------------------------------------- sampling

  /** Coarse city-district weight (0..1) used by the biome classifier. */
  urbanAt(x: number, z: number): number {
    return fbm2(this.urbanNoise, x * 0.00035, z * 0.00035, 3);
  }

  /**
   * Raw terrain height (metres) before road cutting.
   * Island falloff + warped plains + ridged mountains + erosion-like valleys.
   */
  rawHeightAt(x: number, z: number): number {
    const warpX = x + (fbm2(this.coastNoise, x * 0.0004 + 3, z * 0.0004 + 7, 3) - 0.5) * 420 * TERRAIN_SHAPE.coastWarp;
    const warpZ = z + (fbm2(this.coastNoise, x * 0.0004 + 11, z * 0.0004 + 2, 3) - 0.5) * 420 * TERRAIN_SHAPE.coastWarp;

    const radius = Math.sqrt(warpX * warpX + warpZ * warpZ);
    // Island mask: 1 inland, 0 past the coastline.
    // Flat plateau out to 62 % of the radius, then a coastline the rest of the
    // way: the whole race route stays inland, the horizon reads as an ocean.
    const island = 1 - smoothstep(TERRAIN_SHAPE.islandRadius * 0.62, TERRAIN_SHAPE.islandRadius, radius);

    const plains = warpedFbm(this.heightNoise, x * 0.00085, z * 0.00085, 0.7, 5) - 0.5;
    // Mountain ridges: two overlapping bands so the skyline is not symmetric.
    const ridgeA = ridged2(this.ridgeNoise, x * TERRAIN_SHAPE.ridgeFrequency, z * TERRAIN_SHAPE.ridgeFrequency, 5);
    const bandA = Math.exp(-Math.pow((x + 1250) / 900, 2) - Math.pow((z + 950) / 1100, 2));
    const bandB = Math.exp(-Math.pow((x - 1350) / 1000, 2) - Math.pow((z + 1350) / 800, 2));
    const mountains = Math.pow(Math.max(ridgeA, 0), 2.1) * Math.max(bandA, bandB * 0.85);

    // Valleys: subtract a soft fBm so low ground reads as eroded.
    const valley = Math.pow(fbm2(this.heightNoise, x * 0.0016 + 40, z * 0.0016 + 20, 4), 1.6) * 26;

    let h = TERRAIN_SHAPE.seaLevel + island * (TERRAIN_SHAPE.plainAmplitude + plains * 46) - valley;
    h += mountains * TERRAIN_SHAPE.mountainAmplitude * island;
    // Flatten the low-lying areas a little more so plains stay drivable.
    h = mix(h, h * 0.9 + 6, smoothstep(0.55, 0.85, island) * 0.35);
    // Deep water beyond the island so the horizon reads as an ocean.
    h -= (1 - island) * 90;
    return h;
  }

  /** Shortest distance to a road corridor (cached on a 4 m lattice). */
  private corridorDistance(x: number, z: number): number {
    if (!this.corridor) return Infinity;
    const key = ((Math.round(x / 4) + 8192) * 32768 + (Math.round(z / 4) + 8192)) | 0;
    const hit = this.corridorCache.get(key);
    if (hit !== undefined) return hit;
    const info = this.corridor.corridorAt(x, z);
    const value = info ? info.distance : Infinity;
    if (this.corridorCache.size > 200000) this.corridorCache.clear();
    this.corridorCache.set(key, value);
    return value;
  }

  private corridor: CorridorProvider | null = null;

  /** Cached height lookup (the mesher samples shared chunk edges repeatedly). */
  heightAt(x: number, z: number): number {
    const key = ((Math.round(x) + 8192) * 32768 + (Math.round(z) + 8192)) | 0;
    const hit = this.heightCache.get(key);
    if (hit !== undefined) return hit;
    const value = this.computeHeight(x, z);
    if (this.heightCache.size > 400000) this.heightCache.clear();
    this.heightCache.set(key, value);
    return value;
  }

  private computeHeight(x: number, z: number): number {
    const base = this.rawHeightAt(x, z);
    if (!this.corridor) return base;
    const info = this.corridor.corridorAt(x, z);
    if (!info || info.tunnel) return base;
    // Cut and fill: the road surface wins inside the carriageway, then a
    // 26 m shoulder blends back into the natural terrain.
    const halfRoad = 13;
    const blend = 1 - smoothstep(halfRoad, halfRoad + 26, info.distance);
    if (blend <= 0.001) return base;
    return mix(base, info.y - 0.12 * (1 - blend), blend);
  }

  /** Hill-shaded slope (0 = flat) used by biome classification and scatter. */
  slopeAt(x: number, z: number): number {
    const d = 6;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return Math.min(1, Math.sqrt(hx * hx + hz * hz) / (2 * d) * 1.35);
  }

  /** Surface normal from the height field (used to orient rocks/trees). */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const d = 4;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return out.set(-hx, 2 * d, -hz).normalize();
  }

  /** True when the position is under water. */
  isUnderwater(x: number, z: number): boolean {
    return this.heightAt(x, z) < TERRAIN_SHAPE.seaLevel;
  }

  // ------------------------------------------------------------ ocean

  private buildOcean(): void {
    const size = CONFIG.world.extent * 3;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    const mesh = new THREE.Mesh(geo, this.waterMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = TERRAIN_SHAPE.seaLevel;
    mesh.name = 'ocean';
    mesh.receiveShadow = false;
    this.ocean = mesh;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------- streaming

  /** Ensures every chunk within the quality view distance is meshed. */
  ensureAround(focus: THREE.Vector3): void {
    const cs = this.chunkSize;
    const ci = Math.floor(focus.x / cs);
    const cj = Math.floor(focus.z / cs);
    const r = this.viewDistance;
    for (let ix = ci - r; ix <= ci + r; ix++) {
      for (let iz = cj - r; iz <= cj + r; iz++) {
        // Round view shape: skip the corners for a cheap perf win.
        if (Math.abs(ix - ci) + Math.abs(iz - cj) > r + 2) continue;
        const key = CHUNK_KEY(ix, iz);
        if (this.chunks.has(key)) continue;
        this.buildChunk(ix, iz, key);
      }
    }
    this.pruneAround(ci, cj);
  }

  private pruneAround(ci: number, cj: number): void {
    const r = this.viewDistance + 2;
    for (const [key, chunk] of this.chunks) {
      if (Math.abs(Math.floor(chunk.cx / this.chunkSize) - ci) > r + 1 || Math.abs(Math.floor(chunk.cz / this.chunkSize) - cj) > r + 1) {
        this.group.remove(chunk.mesh);
        chunk.mesh.geometry.dispose();
        for (const child of chunk.scatter.children) {
          const inst = child as THREE.InstancedMesh;
          inst.geometry.dispose();
        }
        this.group.remove(chunk.scatter);
        this.chunks.delete(key);
      }
    }
  }

  private buildChunk(ix: number, iz: number, key: string): void {
    const cs = this.chunkSize;
    const n = this.segments;
    const step = cs / n;
    const ox = ix * cs;
    const oz = iz * cs;
    const verts = (n + 1) * (n + 1);
    const positions = new Float32Array(verts * 3);
    const uvs = new Float32Array(verts * 2);
    const colors = new Float32Array(verts * 3);
    const indices: number[] = [];

    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const vi = j * (n + 1) + i;
        const x = ox + i * step;
        const z = oz + j * step;
        const y = this.heightAt(x, z);
        positions[vi * 3] = x;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = z;
        uvs[vi * 2] = i / n;
        uvs[vi * 2 + 1] = j / n;
        const slope = this.slopeAt(x, z);
        this.biomes.colourAt(y, slope, x, z, this.urbanAt(x, z), this.tmpColor);
        colors[vi * 3] = this.tmpColor.r;
        colors[vi * 3 + 1] = this.tmpColor.g;
        colors[vi * 3 + 2] = this.tmpColor.b;
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `terrain-chunk-${key}`;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    this.group.add(mesh);

    const scatter = this.buildScatter(ox, oz, cs, n);
    this.group.add(scatter);
    this.chunks.set(key, { key, mesh, scatter, cx: ox + cs / 2, cz: oz + cs / 2 });
  }

  /** Instanced vegetation / rocks for one chunk, chosen by biome density. */
  private buildScatter(ox: number, oz: number, cs: number, n: number): THREE.Group {
    const group = new THREE.Group();
    group.name = 'scatter';
    const density = this.quality.settings.detailDensity;
    if (density <= 0.02) return group;
    const candidates = Math.round(46 * density);
    if (candidates <= 0) return group;

    const matrices: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (let i = 0; i < candidates; i++) {
      const x = ox + ((i * 37.13) % cs);
      const z = oz + ((i * 91.71) % (cs - 1e-3));
      if (this.corridorDistance(x, z) < 16) continue;
      const y = this.heightAt(x, z);
      if (y < TERRAIN_SHAPE.seaLevel + 1.2) continue;
      const slope = this.slopeAt(x, z);
      const biome = this.biomes.biomeAtCached(y, slope, x, z, this.urbanAt(x, z));
      const chance = this.biomes.scatterDensity(biome);
      if (chance <= 0) continue;
      if (((i * 7.3) % 1) > chance) continue;
      this.normalAt(x, z, normal);
      up.set(0, 1, 0);
      q.setFromUnitVectors(up, normal);
      pos.set(x, y - 0.2, z);
      const s = 0.7 + ((i * 13.7) % 1) * 0.9;
      scale.set(s, s * (0.85 + ((i * 5.1) % 1) * 0.5), s);
      matrices.push(new THREE.Matrix4().compose(pos, q, scale));
    }
    if (!matrices.length) return group;

    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 3.2, 5);
    const canopyGeo = new THREE.ConeGeometry(1.5, 4.4, 7);
    const rockGeo = new THREE.DodecahedronGeometry(1.1, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.95 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2f4a2c, roughness: 0.92 });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x77726a, roughness: 0.95, flatShading: true });

    const trees = new THREE.InstancedMesh(trunkGeo, trunkMat, matrices.length);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, matrices.length);
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, matrices.length);
    let treeCount = 0;
    let rockCount = 0;
    const lifted = new THREE.Matrix4();
    for (const m of matrices) {
      const isRock = ((m.elements[12]! * 3.1 + m.elements[14]! * 1.7) % 1 + 1) % 1 > 0.72;
      if (isRock) {
        rocks.setMatrixAt(rockCount++, m);
      } else {
        trees.setMatrixAt(treeCount, m);
        lifted.makeTranslation(0, 3.4, 0);
        canopies.setMatrixAt(treeCount, m.clone().multiply(lifted));
        treeCount++;
      }
    }
    trees.count = treeCount;
    canopies.count = treeCount;
    rocks.count = rockCount;
    trees.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    rocks.instanceMatrix.needsUpdate = true;
    trees.castShadow = this.quality.settings.shadowMapSize > 0;
    canopies.castShadow = trees.castShadow;
    group.add(trees, canopies, rocks);
    void n;
    return group;
  }

  // -------------------------------------------------------------- frame

  update(elapsed: number, camera: THREE.Camera): void {
    // Scroll the ocean normals; two directions would need a shader, one is
    // enough to read as moving water from a car at 200 km/h.
    const map = this.waterMaterial.normalMap;
    if (map) {
      map.offset.x = (elapsed * 0.006) % 1;
      map.offset.y = (elapsed * 0.004) % 1;
    }
    void camera;
  }

  /** Drops the corridor caches after the road network changes. */
  invalidateCorridor(): void {
    this.corridorCache.clear();
    this.heightCache.clear();
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) {
      chunk.mesh.geometry.dispose();
      for (const child of chunk.scatter.children) (child as THREE.InstancedMesh).geometry.dispose();
    }
    this.chunks.clear();
    this.group.clear();
  }
}
