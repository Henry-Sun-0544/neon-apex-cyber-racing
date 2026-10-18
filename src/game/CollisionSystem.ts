import * as THREE from 'three';
import { CONFIG } from './Config';
import type { RaceWorld } from './world/RaceWorld';
import type { CollisionEvent, StaticBox } from './Types';
import type { VehicleBase } from './VehicleBase';
import { clamp, damp, angleDelta } from './Utils';

const CELL = 48;

/**
 * Yaw (radians) of the track tangent, flipped to point the way the vehicle is
 * facing so that a wall-riding assist can never spin a car around.
 */
function forwardTangentYaw(yaw: number, tangent: THREE.Vector3): number {
  const t = Math.atan2(tangent.x, tangent.z);
  return Math.cos(t - yaw) < 0 ? t + Math.PI : t;
}

/**
 * Collision handling for the whole race.
 *
 * - Track walls are implicit: the car's signed lateral offset from the centre
 *   line is clamped to the road width (cheap, always correct, never tunnels).
 * - Static obstacles (towers, neon pylons) live in a uniform spatial hash.
 * - Cars collide as circles in the XZ plane with a mass-less impulse exchange.
 *
 * Every contact produces a `CollisionEvent` that drives sparks, audio and
 * camera shake in the caller, so all feedback stays in one place.
 */
export class CollisionSystem {
  private readonly grid = new Map<number, number[]>();
  private readonly boxes: StaticBox[];
  private readonly cell = CELL;
  private wallGrindCooldown = 0;

