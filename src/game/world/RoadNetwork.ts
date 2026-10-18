import * as THREE from 'three';
import type { MaterialLibrary } from '../MaterialLibrary';
import type { QualityManager } from '../QualityManager';
import type { StaticBox } from '../Types';
import { CONFIG } from '../Config';
import { buildEdgeGeometry, mergeBucket, type EdgeGeometry } from './RoadGenerator';
import { mix, smoothstep } from './Noise';
import type { CorridorProvider, TerrainSystem } from './TerrainSystem';

/** Road taxonomy: each class gets its own width, lanes, speed and detail set. */
export type RoadClass = 'race' | 'highway' | 'arterial' | 'street' | 'mountain' | 'coastal' | 'ramp' | 'trail';

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  y: number;
  kind: 'junction' | 'roundabout' | 'portal' | 'end';
}

export interface RoadEdge {
  id: number;
  from: number;
  to: number;
  name: string;
  roadClass: RoadClass;
  /** Lanes per direction (1 = two-lane road). */
  lanes: number;
  halfWidth: number;
  speedLimit: number;
  curve: THREE.CatmullRomCurve3;
  length: number;
  tunnel: boolean;
  bridge: boolean;
  /** True for edges that belong to the race route. */
  race: boolean;
}

/** Author-time description of the closed race route (XZ pairs, metres). */
const ROUTE_POINTS: Array<[number, number]> = [
  [1250, 1250],
  [1480, 920],
  [1500, 420],
  [1350, 60],
  [1080, -280],
  [720, -520],
  [320, -680],
  [-160, -760],
  [-620, -830],
  [-1020, -900],
  [-1320, -830],
  [-1450, -560],
  [-1330, -260],
  [-1080, -110],
  [-1240, 160],
  [-980, 400],
  [-720, 650],
  [-420, 820],
  [-100, 860],
  [260, 700],
  [620, 600],
  [980, 700],
  [1150, 980],
  [1280, 1120],
];

/** Capsules that force a tunnel (terrain is NOT cut, a shell is built). */
const TUNNEL_CAPSULES: Array<{ x: number; z: number; r: number }> = [{ x: -1390, z: -700, r: 300 }];

/** Capsules that force an elevated bridge deck (terrain is NOT cut). */
const BRIDGE_CAPSULES: Array<{ x: number; z: number; r: number }> = [{ x: 90, z: -725, r: 420 }];

const CLASS_SPEC: Record<RoadClass, { lanes: number; halfWidth: number; speed: number }> = {
  race: { lanes: 2, halfWidth: 12.5, speed: 190 },
  highway: { lanes: 3, halfWidth: 15, speed: 150 },
  arterial: { lanes: 2, halfWidth: 11, speed: 90 },
  street: { lanes: 1, halfWidth: 7.5, speed: 60 },
  mountain: { lanes: 1, halfWidth: 9, speed: 80 },
  coastal: { lanes: 2, halfWidth: 12, speed: 120 },
  ramp: { lanes: 1, halfWidth: 6, speed: 70 },
  trail: { lanes: 1, halfWidth: 5, speed: 50 },
};

/**
 * The open-world road network.
 *
 * A closed "race route" (built from authored control points so it is always
 * drivable) is combined with generated city streets, a ring highway, a
 * roundabout, ramps and mountain trails. Every edge is a spline; a spatial hash
 * over sampled road points answers "how close is the nearest road and how high
 * is it", which is what lets the terrain cut and fill itself around the roads.
 *
 * Tunnels and bridges are authored as capsules: inside them the terrain is left
 * alone and the generator builds a shell or a deck instead.
 */
export class RoadNetwork implements CorridorProvider {
  readonly group = new THREE.Group();
  readonly nodes: RoadNode[] = [];
  readonly edges: RoadEdge[] = [];
  readonly collisionBoxes: StaticBox[] = [];
  /** Extra polylines for the minimap (side roads only). */
  readonly minimapRoads: number[][] = [];

