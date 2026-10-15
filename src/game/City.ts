import * as THREE from 'three';
import { CONFIG } from './Config';
import type { Track } from './Track';
import type { StaticBox } from './Types';
import { makeRng, pick, randRange } from './Utils';

interface BuildingRecord {
  x: number;
  y: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  rotY: number;
  variant: number;
  tint: THREE.Color;
}

const SIGN_WORDS = [
  'NEON APEX',
  'サイバー',
  'APEX CORP',
  'NOODLE 24H',
  'HYPERDRIVE',
  '夜間営業',
  'ZAIBATSU',
  'GRID RUNNER',
  'CHROME',
  'ELECTRO CITY',
];

/**
 * Procedural cyberpunk city: towers with glowing windows, neon signage,
 * holographic billboards, street lights and support structures.
 *
 * Everything is either instanced or shares a handful of generated canvas
 * textures, so the whole city costs < 40 draw calls.
 */
export class City {
  readonly group = new THREE.Group();
  /** Static collision volumes (towers close to the track + on-road neon pylons). */
  readonly collisionBoxes: StaticBox[] = [];

  private readonly rng = makeRng(913377);
  private readonly holoBillboards: THREE.Mesh[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(private readonly track: Track) {
    this.buildGround();
    const buildings = this.buildTowers();
    this.buildSigns(buildings);
    this.buildHolograms();
    this.buildStreetLights();
    this.buildNeonPointLights();
    this.buildRoadPylons();
  }

  /** Per-frame eye candy (drifting holograms, pulsing opacity). */
  update(_dt: number, elapsed: number): void {
    for (let i = 0; i < this.holoBillboards.length; i++) {
      const b = this.holoBillboards[i]!;
      b.position.y += Math.sin(elapsed * 0.7 + i) * 0.004;
      b.rotation.y += 0.0006 * (i % 2 === 0 ? 1 : -1);
      const mat = b.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.66 + Math.sin(elapsed * 1.6 + i * 1.7) * 0.16;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  // ============================================================ ground

  private buildGround(): void {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#07050f';
    ctx.fillRect(0, 0, 512, 512);
    // Neon grid
    ctx.strokeStyle = 'rgba(36,240,255,0.30)';
    ctx.lineWidth = 2;
    const cell = 64;
    for (let i = 0; i <= 512; i += cell) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 512);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(512, i);
      ctx.stroke();
    }
    // Random lit blocks (wet asphalt reflections)
    for (let i = 0; i < 260; i++) {
      const x = Math.floor(Math.random() * 8) * cell;
      const y = Math.floor(Math.random() * 8) * cell;
      ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,47,185,0.08)' : 'rgba(160,92,255,0.08)';
      ctx.fillRect(x, y, cell, cell);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(30, 30);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;

    const geo = new THREE.PlaneGeometry(2600, 2600, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      color: 0x33334d,
      roughness: 0.68,
      metalness: 0.7,
      emissive: 0x0d0720,
      emissiveIntensity: 0.3,
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = CONFIG.track.groundY;
    ground.name = 'ground';
    this.group.add(ground);
    this.disposables.push(geo, mat, tex);
  }

  // ============================================================ towers

  /** Window texture: a grid of lit/unlit windows, one canvas per colour variant. */
  private createWindowTexture(hue: number): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#05040c';
    ctx.fillRect(0, 0, 64, 64);
    const cols = 6;
    const rows = 10;
    const w = 64 / cols;
    const h = 64 / rows;
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        const lit = Math.random() < 0.42;
        if (!lit) continue;
        const l = 45 + Math.random() * 55;
        const col = new THREE.Color().setHSL(hue + randRange(-0.05, 0.05), 0.9, l / 480 + 0.1);
        ctx.fillStyle = `rgb(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)})`;
        ctx.fillRect(x * w + 0.6, y * h + 0.6, w - 1.6, h - 2.2);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 5);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  private buildTowers(): BuildingRecord[] {
    const variantCount = 4;
    const hues = [0.52, 0.83, 0.12, 0.72];
    const textures = hues.map((h) => this.createWindowTexture(h));
    const buckets: BuildingRecord[][] = Array.from({ length: variantCount }, () => []);

    // Walk the loop; every step place towers on both sides at a random depth.
    const step = 24;
    const count = Math.floor(this.track.totalLength / step);
    for (let i = 0; i < count; i++) {
      const distance = i * step + this.rng() * step * 0.5;
      const f = this.track.frameAt(distance);
      const yaw = Math.atan2(f.tangent.x, f.tangent.z);
      for (const sideSign of [-1, 1]) {
        // Two depth bands: a dense near canyon and a taller far skyline.
        const near = this.rng() < 0.62;
        const lateral = sideSign * (near ? randRange(30, 66) : randRange(74, 190));
        const width = near ? randRange(12, 26) : randRange(18, 40);
        const depth = near ? randRange(12, 26) : randRange(18, 40);
        const basePos = f.pos.clone().addScaledVector(f.side, lateral);
        const roadY = f.pos.y;
        const minHeight = roadY - CONFIG.track.groundY + randRange(8, 34);
        const height = near
          ? Math.max(minHeight, randRange(28, 86))
          : Math.max(minHeight, randRange(60, 190));
        const rec: BuildingRecord = {
          x: basePos.x,
          y: CONFIG.track.groundY,
          z: basePos.z,
          width,
          depth,
          height,
          rotY: yaw + randRange(-0.25, 0.25),
          variant: Math.floor(this.rng() * variantCount),
          tint: new THREE.Color().setHSL(0.62 + randRange(-0.15, 0.2), randRange(0.05, 0.3), randRange(0.07, 0.2)),
        };
        buckets[rec.variant]!.push(rec);

        // Towers close to the highway become real obstacles.
        if (Math.abs(lateral) < 64) {
          this.collisionBoxes.push({
            x: rec.x,
            y: rec.y + height / 2,
            z: rec.z,
            halfX: width / 2,
            halfY: height / 2,
            halfZ: depth / 2,
            rotY: rec.rotY,
            tag: 'building',
          });
        }
      }
    }

    const all: BuildingRecord[] = [];
    buckets.forEach((records, variant) => {
      if (records.length === 0) return;
      // Unit box anchored at its base so per-instance Y scale == height.
      const geo = new THREE.BoxGeometry(1, 1, 1);
      geo.translate(0, 0.5, 0);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x141227,
        emissive: 0xffffff,
        emissiveMap: textures[variant]!,
        emissiveIntensity: 0.95,
        roughness: 0.82,
        metalness: 0.35,
      });
      const inst = new THREE.InstancedMesh(geo, mat, records.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const scale = new THREE.Vector3();
      const pos = new THREE.Vector3();
      records.forEach((rec, i) => {
        pos.set(rec.x, rec.y, rec.z);
        q.setFromAxisAngle(up, rec.rotY);
        scale.set(rec.width, rec.height, rec.depth);
        m.compose(pos, q, scale);
        inst.setMatrixAt(i, m);
        inst.setColorAt(i, rec.tint);
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.name = `towers-${variant}`;
      this.group.add(inst);
      this.disposables.push(geo, mat, textures[variant]!);
      all.push(...records);

      // Neon crown strip near the top of every tower.
      const crownGeo = new THREE.BoxGeometry(1, 1.6, 1);
      const crownMat = new THREE.MeshBasicMaterial({ vertexColors: false, toneMapped: false, color: 0xffffff });
      const crowns = new THREE.InstancedMesh(crownGeo, crownMat, records.length);
      const colors = [new THREE.Color(0x24f0ff), new THREE.Color(0xff2fb9), new THREE.Color(0xa05cff), new THREE.Color(0xb6ff3a)];
      records.forEach((rec, i) => {
        pos.set(rec.x, rec.y + rec.height * randRange(0.72, 0.96), rec.z);
        q.setFromAxisAngle(up, rec.rotY);
        scale.set(rec.width * 1.02, 2.4, rec.depth * 1.02);
        m.compose(pos, q, scale);
        crowns.setMatrixAt(i, m);
        crowns.setColorAt(i, pick(colors));
      });
      crowns.instanceMatrix.needsUpdate = true;
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
      this.group.add(crowns);
      this.disposables.push(crownGeo, crownMat);
    });

    return all;
  }

  // ============================================================ signage

  private createSignTexture(word: string, color: string): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(4,2,12,0.92)';
    ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = color;
    ctx.lineWidth = 8;
    ctx.strokeRect(6, 6, 500, 116);
    ctx.font = 'bold 62px Impact, "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 30;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(word, 256, 68, 470);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Billboards mounted on facades, facing the highway. */
  private buildSigns(buildings: BuildingRecord[]): void {
    const palette = ['#24f0ff', '#ff2fb9', '#b6ff3a', '#a05cff'];
    const textures = [0, 1, 2, 3].map((i) => this.createSignTexture(SIGN_WORDS[i]!, palette[i]!));
    const geo = new THREE.PlaneGeometry(1, 1);
    // Roughly a third of the towers carry a billboard, split across 4 shared textures.
    const groups: BuildingRecord[][] = [[], [], [], []];
    for (const b of buildings) {
      if (b.height < 30 || this.rng() > 0.34) continue;
      groups[Math.floor(this.rng() * 4)]!.push(b);
    }
    groups.forEach((list, i) => {
      if (list.length === 0) return;
      const mat = new THREE.MeshBasicMaterial({
        map: textures[i]!,
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      list.forEach((b, k) => {
        // Face the building toward the loop centre so the sign is visible from the road.
        const toCentre = new THREE.Vector2(-b.x, -b.z).normalize();
        const angle = Math.atan2(toCentre.x, toCentre.y);
        const w = randRange(10, 20);
        const h = w * 0.25;
        const y = b.y + randRange(b.height * 0.35, b.height * 0.9);
        const r = Math.hypot(b.x, b.z) - randRange(b.width, b.depth) * 0.5 - 0.6;
        const p = new THREE.Vector3(toCentre.x * r, y, toCentre.y * r);
        q.setFromAxisAngle(up, angle);
        m.compose(p, q, new THREE.Vector3(w, h, 1));
        inst.setMatrixAt(k, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
      this.disposables.push(mat, textures[i]!);
    });
  }

  private buildHolograms(): void {
    const words = ['NEON APEX', 'サイバーシティ', 'APEX CORP'];
    const colors = ['#ff2fb9', '#24f0ff', '#b6ff3a'];
    for (let i = 0; i < 6; i++) {
      const tex = this.createSignTexture(words[i % words.length]!, colors[i % colors.length]!);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(70, 18), mat);
      const distance = (i / 6) * this.track.totalLength + 40;
      const f = this.track.frameAt(distance);
      const sideSign = i % 2 === 0 ? 1 : -1;
      mesh.position.copy(f.pos).addScaledVector(f.side, sideSign * randRange(60, 110));
      mesh.position.y += randRange(40, 95);
      mesh.rotation.y = Math.atan2(f.side.x, f.side.z) + (sideSign > 0 ? Math.PI : 0);
      this.group.add(mesh);
      this.holoBillboards.push(mesh);
      this.disposables.push(mat, tex, mesh.geometry as THREE.PlaneGeometry);
    }
  }

  private buildStreetLights(): void {
    const step = 32;
    const count = Math.floor(this.track.totalLength / step) * 2;
    const poleGeo = new THREE.CylinderGeometry(0.28, 0.36, 12, 6);
    poleGeo.translate(0, 6, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x161428, roughness: 0.8, metalness: 0.6 });
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, count);
    const headGeo = new THREE.BoxGeometry(2.6, 0.5, 1.2);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xcfe8ff, toneMapped: false });
    const heads = new THREE.InstancedMesh(headGeo, headMat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let idx = 0;
    for (let i = 0; i < count / 2; i++) {
      const d = i * step;
      const f = this.track.frameAt(d);
      for (const sign of [-1, 1]) {
        const p = f.pos.clone().addScaledVector(f.side, sign * 24);
        p.y = CONFIG.track.groundY;
        q.setFromAxisAngle(up, Math.atan2(f.tangent.x, f.tangent.z));
        m.compose(p, q, new THREE.Vector3(1, 1, 1));
        poles.setMatrixAt(idx, m);
        const head = p.clone();
        head.y = CONFIG.track.groundY + 12;
        m.compose(head, q, new THREE.Vector3(1, 1, 1));
        heads.setMatrixAt(idx, m);
        idx++;
      }
    }
    poles.count = idx;
    heads.count = idx;
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    this.group.add(poles, heads);
    this.disposables.push(poleGeo, poleMat, headGeo, headMat);
  }

  /** A small number of real point lights placed along the loop (perf budget). */
  private buildNeonPointLights(): void {
    const total = 8;
    const colors = [0x24f0ff, 0xff2fb9, 0xa05cff, 0xb6ff3a];
    for (let i = 0; i < total; i++) {
      const f = this.track.frameAt((i / total) * this.track.totalLength + 30);
      const light = new THREE.PointLight(colors[i % colors.length]!, 520, 140, 2);
      light.position.copy(f.pos).addScaledVector(f.side, i % 2 === 0 ? 12 : -12);
      light.position.y += 9;
      this.group.add(light);
    }
  }

  /**
   * Neon pylons standing on the road shoulder — these are the "hittable"
   * roadside structures that make collisions readable during a race.
   */
  private buildRoadPylons(): void {
    const spacing = 150;
    const total = Math.max(6, Math.floor(this.track.totalLength / spacing));
    const geo = new THREE.BoxGeometry(1.2, 5.4, 1.2);
    geo.translate(0, 2.7, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x232035,
      emissive: 0xff2fb9,
      emissiveIntensity: 0.85,
      roughness: 0.45,
      metalness: 0.7,
    });
    const inst = new THREE.InstancedMesh(geo, mat, total * 2);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let idx = 0;
    for (let i = 0; i < total; i++) {
      const d = (i + 0.5) * spacing + 25;
      const f = this.track.frameAt(d);
      for (const sign of [-1, 1]) {
        if (this.rng() < 0.35) continue; // leave gaps so it never feels like a wall
        const lateral = sign * (this.track.halfWidth - 1.4);
        const p = f.pos.clone().addScaledVector(f.side, lateral);
        q.setFromAxisAngle(up, Math.atan2(f.tangent.x, f.tangent.z));
        m.compose(p, q, new THREE.Vector3(1, 1, 1));
        inst.setMatrixAt(idx++, m);
        this.collisionBoxes.push({
          x: p.x,
          y: p.y + 2.7,
          z: p.z,
          halfX: 0.62,
          halfY: 2.7,
          halfZ: 0.62,
          rotY: Math.atan2(f.tangent.x, f.tangent.z),
          tag: 'pylon',
        });
      }
    }
    inst.count = idx;
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
    this.disposables.push(geo, mat);
  }
}
