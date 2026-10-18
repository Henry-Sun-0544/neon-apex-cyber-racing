import * as THREE from 'three';
import { clamp } from '../Utils';

/** One evenly spaced sample of a route centre line. */
export interface TrackSample {
  pos: THREE.Vector3;
  /** Normalised forward direction. */
  tangent: THREE.Vector3;
  /** Right-hand vector (tangent x up). */
  side: THREE.Vector3;
  /** Up vector, orthogonalised. */
  normal: THREE.Vector3;
  /** Arc-length distance from the start/finish line. */
  distance: number;
}

/** A speed pad painted on the road. */
export interface BoostPad {
  distance: number;
  lateral: number;
  halfLength: number;
  halfWidth: number;
  mesh: THREE.Mesh;
}

/** Check-point gate (visual only, detection is distance based). */
export interface Checkpoint {
  distance: number;
  mesh: THREE.Object3D;
}

/** Result of projecting a world position onto a route centre line. */
export interface TrackProjection {
  index: number;
  distance: number;
  /** Signed lateral offset (positive = right hand side of travel). */
  lateral: number;
  height: number;
  tangent: THREE.Vector3;
  side: THREE.Vector3;
}

/**
 * Arc-length parameterised spline used by every race route.
 *
 * The Round 1 `Track` built its samples and its projection maths inline; Round 2
 * adds a second route (the open-world road network), so that maths now lives
 * here and both routes share it. Keeping one implementation is what guarantees
 * that AI, lap logic, collision and the road ribbon can never disagree about
 * where the road is.
 *
 * The projection uses a windowed search around a per-vehicle hint index, so it
 * stays O(1) per frame regardless of the sample count.
 */
export abstract class SplinePath {
  readonly group = new THREE.Group();
  readonly samples: TrackSample[] = [];
  readonly checkpoints: Checkpoint[] = [];
  readonly boostPads: BoostPad[] = [];
  /** Flattened XZ polyline (x,y,z triplets) used by the minimap. */
  readonly minimapPoints: number[] = [];
  halfWidth = 12;
  totalLength = 0;
  /** Reference ground height under the route. */
  groundY = 0;
  /** Extra polylines contributed to the minimap (side roads). */
  minimapRoads: number[][] = [];

  /**
   * Samples a curve at (approximately) uniform arc length and fills `samples`,
   * `totalLength` and `minimapPoints`.
   */
  protected buildSamples(curve: THREE.CatmullRomCurve3 | THREE.Curve<THREE.Vector3>, count: number): void {
    const pts = curve.getSpacedPoints(count); // count + 1 points, last == first
    let distance = 0;
    for (let i = 0; i < count; i++) {
      const pos = pts[i]!.clone();
      const next = pts[(i + 1) % count]!;
      const prev = pts[(i - 1 + count) % count]!;
      const tangent = next.clone().sub(prev);
      if (tangent.lengthSq() < 1e-8) tangent.set(0, 0, 1);
      tangent.normalize();
      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
      if (side.lengthSq() < 0.5) side.set(1, 0, 0);
      const normal = new THREE.Vector3().crossVectors(side, tangent).normalize();
      this.samples.push({ pos, tangent, side, normal, distance });
      distance += pos.distanceTo(next);
    }
    this.totalLength = distance;
    for (let i = 0; i < count; i += 4) {
      const s = this.samples[i]!;
      this.minimapPoints.push(s.pos.x, s.pos.y, s.pos.z);
    }
  }

  /** Sample index for a given arc-length distance (wrapped). */
  indexAt(distance: number): number {
    const n = this.samples.length;
    const t = ((distance % this.totalLength) + this.totalLength) % this.totalLength;
    return Math.min(n - 1, Math.floor((t / this.totalLength) * n));
  }

  /** Interpolated frame at an arc-length distance (wrapped). */
  frameAt(distance: number): { pos: THREE.Vector3; tangent: THREE.Vector3; side: THREE.Vector3 } {
    const n = this.samples.length;
    const wrapped = ((distance % this.totalLength) + this.totalLength) % this.totalLength;
    const f = (wrapped / this.totalLength) * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const t = f - Math.floor(f);
    const a = this.samples[i0]!;
    const b = this.samples[i1]!;
    return {
      pos: a.pos.clone().lerp(b.pos, t),
      tangent: a.tangent.clone().lerp(b.tangent, t).normalize(),
      side: a.side.clone().lerp(b.side, t).normalize(),
    };
  }

  /** World position on the driving line at `distance` with a lateral offset. */
  pointAt(distance: number, lateral = 0, height = 0): THREE.Vector3 {
    const f = this.frameAt(distance);
    return f.pos.addScaledVector(f.side, lateral).addScaledVector(new THREE.Vector3(0, 1, 0), height);
  }

  /** Project a world position onto the centre line (windowed, O(1) with a hint). */
  project(point: THREE.Vector3, hintIndex = -1): TrackProjection {
    const n = this.samples.length;
    let bestIndex = 0;
    let bestDist = Infinity;

    if (hintIndex >= 0) {
      const window = 70;
      for (let k = -window; k <= window; k++) {
        const i = (hintIndex + k + n) % n;
        const d = this.samples[i]!.pos.distanceToSquared(point);
        if (d < bestDist) {
          bestDist = d;
          bestIndex = i;
        }
      }
    } else {
      for (let i = 0; i < n; i += 8) {
        const d = this.samples[i]!.pos.distanceToSquared(point);
        if (d < bestDist) {
          bestDist = d;
          bestIndex = i;
        }
      }
      for (let k = -8; k <= 8; k++) {
        const i = (bestIndex + k + n) % n;
        const d = this.samples[i]!.pos.distanceToSquared(point);
        if (d < bestDist) {
          bestDist = d;
          bestIndex = i;
        }
      }
    }

    const s = this.samples[bestIndex]!;
    const rel = point.clone().sub(s.pos);
    const segLen = this.totalLength / n;
    const along = clamp(rel.dot(s.tangent), -segLen, segLen);
    const lateral = rel.dot(s.side);
    return {
      index: bestIndex,
      distance: s.distance + along,
      lateral,
      height: s.pos.y,
      tangent: s.tangent.clone(),
      side: s.side.clone(),
    };
  }

  /** Grid slots for the starting pack: `[distance, lateral]` pairs. */
  startSlots(): Array<[number, number]> {
    const slots: Array<[number, number]> = [];
    const rows = 2;
    const perRow = 3;
    const lane = Math.max(4.4, this.halfWidth * 0.34);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < perRow; c++) {
        const lateral = (c - (perRow - 1) / 2) * lane;
        slots.push([this.totalLength - 12 - r * 9.5, lateral]);
      }
    }
    return slots;
  }

  /** True when the position sits on one of the speed pads (pad coordinates). */
  padAt(distance: number, lateral: number): BoostPad | null {
    for (const pad of this.boostPads) {
      const dDelta = Math.abs(this.shortestDelta(distance, pad.distance));
      if (dDelta < pad.halfLength && Math.abs(lateral - pad.lateral) < pad.halfWidth) return pad;
    }
    return null;
  }

  /** Signed shortest distance from a to b along the loop. */
  shortestDelta(a: number, b: number): number {
    let d = (b - a) % this.totalLength;
    if (d > this.totalLength / 2) d -= this.totalLength;
    if (d < -this.totalLength / 2) d += this.totalLength;
    return d;
  }

  /** Per-frame hook; routes that stream or animate override it. */
  update(_dt: number, _elapsed: number, _focus: THREE.Vector3): void {
    /* static route */
  }

  abstract dispose(): void;
}
