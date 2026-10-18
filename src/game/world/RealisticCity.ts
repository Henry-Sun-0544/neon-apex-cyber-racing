import * as THREE from 'three';
import type { MaterialLibrary } from '../MaterialLibrary';
import type { QualityManager } from '../QualityManager';
import type { StaticBox } from '../Types';
import { makeRng } from './Noise';
import type { RoadNetwork } from './RoadNetwork';
import type { TerrainSystem } from './TerrainSystem';

/** Districts the city generator knows about. */
type District = 'downtown' | 'commercial' | 'residential' | 'industrial' | 'port' | 'park';

interface Block {
  x: number;
  z: number;
  district: District;
  /** Building footprints inside the block. */
  buildings: Array<{ x: number; z: number; w: number; d: number; h: number; rot: number; tint: number; facade: number }>;
}

/**
 * GTA-style procedural city.
 *
 * The generator lays out districts on a coarse grid, fills each block with
 * buildings of a district-appropriate footprint and height, then dresses the
 * result with instanced props (air-conditioning units, roof plant, antennas,
 * awnings, bins, benches, palms) and street furniture.
 *
 * Everything repeated is an `InstancedMesh`, and every building is merged into a
 * couple of geometry buckets, so a downtown of several hundred towers costs
 * well under a hundred draw calls.
 */
export class RealisticCity {
  readonly group = new THREE.Group();
  readonly collisionBoxes: StaticBox[] = [];
  private readonly rng = makeRng(70707);
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly instanced: THREE.InstancedMesh[] = [];
  private readonly blocks: Block[] = [];
  private readonly propMatrices: Record<string, THREE.Matrix4[]> = {
    ac: [],
    antenna: [],
    awning: [],
    bin: [],
    bench: [],
    palm: [],
    hydrant: [],
  };

  constructor(
    private readonly terrain: TerrainSystem,
    private readonly roads: RoadNetwork,
    private readonly library: MaterialLibrary,
    private readonly quality: QualityManager,
  ) {
    this.group.name = 'realistic-city';
    this.layout();
    this.buildBuildings();
    this.buildStreets();
    this.buildProps();
  }

  // ---------------------------------------------------------------- layout

  /** Lays out the districts around the authored city centre. */
  private layout(): void {
    const districts: Array<{ x: number; z: number; r: number; district: District }> = [
      { x: -300, z: 780, r: 330, district: 'downtown' },
      { x: -640, z: 620, r: 240, district: 'commercial' },
      { x: 40, z: 980, r: 300, district: 'residential' },
      { x: -720, z: 1040, r: 260, district: 'industrial' },
      { x: 700, z: 1250, r: 300, district: 'port' },
      { x: -120, z: 420, r: 220, district: 'park' },
    ];
    const density = this.quality.settings.detailDensity;
    for (const zone of districts) {
      const cell = zone.district === 'downtown' ? 78 : zone.district === 'commercial' ? 86 : 96;
      const steps = Math.ceil(zone.r / cell);
      for (let ix = -steps; ix <= steps; ix++) {
        for (let iz = -steps; iz <= steps; iz++) {
          const jitterX = (this.rng() - 0.5) * cell * 0.3;
          const jitterZ = (this.rng() - 0.5) * cell * 0.3;
          const x = zone.x + ix * cell + jitterX;
          const z = zone.z + iz * cell + jitterZ;
          const dist = Math.hypot(x - zone.x, z - zone.z);
          if (dist > zone.r) continue;
          // Keep the carriageway clear.
          if ((this.roads.corridorAt(x, z)?.distance ?? 999) < 20) continue;
          const y = this.terrain.heightAt(x, z);
          // No construction under water or on cliffs.
          if (y < -20) continue;
          if (this.terrain.slopeAt(x, z) > 0.42) continue;
          if (this.rng() > (zone.district === 'park' ? 0.35 : 0.82) * (0.55 + density * 0.45)) continue;
          this.blocks.push({
            x,
            z,
            district: zone.district,
            buildings: this.fillBlock(x, z, cell, zone.district, dist / zone.r),
          });
        }
      }
    }
  }

