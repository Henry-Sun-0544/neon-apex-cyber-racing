import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import type { QualitySettings } from './QualityManager';

/**
 * The post-processing chain.
 *
 * Two styles need very different looks, so every pass is requested through a
 * `PostFxRequest` and gated by the quality budget. Passes are created once and
 * toggled, never rebuilt per frame; a style switch simply rewrites the request.
 *
 *   RenderPass → SSR-lite → SSAO → Bokeh(DoF) → Bloom → GodRays
 *              → OutputPass(ACES) → ColorGrade → SMAA
 *
 * The two custom passes are real screen-space effects:
 *  - `ScreenSpaceReflectionPass` marches the colour buffer to fake wet-road
 *    reflections (the official SSRPass needs a G-buffer/selects contract that
 *    is far too heavy here, and this pass degrades to a no-op in one uniform).
 *  - `GodRaysShader` radially scatters bright pixels towards the sun.
 */

// --------------------------------------------------------------- SSR-lite

const SSRShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uIntensity: { value: 0 },
    uSteps: { value: 8 },
    uThreshold: { value: 1.6 },
    uStepSize: { value: 0.012 },
    uWetness: { value: 0.6 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uIntensity;
    uniform float uSteps;
    uniform float uThreshold;
    uniform float uStepSize;
    uniform float uWetness;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float lum = dot(base.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 acc = vec3(0.0);
      float hits = 0.0;
      float strength = uIntensity * smoothstep(0.05, 0.8, uWetness);
      if (strength > 0.001 && lum < 0.60) {
        // March "up" the screen: wet asphalt mirrors whatever is above it.
        vec2 dir = vec2(0.35, 1.0) * uStepSize;
        vec2 uv = vUv;
        for (int i = 0; i < 24; i++) {
          if (float(i) >= uSteps) break;
          uv += dir;
          if (uv.y > 1.0 || uv.x < 0.0 || uv.x > 1.0) break;
          vec3 s = texture2D(tDiffuse, uv).rgb;
          float sl = dot(s, vec3(0.2126, 0.7152, 0.0722));
          if (sl > uThreshold) {
            acc += s;
            hits += 1.0;
          }
        }
      }
      vec3 refl = hits > 0.0 ? acc / hits : vec3(0.0);
      // Fresnel-ish: grazing angles (bottom of the road) reflect more.
      float fres = pow(1.0 - abs(vUv.y - 0.5) * 2.0, 1.5) * 0.5 + 0.5;
      float mixAmount = step(0.5, hits) * strength * 0.42 * fres;
      gl_FragColor = vec4(mix(base.rgb, base.rgb * 0.35 + refl, mixAmount), base.a);
    }
  `,
};

// --------------------------------------------------------------- god rays

const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2(0.5, 0.8) },
    uIntensity: { value: 0 },
    uColor: { value: new THREE.Color(0xffd9a0) },
    uDecay: { value: 0.55 },
    uThreshold: { value: 2.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSun;
    uniform float uIntensity;
    uniform vec3 uColor;
    uniform float uDecay;
    uniform float uThreshold;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uIntensity <= 0.001) {
        gl_FragColor = base;
        return;
      }
      vec2 dir = (uSun - vUv) * uDecay;
      vec3 acc = vec3(0.0);
      vec2 uv = vUv;
      float weight = 1.0;
      float totalWeight = 0.0;
      for (int i = 0; i < 20; i++) {
        uv += dir * 0.05;
        vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
        // Only genuinely bright pixels scatter (sky, sun disc, specular hits).
        float l = max(0.0, dot(s, vec3(0.2126, 0.7152, 0.0722)) - uThreshold);
        acc += s * l * weight;
        totalWeight += weight;
        weight *= 0.94;
      }
      // Normalise by the accumulated weight: without this the pass behaves like
      // an additive wash whose strength scales with the sample count.
      vec3 shafts = acc / max(totalWeight, 0.001);
      gl_FragColor = vec4(base.rgb + shafts * uIntensity * uColor, base.a);
    }
  `,
};

// ------------------------------------------------------------ colour grade

const ColorGradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uExposure: { value: 1 },
    uContrast: { value: 1.05 },
    uSaturation: { value: 1.06 },
    uTemperature: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uVignette: { value: 0.25 },
    uGrain: { value: 0.03 },
    uChromatic: { value: 0.0012 },
    uTime: { value: 0 },
    uBlur: { value: 0 },
    uBlurDir: { value: new THREE.Vector2(0, 0) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uTemperature;
    uniform vec3 uTint;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uChromatic;
    uniform float uTime;
    uniform float uBlur;
    uniform vec2 uBlurDir;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      // Chromatic aberration grows towards the edges of the frame.
      vec2 centre = uv - 0.5;
      float r2 = dot(centre, centre);
      vec2 ca = centre * uChromatic * r2 * 4.0;

      vec3 col;
      col.r = texture2D(tDiffuse, uv + ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - ca).b;

      // Velocity blur (sampled along the screen-space camera delta).
      if (uBlur > 0.0005) {
        vec3 blur = col;
        for (int i = 1; i <= 4; i++) {
          float t = float(i) / 4.0;
          blur += texture2D(tDiffuse, uv - uBlurDir * uBlur * t).rgb;
        }
        col = blur / 5.0;
      }

      col *= uExposure;
      col *= uTint;
      // Warm/cool shift: +temperature pushes towards orange, - towards blue.
      col.r *= 1.0 + uTemperature * 0.16;
      col.b *= 1.0 - uTemperature * 0.16;

      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;

      // Vignette.
      col *= 1.0 - uVignette * smoothstep(0.18, 0.85, r2 * 2.0);

      // Film grain.
      float g = hash(uv * vec2(1920.0, 1080.0) + uTime) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    }
  `,
};

/** Every effect the styles can ask for, already resolved against quality. */
export interface PostFxRequest {
  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  ssao: boolean;
  ssaoRadius: number;
  ssr: boolean;
  ssrIntensity: number;
  ssrWetness: number;
  godRays: boolean;
  godRaysIntensity: number;
  dof: boolean;
  dofFocus: number;
  dofAperture: number;
  dofMaxBlur: number;
  motionBlur: number;
  colorGrade: boolean;
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: THREE.Vector3;
  vignette: number;
  grain: number;
  chromatic: number;
  smaa: boolean;
}

export const DEFAULT_FX: PostFxRequest = {
  bloom: true,
  bloomStrength: 0.5,
  bloomRadius: 0.45,
  bloomThreshold: 0.82,
  ssao: false,
  ssaoRadius: 6,
  ssr: false,
  ssrIntensity: 0.6,
  ssrWetness: 0.5,
  godRays: false,
  godRaysIntensity: 0.5,
  dof: false,
  dofFocus: 40,
  dofAperture: 0.0003,
  dofMaxBlur: 0.008,
  motionBlur: 0,
  colorGrade: true,
  exposure: 1,
  contrast: 1.05,
  saturation: 1.05,
  temperature: 0,
  tint: new THREE.Vector3(1, 1, 1),
  vignette: 0.22,
  grain: 0.02,
  chromatic: 0.0008,
  smaa: true,
};

/** Runtime context pushed into the passes every frame. */
export interface PostFxFrame {
  /** Seconds since boot (grain animation). */
  time: number;
  /** Screen-space sun position in UV space, or null when the sun is behind. */
  sunUv: THREE.Vector2 | null;
  /** Camera movement in screen space (motion blur direction), -1..1. */
  blurDir: THREE.Vector2;
  /** 0..1 blur amount. */
  blur: number;
  /** Adaptive exposure multiplier. */
  exposure: number;
}

export class PostProcessingStack {
  private renderPass: RenderPass | null = null;
  private ssrPass: ShaderPass | null = null;
  private ssaoPass: SSAOPass | null = null;
  private bokehPass: BokehPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private godRayPass: ShaderPass | null = null;
  private outputPass: OutputPass | null = null;
  private gradePass: ShaderPass | null = null;
  private smaaPass: SMAAPass | null = null;
  private composerRef: EffectComposer | null = null;
  /** True when the heavyweight chain exists at all. */
  active = false;
  private fx: PostFxRequest = { ...DEFAULT_FX, tint: new THREE.Vector3(1, 1, 1) };
  private quality: QualitySettings;
  private width = 1;
  private height = 1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    quality: QualitySettings,
  ) {
    this.quality = quality;
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.applyCheapPath();
  }

  /** Applies a fresh quality budget: rebuilds the chain if the shape changed. */
  setQuality(quality: QualitySettings): void {
    const before = this.quality;
    this.quality = quality;
    if (!this.active) return;
    const shapeChanged =
      before.ssao !== quality.ssao || before.depthOfField !== quality.depthOfField || before.smaa !== quality.smaa;
    if (shapeChanged) this.build();
    else this.applyFxToPasses();
  }

  /** Rewrites the requested effect set without touching the composer layout. */
  setFx(fx: Partial<PostFxRequest>): void {
    Object.assign(this.fx, fx);
    if (!this.shouldUseComposer()) {
      this.dispose();
      this.applyCheapPath();
      return;
    }
    if (!this.active) this.build();
    else this.applyFxToPasses();
  }

  private shouldUseComposer(): boolean {
    const q = this.quality;
    return q.bloom || q.ssao || q.depthOfField || q.godRays;
  }

  /** True when a composer chain is currently installed. */
  get usingComposer(): boolean {
    return this.active && this.composerRef !== null;
  }

  private applyCheapPath(): void {
    this.renderer.toneMappingExposure = this.fx.exposure;
  }

  /** (Re)builds the composer chain for the current quality budget. */
  private build(): void {
    this.dispose();
    try {
      const composer = new EffectComposer(this.renderer);
      composer.setSize(this.width, this.height);

      const renderPass = new RenderPass(this.scene, this.camera);
      composer.addPass(renderPass);
      this.renderPass = renderPass;

      const ssrShader = new ShaderPass(SSRShader);
      ssrShader.enabled = false;
      composer.addPass(ssrShader);
      this.ssrPass = ssrShader;

      if (this.quality.ssao) {
        try {
          const ssao = new SSAOPass(this.scene, this.camera, this.width, this.height);
          ssao.kernelRadius = this.fx.ssaoRadius;
          ssao.minDistance = 0.004;
          ssao.output = SSAOPass.OUTPUT.Default;
          composer.addPass(ssao);
          this.ssaoPass = ssao;
        } catch (error) {
          console.warn('[NA:CR] SSAO 不可用，已跳过', error);
        }
      }

      if (this.quality.depthOfField) {
        try {
          const bokeh = new BokehPass(this.scene, this.camera, {
            focus: this.fx.dofFocus,
            aperture: this.fx.dofAperture,
            maxblur: this.fx.dofMaxBlur,
          });
          composer.addPass(bokeh);
          this.bokehPass = bokeh;
        } catch (error) {
          console.warn('[NA:CR] 景深不可用，已跳过', error);
        }
      }

      if (this.quality.bloom) {
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(this.width, this.height),
          this.fx.bloomStrength,
          this.fx.bloomRadius,
          this.fx.bloomThreshold,
        );
        composer.addPass(bloom);
        this.bloomPass = bloom;
      }

      const god = new ShaderPass(GodRaysShader);
      god.enabled = false;
      composer.addPass(god);
      this.godRayPass = god;

      const output = new OutputPass();
      composer.addPass(output);
      this.outputPass = output;

      const grade = new ShaderPass(ColorGradeShader);
      composer.addPass(grade);
      this.gradePass = grade;

      if (this.quality.smaa) {
        const smaa = new SMAAPass();
        composer.addPass(smaa);
        this.smaaPass = smaa;
      }

      this.composerRef = composer;
      this.active = true;
      this.applyFxToPasses();
    } catch (error) {
      console.warn('[NA:CR] 后处理链创建失败，回退到直接渲染', error);
      this.composerRef = null;
      this.active = false;
    }
  }

  /** Stored separately so `composerHandle` stays read-only for consumers. */
  get composerHandle(): EffectComposer | null {
    return this.composerRef;
  }

  /** Rebuilds after a settings change. */
  rebuild(): void {
    if (this.shouldUseComposer()) this.build();
    else {
      this.dispose();
      this.applyCheapPath();
    }
  }

  private applyFxToPasses(): void {
    const q = this.quality;
    const fx = this.fx;
    if (this.bloomPass) {
      this.bloomPass.enabled = fx.bloom && q.bloom;
      this.bloomPass.strength = fx.bloomStrength;
      this.bloomPass.radius = fx.bloomRadius;
    }
    if (this.ssaoPass) this.ssaoPass.enabled = fx.ssao && q.ssao;
    if (this.ssrPass) {
      this.ssrPass.enabled = fx.ssr && q.ssr;
      const u = this.ssrPass.uniforms;
      u.uIntensity!.value = fx.ssrIntensity;
      u.uWetness!.value = fx.ssrWetness;
      u.uSteps!.value = q.id === 'ultra' ? 14 : 8;
    }
    if (this.godRayPass) {
      this.godRayPass.enabled = fx.godRays && q.godRays;
      this.godRayPass.uniforms.uIntensity!.value = fx.godRaysIntensity;
    }
    if (this.bokehPass) {
      this.bokehPass.enabled = fx.dof && q.depthOfField;
      const uniforms = (this.bokehPass as unknown as { materialBokeh?: { uniforms: Record<string, { value: number }> } })
        .materialBokeh?.uniforms;
      if (uniforms) {
        if (uniforms.focus) uniforms.focus.value = fx.dofFocus;
        if (uniforms.aperture) uniforms.aperture.value = fx.dofAperture;
        if (uniforms.maxblur) uniforms.maxblur.value = fx.dofMaxBlur;
      }
    }
    if (this.gradePass) this.gradePass.enabled = fx.colorGrade;
    this.renderer.toneMappingExposure = 1;
  }

  /** Pushes the per-frame uniforms (sun position, camera velocity, time). */
  update(dt: number, frame: PostFxFrame): void {
    /*
     * Exposure MUST be applied before the tone curve. `OutputPass` reads
     * `renderer.toneMappingExposure` when it applies ACES, so the adaptive
     * exposure goes there and the colour-grade pass (which runs *after* tone
     * mapping, in display space) stays exposure-neutral. Multiplying a
     * tone-mapped image by 0.5 would just crush it flat.
     */
    this.renderer.toneMappingExposure = frame.exposure;
    /*
     * Bloom / god rays / SSR run *before* `OutputPass`, so they see the raw HDR
     * buffer rather than the exposed image. Their thresholds are therefore
     * authored in photographic units and divided by the exposure here — without
     * this, a whole-frame bloom firestorm appears as soon as the adaptive
     * exposure drops below 1.
     */
    const inverseExposure = 1 / Math.max(0.05, frame.exposure);
    if (this.bloomPass) this.bloomPass.threshold = this.fx.bloomThreshold * inverseExposure;
    if (this.godRayPass) this.godRayPass.uniforms.uThreshold!.value = 0.98 * inverseExposure;
    if (this.ssrPass) this.ssrPass.uniforms.uThreshold!.value = 1.4 * inverseExposure;
    if (this.gradePass) {
      const u = this.gradePass.uniforms;
      u.uTime!.value += dt;
      u.uExposure!.value = 1;
      u.uContrast!.value = this.fx.contrast;
      u.uSaturation!.value = this.fx.saturation;
      u.uTemperature!.value = this.fx.temperature;
      (u.uTint!.value as THREE.Vector3).copy(this.fx.tint);
      u.uVignette!.value = this.fx.vignette;
      u.uGrain!.value = this.fx.grain;
      u.uChromatic!.value = this.fx.chromatic;
      u.uBlur!.value = frame.blur;
      (u.uBlurDir!.value as THREE.Vector2).copy(frame.blurDir);
    }
    if (this.godRayPass) {
      const enabled = this.godRayPass.enabled && frame.sunUv !== null;
      this.godRayPass.enabled = enabled;
      if (frame.sunUv) (this.godRayPass.uniforms.uSun!.value as THREE.Vector2).copy(frame.sunUv);
    }
  }

  render(): void {
    if (this.composerRef && this.active) this.composerRef.render();
    else this.renderer.render(this.scene, this.camera);
  }

  setSize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.composerRef?.setSize(w, h);
    this.ssaoPass?.setSize(w, h);
    this.bloomPass?.setSize(w, h);
    this.smaaPass?.setSize(w, h);
  }

  dispose(): void {
    if (this.composerRef) {
      for (const pass of this.composerRef.passes) {
        const disposable = pass as unknown as { dispose?: () => void };
        disposable.dispose?.();
      }
      this.composerRef.passes.length = 0;
      this.composerRef.dispose();
    }
    this.composerRef = null;
    this.renderPass = null;
    this.ssrPass = null;
    this.ssaoPass = null;
    this.bokehPass = null;
    this.bloomPass = null;
    this.godRayPass = null;
    this.outputPass = null;
    this.gradePass = null;
    this.smaaPass = null;
    this.active = false;
  }

  /** Debug helper: which passes are live right now. */
  describe(): string {
    const on: string[] = [];
    if (this.ssrPass?.enabled) on.push('SSR');
    if (this.ssaoPass?.enabled) on.push('SSAO');
    if (this.bokehPass?.enabled) on.push('DoF');
    if (this.bloomPass?.enabled) on.push('Bloom');
    if (this.godRayPass?.enabled) on.push('GodRays');
    if (this.gradePass?.enabled) on.push('Grade');
    if (this.smaaPass) on.push('SMAA');
    return on.length ? on.join('+') : 'off';
  }
}
