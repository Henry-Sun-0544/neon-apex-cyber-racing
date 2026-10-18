import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CONFIG } from '../Config';
import type { QualitySettings } from '../QualityManager';
import { DEFAULT_FX, type PostFxRequest } from '../PostProcessingStack';
import { GameStyle, type GameStyleId, type StylePalette } from './GameStyle';

/** Weather states the realistic style cycles through on its own. */
export type WeatherState = 'clear' | 'hazy' | 'cloudy' | 'rain' | 'storm' | 'snow';

interface WeatherProfile {
  turbidity: number;
  cloudCoverage: number;
  cloudDensity: number;
  fogScale: number;
  rain: number;
  snow: number;
  exposure: number;
  /** How much sunlight reaches the ground (0..1). */
  sun: number;
}

const WEATHER: Record<WeatherState, WeatherProfile> = {
  clear: { turbidity: 2.6, cloudCoverage: 0.12, cloudDensity: 0.2, fogScale: 0.55, rain: 0, snow: 0, exposure: 1.05, sun: 1 },
  hazy: { turbidity: 7.5, cloudCoverage: 0.32, cloudDensity: 0.35, fogScale: 1.15, rain: 0, snow: 0, exposure: 0.98, sun: 0.8 },
  cloudy: { turbidity: 5.2, cloudCoverage: 0.6, cloudDensity: 0.55, fogScale: 1.3, rain: 0, snow: 0, exposure: 0.9, sun: 0.5 },
  rain: { turbidity: 4.2, cloudCoverage: 0.78, cloudDensity: 0.7, fogScale: 1.9, rain: 0.75, snow: 0, exposure: 0.78, sun: 0.24 },
  storm: { turbidity: 3.4, cloudCoverage: 0.9, cloudDensity: 0.85, fogScale: 2.6, rain: 1, snow: 0, exposure: 0.68, sun: 0.12 },
  snow: { turbidity: 6.4, cloudCoverage: 0.82, cloudDensity: 0.78, fogScale: 2.2, rain: 0, snow: 0.85, exposure: 0.95, sun: 0.3 },
};

/** Transition table: from each state, which states can come next. */
const WEATHER_NEXT: Record<WeatherState, WeatherState[]> = {
  clear: ['clear', 'hazy', 'cloudy'],
  hazy: ['clear', 'cloudy', 'rain'],
  cloudy: ['clear', 'hazy', 'rain', 'storm'],
  rain: ['cloudy', 'storm', 'rain', 'snow'],
  storm: ['rain', 'cloudy'],
  snow: ['cloudy', 'rain', 'snow'],
};

/**
 * The Round 2 realistic look.
 *
 * Built on the official `Sky` atmospheric-scattering shader (which in three
 * r186 also renders animated volumetric-style clouds), a full day/night cycle,
 * a physically-plausible light rig with soft shadows, an image-based lighting
 * probe regenerated from the sky, a weather state machine that drives rain and
 * fog, and a photo-grade post chain (SSAO, DoF, bloom, god rays, colour grade).
 */
export class RealisticStyle extends GameStyle {
  readonly id: GameStyleId = 'realistic';
  readonly dayCycle = true;
  readonly wet = true;

  readonly palette: StylePalette = {
    fog: 0x9fb3c8,
    fogDensity: 0.0012,
    ambient: 0x8fa6c4,
    ambientIntensity: 0.28,
    hemiSky: 0x9fc4ff,
    hemiGround: 0x6a5f4c,
    hemiIntensity: 0.4,
    sun: 0xfff2dc,
    sunIntensity: 2.4,
    rim: 0x9dc4ff,
    rimIntensity: 0.3,
    roadTint: 0x6d6f73,
    railTint: 0xb9bcc2,
    buildingTint: 0xcfcbc2,
    terrainTint: 0x8d8a72,
    accentA: 0xff8a3d,
    accentB: 0x39a7ff,
    flameA: 0xffb066,
    flameB: 0xff6a2b,
    dust: 0xe6d6b8,
    minimapTrack: 'rgba(232,238,246,0.30)',
    minimapAccent: 'rgba(255,138,61,0.95)',
    minimapBackdrop: 'rgba(12,16,22,0.62)',
    uiAccent: '#3fa9ff',
    uiAccent2: '#ff8a3d',
    uiBg: 'rgba(10,13,18,0.86)',
    uiPanel: 'rgba(24,28,36,0.78)',
    uiText: '#eef2f7',
  };