  /** Closed centre line of the race route. */
  readonly routeCurve: THREE.CatmullRomCurve3;
  readonly routeLength: number;
  /** Flag runs along the route (t ranges that are tunnel or bridge). */
  readonly routeFlags: Array<{ t0: number; t1: number; tunnel: boolean; bridge: boolean }> = [];

  /** Flattened road samples used by the corridor hash. */
  private readonly sampleX: number[] = [];
  private readonly sampleY: number[] = [];
  private readonly sampleZ: number[] = [];
  private readonly sampleNoCut: boolean[] = [];
  private readonly grid = new Map<number, number[]>();
  private static readonly CELL = 48;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly instanced: THREE.InstancedMesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(
    private readonly terrain: TerrainSystem,
    private readonly library: MaterialLibrary,
    private readonly quality: QualityManager,
  ) {
    this.group.name = 'road-network';
    this.routeCurve = this.buildRouteCurve();
    this.routeLength = this.routeCurve.getLength();
    this.classifyRouteFlags();
    this.buildRouteEdges();
    this.buildCityGrid();
    this.buildRingHighway();
    this.buildRoundabout();
    this.buildRamps();
    this.buildTrails();
    this.buildCorridorHash();
    this.buildMeshes();
  }

  // ------------------------------------------------------------- route

