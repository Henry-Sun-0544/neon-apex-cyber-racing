import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialLibrary } from '../MaterialLibrary';
import type { QualitySettings } from '../QualityManager';
import type { RoadEdge } from './RoadNetwork';
import type { TerrainSystem } from './TerrainSystem';

/** Orthonormal frame along a road centre line. */
export interface RoadFrame {
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
  side: THREE.Vector3;
  normal: THREE.Vector3;
}

/** Everything one edge contributes, bucketed by material for cheap merging. */
export interface EdgeGeometry {
  asphalt: THREE.BufferGeometry[];
  markings: THREE.BufferGeometry[];
  rails: THREE.BufferGeometry[];
  concrete: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  lampMatrices: THREE.Matrix4[];
  studMatrices: THREE.Matrix4[];
  /** Tunnel shells (rendered back-side). */
  tunnel: THREE.BufferGeometry[];
  /** Deck support piers. */
  piers: THREE.BufferGeometry[];
  /** Suspension cables (line segments). */
  cables: THREE.BufferGeometry | null;
}

function emptyEdge(): EdgeGeometry {
  return {
    asphalt: [],
    markings: [],
    rails: [],
    concrete: [],
    glass: [],
    lampMatrices: [],
    studMatrices: [],
    tunnel: [],
    piers: [],
    cables: null,
  };
}

/**
 * Builds a ribbon between two lateral offsets of a run of frames.
 * `heightA/heightB` are measured along the frame normal so the strip follows
 * banking and slope exactly.
 */