  /** Sky dome (atmospheric scattering + clouds). */
  // (the constructor seeds timeOfDay from CONFIG.style.startTimeOfDay)
  private sky!: Sky;
  private sunLight!: THREE.DirectionalLight;
  private moonLight!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private ambient!: THREE.AmbientLight;
  private fill!: THREE.DirectionalLight;
  private sunDirectionVec = new THREE.Vector3(0, 1, 0);
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private readonly probeScene = new THREE.Scene();
  private envTimer = 0;
  private shadowFocus = new THREE.Vector3();
  private cloudTime = 0;

  /** Current weather + its smoothed values. */
  weather: WeatherState = 'clear';
  private weatherTimer = 12;
  private smoothed: WeatherProfile = { ...WEATHER.clear };
  /** Wetness of the road surface (0 dry .. 1 soaked); drives SSR-lite. */
  wetness = 0;

  override attach(env: Parameters<GameStyle['attach']>[0]): void {
    this.timeOfDay = CONFIG.style.startTimeOfDay;
    // PMREM needs the live renderer, which only exists once the game boots.
    if (!this.pmrem) {
      try {
        this.pmrem = new THREE.PMREMGenerator(env.renderer);
        this.pmrem.compileEquirectangularShader();
      } catch (error) {
        console.warn('[NA:CR] PMREMGenerator 不可用，跳过环境光探针', error);
        this.pmrem = null;
      }
    }
    super.attach(env);
  }

  protected build(): void {
    this.buildSky();
    this.buildLighting();
    this.setWeather('clear', true);
  }

  // ------------------------------------------------------------------ sky

  private buildSky(): void {
    const sky = new Sky();
    sky.scale.setScalar(450000);
    sky.name = 'sky';
    this.sky = sky;
    this.patchSkyIntensity(sky);
    this.root.add(sky);
    // The probe scene shares the very same mesh: PMREM samples it in isolation
    // so the environment map only contains sky + clouds.
  }

  /**
   * Adds an `intensity` uniform to the official Sky shader.
   *
   * The shader emits physically bright HDR values (tens of nits). That is
   * correct for a visible sky, but the *image based lighting* derived from it
   * would swamp every material — the classic "PMREM of a real sky" overexposure.
   * The extra uniform lets the probe be generated from a dimmed copy of the very
   * same sky, so IBL stays physically consistent in colour while sitting in a
   * sane exposure range. If three ever changes the shader, the patch is skipped
   * and the material keeps its original behaviour.
   */
  private patchSkyIntensity(sky: Sky): void {
    const material = sky.material as THREE.ShaderMaterial;
    const marker = 'gl_FragColor = vec4( texColor, 1.0 );';
    if (!material.fragmentShader.includes(marker)) {
      this.skyIntensitySupported = false;
      return;
    }
    material.fragmentShader =
      'uniform float skyIntensity;\n' + material.fragmentShader.replace(marker, 'gl_FragColor = vec4( texColor * skyIntensity, 1.0 );');
    material.uniforms.skyIntensity = { value: 1 };
    material.needsUpdate = true;
    this.skyIntensitySupported = true;
  }

  private skyIntensitySupported = false;

  /** IBL strength relative to the visible sky (see patchSkyIntensity). */
  private static readonly PROBE_INTENSITY = 0.14;

  private setSkyIntensity(value: number): void {
    if (!this.skyIntensitySupported) return;
    const uniforms = (this.sky.material as THREE.ShaderMaterial).uniforms;
    if (uniforms.skyIntensity) uniforms.skyIntensity.value = value;
  }

  // -------------------------------------------------------------- lighting

  private buildLighting(): void {
    this.sunLight = new THREE.DirectionalLight(this.palette.sun, this.palette.sunIntensity);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    // The sun sits a fixed distance up-sun of the shadow focus and the shadow
    // camera spans comfortably past the ortho box: with the light only ~400 m
    // away and a far plane of 300 the scene fell *outside* the shadow frustum
    // and the maps came back empty (no shadows at all).
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 620;
    this.sunLight.shadow.bias = -0.0006;
    this.sunLight.shadow.normalBias = 0.55;
    this.sunLight.position.set(220, 320, 140);
    const cam = this.sunLight.shadow.camera;
    cam.left = -CONFIG.style.shadowDistance;
    cam.right = CONFIG.style.shadowDistance;
    cam.top = CONFIG.style.shadowDistance;
    cam.bottom = -CONFIG.style.shadowDistance;
    cam.updateProjectionMatrix();

    this.moonLight = new THREE.DirectionalLight(0x9fb6ff, 0.22);
    this.moonLight.position.set(-160, 260, -120);

    this.hemi = new THREE.HemisphereLight(this.palette.hemiSky, this.palette.hemiGround, this.palette.hemiIntensity);
    this.ambient = new THREE.AmbientLight(this.palette.ambient, this.palette.ambientIntensity);
    this.fill = new THREE.DirectionalLight(this.palette.rim, this.palette.rimIntensity);
    this.fill.position.set(-180, 140, -260);

    this.root.add(this.sunLight, this.sunLight.target, this.moonLight, this.hemi, this.ambient, this.fill);
  }

