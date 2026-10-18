import { CONFIG, type RaceResult, type RacerSnapshot } from './Config';
import type { AIVehicle } from './AIVehicle';
import type { RaceWorld } from './world/RaceWorld';
import type { VehicleBase } from './VehicleBase';

export type RacePhase = 'menu' | 'countdown' | 'racing' | 'finished';

/** Race bookkeeping for one car (player or AI). */
export interface Racer {
  id: number;
  name: string;
  isPlayer: boolean;
  vehicle: VehicleBase;
  /** Completed laps (only counted when a full loop was driven). */
  lap: number;
  /** Forward distance driven inside the current lap (anti-cheat accumulator). */
  lapDistance: number;
  /** Distance of the previous frame, used to detect line crossings. */
  lastTrackDistance: number;
  /** Monotonic race distance in metres; the primary ranking key. */
  raceDistance: number;
  lapStartTime: number;
  lapTimes: number[];
  bestLap: number | null;
  lastLapTime: number | null;
  finished: boolean;
  finishTime: number | null;
  rank: number;
}

export interface RaceHooks {
  /** A lap was just completed (forward crossing of the start line). */
  onLap?: (racer: Racer, lapTime: number, isBest: boolean) => void;
  /** A racer crossed the finish line for the last time. */
  onFinish?: (racer: Racer) => void;
  /** A racer crossed the start line at all (used for lap-count toasts). */
  onLapStarted?: (racer: Racer) => void;
}

/**
 * Race director: phase machine, lap/checkpoint logic, timing and standings.
 * It owns no rendering — it only drives the numbers behind the HUD.
 */
export class GameState {
  phase: RacePhase = 'menu';
  racers: Racer[] = [];
  raceTime = 0;
  countdown = CONFIG.race.countdownFrom;
  readonly totalLaps = CONFIG.race.laps;
  /** Wall-clock time (seconds) when the race was marked finished. */
  finishedAt = 0;

  /** Swaps the race route (map-mode switch) without touching the racers. */
  setWorld(world: RaceWorld): void {
    this.track = world;
    for (const r of this.racers) {
      r.lastTrackDistance = 0;
      r.lapDistance = 0;
      r.vehicle.hintIndex = -1;
    }
  }

  constructor(
    private track: RaceWorld,
    player: VehicleBase,
    ais: AIVehicle[],
    playerName = 'YOU',
  ) {
    const all: Array<{ v: VehicleBase; name: string; isPlayer: boolean }> = [
      { v: player, name: playerName, isPlayer: true },
      ...ais.map((v) => ({ v: v as VehicleBase, name: v.profile.name, isPlayer: false })),
    ];
    this.racers = all.map((entry, i) => ({
      id: i,
      name: entry.name,
      isPlayer: entry.isPlayer,
      vehicle: entry.v,
      lap: 0,
      lapDistance: 0,
      lastTrackDistance: 0,
      raceDistance: 0,
      lapStartTime: 0,
      lapTimes: [],
      bestLap: null,
      lastLapTime: null,
      finished: false,
      finishTime: null,
      rank: i + 1,
    }));
  }

  get player(): Racer {
    return this.racers.find((r) => r.isPlayer)!;
  }

  /** Put everybody back on the grid and clear all timings. */
  resetToGrid(): void {
    const slots = this.track.startSlots();
    // Player starts in the middle of the pack: more fun than pole or last.
    const playerSlot = Math.min(4, slots.length - 1);
    let aiSlot = 0;

    const assign = (racer: Racer, slot: [number, number]): void => {
      const [distance, lateral] = slot;
      const frame = this.track.frameAt(distance);
      const position = frame.pos.clone().addScaledVector(frame.side, lateral);
      racer.vehicle.placeAt(position, Math.atan2(frame.tangent.x, frame.tangent.z), 0);
      racer.vehicle.resetState();
      racer.lap = 0;
      racer.lapDistance = 0;
      racer.raceDistance = 0;
      racer.lapStartTime = 0;
      racer.lapTimes = [];
      racer.bestLap = null;
      racer.lastLapTime = null;
      racer.finished = false;
      racer.finishTime = null;
      const proj = this.track.project(position, -1);
      racer.lastTrackDistance = proj.distance;
    };

    for (const racer of this.racers) {
      if (racer.isPlayer) {
        assign(racer, slots[playerSlot]!);
      } else {
        // Skip the slot the player occupies.
        let index = aiSlot++;
        if (index >= playerSlot) index += 1;
        assign(racer, slots[index % slots.length]!);
      }
      // Cars wait on the grid; GO unfreezes them (see VehicleBase.step).
      racer.vehicle.parked = true;
    }
    this.raceTime = 0;
    this.countdown = CONFIG.race.countdownFrom;
    this.phase = 'menu';
    this.finishedAt = 0;
  }

