import * as THREE from 'three';
import { CONFIG } from './Config';
import type { Track } from './Track';
import type { VehicleBase, VehicleInput } from './VehicleBase';
import { angleDelta, clamp } from './Utils';

/** Per-driver personality — this is what makes the pack feel human. */
export interface AIProfile {
  name: string;
  bodyColor: number;
  accentColor: number;
  /** Multiplier applied to the target speed (skill). */
  speedScale: number;
  /** Preferred side of the road (-1 left .. +1 right). */
  laneBias: number;
  /** Amplitude of the sinusoidal lane wander. */
  wobble: number;
  /** Random phase so the pack does not move in lock-step. */
  phase: number;
  /** Probability per second of a small driver mistake. */
  mistakeChance: number;
  /** 0..1 — how eagerly this driver uses nitro on straights. */
  nitroSkill: number;
}

/** What the AI needs to know about the race this frame. */
export interface AIWorldView {
  elapsed: number;
  /** Total travelled distance of this driver. */
  selfProgress: number;
  /** Total travelled distance of the player (for rubber banding). */
  playerProgress: number;
  totalLength: number;
  rivals: Array<{ position: THREE.Vector3; progress: number }>;
}

const NAMES = ['VEX-01', 'NULLBYTE', 'KIRIN', 'RAZOR-9', 'GHOST', 'SYNTHIA', 'OVERCLOCK', 'HEX'];
const BODY_COLORS = [0x2a0f3d, 0x3d0f22, 0x0f2f3d, 0x231040, 0x103a2a, 0x3d2a0f];
const ACCENT_COLORS = [
  CONFIG.colors.magenta,
  CONFIG.colors.violet,
  CONFIG.colors.lime,
  CONFIG.colors.amber,
  0x5cffd0,
  0xff5c8a,
];

/** Builds a deterministic-ish grid of AI drivers. */
export function createProfiles(count: number, seed = 1337): AIProfile[] {
  const profiles: AIProfile[] = [];
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const t = count <= 1 ? 0.5 : i / (count - 1);
    profiles.push({
      name: NAMES[i % NAMES.length]!,
      bodyColor: BODY_COLORS[i % BODY_COLORS.length]!,
      accentColor: ACCENT_COLORS[i % ACCENT_COLORS.length]!,
      // Spread skill from slowest to fastest, then shuffle a little.
      speedScale: clamp(
        CONFIG.ai.speedScaleMin + t * (CONFIG.ai.speedScaleMax - CONFIG.ai.speedScaleMin) + (rnd() - 0.5) * 0.05,
        0.7,
        1.05,
      ),
      laneBias: (rnd() - 0.5) * 1.6,
      wobble: 0.6 + rnd() * 1.9,
      phase: rnd() * Math.PI * 2,
      mistakeChance: 0.02 + rnd() * 0.09,
      nitroSkill: 0.25 + rnd() * 0.7,
    });
  }
  return profiles;
}

/**
 * Racing-line follower: computes a look-ahead target on the track (with a
 * personal lane offset, apex-seeking and simple traffic avoidance) and converts
 * the geometry error into throttle/brake/steer inputs.
 */
export class AIController {
  private stuckTimer = 0;
  private nitroTimer = 0;
  private mistakeTimer = 0;
  private laneOffset = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(
    readonly profile: AIProfile,
    private readonly track: Track,
  ) {}

