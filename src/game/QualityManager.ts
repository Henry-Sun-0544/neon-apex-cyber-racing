/**
 * Quality presets and the automatic degradation ladder.
 *
 * Round 2 adds a second (realistic) style whose cost profile is very different
 * from the cyberpunk one, so "quality" can no longer be a handful of booleans
 * buried in a render config. Every expensive feature is now described here and
 * every consumer (SceneManager, PostProcessingStack, MaterialLibrary, the world
 * systems) reads its budget from the *effective* settings object.
 *
 * The ladder is intentionally monotonic: a run that degrades never climbs back
 * up on its own, which keeps the frame time stable instead of oscillating
 * between two quality levels.
 */

export type QualityPresetId = 'low' | 'medium' | 'high' | 'ultra';

/** Everything a renderer/world system may want to know about the budget. */
export interface QualitySettings {
  id: QualityPresetId;
  /** Short display name (CN + EN), shown in the UI. */
  label: string;
  /** Hard cap on `devicePixelRatio`. */
  pixelRatio: number;
  /** Shadow map edge in pixels; `0` disables shadow maps entirely. */
  shadowMapSize: number;
  /** PCFSoft (true) vs PCF (false) shadow filtering. */
  shadowSoft: boolean;
  /** Half-extent (metres) of the shadow camera around the player. */
  shadowRadius: number;
  /** UnrealBloom. */
  bloom: boolean;
  /** Screen-space ambient occlusion. */
  ssao: boolean;
  /** Screen-space reflections (ultra only, heavy). */
  ssr: boolean;
  /** Sub-pixel morphological AA. */
  smaa: boolean;
  /** Radial sun scattering ("god rays"). */
  godRays: boolean;
  /** Velocity-based motion blur. */
  motionBlur: boolean;
  /** Contrast / saturation / temperature grading + vignette + grain + CA. */
  colorGrade: boolean;
  /** Animated film grain in the colour grade pass. */
  filmGrain: boolean;
  /** Lens chromatic aberration in the colour grade pass. */
  chromaticAberration: boolean;
  /** Bokeh depth of field. */
  depthOfField: boolean;
  /** Screen-space reflection (SSR) render every N frames; 0 disables. */
  reflectionInterval: number;
  /** PMREM environment probe size (0 = no image based lighting). */
  envMapSize: number;
  /** Procedural PBR texture edge in pixels. */
  textureSize: number;
  /** Anisotropic filtering samples. */
  anisotropy: number;
  /** 0 = full detail, higher = simpler geometry. */
  lodBias: number;
  /** Terrain chunk edge (metres) for the streaming terrain. */
  terrainChunkSize: number;
  /** How many chunks (rings) to keep resident around the camera. */
  terrainViewDistance: number;
  /** Extra traffic cars in open-world mode. */
  trafficCount: number;
  /** Scatter/prop multiplier for the city and biomes (0..1). */
  detailDensity: number;
  /** Multiplier applied to every particle pool. */
  particleScale: number;
}

/** One rung of the automatic degradation ladder. */
interface DegradeStep {
  label: string;
  apply: (base: QualitySettings) => void;
}

function clone(base: QualitySettings): QualitySettings {
  return { ...base };
}

