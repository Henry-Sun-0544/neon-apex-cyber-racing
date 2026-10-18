import * as THREE from 'three';
import { CONFIG } from '../Config';
import { DEFAULT_FX, type PostFxRequest } from '../PostProcessingStack';
import type { QualitySettings } from '../QualityManager';
import { GameStyle, type GameStyleId, type StylePalette } from './GameStyle';

/**
 * The Round 1 look, kept intact.
 *
 * A procedural synthwave sky dome (three neon bands, 700 stars and a magenta
 * moon), purple ambient fill, a magenta rim light and a heavy bloom pass. It is
 * the default style and remains fully playable after Round 2.
 */
export class CyberpunkStyle extends GameStyle {
  readonly id: GameStyleId = 'cyberpunk';
  readonly dayCycle = false;
  readonly wet = true;

  readonly palette: StylePalette = {
    fog: CONFIG.render.fogColor,
    fogDensity: CONFIG.render.fogDensity,
    ambient: 0x1a1f3d,
    ambientIntensity: 0.55,
    hemiSky: 0x3a2c73,
    hemiGround: 0x08050f,
    hemiIntensity: 0.4,
    sun: 0x8f6bff,
    sunIntensity: 0.6,
    rim: 0xff3fa0,
    rimIntensity: 0.28,
    roadTint: 0x8a8aa6,
    railTint: 0x24f0ff,
    buildingTint: 0x2a2740,
    terrainTint: 0x141227,
    accentA: CONFIG.colors.cyan,
    accentB: CONFIG.colors.magenta,
    flameA: 0x7ce8ff,
    flameB: 0xff5ad0,
    dust: 0x8fb6ff,
    minimapTrack: 'rgba(36,240,255,0.22)',
    minimapAccent: 'rgba(255,47,185,0.9)',
    minimapBackdrop: 'rgba(6,3,18,0.6)',
    uiAccent: '#24f0ff',
    uiAccent2: '#ff2fb9',
    uiBg: 'rgba(6,3,18,0.82)',
    uiPanel: 'rgba(14,8,32,0.72)',
    uiText: '#e8f6ff',
  };

  private skyMesh: THREE.Mesh | null = null;
  private ambient!: THREE.AmbientLight;
  private hemi!: THREE.HemisphereLight;
  private key!: THREE.DirectionalLight;
  private rim!: THREE.DirectionalLight;
  private drift = 0;

  protected build(): void {
    this.buildSky();
    this.buildLights();
  }

  /** Procedural night sky dome with a synthwave gradient, stars and a moon. */
  private buildSky(): void {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 512;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#07040f');
    grad.addColorStop(0.35, '#160a33');
    grad.addColorStop(0.62, '#3a1055');
    grad.addColorStop(0.78, '#7a1b64');
    grad.addColorStop(0.9, '#c02a72');
    grad.addColorStop(1, '#1a0730');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 512);

    // Neon haze bands (distant city glow).
    for (let i = 0; i < 40; i++) {
      const y = 260 + Math.random() * 210;
      ctx.fillStyle = `rgba(${120 + Math.random() * 135},${30 + Math.random() * 80},255,${0.03 + Math.random() * 0.05})`;
      ctx.fillRect(0, y, 1024, 1 + Math.random() * 3);
    }
    // Stars.
    for (let i = 0; i < 700; i++) {
      const x = Math.random() * 1024;
      const y = Math.random() * 300;
      const a = Math.random() * 0.8 + 0.1;
      const r = Math.random() * 1.4;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Moon.
    const moonX = 760;
    const moonY = 120;
    const moonGrad = ctx.createRadialGradient(moonX, moonY, 4, moonX, moonY, 90);
    moonGrad.addColorStop(0, 'rgba(255,236,255,0.95)');
    moonGrad.addColorStop(0.2, 'rgba(255,180,240,0.5)');
    moonGrad.addColorStop(1, 'rgba(255,120,220,0)');
    ctx.fillStyle = moonGrad;
    ctx.beginPath();
    ctx.arc(moonX, moonY, 90, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,245,255,0.98)';
    ctx.beginPath();
    ctx.arc(moonX, moonY, 26, 0, Math.PI * 2);
    ctx.fill();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    this.disposables.push(tex);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1900, 32, 20),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, toneMapped: false }),
    );
    sky.name = 'neon-sign';
    this.skyMesh = sky;
    this.root.add(sky);
  }

  private buildLights(): void {
    this.ambient = new THREE.AmbientLight(this.palette.ambient, this.palette.ambientIntensity);
    this.hemi = new THREE.HemisphereLight(this.palette.hemiSky, this.palette.hemiGround, this.palette.hemiIntensity);
    this.key = new THREE.DirectionalLight(this.palette.sun, this.palette.sunIntensity);
    this.key.position.set(-220, 320, 140);
    this.rim = new THREE.DirectionalLight(this.palette.rim, this.palette.rimIntensity);
    this.rim.position.set(180, 120, -260);
    this.root.add(this.ambient, this.hemi, this.key, this.rim);
  }

  override configureAtmosphere(): void {
    const { scene, renderer } = this.env;
    scene.fog = new THREE.FogExp2(this.palette.fog, this.palette.fogDensity);
    scene.background = new THREE.Color(0x05030f);
    scene.environment = null;
    renderer.shadowMap.enabled = false;
    renderer.toneMappingExposure = 0.95;
  }

  override setQuality(quality: QualitySettings): void {
    // The cyberpunk look is a night scene: shadows cost a lot and add little,
    // so they stay off regardless of the preset (documented behaviour).
    this.env.renderer.shadowMap.enabled = false;
    this.key.castShadow = false;
    void quality;
  }

  override fxRequest(quality: QualitySettings): PostFxRequest {
    return {
      ...DEFAULT_FX,
      bloom: quality.bloom,
      bloomStrength: CONFIG.render.bloomStrength,
      bloomRadius: CONFIG.render.bloomRadius,
      bloomThreshold: CONFIG.render.bloomThreshold,
      ssao: false,
      ssr: false,
      godRays: false,
      dof: false,
      motionBlur: quality.motionBlur ? 0.12 : 0,
      colorGrade: quality.colorGrade,
      exposure: 0.95,
      contrast: 1.08,
      saturation: 1.22,
      temperature: -0.12,
      tint: new THREE.Vector3(0.98, 0.97, 1.08),
      vignette: 0.34,
      grain: quality.filmGrain ? 0.035 : 0,
      chromatic: quality.chromaticAberration ? 0.0022 : 0,
      smaa: quality.smaa,
    };
  }

  override update(dt: number, elapsed: number, _camera: THREE.PerspectiveCamera): void {
    this.drift += dt;
    if (this.skyMesh) {
      // A very slow roll keeps the sky from reading as a static image.
      this.skyMesh.rotation.z = Math.sin(this.drift * 0.02) * 0.01;
    }
    const pulse = 0.5 + Math.sin(elapsed * 1.6) * 0.12;
    this.rim.intensity = this.palette.rimIntensity * (0.85 + pulse * 0.3);
  }

  override sunDirection(): THREE.Vector3 | null {
    // Neon city: no sun shafts.
    return null;
  }

  override get flameColors(): [number, number] {
    return [this.palette.flameA, this.palette.flameB];
  }

  override get keyLightDirection(): THREE.Vector3 {
    return this.key.position.clone().normalize();
  }
}
