import * as THREE from 'three';
import { CONFIG, type CarStats } from './Config';
import { createCarModel, disposeCarModel, type CarModel, type CarStyle } from './CarModel';
import type { MaterialLibrary } from './MaterialLibrary';
import { createDetailedCarModel, type VehicleDetail } from './VehicleFactory';
import { clamp, damp } from './Utils';

/** Normalised driver input consumed by the physics step. */
export interface VehicleInput {
  /** 0..1 forward throttle. */
  throttle: number;
  /** 0..1 brake / reverse. */
  brake: number;
  /** -1 (left) .. +1 (right). */
  steer: number;
  /** Nitro requested (player) or AI decision. */
  nitro: boolean;
}

export const emptyInput = (): VehicleInput => ({ throttle: 0, brake: 0, steer: 0, nitro: false });

/**
 * Shared arcade vehicle simulation.
 *
 * The model keeps a 2D velocity that is decomposed into longitudinal and
 * lateral parts every frame: the lateral part decays with a "grip" constant,
 * which produces believable drift, slide and counter-steer behaviour without a
 * full tyre simulation.
 */
export class VehicleBase {
  readonly object = new THREE.Group();
  model: CarModel;
  readonly accent: THREE.Color;

  /** World position of the car root (wheels touch y=0 of the object). */
  readonly position = new THREE.Vector3();
  /** World velocity (m/s). */
  readonly velocity = new THREE.Vector3();

  /** Heading in radians; forward = (sin(yaw), 0, cos(yaw)). */
  yaw = 0;
  /** Signed forward speed (m/s). */
  speed = 0;
  /** Arc-length cache used to keep track projection O(1). */
  hintIndex = -1;

  /**
   * Per-car physics tunables. A copy of CONFIG.car so every chassis in the
   * garage (and every AI car) can be tuned independently.
   */
  readonly stats: CarStats = { ...CONFIG.car };
  /**
   * Road slope along the car heading (dy per metre forward, signed), written
   * by CollisionSystem every frame. Positive = nose points uphill.
   */
  slopeAlong = 0;

  nitro = CONFIG.car.nitroCapacity;
  nitroActive = false;
  boostTimer = 0;
  /**
   * Parked on the grid (countdown / pre-race): physics is frozen so slope
   * gravity cannot make cars roll before GO. Any throttle input unparks.
   */
  parked = false;

  /** Visual state */
  steerVisual = 0;
  /** Road slope pitch supplied by the collision/track synchroniser. */
  roadPitch = 0;
  /** Last requested throttle (0..1) — used by the anti-wedge assist. */
  lastThrottle = 0;
  /** Seconds spent pinned against an obstacle at near-zero speed. */
  stuckTimer = 0;
  /** Consecutive unstick attempts; escalates until the car is free again. */
  wedgeRescues = 0;
  private wheelSpin = 0;
  private roll = 0;
  private pitchVisual = 0;
  private prevSpeed = 0;
  private bob = 0;
  private lastNitroRelease = 0;
  private elapsed = 0;

  readonly radius = CONFIG.car.radius;

  /** Last applied looks, so a style switch can rebuild without the caller. */
  private carStyle: CarStyle;

  constructor(style: CarStyle, detail: VehicleDetail = 'low', library: MaterialLibrary | null = null) {
    this.carStyle = { ...style };
    this.detail = detail;
    this.library = library;
    this.model = this.buildModel();
    this.accent = new THREE.Color(style.accentColor);
    this.object.rotation.order = 'YXZ';
    this.object.add(this.model.group);
  }

  /** Detail rank + material library used to build the current body. */
  private detail: VehicleDetail;
  private library: MaterialLibrary | null;

  /**
   * Builds the body. Low detail keeps the cheap Round 1 silhouette; everything
   * above it uses the merged, high-detail factory model.
   */
  private buildModel(): CarModel {
    if (this.detail !== 'low' && this.library) {
      return createDetailedCarModel(this.carStyle, this.library, this.detail);
    }
    return createCarModel(this.carStyle);
  }