  override setQuality(quality: QualitySettings): void {
    const { renderer } = this.env;
    const shadows = quality.shadowMapSize > 0;
    renderer.shadowMap.enabled = shadows;
    renderer.shadowMap.type = quality.shadowSoft ? THREE.VSMShadowMap : THREE.PCFShadowMap;
    this.sunLight.castShadow = shadows;
    this.sunLight.shadow.mapSize.set(quality.shadowMapSize || 1024, quality.shadowMapSize || 1024);
    // A material change on the shadow map size requires a fresh render target.
    if (this.sunLight.shadow.map) {
      this.sunLight.shadow.map.dispose();
      this.sunLight.shadow.map = null;
    }
  }

  // -------------------------------------------------------------- weather

  /** Forces a weather state (used at boot and by the debug API). */
  setWeather(state: WeatherState, immediate = false): void {
    this.weather = state;
    const profile = WEATHER[state];
    if (immediate) {
      this.smoothed = { ...profile };
      this.rain = profile.rain;
      this.snow = profile.snow;
      this.wetness = profile.rain * 0.9 + profile.snow * 0.4;
    }
    // Rain only makes sense once the style is attached.
    if (this.env) this.applyWeatherTargets();
  }

  private applyWeatherTargets(): void {
    const profile = WEATHER[this.weather];
    this.rain = profile.rain;
    this.snow = profile.snow;
  }

  private advanceWeather(dt: number): void {
    this.weatherTimer -= dt;
    const target = WEATHER[this.weather];
    // Smooth every profile value so transitions read as weather, not as a cut.
    const rate = 0.35;
    const k = 1 - Math.exp(-rate * dt);
    this.smoothed.turbidity += (target.turbidity - this.smoothed.turbidity) * k;
    this.smoothed.cloudCoverage += (target.cloudCoverage - this.smoothed.cloudCoverage) * k;
    this.smoothed.cloudDensity += (target.cloudDensity - this.smoothed.cloudDensity) * k;
    this.smoothed.fogScale += (target.fogScale - this.smoothed.fogScale) * k;
    this.smoothed.exposure += (target.exposure - this.smoothed.exposure) * k;
    this.smoothed.sun += (target.sun - this.smoothed.sun) * k;
    this.rain += (target.rain - this.rain) * k;
    this.snow += (target.snow - this.snow) * k;
    // The road dries out slowly once the rain stops.
    const wetTarget = Math.max(target.rain * 0.95, target.snow * 0.5);
    const wetRate = wetTarget > this.wetness ? 0.45 : 0.05;
    this.wetness += (wetTarget - this.wetness) * (1 - Math.exp(-wetRate * dt));
    if (this.weatherTimer <= 0) {
      const options = WEATHER_NEXT[this.weather];
      this.weather = options[Math.floor(Math.random() * options.length)]!;
      this.weatherTimer = 55 + Math.random() * 90;
      this.applyWeatherTargets();
      console.info(`[NA:CR] 天气切换: ${this.weather}`);
    }
  }

  // ----------------------------------------------------------- atmosphere

  override configureAtmosphere(): void {
    const { scene, renderer } = this.env;
    scene.fog = new THREE.FogExp2(this.palette.fog, this.palette.fogDensity);
    scene.background = new THREE.Color(0x9fb3c8);
    renderer.toneMappingExposure = 1;
  }

  // ----------------------------------------------------------- sky update

  /** Sun elevation/azimuth for the current time of day. */
  private computeSunPosition(out: THREE.Vector3): number {
    const tod = this.timeOfDay;
    const theta = (tod - 0.25) * Math.PI * 2;
    const elevation = Math.sin(theta) * 78;
    const azimuth = 168 + (tod - 0.25) * 210;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const thetaA = THREE.MathUtils.degToRad(azimuth);
    out.setFromSphericalCoords(1, phi, thetaA);
    return elevation;
  }