  /** Splits a block into building footprints for its district. */
  private fillBlock(
    cx: number,
    cz: number,
    cell: number,
    district: District,
    central: number,
  ): Block['buildings'] {
    const out: Block['buildings'] = [];
    const rng = this.rng;
    switch (district) {
      case 'downtown': {
        const count = rng() < 0.5 ? 1 : 2;
        for (let i = 0; i < count; i++) {
          const w = cell * (0.45 + rng() * 0.32);
          const d = cell * (0.45 + rng() * 0.32);
          const h = 46 + rng() * 132 * (1 - central * 0.45);
          out.push({ x: cx + (rng() - 0.5) * cell * 0.3, z: cz + (rng() - 0.5) * cell * 0.3, w, d, h, rot: 0, tint: 0.75 + rng() * 0.25, facade: Math.floor(rng() * 3) });
        }
        break;
      }
      case 'commercial': {
        const w = cell * (0.55 + rng() * 0.3);
        const d = cell * (0.5 + rng() * 0.3);
        const h = 18 + rng() * 38;
        out.push({ x: cx, z: cz, w, d, h, rot: 0, tint: 0.85 + rng() * 0.2, facade: Math.floor(rng() * 3) });
        break;
      }
      case 'residential': {
        const perRow = 2;
        for (let i = 0; i < perRow; i++) {
          for (let j = 0; j < perRow; j++) {
            const w = cell * (0.3 + rng() * 0.12);
            const d = cell * (0.32 + rng() * 0.12);
            const h = 8 + rng() * 10;
            out.push({
              x: cx + (i - 0.5) * cell * 0.44,
              z: cz + (j - 0.5) * cell * 0.44,
              w,
              d,
              h,
              rot: (rng() - 0.5) * 0.1,
              tint: 0.9 + rng() * 0.14,
              facade: Math.floor(rng() * 3),
            });
          }
        }
        break;
      }
      case 'industrial': {
        const w = cell * (0.7 + rng() * 0.2);
        const d = cell * (0.55 + rng() * 0.25);
        const h = 12 + rng() * 16;
        out.push({ x: cx, z: cz, w, d, h, rot: 0, tint: 0.7 + rng() * 0.2, facade: 2 });
        break;
      }
      case 'port': {
        // Warehouses plus the occasional crane mast.
        const w = cell * (0.6 + rng() * 0.3);
        const d = cell * (0.5 + rng() * 0.3);
        const h = 14 + rng() * 12;
        out.push({ x: cx, z: cz, w, d, h, rot: (rng() - 0.5) * 0.35, tint: 0.6 + rng() * 0.25, facade: 2 });
        break;
      }
      default:
        break;
    }
    return out;
  }

  // ------------------------------------------------------------- buildings

