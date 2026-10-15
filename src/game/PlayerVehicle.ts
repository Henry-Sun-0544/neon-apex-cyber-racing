import * as THREE from 'three';
import { CONFIG } from './Config';
import type { Track } from './Track';
import type { ParticleSystem } from './ParticleSystem';
import { VehicleBase, type VehicleInput } from './VehicleBase';

/**
 * The player car: same physics as the AI, plus nitro management, exhaust
 * flames, speed-pad pickup detection and effect triggers.
 */
export class PlayerVehicle extends VehicleBase {
  /** Nitro was requested but the tank was empty (one-shot flag for audio). */
  nitroDry = false;
  /** True on the frame a speed pad is picked up. */
  padPicked = false;
  private flameAccumulator = 0;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private wasBoosting = false;

  constructor() {
    super({ bodyColor: 0x1b2340, accentColor: CONFIG.colors.cyan, isPlayer: true });
    this.object.name = 'player-car';
  }

  /**
   * @param dt      delta time in seconds
   * @param input   driver input
   * @param track   track used for speed-pad detection
   * @param particles particle system for flames / pad bursts
   */
  update(dt: number, input: VehicleInput, track: Track, particles: ParticleSystem): void {
    const wasActive = this.nitroActive;
    this.updateNitro(dt, input.nitro);
    if (wasActive && !this.nitroActive && this.nitro <= 0.5 && input.nitro) this.nitroDry = true;
    else this.nitroDry = false;

    this.step(dt, input);
    this.updateBrakeLights(input.brake > 0.05 && this.speed > 1);

    // ------------------------------------------------------- speed pads
    this.padPicked = false;
    const proj = track.project(this.position, this.hintIndex);
    this.hintIndex = proj.index;
    const pad = track.padAt(proj.distance, proj.lateral);
    if (pad && Math.abs(this.speed) > 2) {
      this.applyBoostPad();
      this.padPicked = true;
      const forward = this.forwardVector();
      this.tmpA.copy(this.position);
      particles.emitBoostBurst(this.tmpA, forward, 60);
    }

    this.updateFlames(dt, particles, input);
  }

  /** Nitro flame + light exhaust trail out of both nozzles. */
  private updateFlames(dt: number, particles: ParticleSystem, input: VehicleInput): void {
    const boosting = this.boosting;
    for (let i = 0; i < this.model.exhausts.length; i++) {
      const anchor = this.model.exhausts[i]!;
      anchor.getWorldPosition(this.tmpA);
      const backward = this.tmpB.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      if (boosting) {
        const intensity = this.nitroActive ? 1 : 0.75;
        particles.emitFlame(this.tmpA, backward, intensity, dt, this.accent);
      } else {
        // Soft exhaust puff when flooring the throttle.
        this.flameAccumulator += dt;
        if (input.throttle > 0.55 && this.flameAccumulator > 0.06) {
          this.flameAccumulator = 0;
          particles.emitFlame(this.tmpA, backward, 0.28, 0.06, new THREE.Color(0xff8a3d));
        }
      }
    }
    this.wasBoosting = boosting;
  }

  /** True when the boost state just started (edge trigger for SFX). */
  get boostStarted(): boolean {
    return this.boosting && !this.wasBoosting;
  }
}
