import * as THREE from 'three';
import type { MaterialLibrary } from '../MaterialLibrary';
import type { PostFxRequest } from '../PostProcessingStack';
import type { QualitySettings } from '../QualityManager';

/** The two selectable looks. Adding a third only needs a new subclass. */
export type GameStyleId = 'cyberpunk' | 'realistic';

export const GAME_STYLE_IDS: GameStyleId[] = ['cyberpunk', 'realistic'];

/** Every colour a style owns. Consumed by lights, materials, particles and the UI. */
export interface StylePalette {
  /** Exponential fog colour and density. */
  fog: number;
  fogDensity: number;
  /** Ambient / hemisphere fill. */
  ambient: number;
  ambientIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Key light (sun or moon). */
  sun: number;
  sunIntensity: number;
  /** Opposite fill / rim light. */
  rim: number;
  rimIntensity: number;
  /** Material tints the world generators use. */
  roadTint: number;
  railTint: number;
  buildingTint: number;
  terrainTint: number;
  /** Signature accents (neon in cyberpunk, signal colours in realistic). */
  accentA: number;
  accentB: number;
  /** Particle colours: nitro flame + ambient dust/rain. */
  flameA: number;
  flameB: number;
  dust: number;
  /** Minimap canvas colours. */
  minimapTrack: string;
  minimapAccent: string;
  minimapBackdrop: string;
  /** UI theme (CSS custom properties are driven from these). */
  uiAccent: string;
  uiAccent2: string;
  uiBg: string;
  uiPanel: string;
  uiText: string;
}

/** Everything a style is allowed to touch. */
export interface StyleEnvironment {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  materials: MaterialLibrary;
  quality: QualitySettings;
}

/** Style metadata used by the menus (kept separate from the heavy instances). */
export interface StyleMeta {
  id: GameStyleId;
  name: string;
  short: string;
  tagline: string;
}

export const STYLE_META: Record<GameStyleId, StyleMeta> = {
  cyberpunk: {
    id: 'cyberpunk',
    name: '赛博朋克 CYBERPUNK',
    short: 'CYBERPUNK',
    tagline: '霓虹暗夜 · 合成波 · 辉光',
  },
  realistic: {
    id: 'realistic',
    name: '真实风格 REALISTIC',
    short: 'REALISTIC',
    tagline: '写实天光 · PBR 材质 · 昼夜与天气',
  },
};

/**
 * Base class for a game look.
 *
 * A style only ever owns *presentation*: the sky, the light rig, fog, the
 * post-processing request and the material grades. It never owns geometry,
 * physics or race state, which is exactly why switching styles at runtime
 * cannot lose a lap, a timing value or the player's position — nothing that
 * holds game state is rebuilt.
 */
export abstract class GameStyle {
  abstract readonly id: GameStyleId;
  abstract readonly palette: StylePalette;
  /** Root holding every object this style added (removed wholesale on switch). */
  readonly root = new THREE.Group();
  /** Styles with a moving sun report `true` so the HUD can show a clock. */
  abstract readonly dayCycle: boolean;
  /** Wet road surface (drives the SSR-lite pass and the road material grade). */
  abstract readonly wet: boolean;
  /** 0..1 precipitation amounts consumed by the particle layer. */
  rain = 0;
  snow = 0;
  /** 0 = midnight, 0.5 = noon. Fixed for styles without a cycle. */
  timeOfDay = 0.5;
  protected env!: StyleEnvironment;
  protected readonly disposables: Array<{ dispose(): void }> = [];

  /** Installs the style into the scene (called on boot and on every switch). */
  attach(env: StyleEnvironment): void {
    this.env = env;
    this.root.name = `style:${this.id}`;
    this.build();
    env.scene.add(this.root);
    this.configureAtmosphere();
  }

  /** Detaches everything without touching the world graph. */
  detach(scene: THREE.Scene): void {
    scene.remove(this.root);
    this.root.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  /** Builds sky + lights into `root`. */
  protected abstract build(): void;
  /** Fog + background for the current time of day. */
  abstract configureAtmosphere(): void;
  /** The effect request, already scaled by the quality budget. */
  abstract fxRequest(quality: QualitySettings): PostFxRequest;
  /** Per-frame animation (sun path, clouds, weather). */
  abstract update(dt: number, elapsed: number, camera: THREE.PerspectiveCamera): void;
  /**
   * World-space direction from the camera towards the sun (or `null` when the
   * sun is below the horizon). Drives the god-ray pass.
   */
  abstract sunDirection(): THREE.Vector3 | null;
  /** Adaptive exposure multiplier (1 = neutral). */
  exposureAdaptation(_camera: THREE.PerspectiveCamera): number {
    return 1;
  }
  /** Keeps a shadow-casting key light centred on the action. */
  updateShadowFocus(_point: THREE.Vector3): void {
    /* only shadowed styles care */
  }
  /** Called when the quality preset changes. */
  setQuality(_quality: QualitySettings): void {
    /* most styles do not care */
  }
  /** Streak light colour for particles (nitro flame etc.). */
  get flameColors(): [number, number] {
    return [this.palette.flameA, this.palette.flameB];
  }
  /** Human readable in-world clock ("17:24"), or "NIGHT" for static styles. */
  get clock(): string {
    if (!this.dayCycle) return 'NIGHT';
    const totalMinutes = Math.round(this.timeOfDay * 24 * 60) % (24 * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  /** Position of the celestial body for shadow-camera placement. */
  get keyLightDirection(): THREE.Vector3 {
    return new THREE.Vector3(0, 1, 0);
  }
}
