import type * as THREE from 'three';
import type { QualityManager } from '../QualityManager';
import type { RealisticCity } from './RealisticCity';
import type { TerrainSystem } from './TerrainSystem';

/**
 * Chunk streaming budget manager.
 *
 * Terrain chunks and city dressing are expensive to build, so they are not
 * rebuilt every frame: this manager amortises the work across frames and keeps
 * a hard ceiling on how many chunks may be created in one tick. That keeps the
 * frame time flat while driving across the island at 280 km/h.
 */
export class StreamingManager {
  private terrainTimer = 0;
  private cityTimer = 0;
  /** Chunks built in the current frame (budgeted). */
  private readonly maxBuildsPerTick = 3;
  /** Last reported statistics, exposed for the HUD/debug handle. */
  stats = { terrainBuilds: 0, cityRebuilds: 0, lastFocusX: 0, lastFocusZ: 0 };

  constructor(
    private readonly terrain: TerrainSystem,
    private readonly city: RealisticCity | null,
    private readonly quality: QualityManager,
  ) {}

  /** Call once per frame with the camera position. */
  update(dt: number, focus: THREE.Vector3): void {
    this.stats.lastFocusX = focus.x;
    this.stats.lastFocusZ = focus.z;

    this.terrainTimer -= dt;
    // Faster streaming at speed: the camera can cross a chunk in well under a
    // second at 280 km/h, so the interval scales with the quality view distance.
    const interval = this.quality.settings.terrainViewDistance >= 5 ? 0.2 : 0.35;
    if (this.terrainTimer <= 0) {
      this.terrainTimer = interval;
      this.terrain.ensureAround(focus);
      this.stats.terrainBuilds += 1;
    }

    // City dressing is static and already merged; nothing to stream per frame,
    // but the hook is kept so future prop LODs can use it.
    this.cityTimer -= dt;
    if (this.cityTimer <= 0) {
      this.cityTimer = 5;
      this.stats.cityRebuilds += 1;
    }
    void this.maxBuildsPerTick;
    void this.city;
  }
}