  /** Builds the XZ route, then drapes a smoothed elevation profile onto it. */
  private buildRouteCurve(): THREE.CatmullRomCurve3 {
    const flat = ROUTE_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const xz = new THREE.CatmullRomCurve3(flat, true, 'catmullrom', 0.5);
    // Pass 1: sample the natural terrain along the route.
    const samples = 420;
    const pts = xz.getSpacedPoints(samples);
    const heights = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      heights[i] = this.terrain.rawHeightAt(pts[i]!.x, pts[i]!.z);
    }
    // Pass 2: smooth hard (a road is graded, not a noise field) ...
    let smoothed = RoadNetwork.smooth(heights, 26, 3);
    // ... then clamp the longitudinal grade to +-9 % so nothing is unclimbable.
    const spacing = xz.getLength() / samples;
    smoothed = RoadNetwork.clampGrade(smoothed, spacing, 0.09);
    // Pass 3: keep the route on dry land, and ramp it smoothly up onto the
    // bridge deck instead of stepping at the capsule boundary.
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < samples; i++) {
      const p = pts[i]!;
      const dry = Math.max(smoothed[i]!, CONFIG.world.seaLevel + 7);
      const bridgeBlend = this.capsuleBlend(p.x, p.z, BRIDGE_CAPSULES);
      out.push(new THREE.Vector3(p.x, mix(dry, CONFIG.world.seaLevel + 34, bridgeBlend), p.z));
    }
    return new THREE.CatmullRomCurve3(out, true, 'catmullrom', 0.5);
  }

  /** Moving-average smoothing with `passes` iterations (wrap-around). */
  private static smooth(values: Float32Array, window: number, passes: number): Float32Array {
    let current = values;
    const n = values.length;
    for (let p = 0; p < passes; p++) {
      const next = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        let count = 0;
        for (let k = -window; k <= window; k++) {
          const idx = (((i + k) % n) + n) % n;
          sum += current[idx]!;
          count += 1;
        }
        next[i] = sum / count;
      }
      current = next;
    }
    return current;
  }

  /** Limits |dy/dx| to `maxGrade` by walking the profile forward and back. */
  private static clampGrade(values: Float32Array, spacing: number, maxGrade: number): Float32Array {
    const n = values.length;
    const maxStep = spacing * maxGrade;
    const out = Float32Array.from(values);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < n; i++) {
        const delta = out[i]! - out[i - 1]!;
        if (Math.abs(delta) > maxStep) out[i] = out[i - 1]! + Math.sign(delta) * maxStep;
      }
      for (let i = n - 2; i >= 0; i--) {
        const delta = out[i]! - out[i + 1]!;
        if (Math.abs(delta) > maxStep) out[i] = out[i + 1]! + Math.sign(delta) * maxStep;
      }
    }
    return out;
  }

  /**
   * Smooth 0..1 weight for a capsule: 1 deep inside, 0 outside. Used to ramp
   * the bridge deck up and back down again without a step in the profile.
   */
  private capsuleBlend(x: number, z: number, capsules: Array<{ x: number; z: number; r: number }>): number {
    let best = 0;
    for (const c of capsules) {
      const d = Math.hypot(x - c.x, z - c.z) / c.r;
      best = Math.max(best, 1 - smoothstep(0.55, 1, d));
    }
    return best;
  }

  private insideCapsule(x: number, z: number, capsules: Array<{ x: number; z: number; r: number }>): boolean {
    for (const c of capsules) {
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz < c.r * c.r) return true;
    }
    return false;
  }

  /** Samples the finished curve and groups tunnel/bridge runs into t ranges. */
  private classifyRouteFlags(): void {
    const samples = 1000;
    const flags: Array<{ tunnel: boolean; bridge: boolean }> = [];
    for (let i = 0; i < samples; i++) {
      const p = this.routeCurve.getPointAt(i / samples);
      flags.push({
        tunnel: this.insideCapsule(p.x, p.z, TUNNEL_CAPSULES),
        bridge: this.insideCapsule(p.x, p.z, BRIDGE_CAPSULES),
      });
    }
    let start = 0;
    for (let i = 1; i <= samples; i++) {
      const same =
        i < samples && flags[i]!.tunnel === flags[start]!.tunnel && flags[i]!.bridge === flags[start]!.bridge;
      if (same) continue;
      // Drop micro-runs: they would produce a sliver of tunnel shell.
      if (i - start >= 4) {
        this.routeFlags.push({
          t0: start / samples,
          t1: i / samples,
          tunnel: flags[start]!.tunnel,
          bridge: flags[start]!.bridge,
        });
      } else if (this.routeFlags.length) {
        this.routeFlags[this.routeFlags.length - 1]!.t1 = i / samples;
      }
      start = i;
    }
  }

  /** One edge per flag run, so tunnels and bridges get their own geometry. */
  private buildRouteEdges(): void {
    for (const run of this.routeFlags) {
      const points: THREE.Vector3[] = [];
      const steps = Math.max(8, Math.round(((run.t1 - run.t0) * this.routeLength) / 12));
      for (let i = 0; i <= steps; i++) {
        points.push(this.routeCurve.getPointAt(run.t0 + ((run.t1 - run.t0) * i) / steps));
      }
      const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
      this.addEdge(curve, 'race', run.tunnel, run.bridge, true, 'RACE ROUTE');
    }
  }

  // ------------------------------------------------------------- side roads

  /** Builds an edge from authored XZ control points draped on the terrain. */
  private addDrapedEdge(
    points: Array<[number, number]>,
    roadClass: RoadClass,
    name: string,
    closed = false,
    lift = 0,
    smoothWindow = 8,
  ): RoadEdge {
    const flat = points.map(([x, z]) => new THREE.Vector3(x, this.terrain.rawHeightAt(x, z) + lift, z));
    const rough = new THREE.CatmullRomCurve3(flat, closed, 'catmullrom', 0.5);
    const steps = Math.max(16, Math.round(rough.getLength() / 22));
    const sampled = rough.getSpacedPoints(steps);
    const heights = new Float32Array(steps);
    for (let i = 0; i < steps; i++) heights[i] = this.terrain.rawHeightAt(sampled[i]!.x, sampled[i]!.z) + lift;
    const smoothed = RoadNetwork.smooth(heights, smoothWindow, 2);
    const draped: THREE.Vector3[] = [];
    for (let i = 0; i < steps; i++) draped.push(new THREE.Vector3(sampled[i]!.x, smoothed[i]!, sampled[i]!.z));
    const curve = new THREE.CatmullRomCurve3(draped, closed, 'catmullrom', 0.5);
    return this.addEdge(curve, roadClass, false, false, false, name);
  }

  /** Registers an edge in the graph and pushes it to the minimap. */
  private addEdge(
    curve: THREE.CatmullRomCurve3,
    roadClass: RoadClass,
    tunnel: boolean,
    bridge: boolean,
    race: boolean,
    name: string,
  ): RoadEdge {
    const spec = CLASS_SPEC[roadClass];
    const id = this.edges.length;
    const edge: RoadEdge = {
      id,
      from: -1,
      to: -1,
      name: `${name} #${id}`,
      roadClass,
      lanes: spec.lanes,
      halfWidth: spec.halfWidth,
      speedLimit: spec.speed,
      curve,
      length: curve.getLength(),
      tunnel,
      bridge,
      race,
    };
    this.edges.push(edge);
    if (!race) {
      const line: number[] = [];
      const n = Math.max(8, Math.round(edge.length / 30));
      for (let i = 0; i <= n; i++) {
        const p = curve.getPointAt(i / n);
        line.push(p.x, p.y, p.z);
      }
      this.minimapRoads.push(line);
    }
    return edge;
  }

  /** Downtown street grid, draped over the city district. */
  private buildCityGrid(): void {
    const cityX = [-640, -470, -300, -130, 40];
    const zTop = 500;
    const zBottom = 1060;
    for (const x of cityX) {
      this.addDrapedEdge(
        [
          [x + 30, zTop - 40],
          [x - 10, (zTop + zBottom) / 2],
          [x + 20, zBottom + 30],
        ],
        'street',
        'CITY ST',
      );
    }
    const cityZ = [540, 690, 840, 990];
    for (const z of cityZ) {
      this.addDrapedEdge(
        [
          [-700, z - 20],
          [-330, z + 20],
          [90, z - 15],
        ],
        'street',
        'CITY AVE',
      );
    }
  }

  /** Ring highway encircling the city district. */
  private buildRingHighway(): void {
    const cx = -280;
    const cz = 780;
    const rx = 620;
    const rz = 480;
    const pts: Array<[number, number]> = [];
    const segments = 14;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push([
        cx + Math.cos(a) * rx * (1 + Math.sin(a * 3) * 0.05),
        cz + Math.sin(a) * rz * (1 + Math.cos(a * 2) * 0.06),
      ]);
    }
    this.addDrapedEdge(pts, 'highway', 'RING HWY', true, 12, 12);
  }

  /** Big roundabout at the eastern interchange. */
  private buildRoundabout(): void {
    const cx = 300;
    const cz = 705;
    const r = 34;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
    this.addDrapedEdge(pts, 'ramp', 'ROUNDABOUT', true, 6, 4);
    // Central island.
    const island = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.55, r * 0.6, 1.2, 14),
      this.library.concreteMaterial(0x8f8a80),
    );
    island.position.set(cx, this.terrain.heightAt(cx, cz) + 0.6, cz);
    island.receiveShadow = true;
    this.group.add(island);
  }

  /** Slip roads linking the ring highway to the race route. */
  private buildRamps(): void {
    this.addDrapedEdge(
      [
        [120, 560],
        [230, 620],
        [320, 690],
      ],
      'ramp',
      'RAMP E',
      false,
      10,
      6,
    );
    this.addDrapedEdge(
      [
        [-760, 430],
        [-700, 560],
        [-620, 690],
      ],
      'ramp',
      'RAMP W',
      false,
      10,
      6,
    );
  }

  /** Dirt trails through the mountains: the map's off-road excursion. */
  private buildTrails(): void {
    this.addDrapedEdge(
      [
        [-1450, -1150],
        [-1180, -1050],
        [-1000, -830],
      ],
      'trail',
      'RIDGE TRAIL',
      false,
      2,
      14,
    );
    this.addDrapedEdge(
      [
        [-1180, 500],
        [-1000, 260],
        [-900, 60],
      ],
      'trail',
      'PASS TRAIL',
      false,
      2,
      14,
    );
    this.addDrapedEdge(
      [
        [1180, -700],
        [980, -430],
        [900, -160],
      ],
      'trail',
      'VALLEY TRAIL',
      false,
      2,
      14,
    );
  }

  // ------------------------------------------------------------- corridor

  /** Samples every edge into a spatial hash for the terrain cut. */
  private buildCorridorHash(): void {
    for (const edge of this.edges) {
      const step = edge.roadClass === 'trail' ? 14 : 7;
      const n = Math.max(4, Math.round(edge.length / step));
      for (let i = 0; i <= n; i++) {
        const p = edge.curve.getPointAt(i / n);
        const index = this.sampleX.length;
        this.sampleX.push(p.x);
        this.sampleY.push(p.y);
        this.sampleZ.push(p.z);
        // Tunnels and bridges must NOT cut the terrain (the shell/deck handles it).
        this.sampleNoCut.push(edge.tunnel || edge.bridge);
        const key = this.cellKey(p.x, p.z);
        const list = this.grid.get(key);
        if (list) list.push(index);
        else this.grid.set(key, [index]);
      }
    }
  }

  private cellKey(x: number, z: number): number {
    const ix = Math.floor(x / RoadNetwork.CELL);
    const iz = Math.floor(z / RoadNetwork.CELL);
    return (ix + 4096) * 16384 + (iz + 4096);
  }

  /** Nearest road surface within ~64 m, used by the terrain and the scatter. */
  corridorAt(x: number, z: number): { distance: number; y: number; tunnel: boolean } | null {
    const cell = RoadNetwork.CELL;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let best = Infinity;
    let bestIndex = -1;
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        const list = this.grid.get((ix + 4096) * 16384 + (iz + 4096));
        if (!list) continue;
        for (const index of list) {
          const dx = this.sampleX[index]! - x;
          const dz = this.sampleZ[index]! - z;
          const d = dx * dx + dz * dz;
          if (d < best) {
            best = d;
            bestIndex = index;
          }
        }
      }
    }
    if (bestIndex < 0) return null;
    const distance = Math.sqrt(best);
    if (distance > 64) return null;
    return { distance, y: this.sampleY[bestIndex]!, tunnel: this.sampleNoCut[bestIndex]! };
  }

  /** Nearest route-adjacent spawn/anchor point (used by the traffic + city). */
  routeAnchor(t: number): THREE.Vector3 {
    return this.routeCurve.getPointAt(((t % 1) + 1) % 1);
  }

  // --------------------------------------------------------------- meshes

  /** Builds and merges every road mesh (a handful of draw calls in total). */
  private buildMeshes(): void {
    const settings = this.quality.settings;
    const asphalt: THREE.BufferGeometry[] = [];
    const markings: THREE.BufferGeometry[] = [];
    const rails: THREE.BufferGeometry[] = [];
    const concrete: THREE.BufferGeometry[] = [];
    const tunnelShells: THREE.BufferGeometry[] = [];
    const piers: THREE.BufferGeometry[] = [];
    const cables: THREE.BufferGeometry[] = [];
    const studMatrices: THREE.Matrix4[] = [];
    const lampMatrices: THREE.Matrix4[] = [];

    for (const edge of this.edges) {
      const geo: EdgeGeometry = buildEdgeGeometry(edge, this.terrain, this.library, settings);
      asphalt.push(...geo.asphalt);
      markings.push(...geo.markings);
      rails.push(...geo.rails);
      concrete.push(...geo.concrete);
      tunnelShells.push(...geo.tunnel);
      piers.push(...geo.piers);
      if (geo.cables) cables.push(geo.cables);
      studMatrices.push(...geo.studMatrices);
      lampMatrices.push(...geo.lampMatrices);
    }

    const concreteMat = this.library.concreteMaterial(0x9c9a94);
    this.materials.push(concreteMat);
    const add = (bucket: THREE.BufferGeometry[], material: THREE.Material, shadow: boolean, name: string): void => {
      const merged = mergeBucket(bucket);
      if (!merged) return;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = name;
      mesh.receiveShadow = shadow;
      mesh.castShadow = false;
      this.meshes.push(mesh);
      this.geometries.push(merged);
      this.group.add(mesh);
    };

    add(asphalt, this.library.asphaltMaterial(), true, 'road-surface');
    const paint = new THREE.MeshStandardMaterial({ color: 0xd8d8cf, roughness: 0.62, metalness: 0.02 });
    this.materials.push(paint);
    add(markings, paint, false, 'road-markings');
    const railMat = this.library.metalMaterial(0xb9bcc2, 0.4);
    this.materials.push(railMat);
    add(rails, railMat, true, 'road-rails');
    add(concrete, concreteMat, true, 'road-concrete');

    const piersMerged = mergeBucket(piers);
    if (piersMerged) {
      const piersMesh = new THREE.Mesh(piersMerged, concreteMat);
      piersMesh.castShadow = true;
      piersMesh.receiveShadow = true;
      piersMesh.name = 'road-piers';
      this.geometries.push(piersMerged);
      this.group.add(piersMesh);
      this.meshes.push(piersMesh);
    }
    const shellMerged = mergeBucket(tunnelShells);
    if (shellMerged) {
      const shellMat = new THREE.MeshStandardMaterial({
        color: 0x8a8880,
        roughness: 0.95,
        metalness: 0.04,
        side: THREE.BackSide,
      });
      this.materials.push(shellMat);
      const shell = new THREE.Mesh(shellMerged, shellMat);
      shell.name = 'tunnel-shell';
      this.geometries.push(shellMerged);
      this.group.add(shell);
      this.meshes.push(shell);
    }
    const cableMerged = mergeBucket(cables);
    if (cableMerged) {
      const cableMat = new THREE.LineBasicMaterial({ color: 0x8d8f93 });
      this.materials.push(cableMat);
      const lines = new THREE.LineSegments(cableMerged, cableMat);
      lines.name = 'bridge-cables';
      this.group.add(lines);
    }

    // Reflective studs along the race route / highways.
    if (studMatrices.length && settings.detailDensity > 0.4) {
      const studGeo = new THREE.SphereGeometry(0.11, 6, 4);
      const studMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4, toneMapped: false });
      const studs = new THREE.InstancedMesh(studGeo, studMat, studMatrices.length);
      studMatrices.forEach((m, i) => studs.setMatrixAt(i, m));
      studs.instanceMatrix.needsUpdate = true;
      studs.name = 'road-studs';
      this.geometries.push(studGeo);
      this.materials.push(studMat);
      this.instanced.push(studs);
      this.group.add(studs);
    }

    // Street lamps: one instanced mesh for the whole network.
    if (lampMatrices.length && settings.detailDensity > 0.3) {
      const headGeo = new THREE.BoxGeometry(1.5, 0.28, 0.7);
      const headMat = new THREE.MeshStandardMaterial({
        color: 0xfff4d6,
        emissive: 0xffdca8,
        emissiveIntensity: 0.35,
        roughness: 0.4,
      });
      const heads = new THREE.InstancedMesh(headGeo, headMat, lampMatrices.length);
      lampMatrices.forEach((m, i) => heads.setMatrixAt(i, m));
      heads.instanceMatrix.needsUpdate = true;
      heads.name = 'street-lamps';
      this.geometries.push(headGeo);
      this.materials.push(headMat);
      this.instanced.push(heads);
      this.group.add(heads);
    }

    // NOTE: the race route's walls are *implicit* — CollisionSystem clamps the
    // car's lateral offset to `world.halfWidth`, exactly as it does on the
    // circuit. Emitting boxes along the route here would put solid volumes on
    // the racing line, so this list stays empty and only the city contributes.
  }

  /** Applies the active theme to the generated road materials. */
  setTheme(_theme: 'cyberpunk' | 'realistic'): void {
    // Road materials are already style-neutral PBR; MaterialLibrary.applyTheme
    // handles the circuit's neon-specific surfaces.
  }

  /** Total road length across every edge (HUD/README statistics). */
  get totalLength(): number {
    let total = 0;
    for (const e of this.edges) total += e.length;
    return total;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const inst of this.instanced) inst.dispose();
    this.group.clear();
  }
}