  constructor(boxes: StaticBox[]) {
    this.boxes = boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const cos = Math.abs(Math.cos(b.rotY));
      const sin = Math.abs(Math.sin(b.rotY));
      const hx = b.halfX * cos + b.halfZ * sin;
      const hz = b.halfX * sin + b.halfZ * cos;
      const minIx = Math.floor((b.x - hx) / this.cell);
      const maxIx = Math.floor((b.x + hx) / this.cell);
      const minIz = Math.floor((b.z - hz) / this.cell);
      const maxIz = Math.floor((b.z + hz) / this.cell);
      for (let ix = minIx; ix <= maxIx; ix++) {
        for (let iz = minIz; iz <= maxIz; iz++) {
          const key = this.key(ix, iz);
          const list = this.grid.get(key);
          if (list) list.push(i);
          else this.grid.set(key, [i]);
        }
      }
    }
  }

  private key(ix: number, iz: number): number {
    return (ix + 4096) * 16384 + (iz + 4096);
  }

  /**
   * Resolve every contact for one vehicle and return the events that happened.
   * Also keeps the car glued to the road surface (height + slope pitch).
   */
  resolve(vehicle: VehicleBase, track: RaceWorld, opponents: VehicleBase[], dt: number): CollisionEvent[] {
    const events: CollisionEvent[] = [];
    const proj = track.project(vehicle.position, vehicle.hintIndex);
    vehicle.hintIndex = proj.index;

    // ------------------------------------------------- road surface follow
    vehicle.position.y = damp(vehicle.position.y, proj.height, 16, dt);
    // Average the slope over the car's length (sample 2.2 m ahead/behind along
    // the arc): the instantaneous tangent makes long cars spear through the
    // deck on tight crests and dips.
    const ahead = track.frameAt(proj.distance + 2.2);
    const behind = track.frameAt(proj.distance - 2.2);
    const slope = (ahead.pos.y - behind.pos.y) / 4.4;
    vehicle.roadPitch = -Math.asin(clamp(slope, -0.5, 0.5));
    // Slope along the car heading: the tangent's vertical component weighted
    // by how nose-aligned the car is with the road. VehicleBase turns this
    // into gravity (uphill pulls back / downhill pushes on / unbraked cars
    // roll downhill).
    vehicle.slopeAlong =
      proj.tangent.y * (Math.sin(vehicle.yaw) * proj.tangent.x + Math.cos(vehicle.yaw) * proj.tangent.z);

    // --------------------------------------------------------- track walls
    const limit = track.halfWidth - 1.15;
    if (Math.abs(proj.lateral) > limit) {
      const sign = Math.sign(proj.lateral) || 1;
      const push = Math.abs(proj.lateral) - limit;
      vehicle.position.addScaledVector(proj.side, -sign * push);

      const lateralVel = vehicle.velocity.dot(proj.side);
      const closing = lateralVel * sign; // > 0 means driving into the barrier

      // Reflect only the offending normal component.
      if (closing > 0) {
        vehicle.velocity.addScaledVector(proj.side, -lateralVel * (1 + CONFIG.car.restitution));
      }

      const contact = clamp(closing / 10, 0, 1);

      // Wall riding: scrub friction alone parks a car that is held nose-first
      // against a barrier at ~0 m/s, so the car is also steered back along the
      // barrier. The player keeps their momentum and is never trapped.
      const assist = CONFIG.car.wallAssistRate * (0.35 + contact) * dt;
      vehicle.yaw += clamp(angleDelta(vehicle.yaw, forwardTangentYaw(vehicle.yaw, proj.tangent)), -assist, assist);

      // Scrape friction is applied as a *rate*, never as a flat per-frame cut,
      // so a car sliding along a barrier keeps its momentum regardless of FPS.
      const forward = vehicle.forwardVector();
      const scrubRate = 0.9 + contact * 5.5; // 1/s
      const long = vehicle.velocity.dot(forward);
      // A driver who is asking for throttle always keeps a floor speed: being
      // pinned must cost speed, never park the car.
      const floor = vehicle.lastThrottle > 0.35 ? CONFIG.car.wallScrubFloor : 0;
      const retained = Math.max(
        Math.abs(long) * Math.exp(-scrubRate * dt),
        Math.min(Math.abs(long), floor),
      );
      vehicle.velocity.addScaledVector(forward, Math.sign(long) * retained - long);

      // A genuine crash (hard, mostly sideways) costs a one-off chunk of speed.
      if (closing > 6) {
        vehicle.velocity.multiplyScalar(1 - clamp(closing / 120, 0.05, 0.28));
      }
      vehicle.speed = vehicle.velocity.dot(forward);

      if (closing > 2.5) {
        events.push({
          point: vehicle.position.clone(),
          strength: clamp(closing / 16, 0.15, 1),
          kind: 'wall',
          normal: proj.side.clone().multiplyScalar(-sign),
        });
      } else if (this.wallGrindCooldown <= 0 && Math.abs(vehicle.speed) > 8) {
        // Grinding along the barrier keeps a trickle of sparks going.
        this.wallGrindCooldown = 0.12;
        events.push({
          point: vehicle.position.clone(),
          strength: 0.16,
          kind: 'wall',
          normal: proj.side.clone().multiplyScalar(-sign),
        });
      }
    }
    if (this.wallGrindCooldown > 0) this.wallGrindCooldown -= dt;

    // ------------------------------------------------------ static boxes
    events.push(...this.resolveStatic(vehicle));

    // ---------------------------------------------------------- car bumps
    for (const other of opponents) {
      if (other === vehicle) continue;
      const dx = other.position.x - vehicle.position.x;
      const dz = other.position.z - vehicle.position.z;
      const dy = Math.abs(other.position.y - vehicle.position.y);
      const minDist = vehicle.radius + other.radius;
      const distSq = dx * dx + dz * dz;
      if (dy > 3 || distSq > minDist * minDist || distSq < 1e-6) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDist - dist;

      // Separate both bodies proportionally.
      vehicle.position.x -= nx * overlap * 0.5;
      vehicle.position.z -= nz * overlap * 0.5;
      other.position.x += nx * overlap * 0.5;
      other.position.z += nz * overlap * 0.5;

      // Exchange the normal component of the velocity (equal masses).
      const vnSelf = vehicle.velocity.x * nx + vehicle.velocity.z * nz;
      const vnOther = other.velocity.x * nx + other.velocity.z * nz;
      const relative = vnSelf - vnOther;
      if (relative > 0) {
        const impulse = relative * (0.5 + CONFIG.car.restitution * 0.5);
        vehicle.velocity.x -= nx * impulse;
        vehicle.velocity.z -= nz * impulse;
        other.velocity.x += nx * impulse;
        other.velocity.z += nz * impulse;
        vehicle.speed = vehicle.velocity.dot(vehicle.forwardVector());
        other.speed = other.velocity.dot(other.forwardVector());
        const strength = clamp(relative / 20, 0.15, 1);
        const mid = new THREE.Vector3(
          (vehicle.position.x + other.position.x) / 2,
          (vehicle.position.y + other.position.y) / 2 + 0.6,
          (vehicle.position.z + other.position.z) / 2,
        );
        events.push({ point: mid, strength, kind: 'car', normal: { x: nx, y: 0.35, z: nz } });
      }
    }

    // ------------------------------------------------- anti-wedge assist
    // Arcade racers must never trap the player: if the car is pinned against a
    // barrier or pylon at a standstill while the driver asks for throttle, ease
    // it back towards the racing line. Purely a nudge — no teleporting.
    if (Math.abs(vehicle.speed) < 2.2 && vehicle.lastThrottle > 0.4) {
      vehicle.stuckTimer += dt;
      if (vehicle.stuckTimer > 1.1) {
        vehicle.stuckTimer = 0;
        // Each failed attempt escalates, so no combination of wall + pylon +
        // opponent can pin the player for good. Reversing with S always works
        // too, but a driver who just keeps the throttle down must not be stuck.
        vehicle.wedgeRescues = Math.min(vehicle.wedgeRescues + 1, 4);
        const push = 0.9 * vehicle.wedgeRescues;
        const inward = proj.side.clone().multiplyScalar(-(Math.sign(proj.lateral) || 1));
        vehicle.position.addScaledVector(inward, push);
        // Point the nose back down the track, otherwise the next burst of
        // throttle just drives straight back into whatever pinned the car.
        vehicle.yaw += clamp(angleDelta(vehicle.yaw, forwardTangentYaw(vehicle.yaw, proj.tangent)), -0.6, 0.6);
        vehicle.velocity.addScaledVector(inward, 3.5 + vehicle.wedgeRescues);
        vehicle.velocity.addScaledVector(vehicle.forwardVector(), 5 + vehicle.wedgeRescues * 2);
        vehicle.speed = vehicle.velocity.dot(vehicle.forwardVector());
      }
    } else {
      // Moving again: forget the escalation entirely.
      vehicle.stuckTimer = Math.max(0, vehicle.stuckTimer - dt);
      if (Math.abs(vehicle.speed) > 4) vehicle.wedgeRescues = 0;
    }

    return events;
  }

  /** Circle vs. oriented-box test against the spatial hash. */
  private resolveStatic(vehicle: VehicleBase): CollisionEvent[] {
    const events: CollisionEvent[] = [];
    const r = vehicle.radius;
    const ix = Math.floor(vehicle.position.x / this.cell);
    const iz = Math.floor(vehicle.position.z / this.cell);
    const candidates = new Set<number>();
    for (let ax = -1; ax <= 1; ax++) {
      for (let az = -1; az <= 1; az++) {
        const list = this.grid.get(this.key(ix + ax, iz + az));
        if (list) for (const idx of list) candidates.add(idx);
      }
    }
    for (const idx of candidates) {
      const b = this.boxes[idx]!;
      if (Math.abs(vehicle.position.y - b.y) > b.halfY + 1.2) continue;
      const dx = vehicle.position.x - b.x;
      const dz = vehicle.position.z - b.z;
      const cos = Math.cos(b.rotY);
      const sin = Math.sin(b.rotY);
      // World -> box local space
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      const closestX = clamp(lx, -b.halfX, b.halfX);
      const closestZ = clamp(lz, -b.halfZ, b.halfZ);
      let nx = lx - closestX;
      let nz = lz - closestZ;
      let dist = Math.hypot(nx, nz);
      const inside = dist < 1e-5;
      if (inside) {
        // Deep penetration: push out along the shallowest axis.
        const overlapX = b.halfX - Math.abs(lx);
        const overlapZ = b.halfZ - Math.abs(lz);
        if (overlapX < overlapZ) {
          nx = Math.sign(lx) || 1;
          nz = 0;
          dist = 0;
        } else {
          nx = 0;
          nz = Math.sign(lz) || 1;
          dist = 0;
        }
      }
      if (dist > r) continue;
      const invDist = dist > 1e-5 ? 1 / dist : 0;
      const unitLx = nx * invDist;
      const unitLz = nz * invDist;
      const penetration = r - dist;
      // Local -> world normal
      const worldNx = unitLx * cos + unitLz * sin;
      const worldNz = -unitLx * sin + unitLz * cos;
      vehicle.position.x += worldNx * penetration;
      vehicle.position.z += worldNz * penetration;

      const vn = vehicle.velocity.x * worldNx + vehicle.velocity.z * worldNz;
      if (vn < 0) {
        vehicle.velocity.x -= worldNx * vn * (1 + 0.35);
        vehicle.velocity.z -= worldNz * vn * (1 + 0.35);
        // Hard impacts cost more speed than a glancing hit.
        const penalty = clamp(Math.abs(vn) / 25, 0.05, 0.45);
        vehicle.velocity.multiplyScalar(1 - penalty);
        vehicle.speed = vehicle.velocity.dot(vehicle.forwardVector());
        events.push({
          point: new THREE.Vector3(vehicle.position.x, vehicle.position.y + 0.6, vehicle.position.z),
          strength: clamp(Math.abs(vn) / 18, 0.15, 1),
          kind: b.tag === 'building' ? 'building' : 'wall',
          normal: { x: worldNx, y: 0.3, z: worldNz },
        });
      }
    }
    return events;
  }
}