  /** Starts the 3-2-1-GO sequence. */
  startCountdown(): void {
    this.resetToGrid();
    this.phase = 'countdown';
  }

  /**
   * Advances the director by one frame.
   * Physics itself is stepped by the caller; this only tracks the numbers.
   */
  update(dt: number, hooks: RaceHooks = {}): void {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'racing';
        this.raceTime = 0;
        for (const r of this.racers) r.lapStartTime = 0;
      }
      return;
    }
    if (this.phase !== 'racing') return;

    this.raceTime += dt;
    const total = this.track.totalLength;

    for (const r of this.racers) {
      if (r.finished) continue;
      const proj = this.track.project(r.vehicle.position, r.vehicle.hintIndex);
      r.vehicle.hintIndex = proj.index;
      let delta = proj.distance - r.lastTrackDistance;
      let crossedForward = false;
      if (delta < -total / 2) {
        crossedForward = true;
        delta += total;
      } else if (delta > total / 2) {
        delta -= total;
      }
      r.lastTrackDistance = proj.distance;
      if (delta > 0) {
        r.lapDistance += delta;
        r.raceDistance += delta;
      }

      if (crossedForward) {
        hooks.onLapStarted?.(r);
        // A real lap needs at least 80% of the loop driven since the last one.
        if (r.lapDistance >= total * 0.8) {
          const lapTime = this.raceTime - r.lapStartTime;
          r.lapTimes.push(lapTime);
          r.lastLapTime = lapTime;
          const isBest = r.bestLap === null || lapTime < r.bestLap;
          if (isBest) r.bestLap = lapTime;
          r.lap += 1;
          r.lapStartTime = this.raceTime;
          r.lapDistance = Math.max(0, r.lapDistance - total);
          hooks.onLap?.(r, lapTime, isBest);
          if (r.lap >= this.totalLaps) {
            r.finished = true;
            r.finishTime = this.raceTime;
            hooks.onFinish?.(r);
          }
        }
      }
    }

    this.updateStandings();

    const player = this.player;
    if (player.finished && this.phase === 'racing') {
      this.phase = 'finished';
      this.finishedAt = this.raceTime;
      // Freeze unfinished AI at their current distance so the table is stable.
      for (const r of this.racers) {
        if (!r.finished) r.rank = this.computeRank(r);
      }
    }
  }

  /** Sorted standings: finished cars by time, everybody else by distance. */
  standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return (a.finishTime ?? 0) - (b.finishTime ?? 0);
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.raceDistance - a.raceDistance;
    });
  }

  private computeRank(racer: Racer): number {
    return this.standings().indexOf(racer) + 1;
  }

  private updateStandings(): void {
    const order = this.standings();
    order.forEach((r, i) => {
      r.rank = i + 1;
    });
  }

  /** Current HUD numbers for the player. */
  playerSnapshot(): { rank: number; lap: number; raceTime: number; lapTime: number; bestLap: number | null } {
    const p = this.player;
    return {
      rank: p.rank,
      lap: Math.min(p.lap + 1, this.totalLaps),
      raceTime: this.raceTime,
      lapTime: this.phase === 'racing' || this.phase === 'finished' ? this.raceTime - p.lapStartTime : 0,
      bestLap: p.bestLap,
    };
  }

  /** Final classification for the results screen. */
  results(): RaceResult {
    const order = this.standings();
    const snapshots: RacerSnapshot[] = order.map((r, i) => ({
      id: r.id,
      name: r.name,
      isPlayer: r.isPlayer,
      lap: r.lap,
      position: i + 1,
      totalProgress: r.raceDistance,
      bestLap: r.bestLap,
      totalTime: r.finished ? r.finishTime : null,
      finished: r.finished,
      colorHex: (r.vehicle.accent.getHex() as number) ?? 0xffffff,
    }));
    const p = this.player;
    return {
      racers: snapshots,
      playerPosition: p.rank,
      playerTotalTime: p.finished ? p.finishTime : null,
      playerBestLap: p.bestLap,
      laps: this.totalLaps,
    };
  }
}