  /** Compute this frame's inputs for the given vehicle. */
  update(dt: number, vehicle: VehicleBase, view: AIWorldView): VehicleInput {
    const cfg = CONFIG.ai;
    const proj = this.track.project(vehicle.position, vehicle.hintIndex);
    vehicle.hintIndex = proj.index;
    const d = proj.distance;

    // ------------------------------------------------------- curvature
    const ahead1 = this.track.frameAt(d + 30);
    const ahead2 = this.track.frameAt(d + 70);
    const current = this.track.frameAt(d);
    const turnNear = angleDelta(Math.atan2(current.tangent.x, current.tangent.z), Math.atan2(ahead1.tangent.x, ahead1.tangent.z));
    const turnFar = angleDelta(Math.atan2(ahead1.tangent.x, ahead1.tangent.z), Math.atan2(ahead2.tangent.x, ahead2.tangent.z));
    const curvature = Math.abs(turnNear) + Math.abs(turnFar) * 0.6;
    // Turn direction sign: negative = left, positive = right (yaw decreases when turning right).
    const turnSign = Math.sign(turnNear + turnFar * 0.5) || 0;

    // ------------------------------------------------------ target lane
    const baseLane = this.profile.laneBias * cfg.laneMax * 0.55;
    const wobble = Math.sin(d * 0.012 + this.profile.phase) * this.profile.wobble;
    // Seek the inside of the corner (negative turnSign => left corner => inside is left = +).
    const apex = turnSign * 2.6;
    let avoidance = 0;
    for (const rival of view.rivals) {
      const rp = this.track.project(rival.position, vehicle.hintIndex);
      const gap = this.track.shortestDelta(d, rp.distance);
      const latGap = rp.lateral - proj.lateral;
      if (gap > 0 && gap < 22 && Math.abs(latGap) < 3.4) {
        // Steer around the car in front; pick the side with more room.
        avoidance += latGap >= 0 ? -4.2 : 4.2;
      }
    }
    const targetLane = clamp(baseLane + wobble + apex + avoidance, -cfg.laneMax, cfg.laneMax);
    this.laneOffset += clamp(targetLane - this.laneOffset, -6 * dt, 6 * dt);

    // --------------------------------------------------------- steering
    const lookAhead = cfg.lookAhead * (0.55 + clamp(Math.abs(vehicle.speed) / CONFIG.car.maxSpeed, 0, 1) * 0.75);
    const targetPoint = this.track.pointAt(d + lookAhead, this.laneOffset);
    this.tmp.copy(targetPoint).sub(vehicle.position);
    const desiredYaw = Math.atan2(this.tmp.x, this.tmp.z);
    const yawError = angleDelta(vehicle.yaw, desiredYaw);
    const steer = clamp(-yawError * 2.4, -1, 1);

    // ------------------------------------------------------ speed logic
    const speedScale = this.profile.speedScale * (1 - clamp(curvature * 0.7, 0, 0.45));
    const rubber = clamp((view.playerProgress - view.selfProgress) / view.totalLength, -1, 1) * cfg.rubberBand;
    let targetSpeed = CONFIG.car.maxSpeed * clamp(speedScale + rubber, 0.5, 1.04);

    // Occasional mistakes keep the field dynamic.
    if (this.mistakeTimer > 0) {
      this.mistakeTimer -= dt;
      targetSpeed *= 0.62;
    } else if (Math.random() < this.profile.mistakeChance * dt) {
      this.mistakeTimer = 0.4 + Math.random() * 0.9;
    }

    const speed = Math.abs(vehicle.speed);
    let throttle = 0;
    let brake = 0;
    if (speed < targetSpeed) throttle = clamp((targetSpeed - speed) * 0.5 + 0.55, 0, 1);
    else if (speed > targetSpeed * 1.1) brake = clamp((speed - targetSpeed) * 0.12, 0, 1);

    // ------------------------------------------------------------ nitro
    this.nitroTimer -= dt;
    if (this.nitroTimer < 0 && curvature < 0.07 && vehicle.nitro > 45 && speed > targetSpeed * 0.85) {
      if (Math.random() < this.profile.nitroSkill * dt * 3.5) this.nitroTimer = 1.2 + Math.random() * 1.6;
    }
    const nitro = this.nitroTimer > 0;

    // ----------------------------------------------------- stuck recovery
    if (speed < 1.6 && throttle > 0.2) this.stuckTimer += dt;
    else this.stuckTimer = 0;
    if (this.stuckTimer > cfg.stuckTimeout) {
      const f = this.track.frameAt(d + 4);
      vehicle.placeAt(f.pos.clone().addScaledVector(f.side, 0), Math.atan2(f.tangent.x, f.tangent.z), 6);
      vehicle.hintIndex = -1;
      this.stuckTimer = 0;
    }

    return { throttle, brake, steer, nitro };
  }
}
