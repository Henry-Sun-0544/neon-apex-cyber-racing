import type * as THREE from 'three';
import type { BoostPad, Checkpoint, TrackProjection, TrackSample } from './SplinePath';
import type { MapModeId } from './MapMode';

/**
 * The contract every race world implements.
 *
 * Gameplay (lap logic, AI, collision, camera hints, HUD) never talks to a
 * concrete world class — only to this interface. `Track` (the Round 1 circuit)
 * and `OpenWorld` (the Round 2 road network) both satisfy it, which is why the
 * two map modes share one race loop, one AI and one collision system.
 */
export interface RaceWorld {
  readonly id: MapModeId;
  /** Display label for the HUD/minimap. */
  readonly label: string;
  /** Everything the world adds to the scene. */
  readonly group: THREE.Group;
  /** Half width of the drivable surface along the race route (metres). */
  readonly halfWidth: number;
  /** Evenly spaced samples of the race route centre line. */
  readonly samples: TrackSample[];
  readonly totalLength: number;
  readonly checkpoints: Checkpoint[];
  readonly boostPads: BoostPad[];
  /** Flattened XZ polyline (x,y,z triplets) used by the minimap. */
  readonly minimapPoints: number[];
  /** Optional extra minimap polylines (side roads, in open-world mode). */
  readonly minimapRoads?: number[][];
  /** Reference ground height (terrain floor / city floor). */
  readonly groundY: number;

  indexAt(distance: number): number;
  frameAt(distance: number): { pos: THREE.Vector3; tangent: THREE.Vector3; side: THREE.Vector3 };
  pointAt(distance: number, lateral?: number, height?: number): THREE.Vector3;
  project(point: THREE.Vector3, hintIndex?: number): TrackProjection;
  startSlots(): Array<[number, number]>;
  padAt(distance: number, lateral: number): BoostPad | null;
  shortestDelta(a: number, b: number): number;

  /** Per-frame world work: streaming, traffic, prop animation. */
  update(dt: number, elapsed: number, focus: THREE.Vector3): void;
  /** Frees generated geometry (map-mode switch / teardown). */
  dispose(): void;
}