export function ribbon(
  frames: RoadFrame[],
  offsetA: number,
  heightA: number,
  offsetB: number,
  heightB: number,
  vScale: number,
): THREE.BufferGeometry {
  const n = frames.length;
  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const indices: number[] = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    const f = frames[i]!;
    if (i > 0) run += f.pos.distanceTo(frames[i - 1]!.pos);
    const pa = f.pos.clone().addScaledVector(f.side, offsetA).addScaledVector(f.normal, heightA);
    const pb = f.pos.clone().addScaledVector(f.side, offsetB).addScaledVector(f.normal, heightB);
    positions.set([pa.x, pa.y, pa.z], i * 6);
    positions.set([pb.x, pb.y, pb.z], i * 6 + 3);
    const v = run / vScale;
    uvs.set([0, v], i * 4);
    uvs.set([1, v], i * 4 + 2);
  }
  for (let i = 0; i < n - 1; i++) {
    const i0 = i * 2;
    const i1 = (i + 1) * 2;
    indices.push(i0, i0 + 1, i1 + 1, i0, i1 + 1, i1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** A quad lying flat on the road surface (lane markings, studs, lights). */
function flatQuad(centre: THREE.Vector3, side: THREE.Vector3, tangent: THREE.Vector3, halfLen: number, halfWide: number): THREE.BufferGeometry {
  const p = [
    centre.clone().addScaledVector(tangent, halfLen).addScaledVector(side, -halfWide),
    centre.clone().addScaledVector(tangent, halfLen).addScaledVector(side, halfWide),
    centre.clone().addScaledVector(tangent, -halfLen).addScaledVector(side, halfWide),
    centre.clone().addScaledVector(tangent, -halfLen).addScaledVector(side, -halfWide),
  ];
  const positions = new Float32Array(12);
  for (let i = 0; i < 4; i++) positions.set([p[i]!.x, p[i]!.y, p[i]!.z], i * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return geo;
}

/** Axis-aligned box transformed into place, returned as a geometry. */
function boxAt(
  centre: THREE.Vector3,
  size: THREE.Vector3,
  yaw: number,
  pitch = 0,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  m.setPosition(centre);
  geo.applyMatrix4(m);
  return geo;
}

/** Samples the curve of an edge at a fixed arc-length-ish spacing. */
export function sampleEdgeFrames(edge: RoadEdge, spacing: number): RoadFrame[] {
  const divisions = Math.max(4, Math.round(edge.length / spacing));
  const frames: RoadFrame[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= divisions; i++) {
    const t = i / divisions;
    const pos = edge.curve.getPointAt(t);
    const tangent = edge.curve.getTangentAt(t).normalize();
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize();
    const normal = new THREE.Vector3().crossVectors(side, tangent).normalize();
    // Bank the road into the corner: a real road is not a flat ribbon.
    const curvature = edge.curve.getTangentAt(Math.min(1, t + 0.01)).angleTo(edge.curve.getTangentAt(Math.max(0, t - 0.01)));
    const bank = THREE.MathUtils.clamp(curvature * 22, -0.09, 0.09) * (edge.roadClass === 'race' || edge.roadClass === 'highway' ? 1 : 0.4);
    frames.push({ pos, tangent, side, normal: normal.clone().applyAxisAngle(tangent, bank) });
  }
  return frames;
}

/**
 * Turns one road edge into geometry.
 *
 * The same generator covers every road class: the difference is which details
 * are switched on (lanes, rails, lamps, studs, tunnel shell, bridge deck), so
 * a mountain hairpin, a city street and an 8-lane highway all come from one
 * code path.
 */
export function buildEdgeGeometry(
  edge: RoadEdge,
  terrain: TerrainSystem,
  materials: MaterialLibrary,
  quality: QualitySettings,
): EdgeGeometry {
  const out = emptyEdge();
  const spacing = edge.roadClass === 'race' ? 5 : edge.roadClass === 'trail' ? 12 : 8;
  const frames = sampleEdgeFrames(edge, spacing);
  const hw = edge.halfWidth;
  const detail = quality.detailDensity;
  const vScale = 26;

  // -------------------------------------------------------------- surface
  out.asphalt.push(ribbon(frames, -hw, 0, hw, 0, vScale));
  // Shoulders / kerbs: a slightly raised edge that reads as a real cross-section.
  if (edge.roadClass !== 'trail') {
    out.concrete.push(ribbon(frames, -hw - 0.9, 0.06, -hw, 0.0, 14));
    out.concrete.push(ribbon(frames, hw, 0.0, hw + 0.9, 0.06, 14));
    // Sidewalk on urban classes.
    if (edge.roadClass === 'street' || edge.roadClass === 'arterial') {
      out.concrete.push(ribbon(frames, -hw - 3.4, 0.06, -hw - 0.9, 0.06, 14));
      out.concrete.push(ribbon(frames, hw + 0.9, 0.06, hw + 3.4, 0.06, 14));
    }
  }

  // --------------------------------------------------------- lane markings
  const lineW = 0.16;
  const dash = edge.roadClass === 'street' || edge.roadClass === 'arterial';
  // Edge lines.
  out.markings.push(ribbon(frames, -hw + 0.34, 0.015, -hw + 0.34 + lineW, 0.015, 6));
  out.markings.push(ribbon(frames, hw - 0.34 - lineW, 0.015, hw - 0.34, 0.015, 6));
  // Centre: double solid for highways, dashed for streets.
  if (dash) {
    const step = Math.max(1, Math.round(6 / spacing));
    for (let i = 0; i < frames.length - step; i += step * 2) {
      const a = frames[i]!;
      const b = frames[i + step]!;
      const centre = a.pos.clone().lerp(b.pos, 0.5).addScaledVector(a.normal, 0.02);
      const tangent = b.pos.clone().sub(a.pos).normalize();
      out.markings.push(flatQuad(centre, a.side, tangent, a.pos.distanceTo(b.pos) / 2, lineW / 2));
    }
  } else {
    out.markings.push(ribbon(frames, -0.12, 0.015, 0.12, 0.015, 6));
  }
  // Lane dividers between lanes of the same direction.
  for (let lane = 1; lane < edge.lanes; lane++) {
    const off = (hw * 2 * lane) / (edge.lanes * 2);
    for (const sign of [-1, 1]) {
      const o = sign * (0.35 + off);
      const step = Math.max(1, Math.round(7 / spacing));
      for (let i = 0; i < frames.length - step; i += step * 2) {
        const a = frames[i]!;
        const b = frames[i + step]!;
        const centre = a.pos
          .clone()
          .lerp(b.pos, 0.5)
          .addScaledVector(a.side, o)
          .addScaledVector(a.normal, 0.02);
        const tangent = b.pos.clone().sub(a.pos).normalize();
        out.markings.push(flatQuad(centre, a.side, tangent, a.pos.distanceTo(b.pos) / 2, lineW / 2));
      }
    }
  }

  // ------------------------------------------------------- reflective studs
  if (edge.roadClass === 'race' || edge.roadClass === 'highway') {
    const step = Math.max(1, Math.round(9 / spacing));
    for (let i = 0; i < frames.length; i += step) {
      const f = frames[i]!;
      for (const sign of [-1, 1]) {
        const m = new THREE.Matrix4().compose(
          f.pos.clone().addScaledVector(f.side, sign * (hw - 0.55)).addScaledVector(f.normal, 0.05),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(f.tangent.x, f.tangent.z), 0)),
          new THREE.Vector3(1, 1, 1),
        );
        out.studMatrices.push(m);
      }
    }
  }

  // ------------------------------------------------------------- guardrails
  if (edge.roadClass === 'race' || edge.roadClass === 'highway' || edge.roadClass === 'mountain' || edge.roadClass === 'coastal') {
    for (const sign of [-1, 1]) {
      const o = sign * (hw + 0.35);
      out.rails.push(ribbon(frames, o, 0.55, o, 0.95, 12));
      out.rails.push(ribbon(frames, o - sign * 0.12, 0.5, o, 0.55, 12));
      // Posts, merged as boxes every ~7 m.
      const step = Math.max(1, Math.round(7 / spacing));
      for (let i = 0; i < frames.length; i += step) {
        const f = frames[i]!;
        const centre = f.pos.clone().addScaledVector(f.side, o).addScaledVector(f.normal, 0.35);
        out.rails.push(boxAt(centre, new THREE.Vector3(0.18, 0.98, 0.18), Math.atan2(f.tangent.x, f.tangent.z)));
      }
    }
  }

  // ---------------------------------------------------------- street lamps
  if ((edge.roadClass === 'street' || edge.roadClass === 'arterial' || edge.roadClass === 'highway' || edge.roadClass === 'coastal') && detail > 0.3) {
    const step = Math.max(1, Math.round(38 / spacing));
    for (let i = 0; i < frames.length; i += step) {
      const f = frames[i]!;
      const sign = (Math.floor(i / step) % 2 === 0 ? 1 : -1) as 1 | -1;
      const base = f.pos.clone().addScaledVector(f.side, sign * (hw + 1.6));
      const yaw = Math.atan2(f.tangent.x, f.tangent.z);
      // Pole, arm and head.
      out.concrete.push(boxAt(base.clone().add(new THREE.Vector3(0, 4.4, 0)), new THREE.Vector3(0.24, 8.8, 0.24), yaw));
      out.concrete.push(
        boxAt(base.clone().addScaledVector(f.side, -sign * 1.1).add(new THREE.Vector3(0, 8.7, 0)), new THREE.Vector3(2.4, 0.2, 0.2), yaw),
      );
      const headPos = base.clone().addScaledVector(f.side, -sign * 2.1).add(new THREE.Vector3(0, 8.5, 0));
      out.lampMatrices.push(
        new THREE.Matrix4().compose(
          headPos,
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
          new THREE.Vector3(1, 1, 1),
        ),
      );
    }
  }

  // ----------------------------------------------------------- tunnel shell
  if (edge.tunnel) {
    const segments = 12;
    const radius = hw + 3.2;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      // Half-arch: from the left kerb, over the top, to the right kerb.
      for (let s = 0; s <= segments; s++) {
        const a = Math.PI * (s / segments);
        const dir = f.side.clone().multiplyScalar(-Math.cos(a)).addScaledVector(up, Math.sin(a));
        const p = f.pos.clone().addScaledVector(dir, radius).addScaledVector(up, 0.4);
        positions.push(p.x, p.y, p.z);
        uvs.push(s / segments, i / (frames.length - 1 || 1));
      }
    }
    for (let i = 0; i < frames.length - 1; i++) {
      for (let s = 0; s < segments; s++) {
        const a = i * (segments + 1) + s;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const shell = new THREE.BufferGeometry();
    shell.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    shell.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    shell.setIndex(indices);
    shell.computeVertexNormals();
    out.tunnel.push(shell);

    // Ceiling strip lights every ~10 m.
    for (let i = 0; i < frames.length; i += Math.max(1, Math.round(10 / spacing))) {
      const f = frames[i]!;
      const centre = f.pos.clone().addScaledVector(up, radius - 0.6);
      out.markings.push(flatQuad(centre, f.side, f.tangent, 0.7, 0.22));
    }
    // Portals at both ends.
    for (const idx of [0, frames.length - 1]) {
      const f = frames[idx]!;
      const yaw = Math.atan2(f.tangent.x, f.tangent.z);
      out.concrete.push(boxAt(f.pos.clone().add(new THREE.Vector3(0, radius * 0.6, 0)), new THREE.Vector3(hw * 2 + 5, radius * 1.4, 1.6), yaw));
    }
  }

  // --------------------------------------------------------------- bridge
  if (edge.bridge) {
    for (const sign of [-1, 1]) {
      const o = sign * (hw + 0.5);
      out.concrete.push(ribbon(frames, o, 0.15, o, 1.15, 12));
    }
    // Piers down to the terrain / seabed every ~46 m.
    const step = Math.max(1, Math.round(46 / spacing));
    for (let i = 0; i < frames.length; i += step) {
      const f = frames[i]!;
      const ground = terrain.heightAt(f.pos.x, f.pos.z);
      const height = Math.max(4, f.pos.y - ground);
      out.piers.push(
        boxAt(f.pos.clone().add(new THREE.Vector3(0, -height / 2 - 0.4, 0)), new THREE.Vector3(4.2, height, 4.2), Math.atan2(f.tangent.x, f.tangent.z)),
      );
    }
    // Two suspension towers with cables for the signature long span.
    const towerIdx = [Math.round(frames.length * 0.3), Math.round(frames.length * 0.7)];
    const cablePoints: number[] = [];
    for (const idx of towerIdx) {
      const f = frames[idx]!;
      const yaw = Math.atan2(f.tangent.x, f.tangent.z);
      out.concrete.push(boxAt(f.pos.clone().add(new THREE.Vector3(0, 26, 0)), new THREE.Vector3(3.4, 54, 3.4), yaw));
      const top = f.pos.clone().add(new THREE.Vector3(0, 52, 0));
      for (const sign of [-1, 1]) {
        const anchor = top.clone().addScaledVector(f.side, sign * 0.9);
        const deck = f.pos.clone().addScaledVector(f.side, sign * (hw + 0.6)).add(new THREE.Vector3(0, 1.2, 0));
        // Straight hangers are enough at driving speed and cost nothing.
        for (let k = 1; k <= 6; k++) {
          const p = deck.clone().lerp(anchor, k / 7);
          cablePoints.push(deck.x, deck.y, deck.z, p.x, p.y, p.z);
        }
      }
    }
    const cableGeo = new THREE.BufferGeometry();
    cableGeo.setAttribute('position', new THREE.Float32BufferAttribute(cablePoints, 3));
    out.cables = cableGeo;
  }

  // ------------------------------------------------------------- materials
  void materials;
  return out;
}

/** Merges a bucket of geometries (returns null when the bucket is empty). */
export function mergeBucket(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null;
  if (list.length === 1) return list[0]!;
  const merged = mergeGeometries(list, false);
  if (merged) {
    for (const g of list) g.dispose();
    return merged;
  }
  return list[0]!;
}
