import * as THREE from 'three';
import type { MaterialLibrary } from '../MaterialLibrary';
import type { QualityManager } from '../QualityManager';
import type { CollisionEvent, StaticBox } from '../Types';
import { CONFIG } from '../Config';
import { makeRng } from './Noise';
import type { MapModeId } from './MapMode';
import { SplinePath } from './SplinePath';
import type { RaceWorld } from './RaceWorld';
import { BiomeSystem, TERRAIN_SHAPE } from './BiomeSystem';
import { RoadNetwork } from './RoadNetwork';
import { RealisticCity } from './RealisticCity';
import { StreamingManager } from './StreamingManager';
import { TerrainSystem } from './TerrainSystem';
import { TrafficSystem } from './TrafficSystem';
import type { VehicleBase } from '../VehicleBase';

/**
 * The Round 2 open world.
 *
 * Composition order matters and mirrors how the content depends on itself:
 *   1. `TerrainSystem` (no road corridor yet) — the raw island,
 *   2. `RoadNetwork`       — the race route and every side road, draped on it,
 *   3. `terrain.setCorridor(roads)` — the terrain now cuts and fills around the
 *      roads, which is what makes junctions, cuttings and embankments appear,
 *   4. `RealisticCity`     — buildings, placed only where the ground is dry,
 *      flat enough and clear of the carriageway,
 *   5. `TrafficSystem`     — ambient cars on the network,
 *   6. `StreamingManager`  — chunk budget.
 *
 * It implements `RaceWorld` by delegating the arc-length API to `SplinePath`,
 * so the race director, AI and collision system treat it exactly like the
 * circuit.
 */
export class OpenWorld extends SplinePath implements RaceWorld {
  readonly id: MapModeId = 'openworld';
  readonly label = 'OPEN WORLD / 开放世界';

  readonly terrain: TerrainSystem;
  readonly roads: RoadNetwork;
  readonly city: RealisticCity;
  readonly traffic: TrafficSystem;
  readonly streaming: StreamingManager;
  readonly collisionBoxes: StaticBox[] = [];

  private readonly rng = makeRng(20261017);
  private readonly disposables: Array<{ dispose(): void }> = [];
  private chevronTex!: THREE.CanvasTexture;
  private readonly gateMaterials: THREE.Material[] = [];
  private readonly geometryPool: THREE.BufferGeometry[] = [];
  /** Night factor pushed by the active style (window glow). */
  private nightFactor = 0;

  constructor(
    quality: QualityManager,
    private readonly library: MaterialLibrary,
    private theme: 'cyberpunk' | 'realistic',
  ) {
    super();
    this.group.name = 'open-world';
    this.halfWidth = 12.5;

    // --------------------------------------------------------------- terrain
    const biomes = new BiomeSystem(TERRAIN_SHAPE.seaLevel);
    this.terrain = new TerrainSystem(quality, biomes, library, null);
    this.group.add(this.terrain.group);

    // ------------------------------------------------------------- road net
    this.roads = new RoadNetwork(this.terrain, library, quality);
    this.terrain.setCorridor(this.roads);
    this.group.add(this.roads.group);

    // ----------------------------------------------------------- race route
    this.buildSamples(this.roads.routeCurve, CONFIG.world.routeSamples);
    let minY = Infinity;
    for (const s of this.samples) minY = Math.min(minY, s.pos.y);
    this.groundY = minY - 24;
    for (const line of this.roads.minimapRoads) this.minimapRoads.push(line);
    this.buildCheckpoints();
    this.buildBoostPads();

    // ---------------------------------------------------------------- city
    this.city = new RealisticCity(this.terrain, this.roads, library, quality);
    this.group.add(this.city.group);

    // ------------------------------------------------------------- traffic
    this.traffic = new TrafficSystem(this.roads, this.terrain, quality);
    this.group.add(this.traffic.group);

    this.streaming = new StreamingManager(this.terrain, this.city, quality);
    this.collisionBoxes.push(...this.city.collisionBoxes, ...this.roads.collisionBoxes);

    // Prime the chunks around the start line so the first frame is not empty.
    this.terrain.ensureAround(this.samples[0]!.pos);
  }

