/**
 * Global tunables for Neon Apex: Cyber Racing.
 * Everything gameplay/visual related that a designer may want to tweak lives here.
 */

export const CONFIG = {
  /** Race rules */
  race: {
    /** Laps required to finish the race. */
    laps: 3,
    /** Number of AI opponents (>= 3 required by design brief). */
    aiCount: 5,
    /** Seconds of "3 - 2 - 1 - GO" countdown. */
    countdownFrom: 3,
    /** Delay after GO before the player can move (seconds). */
    goHold: 0.6,
  },

  /** Track geometry */
  track: {
    /** Half width of the drivable road surface (metres). */
    halfWidth: 13,
    /** Vertical skirt extruded under the road (hero highway look). */
    skirtDepth: 9,
    /** Resolution of the CatmullRom curve used to sample the ribbon. */
    samples: 1600,
    /** Road elevation amplitude (metres). */
    elevation: 11,
    /** Distance between guard-rail posts (metres). */
    railStep: 7,
    /** Number of check-point gates around the loop. */
    checkpoints: 12,
    /** Number of boost pads around the loop. */
    boostPads: 5,
    /** Number of support pillars (road -> ground). */
    pillars: 90,
  },

  /** Player car physics (arcade, tuned by feel) */
  car: {
    /** Engine force in m/s^2 at full throttle. */
    accel: 30,
    /** Reverse gear force. */
    reverseAccel: 14,
    /** Braking deceleration. */
    brakeForce: 46,
    /** Aerodynamic drag coefficient (v^2 term). */
    drag: 0.0009,
    /** Rolling resistance: constant deceleration in m/s^2. */
    rolling: 0.4,
    /** Regulated top speed in m/s (approx. 238 km/h). */
    maxSpeed: 66,
    /** Top speed while burning nitro (approx. 274 km/h). */
    nitroMaxSpeed: 76,
    /** Thrust curve exponent: thrust fades to zero at the top speed. */
    thrustCurve: 1.8,
    /** Steering authority at low speed (rad/s). */
    steerBase: 2.5,
    /** How quickly the front wheels reach full lock. */
    steerLerp: 7.5,
    /** Lateral grip: higher = more grip, less drift (1/s). */
    grip: 5.2,
    /** Grip while nitro is active (driftier). */
    nitroGrip: 3.6,
    /** Extra yaw torque used for hand-brake style sliding when braking at speed. */
    brakeSlide: 0.55,
    /** Nitro tank capacity (0..100). */
    nitroCapacity: 100,
    /** Nitro drain per second while held. */
    nitroDrain: 26,
    /** Nitro regen per second when not held. */
    nitroRegen: 11,
    /** Delay before regen starts after releasing nitro (seconds). */
    nitroRegenDelay: 0.55,
    /** Additional thrust while nitro is active. */
    nitroThrust: 22,
    /** Boost pad impulse (m/s) and duration (s). */
    boostImpulse: 9,
    boostDuration: 1.5,
    /** Boost pad thrust bonus. */
    boostThrust: 16,
    /** Collision bounce factor. */
    restitution: 0.42,
    /**
     * Wall riding. A car held nose-first against a barrier reaches an
     * equilibrium of ~0 m/s under scrub friction alone, which would trap the
     * player, so a scraping car is also steered back along the barrier
     * (rad/s at full contact) and keeps a floor speed (m/s) while throttling.
     */
    wallAssistRate: 2.6,
    wallScrubFloor: 7,
    /** Rigid body radius used for AI/AI and AI/player collisions. */
    radius: 1.9,
  },

  /** AI behaviour */
  ai: {
    /** Base top speed multiplier range (skill). */
    speedScaleMin: 0.9,
    speedScaleMax: 1.02,
    /** Lateral racing-line amplitude (metres from centre). */
    laneMax: 6.2,
    /** Look-ahead distance used for steering (metres). */
    lookAhead: 26,
    /** Mild catch-up/slow-down rubber banding factor. */
    rubberBand: 0.06,
    /** Seconds of near-zero speed before the AI is teleported back on track. */
    stuckTimeout: 3,
  },

  /** Camera */
  camera: {
    fov: 72,
    /** Extra FOV while nitro is active. */
    nitroFov: 16,
    /** Chase distance/height. */
    chaseDistance: 9.5,
    chaseHeight: 4.1,
    /** Bumper cam */
    hoodDistance: 0.6,
    hoodHeight: 1.35,
    /** Camera follow smoothing (1/s). */
    positionLerp: 6.5,
    lookLerp: 8,
    /** Screen shake decay. */
    shakeDecay: 4.5,
  },

  /** Rendering / performance */
  render: {
    /** Max device pixel ratio (perf guard). */
    maxPixelRatio: 1.6,
    /** Post-processing bloom toggle (auto-disabled on low FPS). */
    bloom: true,
    bloomStrength: 0.52,
    bloomRadius: 0.45,
    bloomThreshold: 0.82,
    /** FPS below this for `perfSampleSeconds` triggers downgrade. */
    downgradeFps: 42,
    perfSampleSeconds: 3.5,
    fogColor: 0x0a0420,
    fogDensity: 0.0072,
  },

  /** Audio */
  audio: {
    bpm: 128,
    masterVolume: 0.7,
  },

  /** Particles */
  particles: {
    maxSparks: 420,
    maxFlames: 520,
    maxMotes: 260,
    maxDust: 420,
    gravity: -26,
  },

  /** Palette shared by meshes + UI */
  colors: {
    cyan: 0x24f0ff,
    magenta: 0xff2fb9,
    violet: 0xa05cff,
    lime: 0xb6ff3a,
    amber: 0xffb347,
    road: 0x14121f,
    concrete: 0x1b1a2b,
  },

  /** Round 2: style / quality / map-mode defaults and world generation budgets */
  style: {
    /** Style used when localStorage has no preference yet. */
    default: 'cyberpunk' as 'cyberpunk' | 'realistic',
    /** Seconds for a full 24 h cycle in the realistic style. */
    dayCycleSeconds: 520,
    /** Starting hour (0..1) for the realistic style: late golden hour. */
    startTimeOfDay: 0.46,
    /** Half-extent of the sun shadow camera (metres). */
    shadowDistance: 130,
    /** Traffic density multiplier applied to the quality budget. */
    trafficDensity: 1,
  },

  /** Quality preset used when localStorage has no preference yet. */
  quality: {
    default: 'high' as 'low' | 'medium' | 'high' | 'ultra',
  },

  /** Map mode used when localStorage has no preference yet. */
  map: {
    default: 'circuit' as 'circuit' | 'openworld',
  },

  /** Open-world generation budgets (kept out of the gameplay config). */
  world: {
    /** World radius in metres (the terrain is a square of 2x this). */
    extent: 2400,
    /** Logical height-field resolution used by the noise sampler. */
    logicalResolution: 1024,
    /** Vertices per terrain chunk edge. */
    chunkSegments: 32,
    /** Sea level (metres). */
    seaLevel: -26,
    /** Number of race-route samples (comparable to the circuit's 1600). */
    routeSamples: 1500,
    /** Checkpoint count on the open-world route. */
    checkpoints: 14,
    /** Boost pads on the open-world route. */
    boostPads: 8,
  },
};