const PRESET_BASE: Record<QualityPresetId, Omit<QualitySettings, 'id' | 'label'>> = {
  low: {
    pixelRatio: 1,
    shadowMapSize: 0,
    shadowSoft: false,
    shadowRadius: 60,
    bloom: false,
    ssao: false,
    ssr: false,
    smaa: false,
    godRays: false,
    filmGrain: false,
    chromaticAberration: false,
    depthOfField: false,
    motionBlur: false,
    colorGrade: true,
    reflectionInterval: 0,
    // A 64 px probe still carries the sky's ambient; without it every PBR
    // surface renders near-black under the analytic lights alone.
    envMapSize: 64,
    textureSize: 256,
    anisotropy: 1,
    lodBias: 2,
    terrainChunkSize: 128,
    terrainViewDistance: 2,
    trafficCount: 12,
    detailDensity: 0.35,
    particleScale: 0.4,
  },
  medium: {
    pixelRatio: 1.25,
    shadowMapSize: 1024,
    shadowSoft: false,
    shadowRadius: 85,
    bloom: true,
    ssao: false,
    ssr: false,
    smaa: true,
    godRays: false,
    filmGrain: false,
    chromaticAberration: false,
    depthOfField: false,
    motionBlur: false,
    colorGrade: true,
    reflectionInterval: 0,
    envMapSize: 64,
    textureSize: 512,
    anisotropy: 4,
    lodBias: 1,
    terrainChunkSize: 128,
    terrainViewDistance: 3,
    trafficCount: 22,
    detailDensity: 0.6,
    particleScale: 0.7,
  },
  high: {
    pixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowSoft: true,
    shadowRadius: 110,
    bloom: true,
    ssao: true,
    ssr: false,
    smaa: true,
    godRays: true,
    filmGrain: true,
    chromaticAberration: true,
    depthOfField: false,
    motionBlur: true,
    colorGrade: true,
    reflectionInterval: 0,
    envMapSize: 128,
    textureSize: 512,
    anisotropy: 8,
    lodBias: 0,
    terrainChunkSize: 96,
    terrainViewDistance: 4,
    trafficCount: 34,
    detailDensity: 0.85,
    particleScale: 1,
  },
  ultra: {
    pixelRatio: 1.75,
    shadowMapSize: 3072,
    shadowSoft: true,
    shadowRadius: 140,
    bloom: true,
    ssao: true,
    ssr: true,
    smaa: true,
    godRays: true,
    filmGrain: true,
    chromaticAberration: true,
    depthOfField: true,
    motionBlur: true,
    colorGrade: true,
    reflectionInterval: 2,
    envMapSize: 256,
    textureSize: 1024,
    anisotropy: 16,
    lodBias: 0,
    terrainChunkSize: 96,
    terrainViewDistance: 5,
    trafficCount: 46,
    detailDensity: 1,
    particleScale: 1.25,
  },
};

const PRESET_LABEL: Record<QualityPresetId, string> = {
  low: '低 LOW',
  medium: '中 MEDIUM',
  high: '高 HIGH',
  ultra: '极致 ULTRA',
};

export const QUALITY_PRESET_IDS: QualityPresetId[] = ['low', 'medium', 'high', 'ultra'];

/** The degradation ladder, applied in order as frames stay slow. */
const LADDER: DegradeStep[] = [
  {
    label: '关闭 SSR / 体积光',
    apply: (q) => {
      q.ssr = false;
      q.reflectionInterval = 0;
      q.godRays = false;
    },
  },
  {
    label: '关闭 SSAO / 景深 / 运动模糊',
    apply: (q) => {
      q.ssao = false;
      q.depthOfField = false;
      q.motionBlur = false;
    },
  },
  {
    label: '阴影分辨率减半 / 像素比降至 1',
    apply: (q) => {
      if (q.shadowMapSize > 0) q.shadowMapSize = Math.max(512, Math.floor(q.shadowMapSize / 2));
      q.shadowSoft = false;
      q.pixelRatio = Math.min(q.pixelRatio, 1);
      q.envMapSize = 0;
    },
  },
  {
    label: 'LOD 降级 / 细节与交通减半',
    apply: (q) => {
      q.lodBias += 1;
      q.detailDensity = Math.max(0.2, q.detailDensity * 0.5);
      q.trafficCount = Math.max(6, Math.floor(q.trafficCount * 0.5));
      q.particleScale = Math.max(0.25, q.particleScale * 0.6);
      q.terrainViewDistance = Math.max(2, q.terrainViewDistance - 1);
    },
  },
  {
    label: '关闭 Bloom 与体积雾',
    apply: (q) => {
      q.bloom = false;
      q.godRays = false;
      q.smaa = false;
    },
  },
];