  /** Merges every building shell into a couple of geometry buckets. */
  private buildBuildings(): void {
    const buckets = new Map<string, THREE.BufferGeometry[]>();
    const push = (key: string, geo: THREE.BufferGeometry): void => {
      const list = buckets.get(key);
      if (list) list.push(geo);
      else buckets.set(key, [geo]);
    };

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const block of this.blocks) {
      const ground = this.terrain.heightAt(block.x, block.z);
      for (const b of block.buildings) {
        const base = new THREE.BoxGeometry(b.w, b.h, b.d);
        // The facade texture is authored per material, so buildings are bucketed
        // by "facade family" — three shells in total instead of one per tower.
        const uv = base.attributes.uv as THREE.BufferAttribute;
        const heightTiles = Math.max(1, Math.round(b.h / 22));
        for (let i = 0; i < uv.count; i++) {
          uv.setY(i, uv.getY(i) * heightTiles);
        }
        uv.needsUpdate = true;
        q.setFromAxisAngle(up, b.rot);
        m.compose(new THREE.Vector3(b.x, ground + b.h / 2, b.z), q, new THREE.Vector3(1, 1, 1));
        base.applyMatrix4(m);
        push(`facade-${b.facade}`, base);

        // Roof slab + parapet for a believable silhouette.
        const roof = new THREE.BoxGeometry(b.w * 1.04, 0.6, b.d * 1.04);
        m.compose(new THREE.Vector3(b.x, ground + b.h + 0.3, b.z), q, new THREE.Vector3(1, 1, 1));
        roof.applyMatrix4(m);
        push('roof', roof);

        // Ground-floor shopfront band on downtown / commercial buildings.
        if (block.district === 'downtown' || block.district === 'commercial') {
          const band = new THREE.BoxGeometry(b.w * 1.01, 4.2, b.d * 1.01);
          m.compose(new THREE.Vector3(b.x, ground + 2.1, b.z), q, new THREE.Vector3(1, 1, 1));
          band.applyMatrix4(m);
          push('podium', band);
        }

        this.cementCollision(b, ground, block.district);

        // Rooftop props.
        const props = 1 + Math.floor(this.rng() * 3);
        for (let i = 0; i < props; i++) {
          const px = b.x + (this.rng() - 0.5) * b.w * 0.6;
          const pz = b.z + (this.rng() - 0.5) * b.d * 0.6;
          const py = ground + b.h + 0.6;
          this.propMatrices.ac!.push(
            new THREE.Matrix4().compose(
              new THREE.Vector3(px, py + 0.6, pz),
              new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.rng() * Math.PI, 0)),
              new THREE.Vector3(1.2, 1.2, 1.2),
            ),
          );
        }
        if (this.rng() < 0.4) {
          this.propMatrices.antenna!.push(
            new THREE.Matrix4().compose(
              new THREE.Vector3(b.x, ground + b.h + 0.6 + 3, b.z),
              new THREE.Quaternion(),
              new THREE.Vector3(1, 1, 1),
            ),
          );
        }
      }
    }

    for (const [key, list] of buckets) {
      const merged = list.length === 1 ? list[0]! : this.mergeAll(list);
      if (!merged) continue;
      const mat =
        key === 'roof'
          ? this.library.concreteMaterial(0x8b8880)
          : key === 'podium'
            ? this.library.concreteMaterial(0x7d7a72)
            : this.library.facadeMaterial(key === 'facade-0' ? 0xf2efe8 : key === 'facade-1' ? 0xd9d4c8 : 0xbdb9b0);
      this.materials.push(mat);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `city-${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.geometries.push(merged);
      this.group.add(mesh);
    }
  }

  private mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
    // Local minimal merge to avoid an extra import path in this module.
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let offset = 0;
    for (const g of list) {
      const pos = g.attributes.position as THREE.BufferAttribute;
      const nor = g.attributes.normal as THREE.BufferAttribute;
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
        uvs.push(uv.getX(i), uv.getY(i));
      }
      const idx = g.index;
      if (idx) {
        for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset);
      } else {
        for (let i = 0; i < pos.count; i++) indices.push(i + offset);
      }
      offset += pos.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    out.setIndex(indices);
    out.computeBoundingSphere();
    return out;
  }

  /** Only buildings near the race route become collision volumes. */
  private cementCollision(
    b: { x: number; z: number; w: number; d: number; h: number },
    ground: number,
    district: District,
  ): void {
    if (district === 'park') return;
    const near = this.roads.corridorAt(b.x, b.z);
    if (!near || near.distance > 46) return;
    this.collisionBoxes.push({
      x: b.x,
      y: ground + b.h / 2,
      z: b.z,
      halfX: b.w / 2,
      halfY: b.h / 2,
      halfZ: b.d / 2,
      rotY: 0,
      tag: 'building',
    });
  }

  // ---------------------------------------------------------- street life

  /** Traffic lights, bus stops, bins, benches and palms along the streets. */
  private buildStreets(): void {
    const m = new THREE.Matrix4();
    const trafficLightGeo = new THREE.BoxGeometry(0.35, 5.2, 0.35);
    const trafficLightMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, metalness: 0.6, roughness: 0.5 });
    const signalGeo = new THREE.SphereGeometry(0.22, 8, 6);
    const signalMat = new THREE.MeshBasicMaterial({ color: 0xff5533, toneMapped: false });
    const blocks: Array<{ pos: THREE.Vector3; yaw: number }> = [];
    for (const edge of this.roads.edges) {
      if (edge.roadClass !== 'street' && edge.roadClass !== 'arterial' && edge.roadClass !== 'ramp') continue;
      const step = 52;
      const n = Math.floor(edge.length / step);
      for (let i = 0; i <= n; i++) {
        const t = n === 0 ? 0 : i / n;
        const p = edge.curve.getPointAt(t);
        const tangent = edge.curve.getTangentAt(t);
        const yaw = Math.atan2(tangent.x, tangent.z);
        const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        for (const sign of [-1, 1]) {
          if (this.rng() < 0.45) continue;
          const pos = p.clone().addScaledVector(side, sign * (edge.halfWidth + 2.1));
          blocks.push({ pos, yaw });
        }
      }
    }
    const poles = new THREE.InstancedMesh(trafficLightGeo, trafficLightMat, Math.max(1, blocks.length));
    const signals = new THREE.InstancedMesh(signalGeo, signalMat, Math.max(1, blocks.length * 3));
    let poleCount = 0;
    let signalCount = 0;
    const base = this.terrain;
    for (const b of blocks) {
      const y = base.heightAt(b.pos.x, b.pos.z);
      m.compose(new THREE.Vector3(b.pos.x, y + 2.6, b.pos.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      poles.setMatrixAt(poleCount++, m);
      for (let k = 0; k < 3; k++) {
        m.compose(new THREE.Vector3(b.pos.x, y + 4.2 + k * 0.6, b.pos.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
        signals.setMatrixAt(signalCount++, m);
      }
    }
    poles.count = poleCount;
    signals.count = signalCount;
    poles.instanceMatrix.needsUpdate = true;
    signals.instanceMatrix.needsUpdate = true;
    this.instanced.push(poles, signals);
    this.group.add(poles, signals);
  }

  /** Instanced detail props: AC units, antennas, awnings, bins, benches, palms. */
  private buildProps(): void {
    const density = this.quality.settings.detailDensity;
    if (density <= 0.25) return;
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    // Palms along the port / beach district.
    for (let i = 0; i < Math.round(140 * density); i++) {
      const a = this.rng() * Math.PI * 2;
      const r = 900 + this.rng() * 420;
      const x = 480 + Math.cos(a) * r * 0.6;
      const z = 1250 + Math.sin(a) * r * 0.5;
      const y = this.terrain.heightAt(x, z);
      if (y < -22) continue;
      q.setFromAxisAngle(up, this.rng() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 0.8 + this.rng() * 0.5, 1));
      this.propMatrices.palm!.push(m.clone());
    }
    // Street furniture on the city grid.
    for (const block of this.blocks) {
      const y = this.terrain.heightAt(block.x, block.z);
      q.setFromAxisAngle(up, this.rng() * Math.PI * 2);
      const offset = 6 + this.rng() * 8;
      m.compose(new THREE.Vector3(block.x + offset, y, block.z + offset), q, new THREE.Vector3(1, 1, 1));
      this.propMatrices.bin!.push(m.clone());
      if (this.rng() < 0.6) {
        m.compose(new THREE.Vector3(block.x - offset, y, block.z + offset * 0.5), q, new THREE.Vector3(1, 1, 1));
        this.propMatrices.bench!.push(m.clone());
      }
      if (this.rng() < 0.3) {
        m.compose(new THREE.Vector3(block.x + offset * 0.5, y, block.z - offset), q, new THREE.Vector3(1, 1, 1));
        this.propMatrices.hydrant!.push(m.clone());
      }
      if (block.district === 'commercial' || block.district === 'downtown') {
        m.compose(new THREE.Vector3(block.x, y + 3.6, block.z + 5.2), q, new THREE.Vector3(1, 1, 1));
        this.propMatrices.awning!.push(m.clone());
      }
    }

    const addInstanced = (
      key: string,
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      castShadow = true,
    ): void => {
      const list = this.propMatrices[key]!;
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mm, i) => inst.setMatrixAt(i, mm));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = castShadow && this.quality.settings.shadowMapSize > 0;
      inst.receiveShadow = true;
      this.instanced.push(inst);
      this.geometries.push(geo);
      this.materials.push(mat);
      this.group.add(inst);
    };

    addInstanced('ac', new THREE.BoxGeometry(1.4, 1.1, 1.2), new THREE.MeshStandardMaterial({ color: 0xa9adb2, metalness: 0.5, roughness: 0.6 }));
    addInstanced('antenna', new THREE.CylinderGeometry(0.09, 0.16, 6, 6), new THREE.MeshStandardMaterial({ color: 0x6f7377, metalness: 0.7, roughness: 0.5 }));
    addInstanced('awning', new THREE.BoxGeometry(6.4, 0.16, 2.4), new THREE.MeshStandardMaterial({ color: 0xb8503f, roughness: 0.75 }));
    addInstanced('bin', new THREE.CylinderGeometry(0.42, 0.36, 1.0, 8), new THREE.MeshStandardMaterial({ color: 0x3f4247, metalness: 0.3, roughness: 0.8 }));
    addInstanced('bench', new THREE.BoxGeometry(1.8, 0.12, 0.5), new THREE.MeshStandardMaterial({ color: 0x6d5641, roughness: 0.85 }));
    addInstanced('hydrant', new THREE.CylinderGeometry(0.16, 0.2, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0xb03a2a, roughness: 0.7 }));
    addInstanced(
      'palm',
      this.buildPalmGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x4c6b3a, roughness: 0.9 }),
    );
  }

  /** A cheap palm: tapered trunk + a crown of six fronds. */
  private buildPalmGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const trunk = new THREE.CylinderGeometry(0.22, 0.34, 9, 6);
    trunk.translate(0, 4.5, 0);
    parts.push(trunk);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const frond = new THREE.BoxGeometry(0.36, 0.1, 3.4);
      const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-0.5, a, 0, 'YXZ'));
      m.setPosition(Math.cos(a) * 1.5, 9.2, Math.sin(a) * 1.5);
      frond.applyMatrix4(m);
      parts.push(frond);
    }
    return this.mergeAll(parts) ?? parts[0]!;
  }

  /** Applies the active theme (realistic is the native look here). */
  setTheme(theme: 'cyberpunk' | 'realistic'): void {
    // The generator already produces PBR-suitable surfaces; the realistic
    // style is its native presentation. Emissive bands are dimmed for night.
    const night = theme === 'cyberpunk';
    for (const mat of this.materials) {
      const standard = mat as THREE.MeshStandardMaterial;
      if (standard.emissiveMap && standard.emissive) {
        standard.emissiveIntensity = night ? 0.6 : 0.0;
        standard.needsUpdate = true;
      }
    }
  }

  /** Night-time window glow (called by the style through the world). */
  setEmissiveIntensity(value: number): void {
    for (const mat of this.materials) {
      const standard = mat as THREE.MeshStandardMaterial;
      if (standard.emissiveMap) {
        standard.emissiveIntensity = value;
        standard.needsUpdate = true;
      }
    }
  }

  get buildingCount(): number {
    let n = 0;
    for (const b of this.blocks) n += b.buildings.length;
    return n;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const inst of this.instanced) inst.dispose();
    this.group.clear();
  }
}
