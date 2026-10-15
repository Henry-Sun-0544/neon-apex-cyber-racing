import * as THREE from 'three';
import { AIController, type AIProfile, type AIWorldView } from './AIController';
import type { ParticleSystem } from './ParticleSystem';
import type { Track } from './Track';
import { VehicleBase } from './VehicleBase';

/** An AI-driven car: physics + racing-line brain + exhaust FX. */
export class AIVehicle extends VehicleBase {
  readonly profile: AIProfile;
  readonly controller: AIController;
  /** Lap progress cached for the standings. */
  raceProgress = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly backward = new THREE.Vector3();

  constructor(profile: AIProfile, track: Track) {
    super({ bodyColor: profile.bodyColor, accentColor: profile.accentColor, isPlayer: false });
    this.profile = profile;
    this.controller = new AIController(profile, track);
    this.object.name = `ai-car-${profile.name}`;
  }

  update(dt: number, track: Track, particles: ParticleSystem, view: AIWorldView): void {
    const input = this.controller.update(dt, this, view);
    this.updateNitro(dt, input.nitro);
    this.step(dt, input);
    this.updateBrakeLights(input.brake > 0.05 && this.speed > 1);

    // Speed pads work for the AI too.
    const proj = track.project(this.position, this.hintIndex);
    this.hintIndex = proj.index;
    if (track.padAt(proj.distance, proj.lateral) && Math.abs(this.speed) > 2) {
      this.applyBoostPad();
      if (Math.random() < 0.35) {
        particles.emitBoostBurst(this.position, this.forwardVector(), 18);
      }
    }

    // Flames on nitro / hard throttle.
    if (this.boosting || input.throttle > 0.8) {
      const intensity = this.boosting ? 0.85 : 0.24;
      this.backward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      for (let i = 0; i < this.model.exhausts.length; i++) {
        this.model.exhausts[i]!.getWorldPosition(this.tmp);
        particles.emitFlame(this.tmp, this.backward, intensity, dt, this.accent);
      }
    }
  }
}