/**
 * Owns the current preset, the degradation level and the frame-time watchdog.
 * `settings` always returns a fresh object: systems store it and must not be
 * able to mutate the manager's state by accident.
 */
export class QualityManager {
  private preset: QualityPresetId;
  private level = 0;
  private accumulator = 0;
  private frames = 0;
  /** Consecutive slow sample windows; two are required before a degrade. */
  private slowWindows = 0;
  /** Set while the watchdog is in its warm-up window after a preset change. */
  private warmup = 0;
  /** Last measured FPS, exposed for the HUD / debug handle. */
  fps = 60;
  /** Notified whenever the effective settings change (style/world re-apply). */
  onChange: (() => void) | null = null;

  constructor(initial: QualityPresetId = 'high') {
    this.preset = initial;
  }

  get presetId(): QualityPresetId {
    return this.preset;
  }

  get presetLabel(): string {
    return PRESET_LABEL[this.preset];
  }

  /** True once the watchdog removed at least one expensive feature. */
  get autoDegraded(): boolean {
    return this.level > 0;
  }

  get degradeLevel(): number {
    return this.level;
  }

  /** Human readable description of what the watchdog turned off. */
  get degradeLabel(): string {
    return this.level === 0 ? '' : LADDER[this.level - 1]!.label;
  }

  /** The effective settings: preset base with every applied rung on top. */
  get settings(): QualitySettings {
    const base = clone({
      ...PRESET_BASE[this.preset],
      id: this.preset,
      label: PRESET_LABEL[this.preset],
    });
    for (let i = 0; i < this.level; i++) LADDER[i]!.apply(base);
    return base;
  }

  /** Switches preset; resets the ladder so the new budget starts clean. */
  setPreset(id: QualityPresetId): void {
    if (!PRESET_BASE[id]) return;
    this.preset = id;
    this.level = 0;
    this.warmup = 2.5;
    this.accumulator = 0;
    this.frames = 0;
    this.slowWindows = 0;
    this.onChange?.();
  }

  /** Steps the preset up/down (the Y hotkey cycles through all four). */
  cyclePreset(direction = 1): QualityPresetId {
    const index = QUALITY_PRESET_IDS.indexOf(this.preset);
    const next = QUALITY_PRESET_IDS[(index + direction + QUALITY_PRESET_IDS.length) % QUALITY_PRESET_IDS.length]!;
    this.setPreset(next);
    return next;
  }

  /** Clears the ladder (used when the player explicitly picks a preset). */
  resetDegradation(): void {
    if (this.level === 0) return;
    this.level = 0;
    this.warmup = 1.5;
    this.onChange?.();
  }

  /**
   * Frame-time watchdog.
   *
   * Returns `true` when a degradation rung was just applied so the caller can
   * rebuild whatever depends on the settings (post FX stack, shadow map size…).
   */
  sample(dt: number, _elapsed: number): boolean {
    // Ignore the first moments after a switch: shader compilation and texture
    // upload would otherwise look like a permanently slow machine.
    if (this.warmup > 0) {
      this.warmup -= dt;
      return false;
    }
    this.accumulator += dt;
    this.frames += 1;

    if (this.accumulator < 2.5) return false;
    this.fps = this.frames / this.accumulator;
    this.accumulator = 0;
    this.frames = 0;

    // Two consecutive slow windows are required so a single hitch (a GC pause,
    // a texture upload) never costs the player image quality.
    if (this.fps < 34 && this.level < LADDER.length) {
      this.slowWindows += 1;
      if (this.slowWindows >= 2) {
        this.slowWindows = 0;
        this.level += 1;
        console.info(
          `[NA:CR] ${this.fps.toFixed(1)} FPS — 自动降级 (${this.level}/${LADDER.length}): ${this.degradeLabel}`,
        );
        this.warmup = 1.5;
        this.onChange?.();
        return true;
      }
    } else {
      this.slowWindows = 0;
    }
    return false;
  }
}
