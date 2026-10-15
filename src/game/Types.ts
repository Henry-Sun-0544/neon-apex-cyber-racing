/** Shared structural types used across gameplay systems. */

/** An axis-aligned-ish oriented box used for static collision (buildings, pylons). */
export interface StaticBox {
  x: number;
  y: number;
  z: number;
  halfX: number;
  halfY: number;
  halfZ: number;
  /** Rotation around Y in radians. */
  rotY: number;
  /** Short label, handy for debugging / different collision responses. */
  tag: 'building' | 'pylon' | 'sign';
}

/** Everything the HUD needs to know about the race each frame. */
export interface HudState {
  speedKmh: number;
  position: number;
  totalRacers: number;
  lap: number;
  totalLaps: number;
  raceTime: number;
  lapTime: number;
  bestLap: number | null;
  nitro: number;
  nitroActive: boolean;
  boosting: boolean;
  wrongWay: boolean;
  fps: number;
}

/** A single collision event consumed by particles / audio / camera shake. */
export interface CollisionEvent {
  point: Vec3Like;
  /** Impact strength 0..1 (already clamped). */
  strength: number;
  kind: 'wall' | 'building' | 'car';
  /** Surface normal pointing away from the obstacle. */
  normal: Vec3Like;
}

/** Minimal structural vector type (avoids importing three into pure-data modules). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
