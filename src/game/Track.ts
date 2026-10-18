import * as THREE from 'three';
import { CONFIG } from './Config';
import { makeRng, randRange } from './Utils';
import type { RaceWorld } from './world/RaceWorld';
import {
  SplinePath,
  type BoostPad,
  type Checkpoint,
  type TrackProjection,
  type TrackSample,
} from './world/SplinePath';

export type { TrackSample, BoostPad, Checkpoint, TrackProjection } from './world/SplinePath';

/**
 * Procedural closed-loop elevated highway.
 *
 * The geometry is generated from a closed CatmullRom curve; every gameplay
 * system (AI, lap logic, collision, camera hints) uses the arc-length
 * parameterisation exposed by this class, so the road ribbon and the logic can
 * never drift apart.
 */
export class Track extends SplinePath implements RaceWorld {
  readonly id = 'circuit' as const;
  readonly label = 'CIRCUIT / 赛道';
  readonly curve: THREE.CatmullRomCurve3;
  /** Meshes whose material uses vertex colours and must be disposed on reset. */
  private disposables: Array<THREE.BufferGeometry> = [];
  private readonly rng = makeRng(20261006);

  constructor() {
    super();
    // ---------------------------------------------------------------- curve
    const controlPoints: THREE.Vector3[] = [];
    const segments = 26;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      // Three harmonics: long straights, hairpins and an extra S-bend layer
      // from the 5th harmonic (verified non-self-intersecting — see
      // tools/validate-track.mjs before changing these numbers).
      const radius = 236 + Math.sin(a * 3) * 52 + Math.cos(a * 2 + 1.15) * 38 + Math.sin(a * 5 + 0.8) * 16;
      const y =
        Math.sin(a * 2 + 0.4) * CONFIG.track.elevation +
        Math.cos(a * 3) * CONFIG.track.elevation * 0.45 +
        Math.sin(a * 4 + 1.3) * CONFIG.track.elevation * 0.3;
      controlPoints.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
    }
    this.curve = new THREE.CatmullRomCurve3(controlPoints, true, 'catmullrom', 0.5);
    this.halfWidth = CONFIG.track.halfWidth;

    // ------------------------------------------------- evenly spaced samples
    this.buildSamples(this.curve, CONFIG.track.samples);

    // Ground sits 1.5 m below the deepest deck underside.
    let minY = Infinity;
    for (const s of this.samples) minY = Math.min(minY, s.pos.y);
    this.groundY = minY - CONFIG.track.skirtDepth - 1.5;