  override update(dt: number, elapsed: number, camera: THREE.PerspectiveCamera): void {
    // ------------------------------------------------------- day / night
    const dayLength = Math.max(30, CONFIG.style.dayCycleSeconds);
    this.timeOfDay = (this.timeOfDay + dt / dayLength) % 1;

    this.advanceWeather(dt);

    const elevationDeg = this.computeSunPosition(this.sunDirectionVec);
    this.cloudTime += dt;
    const uniforms = (this.sky.material as THREE.ShaderMaterial).uniforms;
    uniforms.turbidity!.value = this.smoothed.turbidity;
    uniforms.rayleigh!.value = 1.4;
    uniforms.mieCoefficient!.value = 0.0046;
    uniforms.mieDirectionalG!.value = 0.82;
    uniforms.cloudCoverage!.value = this.smoothed.cloudCoverage;
    uniforms.cloudDensity!.value = this.smoothed.cloudDensity;
    uniforms.cloudScale!.value = 0.00016;
    uniforms.cloudSpeed!.value = 0.000012;
    uniforms.cloudElevation!.value = 0.42;
    uniforms.showSunDisc!.value = this.sunDirectionVec.y > -0.06 ? 1 : 0;
    uniforms.time!.value = this.cloudTime;
    (uniforms.sunPosition!.value as THREE.Vector3).copy(this.sunDirectionVec);

    const dayFactor = THREE.MathUtils.clamp((elevationDeg + 4) / 14, 0, 1); // 0 night .. 1 day
    const weatherSun = this.smoothed.sun;

    // Key light: the sun by day, the moon by night, cross-faded at twilight.
    const sunDir = this.sunDirectionVec.clone().normalize();
    this.sunLight.position.copy(sunDir).multiplyScalar(220).add(this.shadowFocus);
    this.sunLight.target.position.copy(this.shadowFocus);
    this.sunLight.intensity = this.palette.sunIntensity * dayFactor * weatherSun;
    this.sunLight.color.setHSL(0.09, 0.55 - dayFactor * 0.4, 0.5 + dayFactor * 0.34);

    this.moonLight.position.copy(sunDir).multiplyScalar(-300).add(this.shadowFocus);
    this.moonLight.intensity = 0.28 * (1 - dayFactor);

    // Without the PMREM probe (low preset / auto-degraded ladder) the sky's
    // ambient contribution disappears entirely and PBR surfaces render near
    // black — lift the analytic lights to carry it instead.
    const iblBoost = this.env.quality.envMapSize > 0 ? 1 : 2.6;
    this.hemi.intensity = this.palette.hemiIntensity * (0.28 + dayFactor * 0.8) * (0.55 + weatherSun * 0.45) * iblBoost;
    this.ambient.intensity = this.palette.ambientIntensity * (0.5 + dayFactor * 0.9) * (0.6 + weatherSun * 0.4) * iblBoost;
    this.fill.intensity = this.palette.rimIntensity * (0.35 + dayFactor * 0.9);

    // ------------------------------------------------------------ fog
    const fog = this.env.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      const density = this.palette.fogDensity * this.smoothed.fogScale * (1 - dayFactor * 0.22);
      fog.density = density;
      const horizon = this.horizonColor(dayFactor, new THREE.Color());
      fog.color.copy(horizon);
      const background = this.env.scene.background;
      if (background instanceof THREE.Color) background.copy(horizon);
      else this.env.scene.background = horizon;
    }

    // ---------------------------------------------- environment lighting
    if (dayFactor > 0.02) {
      this.envTimer -= dt;
      // The sky drifts over a ~520 s day, so a slow fixed cadence is enough.
      // (Tying this to `reflectionInterval` — the *SSR frame* interval, 0 on
      // most presets — used to regenerate the probe every single second.)
      const interval = 6;
      if (this.envTimer <= 0) {
        this.envTimer = interval;
        this.refreshEnvironment();
      }
    }