  /** Swaps the visible chassis while keeping position/physics state. */
  setStyle(style: CarStyle): void {
    this.carStyle = { ...style };
    this.object.remove(this.model.group);
    disposeCarModel(this.model);
    this.accent.setHex(style.accentColor);
    this.model = this.buildModel();
    this.object.add(this.model.group);
    this.syncTransform();
  }

  /**
   * Applies a new detail budget (quality preset change). The body is rebuilt
   * but position, velocity, nitro, laps and every other piece of state survive.
   */
  setDetail(detail: VehicleDetail, library: MaterialLibrary | null): void {
    if (this.detail === detail && this.library === library) return;
    this.detail = detail;
    this.library = library ?? this.library;
    this.object.remove(this.model.group);
    disposeCarModel(this.model);
    this.model = this.buildModel();
    this.object.add(this.model.group);
    this.syncTransform();
  }

  get detailLevel(): VehicleDetail {
    return this.detail;
  }

  /**
   * Re-skins the car for a new game style. Geometry, physics, position, speed
   * and the nitro tank are all untouched: only the visual model is rebuilt.
   */
  setTheme(theme: 'cyberpunk' | 'realistic'): void {
    if (this.carStyle.theme === theme) return;
    this.setStyle({ ...this.carStyle, theme });
  }

  /** Re-applies the current looks (used after a quality-driven detail change). */
  refreshStyle(): void {
    this.setStyle(this.carStyle);
  }

  get currentStyle(): CarStyle {
    return this.carStyle;
  }

  /** Applies garage physics overrides on top of the base car stats. */
  tune(overrides: Partial<CarStats>): void {
    Object.assign(this.stats, overrides);
  }

  /** The car's own regulated top speed without nitro (m/s). */
  get topSpeed(): number {
    return this.stats.maxSpeed;
  }

  /** True while any boost source is active. */
  get boosting(): boolean {
    return this.nitroActive || this.boostTimer > 0;
  }

  /** Top speed for the current boost state (m/s). */
  get currentMaxSpeed(): number {
    return this.boosting ? this.stats.nitroMaxSpeed : this.stats.maxSpeed;
  }

  /** Reset to a fresh grid slot. */
  placeAt(position: THREE.Vector3, yaw: number, speed = 0): void {
    this.position.copy(position);
    this.yaw = yaw;
    this.speed = speed;
    this.prevSpeed = speed;
    this.velocity.set(Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed);
    this.hintIndex = -1;
    this.steerVisual = 0;
    this.nitroActive = false;
    this.boostTimer = 0;
    this.syncTransform();
  }

  /** Full reset including tank/particles state. */
  resetState(): void {
    this.nitro = this.stats.nitroCapacity;
    this.nitroActive = false;
    this.boostTimer = 0;
    this.speed = 0;
    this.prevSpeed = 0;
    this.velocity.set(0, 0, 0);
    this.steerVisual = 0;
    this.roll = 0;
    this.pitchVisual = 0;
    this.wheelSpin = 0;
    this.hintIndex = -1;
  }

  /** Applies a speed-pad impulse in the car's forward direction. */
  applyBoostPad(): void {
    const cfg = this.stats;
    this.boostTimer = Math.max(this.boostTimer, cfg.boostDuration);
    this.nitro = Math.min(cfg.nitroCapacity, this.nitro + 18);
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.velocity.addScaledVector(forward, cfg.boostImpulse);
    if (this.speed < 0) this.speed = 0;
  }