    this.buildRoad();
    this.buildNeonEdges();
    this.buildPillars();
    this.buildBoostPads();
    this.buildCheckpoints();
    this.buildStartLine();
  }

  /** Dispose all generated geometry. */
  override dispose(): void {
    for (const g of this.disposables) g.dispose();
    this.disposables = [];
  }

  // ======================================================== construction

  /**
   * Builds a ribbon between two lateral/height offsets of the centre line.
   * Used for the road surface, neon trims, guard rails and skirts.
   */
  private buildStrip(
    offsetA: number,
    heightA: number,
    offsetB: number,
    heightB: number,
    vScale: number,
    colorFn?: (index: number, sample: TrackSample) => THREE.Color | null,
  ): THREE.BufferGeometry {
    const n = this.samples.length;
    const vertsPerRow = 2;
    const positions = new Float32Array(n * vertsPerRow * 3);
    const uvs = new Float32Array(n * vertsPerRow * 2);
    const colors = colorFn ? new Float32Array(n * vertsPerRow * 3) : null;
    const indices: number[] = [];

    for (let i = 0; i < n; i++) {
      const s = this.samples[i]!;
      const pa = s.pos.clone().addScaledVector(s.side, offsetA).addScaledVector(s.normal, heightA);
      const pb = s.pos.clone().addScaledVector(s.side, offsetB).addScaledVector(s.normal, heightB);
      const base = i * vertsPerRow;
      positions.set([pa.x, pa.y, pa.z], base * 3);
      positions.set([pb.x, pb.y, pb.z], (base + 1) * 3);
      const v = s.distance / vScale;
      uvs.set([0, v], base * 2);
      uvs.set([1, v], (base + 1) * 2);
      if (colors && colorFn) {
        const c = colorFn(i, s) ?? new THREE.Color(1, 1, 1);
        colors.set([c.r, c.g, c.b], base * 3);
        colors.set([c.r, c.g, c.b], (base + 1) * 3);
      }
    }
    for (let i = 0; i < n; i++) {
      const i0 = i * vertsPerRow;
      const i1 = ((i + 1) % n) * vertsPerRow;
      // winding chosen so the surface faces up
      indices.push(i0, i0 + 1, i1 + 1, i0, i1 + 1, i1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (colors) geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    this.disposables.push(geo);
    return geo;
  }

  /** Procedural asphalt texture with lane markings (canvas based, no assets). */
  private createRoadTexture(): THREE.CanvasTexture {
    const w = 128;
    const h = 512;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#15131f';
    ctx.fillRect(0, 0, w, h);

    // Asphalt noise
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const g = 18 + Math.random() * 26;
      ctx.fillStyle = `rgba(${g + 8},${g + 4},${g + 20},${0.25 + Math.random() * 0.4})`;
      ctx.fillRect(x, y, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }
    // Faint tyre lines
    ctx.fillStyle = 'rgba(60,58,84,0.35)';
    ctx.fillRect(w * 0.26, 0, 6, h);
    ctx.fillRect(w * 0.68, 0, 6, h);

    // Dashed centre line
    ctx.fillStyle = 'rgba(210,225,255,0.55)';
    const dash = 40;
    for (let y = 0; y < h; y += dash * 2) {
      ctx.fillRect(w / 2 - 2, y, 4, dash);
    }
    // Neon edge lines painted into the texture (backup for the glow strips)
    ctx.fillStyle = 'rgba(36,240,255,0.55)';
    ctx.fillRect(4, 0, 3, h);
    ctx.fillStyle = 'rgba(255,47,185,0.55)';
    ctx.fillRect(w - 7, 0, 3, h);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, this.totalLength / 26);
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildRoad(): void {
    const hw = this.halfWidth;
    const geo = this.buildStrip(-hw, 0, hw, 0, 26);
    const tex = this.createRoadTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      color: 0x8a8aa6,
      roughness: 0.88,
      metalness: 0.2,
      envMapIntensity: 0.5,
    });
    const road = new THREE.Mesh(geo, mat);
    road.name = 'road';
    road.receiveShadow = false;
    this.group.add(road);

    // Under-side + skirts so the highway reads as a solid elevated slab.
    const bottom = this.buildStrip(hw, -CONFIG.track.skirtDepth, -hw, -CONFIG.track.skirtDepth, 40);
    const bottomMat = new THREE.MeshStandardMaterial({ color: 0x0a0918, roughness: 0.95, metalness: 0.1 });
    const underside = new THREE.Mesh(bottom, bottomMat);
    underside.name = 'road-underside';
    this.group.add(underside);

    const skirtMat = new THREE.MeshStandardMaterial({ color: 0x191631, roughness: 0.8, metalness: 0.35 });
    const skirtL = this.buildStrip(-hw, 0, -hw, -CONFIG.track.skirtDepth, 40);
    const skirtR = this.buildStrip(hw, -CONFIG.track.skirtDepth, hw, 0, 40);
    for (const geo of [skirtL, skirtR]) {
      const skirt = new THREE.Mesh(geo, skirtMat);
      skirt.name = 'road-skirt';
      this.group.add(skirt);
    }
  }

  /** Bright neon trims + guard rails, all vertex-coloured so bloom picks them up. */
  private buildNeonEdges(): void {
    const hw = this.halfWidth;

    // Road edge glow strips (cyan right, magenta left) — slightly above the surface.
    const rightGeo = this.buildStrip(hw - 0.9, 0.035, hw - 0.15, 0.035, 10, () => new THREE.Color(0x66f6ff));
    const leftGeo = this.buildStrip(-hw + 0.15, 0.035, -hw + 0.9, 0.035, 10, () => new THREE.Color(0xff7ad4));
    const edgeMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    for (const geo of [rightGeo, leftGeo]) {
      const strip = new THREE.Mesh(geo, edgeMat);
      strip.name = 'neon-strip';
      this.group.add(strip);
    }

    // Guard rail bars: alternating neon colour per 90 m block.
    const railGeoLeft = this.buildStrip(-hw + 0.35, 1.05, -hw + 0.35, 1.45, 12, (i, s) => {
      const block = Math.floor(s.distance / 90);
      return new THREE.Color(block % 2 === 0 ? 0xff2fb9 : 0xa05cff);
    });
    const railGeoTop = this.buildStrip(-hw + 0.35, 1.45, -hw + 0.9, 1.45, 12, (i, s) => {
      const block = Math.floor(s.distance / 90);
      return new THREE.Color(block % 2 === 0 ? 0xff2fb9 : 0xa05cff);
    });
    const railGeoRight = this.buildStrip(hw - 0.35, 1.05, hw - 0.35, 1.45, 12, (i, s) => {
      const block = Math.floor(s.distance / 90);
      return new THREE.Color(block % 2 === 0 ? 0x24f0ff : 0x5cffd0);
    });
    const railGeoTopR = this.buildStrip(hw - 0.35, 1.45, hw - 0.9, 1.45, 12, (i, s) => {
      const block = Math.floor(s.distance / 90);
      return new THREE.Color(block % 2 === 0 ? 0x24f0ff : 0x5cffd0);
    });
    const railMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide });
    for (const geo of [railGeoLeft, railGeoTop, railGeoRight, railGeoTopR]) {
      const rail = new THREE.Mesh(geo, railMat);
      rail.name = 'neon-strip';
      this.group.add(rail);
    }

    // Guard rail posts (instanced) for parallax speed cues.
    const postGeo = new THREE.BoxGeometry(0.22, 1.55, 0.22);
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x2a2740,
      emissive: 0x1b6f8a,
      emissiveIntensity: 0.7,
      roughness: 0.5,
      metalness: 0.6,
    });
    const step = CONFIG.track.railStep;
    const count = Math.floor(this.totalLength / step);
    const posts = new THREE.InstancedMesh(postGeo, postMat, count * 2);
    posts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let idx = 0;
    for (let i = 0; i < count; i++) {
      const d = i * step;
      const f = this.frameAt(d);
      const yaw = Math.atan2(f.tangent.x, f.tangent.z);
      q.setFromAxisAngle(up, yaw);
      for (const sign of [-1, 1]) {
        const p = f.pos.clone().addScaledVector(f.side, sign * (this.halfWidth - 0.35));
        p.y += 0.75;
        m.compose(p, q, new THREE.Vector3(1, 1, 1));
        posts.setMatrixAt(idx++, m);
      }
    }
    posts.count = idx;
    posts.instanceMatrix.needsUpdate = true;
    posts.name = 'rail-post';
    this.group.add(posts);

    // Under-glow strips below the skirt for the "floating highway" look.
    const underL = this.buildStrip(-hw + 0.3, -CONFIG.track.skirtDepth + 0.4, -hw + 1.3, -CONFIG.track.skirtDepth + 0.4, 14, () => new THREE.Color(0x2a7bff));
    const underR = this.buildStrip(hw - 1.3, -CONFIG.track.skirtDepth + 0.4, hw - 0.3, -CONFIG.track.skirtDepth + 0.4, 14, () => new THREE.Color(0x9a2bff));
    for (const geo of [underL, underR]) {
      const under = new THREE.Mesh(geo, edgeMat);
      under.name = 'neon-strip';
      this.group.add(under);
    }
  }

  /** Support pillars from the road down to the city floor. */
  private buildPillars(): void {
    const count = CONFIG.track.pillars;
    const geo = new THREE.BoxGeometry(2.2, 1, 2.2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x141227, roughness: 0.9, metalness: 0.3 });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const groundY = this.groundY;
    for (let i = 0; i < count; i++) {
      const d = (i / count) * this.totalLength;
      const f = this.frameAt(d);
      const top = f.pos.y - CONFIG.track.skirtDepth;
      const bottom = groundY;
      const height = Math.max(1, top - bottom);
      const p = f.pos.clone();
      p.y = bottom + height / 2;
      q.setFromAxisAngle(up, Math.atan2(f.tangent.x, f.tangent.z));
      m.compose(p, q, new THREE.Vector3(1, height, 1));
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.name = 'road-pillar';
    this.group.add(inst);
  }

  private createChevronTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.clearRect(0, 0, 128, 256);
    ctx.strokeStyle = '#b6ff3a';
    ctx.lineWidth = 12;
    ctx.shadowColor = '#b6ff3a';
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
    return tex;
  }

  /** Glowing speed pads: 8 of them, randomly offset across the road. */
  private buildBoostPads(): void {
    const tex = this.createChevronTexture();
    const total = CONFIG.track.boostPads;
    for (let i = 0; i < total; i++) {
      const distance = ((i + 0.45) / total) * this.totalLength + randRange(-14, 14);
      const lateral = randRange(-3.6, 3.6);
      const halfLength = 6;
      const halfWidth = 3.6;
      const geo = new THREE.PlaneGeometry(halfWidth * 2, halfLength * 2);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const f = this.frameAt(distance);
      const normal = new THREE.Vector3().crossVectors(f.side, f.tangent).normalize();
      // Sit the pad on the road surface and orient it with the track frame, so
      // the chevron apex (local +Y) points exactly down the driving direction
      // and the plane hugs the road on slopes instead of clipping into it.
      mesh.position
        .copy(f.pos)
        .addScaledVector(f.side, lateral)
        .addScaledVector(normal, 0.06);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.side, f.tangent, normal));
      mesh.name = 'boost-pad';
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.boostPads.push({ distance, lateral, halfLength, halfWidth, mesh });
    }
  }

  /** Neon gates every 1/N of the loop. */
  private buildCheckpoints(): void {
    const total = CONFIG.track.checkpoints;
    const postGeo = new THREE.BoxGeometry(0.5, 7.4, 0.5);
    const barGeo = new THREE.BoxGeometry(this.halfWidth * 2 + 1.2, 0.5, 0.5);
    for (let i = 0; i < total; i++) {
      const distance = (i / total) * this.totalLength;
      const f = this.frameAt(distance);
      const isStart = i === 0;
      const color = isStart ? 0xb6ff3a : i % 2 === 0 ? 0x24f0ff : 0xff2fb9;
      const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
      const gate = new THREE.Group();
      for (const sign of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, mat);
        post.position.copy(f.pos).addScaledVector(f.side, sign * (this.halfWidth + 0.4));
        post.position.y += 3.7;
        gate.add(post);
      }
      const bar = new THREE.Mesh(barGeo, mat);
      bar.position.copy(f.pos);
      bar.position.y += 7.3;
      bar.rotation.y = Math.atan2(f.tangent.x, f.tangent.z);
      gate.add(bar);
      gate.name = 'checkpoint-gate';
      this.group.add(gate);
      this.checkpoints.push({ distance, mesh: gate });
    }
  }

  /** Checkered start/finish line + overhead banner. */
  private buildStartLine(): void {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    const cell = 16;
    for (let y = 0; y < c.height; y += cell) {
      for (let x = 0; x < c.width; x += cell) {
        const on = ((x / cell) + (y / cell)) % 2 === 0;
        ctx.fillStyle = on ? '#f2f6ff' : '#0b0a14';
        ctx.fillRect(x, y, cell, cell);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(this.halfWidth * 2, 6);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, metalness: 0.1 });
    const f = this.frameAt(0);
    const normal = new THREE.Vector3().crossVectors(f.side, f.tangent).normalize();
    const line = new THREE.Mesh(geo, mat);
    line.name = 'start-line';
    // Orient with the track frame: the 6 m axis follows the driving direction
    // exactly and the plane sits parallel to the road, so it neither skews on
    // diagonal segments nor clips into the deck on slopes (same fix as the
    // boost pads).
    line.position.copy(f.pos).addScaledVector(normal, 0.06);
    line.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.side, f.tangent, normal));
    this.group.add(line);

    // Banner
    const bannerCanvas = document.createElement('canvas');
    bannerCanvas.width = 512;
    bannerCanvas.height = 128;
    const bctx = bannerCanvas.getContext('2d')!;
    bctx.fillStyle = 'rgba(6,3,18,0.9)';
    bctx.fillRect(0, 0, 512, 128);
    bctx.strokeStyle = '#24f0ff';
    bctx.lineWidth = 6;
    bctx.strokeRect(4, 4, 504, 120);
    bctx.font = 'bold 62px Impact, Arial Black, sans-serif';
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
    bctx.shadowColor = '#ff2fb9';
    bctx.shadowBlur = 26;
    bctx.fillStyle = '#ffffff';
    bctx.fillText('START / FINISH', 256, 66);
    const btex = new THREE.CanvasTexture(bannerCanvas);
    btex.colorSpace = THREE.SRGBColorSpace;
    const bmat = new THREE.MeshBasicMaterial({ map: btex, transparent: true, toneMapped: false, side: THREE.DoubleSide });
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(26, 6.5), bmat);
    banner.name = 'neon-sign';
    banner.position.copy(f.pos).addScaledVector(new THREE.Vector3(0, 1, 0), 10.2);
    // +PI so the readable face points back down the track towards the drivers.
    banner.rotation.y = Math.atan2(f.tangent.x, f.tangent.z) + Math.PI;
    this.group.add(banner);
  }
}