  /** Chevron texture for the speed pads (shared by both styles). */
  private makeChevronTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, 128, 256);
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 12;
    ctx.shadowColor = '#ffd24a';
    ctx.shadowBlur = 18;
    for (let i = 0; i < 5; i++) {
      const y = 30 + i * 48;
      ctx.beginPath();
      ctx.moveTo(10, y + 30);
      ctx.lineTo(64, y);
      ctx.lineTo(118, y + 30);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.disposables.push(tex);
    return tex;
  }

  /** Check-point gantries: race furniture that reads in both styles. */
  private buildCheckpoints(): void {
    const total = CONFIG.world.checkpoints;
    const postGeo = new THREE.BoxGeometry(0.65, 8.4, 0.65);
    const barGeo = new THREE.BoxGeometry(this.halfWidth * 2 + 2.4, 0.9, 0.9);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.7, roughness: 0.4 });
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x1d2026,
      metalness: 0.4,
      roughness: 0.55,
      emissive: 0x2a6fb0,
      emissiveIntensity: 0.0,
    });
    this.gateMaterials.push(postMat, barMat);
    for (let i = 0; i < total; i++) {
      const distance = (i / total) * this.totalLength;
      const f = this.frameAt(distance);
      const isStart = i === 0;
      const gate = new THREE.Group();
      for (const sign of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.copy(f.pos).addScaledVector(f.side, sign * (this.halfWidth + 0.9));
        post.position.y += 4.2;
        gate.add(post);
      }
      const bar = new THREE.Mesh(barGeo, barMat);
      bar.position.copy(f.pos);
      bar.position.y += 8.1;
      bar.rotation.y = Math.atan2(f.tangent.x, f.tangent.z);
      gate.add(bar);
      gate.name = isStart ? 'checkpoint-start' : `checkpoint-${i}`;
      this.group.add(gate);
      this.checkpoints.push({ distance, mesh: gate });
    }
  }

  /** Speed pads along the race route. */
  private buildBoostPads(): void {
    this.chevronTex = this.makeChevronTexture();
    const total = CONFIG.world.boostPads;
    for (let i = 0; i < total; i++) {
      const distance = ((i + 0.5) / total) * this.totalLength + (this.rng() - 0.5) * 26;
      const lateral = (this.rng() - 0.5) * 7;
      const halfLength = 6;
      const halfWidth = 3.6;
      const geo = new THREE.PlaneGeometry(halfWidth * 2, halfLength * 2);
      const mat = new THREE.MeshBasicMaterial({
        map: this.chevronTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const f = this.frameAt(distance);
      const normal = new THREE.Vector3().crossVectors(f.side, f.tangent).normalize();
      mesh.position
        .copy(f.pos)
        .addScaledVector(f.side, lateral)
        .addScaledVector(normal, 0.07);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.side, f.tangent, normal));
      mesh.name = 'boost-pad';
      mesh.renderOrder = 2;
      this.geometryPool.push(geo);
      this.disposables.push(geo, mat);
      this.group.add(mesh);
      this.boostPads.push({ distance, lateral, halfLength, halfWidth, mesh });
    }
  }

  // ------------------------------------------------------------- per frame

  override update(dt: number, elapsed: number, focus: THREE.Vector3): void {
    this.streaming.update(dt, focus);
    this.terrain.update(elapsed, { position: focus } as THREE.Camera);
    this.traffic.update(dt);
  }

  /** Traffic is an extra dynamic obstacle for the player. */
  resolveTraffic(player: VehicleBase, dt: number): CollisionEvent[] {
    void dt;
    return this.traffic.resolvePlayer(player);
  }

  get trafficPositions(): Array<{ x: number; z: number }> {
    return this.traffic.positions;
  }

  /** Applies the active style to the world's own surfaces. */
  setTheme(theme: 'cyberpunk' | 'realistic', materials: MaterialLibrary): void {
    this.theme = theme;
    this.roads.setTheme(theme);
    this.city.setTheme(theme);
    materials.applyTheme(this.group, theme);
  }

  /** 0 = day, 1 = night; drives the city's window glow. */
  setNightFactor(value: number): void {
    if (Math.abs(value - this.nightFactor) < 0.02) return;
    this.nightFactor = value;
    this.city.setEmissiveIntensity(THREE.MathUtils.clamp(value, 0, 1) * 0.9);
  }

  get statistics(): { roadKm: number; buildings: number; traffic: number; routeKm: number } {
    return {
      roadKm: this.roads.totalLength / 1000,
      buildings: this.city.buildingCount,
      traffic: this.traffic.count,
      routeKm: this.totalLength / 1000,
    };
  }

  override dispose(): void {
    this.terrain.dispose();
    this.roads.dispose();
    this.city.dispose();
    this.traffic.dispose();
    for (const d of this.disposables) d.dispose();
    for (const g of this.geometryPool) g.dispose();
    for (const m of this.gateMaterials) m.dispose();
    this.group.clear();
    void this.theme;
  }
}