    void elapsed;
    void camera;
  }

  /** Sky/fog colour for the current sun elevation. */
  private horizonColor(dayFactor: number, out: THREE.Color): THREE.Color {
    const night = new THREE.Color(0x0b1320);
    const golden = new THREE.Color(0xd9a06a);
    const day = new THREE.Color(0xa8c4dd);
    const stormy = new THREE.Color(0x6d7784);
    out.copy(night).lerp(golden, THREE.MathUtils.clamp(dayFactor * 2.2, 0, 1));
    if (dayFactor > 0.45) out.lerp(day, (dayFactor - 0.45) / 0.55);
    // Heavy weather desaturates the sky towards grey.
    out.lerp(stormy, THREE.MathUtils.clamp(this.smoothed.cloudCoverage - 0.45, 0, 1) * 0.55);
    return out;
  }

  /** Regenerates the PMREM probe from the sky alone (IBL for every PBR material). */
  private refreshEnvironment(): void {
    if (!this.pmrem || this.env.quality.envMapSize <= 0) return;
    try {
      const sky = this.sky;
      this.root.remove(sky);
      this.probeScene.add(sky);
      // Dim the sky for the probe only, then restore it for the visible dome.
      this.setSkyIntensity(RealisticStyle.PROBE_INTENSITY);
      const target = this.pmrem.fromScene(this.probeScene, 0, 0.1, 1000);
      this.setSkyIntensity(1);
      this.probeScene.remove(sky);
      this.root.add(sky);
      this.envTarget?.dispose();
      this.envTarget = target;
      this.env.scene.environment = target.texture;
    } catch (error) {
      console.warn('[NA:CR] 环境光探针生成失败，使用纯光照', error);
      if (this.sky.parent !== this.root) this.root.add(this.sky);
    }
  }

  /** Keeps the shadow camera centred on the player (called by SceneManager). */
  override updateShadowFocus(point: THREE.Vector3): void {
    this.shadowFocus.copy(point);
  }

  override fxRequest(quality: QualitySettings): PostFxRequest {
    const gradeTint = new THREE.Vector3(1.02, 1.0, 0.97);
    return {
      ...DEFAULT_FX,
      bloom: quality.bloom,
      bloomStrength: 0.07,
      bloomRadius: 0.55,
      bloomThreshold: 2.0,
      ssao: quality.ssao,
      ssaoRadius: 5.5,
      ssr: quality.ssr,
      ssrIntensity: 0.6,
      ssrWetness: this.wetness,
      godRays: quality.godRays,
      godRaysIntensity: 0.22,
      dof: quality.depthOfField,
      dofFocus: CONFIG.camera.chaseDistance + 14,
      dofAperture: 0.00016,
      dofMaxBlur: 0.006,
      motionBlur: quality.motionBlur ? 0.55 : 0,
      colorGrade: quality.colorGrade,
      exposure: this.smoothed.exposure,
      contrast: 1.14,
      saturation: 1.1,
      temperature: 0.14,
      tint: gradeTint,
      vignette: 0.32,
      grain: quality.filmGrain ? 0.018 : 0,
      chromatic: quality.chromaticAberration ? 0.0009 : 0,
      smaa: quality.smaa,
    };
  }

  /** Sun direction from the camera, or null when it is too low to scatter. */
  override sunDirection(): THREE.Vector3 | null {
    const dir = this.sunDirectionVec.clone().normalize();
    if (dir.y < 0.02) return null;
    return dir;
  }

  /**
   * Exposure adaptation. The brief asks for "adaptive exposure": a real
   * histogram read-back would stall the pipeline, so exposure is driven by the
   * two things that actually move the average luminance here — the sun
   * elevation and the cloud cover — with the same slow response curve a real
   * meter would have.
   */
  override exposureAdaptation(_camera: THREE.PerspectiveCamera): number {
    const elevation = this.sunDirectionVec.y;
    const base = this.smoothed.exposure;
    if (elevation < -0.08) {
      // Night: lift the shadows so the city lights read without a black screen.
      return base * 1.9;
    }
    const glare = THREE.MathUtils.clamp(elevation, 0, 1);
    return base * (1.02 - glare * 0.2);
  }

  override get keyLightDirection(): THREE.Vector3 {
    return this.sunLight.position.clone().sub(this.shadowFocus).normalize();
  }

  /** Human readable weather for the HUD. */
  get weatherLabel(): string {
    const labels: Record<WeatherState, string> = {
      clear: '晴 CLEAR',
      hazy: '薄雾 HAZY',
      cloudy: '多云 CLOUDY',
      rain: '降雨 RAIN',
      storm: '暴雨 STORM',
      snow: '降雪 SNOW',
    };
    return labels[this.weather];
  }

  /** Dissolves the PMREM resources (style switch). */
  override detach(scene: THREE.Scene): void {
    this.envTarget?.dispose();
    this.envTarget = null;
    if (scene.environment) scene.environment = null;
    super.detach(scene);
  }
}