/** Physics/visual tunables of one car, derived from CONFIG.car plus overrides. */
export type CarStats = typeof CONFIG.car;

/** The selectable chassis bodies. */
export type ChassisId = 'concept' | 'muscle' | 'sports' | 'suv';

/** Identifiers of the garage cars. */
export type CarId = 'hellcat' | 'gtr' | 'modely' | 'concept';

/** One selectable car in the garage. */
export interface CarPreset {
  id: CarId;
  /** Display name on the garage card. */
  name: string;
  tagline: string;
  chassis: ChassisId;
  bodyColor: number;
  accentColor: number;
  /** Overrides on top of the base car physics. */
  stats: Partial<CarStats>;
}

/**
 * The garage. Stats are deliberately distinct:
 *  - HELLCAT  launches hardest, lowest top speed, loosest rear (drift happy)
 *  - GT-R     highest top speed + grip, lazier launch
 *  - MODEL Y  electric torque, heavy and stable, not the fastest
 *  - CONCEPT  the balanced all-rounder everything is tuned against
 */
export const GARAGE: CarPreset[] = [
  {
    id: 'hellcat',
    name: 'HELLCAT SRT',
    tagline: '肌肉车 · 起步猛兽',
    chassis: 'muscle',
    bodyColor: 0x7a1420,
    accentColor: 0xffb347,
    stats: {
      accel: 34,
      brakeForce: 42,
      drag: 0.0011,
      maxSpeed: 60,
      nitroMaxSpeed: 70,
      thrustCurve: 1.5,
      steerBase: 2.3,
      grip: 4.6,
      nitroGrip: 3.2,
    },
  },
  {
    id: 'gtr',
    name: 'NISSAN GT-R',
    tagline: '四驱战神 · 高速之王',
    chassis: 'sports',
    bodyColor: 0x1a2233,
    accentColor: 0xff2b4d,
    stats: {
      accel: 28,
      brakeForce: 48,
      drag: 0.00085,
      maxSpeed: 70,
      nitroMaxSpeed: 79,
      thrustCurve: 2.0,
      steerBase: 2.8,
      grip: 6.4,
      nitroGrip: 4.6,
    },
  },
  {
    id: 'modely',
    name: 'TESLA MODEL Y',
    tagline: '电动 SUV · 稳如轨道',
    chassis: 'suv',
    bodyColor: 0xe3e9f2,
    accentColor: 0x2fd6a3,
    stats: {
      accel: 33,
      brakeForce: 46,
      drag: 0.001,
      maxSpeed: 64,
      nitroMaxSpeed: 73,
      thrustCurve: 1.6,
      steerBase: 2.2,
      grip: 5.9,
      nitroGrip: 4.2,
    },
  },
  {
    id: 'concept',
    name: 'CONCEPT-X',
    tagline: '原型概念车 · 均衡全能',
    chassis: 'concept',
    bodyColor: 0x1b2340,
    accentColor: 0x24f0ff,
    stats: {
      accel: 30,
      brakeForce: 46,
      drag: 0.0009,
      maxSpeed: 66,
      nitroMaxSpeed: 76,
      thrustCurve: 1.8,
      steerBase: 2.7,
      grip: 5.4,
      nitroGrip: 3.8,
    },
  },
];

/** Resolves a garage preset by id, falling back to the balanced concept car. */
export function resolveCarPreset(id: string | null | undefined): CarPreset {
  return GARAGE.find((preset) => preset.id === id) ?? GARAGE.find((p) => p.id === 'concept')!;
}

/** Human readable racer entry used for the scoreboard. */
export interface RacerSnapshot {
  id: number;
  name: string;
  isPlayer: boolean;
  lap: number;
  position: number;
  /** Total distance travelled including completed laps (metres). */
  totalProgress: number;
  bestLap: number | null;
  totalTime: number | null;
  finished: boolean;
  colorHex: number;
}

/** Aggregated race statistics handed to the results screen. */
export interface RaceResult {
  racers: RacerSnapshot[];
  playerPosition: number;
  playerTotalTime: number | null;
  playerBestLap: number | null;
  laps: number;
}