  /** Additive velocity impulse (used by collisions and pad bursts). */
  addImpulse(impulse: THREE.Vector3): void {
    this.velocity.add(impulse);
    this.speed = this.velocity.dot(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)));
  }

  /** Core physics integration. */
  step(dt: number, input: VehicleInput): void {
    const cfg = this.stats;
    this.elapsed += dt;
    this.lastThrottle = input.throttle;

    if (this.parked) {
      // Waiting on the grid: hold position regardless of slope.
      if (input.throttle > 0.1) this.parked = false;
      else {
        this.velocity.set(0, 0, 0);
        this.speed = 0;
        this.prevSpeed = 0;
        this.updateVisuals(dt, 0);
        return;
      }
    }

    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    // ------------------------------------------------------- steering
    this.steerVisual = damp(this.steerVisual, clamp(input.steer, -1, 1), cfg.steerLerp, dt);
    const speedAbs = Math.abs(this.speed);
    const ratio = clamp(speedAbs / cfg.maxSpeed, 0, 1.4);
    // Steering authority shrinks with speed (arcade style: no twitch at 200 km/h).
    const authority = cfg.steerBase * (1 - 0.52 * ratio) * (this.nitroActive ? 0.94 : 1);
    const engage = clamp(speedAbs / 4.5, 0, 1);
    const dir = this.speed < 0 ? -1 : 1;
    this.yaw -= this.steerVisual * authority * engage * dir * dt;

    // ---------------------------------------------------- longitudinal
    const maxSpeed = this.currentMaxSpeed;
    let thrust = 0;
    if (input.throttle > 0) {
      // Thrust fades smoothly to zero as the car reaches its regulated top speed.
      const t = clamp(this.speed / maxSpeed, 0, 1);
      thrust += input.throttle * cfg.accel * (1 - Math.pow(t, cfg.thrustCurve));
    }
    if (input.brake > 0) {
      if (this.speed > 0.8) thrust -= input.brake * cfg.brakeForce;
      else thrust -= input.brake * cfg.reverseAccel;
    }
    if (this.nitroActive) thrust += cfg.nitroThrust;
    if (this.boostTimer > 0) thrust += cfg.boostThrust;
    // Slope gravity: a nose pointing uphill is pulled back, downhill is pushed
    // on. Rolling resistance alone is weaker than even a gentle hill, so an
    // unbraked car creeps backwards downhill (hill hold = hold the brake).
    thrust -= 9.81 * 1.15 * this.slopeAlong;
    // Resistance always opposes motion: quadratic aero drag + constant rolling loss.
    const resist = cfg.drag * this.speed * speedAbs + (this.speed === 0 ? 0 : Math.sign(this.speed) * cfg.rolling);
    thrust -= resist;
    // Standstill snap only when both pedals are released and the road is flat
    // enough: with S held the reverse thrust must win, and on a slope the car
    // keeps rolling instead of parking itself.
    if (
      input.throttle === 0 &&
      input.brake === 0 &&
      Math.abs(this.speed) < 0.4 &&
      !this.nitroActive &&
      this.boostTimer <= 0 &&
      Math.abs(this.slopeAlong) < 0.03
    ) {
      this.speed = 0;
      thrust = 0;
      // Kill the longitudinal velocity component too: vLong below is rebuilt
      // from `velocity`, so zeroing only `speed` leaves the car creeping at
      // the snap threshold forever (HUD shows ~1 km/h while "stopped").
      this.velocity.addScaledVector(forward, -this.velocity.dot(forward));
    }

    // Re-decompose the velocity in the *new* heading frame: this is what makes
    // the car carry momentum through a corner instead of snapping to the nose.
    let vLong = this.velocity.dot(forward) + thrust * dt;
    let vLat = this.velocity.dot(right);
    const grip = this.nitroActive ? cfg.nitroGrip : cfg.grip;
    vLat *= Math.exp(-grip * dt);
    // Braking hard at speed loosens the rear: cheap handbrake slide.
    const slide = input.brake * cfg.brakeSlide * clamp(speedAbs / cfg.maxSpeed, 0, 1);
    vLat *= Math.exp(-slide * dt * 4);

    const reverseMax = 22;
    vLong = clamp(vLong, -reverseMax, maxSpeed);
    this.velocity.copy(forward).multiplyScalar(vLong).addScaledVector(right, vLat);
    this.position.addScaledVector(this.velocity, dt);
    this.prevSpeed = this.speed;
    this.speed = vLong;

    if (this.boostTimer > 0) this.boostTimer = Math.max(0, this.boostTimer - dt);
    this.updateVisuals(dt, thrust);
  }

  /** Wheel spin, steering, body roll/pitch and suspension bob. */
  private updateVisuals(dt: number, thrust: number): void {
    const cfg = this.stats;
    const speedAbs = Math.abs(this.speed);
    this.wheelSpin += (this.speed / 0.44) * dt;

    for (const w of this.model.wheels) {
      if (w.front) w.steer.rotation.y = -this.steerVisual * 0.42;
      w.spin.rotation.x = this.wheelSpin;
      // Suspension squat under acceleration, dive under braking.
      const accel = (this.speed - this.prevSpeed) / Math.max(dt, 1e-4);
      const squat = clamp(-accel * 0.0016, -0.035, 0.05);
      w.steer.position.y = w.baseY + squat * (w.front ? -1 : 1) * 2;
    }

    const ratio = clamp(speedAbs / cfg.maxSpeed, 0, 1.4);
    const rollTarget = -this.steerVisual * 0.12 * ratio;
    this.roll = damp(this.roll, rollTarget, 5.5, dt);
    const accel = (this.speed - this.prevSpeed) / Math.max(dt, 1e-4);
    const pitchTarget = clamp(-accel * 0.0035, -0.05, 0.05);
    this.pitchVisual = damp(this.pitchVisual, pitchTarget, 4.5, dt);
    this.bob = Math.sin(this.elapsed * 12) * 0.012 * clamp(speedAbs / 12, 0, 1);

    this.syncTransform();
  }

  /** Pushes the simulated state into the Three.js transform. */
  syncTransform(): void {
    this.object.position.copy(this.position);
    this.object.position.y += this.bob;
    this.object.rotation.set(this.pitchVisual + this.roadPitch, this.yaw, this.roll);
    const glow = this.model.underglow.material as THREE.MeshBasicMaterial;
    glow.opacity = this.boosting ? 0.95 : 0.5;
  }

  /** World position of one exhaust nozzle. */
  exhaustWorldPosition(index: number, out: THREE.Vector3): THREE.Vector3 {
    const anchor = this.model.exhausts[index % this.model.exhausts.length]!;
    return anchor.getWorldPosition(out);
  }

  /** Forward unit vector (fresh instance). */
  forwardVector(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Brake lights glow when slowing down. */
  protected updateBrakeLights(braking: boolean): void {
    const mat = this.model.brakeMaterial;
    mat.color.setHex(braking ? 0xff6b8a : 0xff2b4d);
  }

  /** Nitro tank bookkeeping shared by player and AI. */
  protected updateNitro(dt: number, wantsNitro: boolean): void {
    const cfg = this.stats;
    if (wantsNitro && this.nitro > 1) {
      this.nitroActive = true;
      this.nitro = Math.max(0, this.nitro - cfg.nitroDrain * dt);
      if (this.nitro <= 0.5) this.lastNitroRelease = this.elapsed;
    } else {
      this.nitroActive = false;
      if (this.elapsed - this.lastNitroRelease > cfg.nitroRegenDelay) {
        this.nitro = Math.min(cfg.nitroCapacity, this.nitro + cfg.nitroRegen * dt);
      }
      if (wantsNitro) this.lastNitroRelease = this.elapsed;
    }
  }

  /** How much lateral slip the car currently has (0..1) — used for FX/audio. */
  get slip(): number {
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    return clamp(Math.abs(this.velocity.dot(right)) / 12, 0, 1);
  }
}
