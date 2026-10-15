import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CONFIG } from './Config';
import { clamp, damp } from './Utils';

export type CameraMode = 'chase' | 'hood';

/** What the camera needs from the car each frame. */
export interface CameraTarget {
  position: THREE.Vector3;
  yaw: number;
  speed: number;
  boosting: boolean;
}

/**
 * Everything related to rendering: renderer, fog, sky, lights, the chase
 * camera rig and the optional bloom pass (auto-disabled when FPS drops).
 */
export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  cameraMode: CameraMode = 'chase';
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private readonly renderPass: RenderPass;
  private readonly outputPass: OutputPass;
  private bloomEnabled: boolean = CONFIG.render.bloom;
  private shake = 0;
  private readonly shakeOffset = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private perfTimer = 0;
  private perfFrames = 0;
  private downgraded = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: window.devicePixelRatio < 1.5,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = false; // night city + bloom reads better and runs faster

    this.scene.fog = new THREE.FogExp2(CONFIG.render.fogColor, CONFIG.render.fogDensity);
    this.scene.background = new THREE.Color(0x05030f);

    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, 0.2, 3000);
    this.camera.position.set(0, 8, -14);
    this.scene.add(this.camera);

    this.buildSky();
    this.buildLights();

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.outputPass = new OutputPass();
    this.setupPostProcessing();
  }

  // ------------------------------------------------------------ setup

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

    // Neon haze bands (like distant city glow)
    for (let i = 0; i < 40; i++) {
      const y = 260 + Math.random() * 210;
      ctx.fillStyle = `rgba(${120 + Math.random() * 135},${30 + Math.random() * 80},255,${0.03 + Math.random() * 0.05})`;
      ctx.fillRect(0, y, 1024, 1 + Math.random() * 3);
    }
    // Stars
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
    // Moon
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
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1900, 32, 20),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, toneMapped: false }),
    );
    sky.name = 'sky';
    this.scene.add(sky);
  }

  private buildLights(): void {
    const ambient = new THREE.AmbientLight(0x1a1f3d, 0.55);
    const hemi = new THREE.HemisphereLight(0x3a2c73, 0x08050f, 0.4);
    const moon = new THREE.DirectionalLight(0x8f6bff, 0.6);
    moon.position.set(-220, 320, 140);
    const rim = new THREE.DirectionalLight(0xff3fa0, 0.28);
    rim.position.set(180, 120, -260);
    this.scene.add(ambient, hemi, moon, rim);
  }

  private setupPostProcessing(): void {
    try {
      const size = new THREE.Vector2(window.innerWidth, window.innerHeight);
      const composer = new EffectComposer(this.renderer);
      composer.setSize(size.x, size.y);
      const bloom = new UnrealBloomPass(
        size,
        CONFIG.render.bloomStrength,
        CONFIG.render.bloomRadius,
        CONFIG.render.bloomThreshold,
      );
      composer.addPass(this.renderPass);
      composer.addPass(bloom);
      composer.addPass(this.outputPass);
      this.composer = composer;
      this.bloomPass = bloom;
      this.bloomEnabled = CONFIG.render.bloom;
    } catch (error) {
      // Bloom is optional: fall back to plain rendering if the driver refuses.
      console.warn('[NA:CR] post-processing unavailable, falling back to direct rendering', error);
      this.composer = null;
      this.bloomPass = null;
      this.bloomEnabled = false;
    }
  }

  /** Disables bloom + lowers the pixel ratio when the machine cannot keep up. */
  private monitorPerformance(dt: number): void {
    if (this.downgraded) return;
    this.perfTimer += dt;
    this.perfFrames += 1;
    if (this.perfTimer < CONFIG.render.perfSampleSeconds) return;
    const fps = this.perfFrames / this.perfTimer;
    this.perfTimer = 0;
    this.perfFrames = 0;
    if (fps < CONFIG.render.downgradeFps) {
      this.downgraded = true;
      this.bloomEnabled = false;
      if (this.bloomPass) this.bloomPass.enabled = false;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
      console.info(`[NA:CR] ${fps.toFixed(1)} FPS detected — bloom disabled, pixel ratio lowered.`);
    }
  }

  // ------------------------------------------------------------ camera

  toggleCameraMode(): CameraMode {
    this.cameraMode = this.cameraMode === 'chase' ? 'hood' : 'chase';
    return this.cameraMode;
  }

  /** Adds camera shake (0..1). */
  addShake(amount: number): void {
    this.shake = clamp(this.shake + amount, 0, 1.4);
  }

  /** Snap the camera behind the car (used on race restart). */
  snapTo(target: CameraTarget): void {
    this.computeDesired(target);
    this.camera.position.copy(this.desired);
    this.lookTarget.copy(target.position);
    this.shake = 0;
  }

  private computeDesired(target: CameraTarget): void {
    const cfg = CONFIG.camera;
    const forward = this.tmp.set(Math.sin(target.yaw), 0, Math.cos(target.yaw));
    if (this.cameraMode === 'chase') {
      this.desired
        .copy(target.position)
        .addScaledVector(forward, -cfg.chaseDistance)
        .add(new THREE.Vector3(0, cfg.chaseHeight, 0));
    } else {
      this.desired
        .copy(target.position)
        .addScaledVector(forward, cfg.hoodDistance)
        .add(new THREE.Vector3(0, cfg.hoodHeight, 0));
    }
    // Never dip below the tarmac.
    this.desired.y = Math.max(this.desired.y, target.position.y + 1.1);
  }

  updateCamera(dt: number, target: CameraTarget, speedRatio: number): void {
    const cfg = CONFIG.camera;
    this.computeDesired(target);
    const lerpRate = this.cameraMode === 'hood' ? cfg.positionLerp * 2.6 : cfg.positionLerp;
    this.camera.position.x = damp(this.camera.position.x, this.desired.x, lerpRate, dt);
    this.camera.position.y = damp(this.camera.position.y, this.desired.y, lerpRate * 0.9, dt);
    this.camera.position.z = damp(this.camera.position.z, this.desired.z, lerpRate, dt);

    // Look slightly ahead of the car for a better sense of speed.
    const forward = this.tmp.set(Math.sin(target.yaw), 0, Math.cos(target.yaw));
    const lookAhead = this.cameraMode === 'hood' ? 16 : 8;
    const desiredLook = new THREE.Vector3()
      .copy(target.position)
      .addScaledVector(forward, lookAhead)
      .add(new THREE.Vector3(0, 1.5, 0));
    this.lookTarget.x = damp(this.lookTarget.x, desiredLook.x, cfg.lookLerp, dt);
    this.lookTarget.y = damp(this.lookTarget.y, desiredLook.y, cfg.lookLerp, dt);
    this.lookTarget.z = damp(this.lookTarget.z, desiredLook.z, cfg.lookLerp, dt);

    // Shake decays over time.
    this.shake = Math.max(0, this.shake - cfg.shakeDecay * dt);
    const s = this.shake * this.shake;
    this.shakeOffset.set(
      (Math.random() - 0.5) * s * 1.6,
      (Math.random() - 0.5) * s * 1.2,
      (Math.random() - 0.5) * s * 1.6,
    );

    this.camera.lookAt(
      this.lookTarget.x + this.shakeOffset.x * 0.5,
      this.lookTarget.y + this.shakeOffset.y * 0.5,
      this.lookTarget.z + this.shakeOffset.z * 0.5,
    );
    this.camera.position.add(this.shakeOffset);

    // Speed / nitro FOV kick.
    const targetFov = cfg.fov + speedRatio * 5 + (target.boosting ? cfg.nitroFov : 0);
    this.camera.fov = damp(this.camera.fov, targetFov, 4, dt);
    this.camera.updateProjectionMatrix();
  }

  /** Menu fly-around camera (slow orbit over the grid). */
  updateMenuCamera(dt: number, centre: THREE.Vector3, elapsed: number): void {
    const radius = 26;
    const a = elapsed * 0.16;
    this.camera.position.set(centre.x + Math.cos(a) * radius, centre.y + 9 + Math.sin(a * 0.6) * 2.5, centre.z + Math.sin(a) * radius);
    this.camera.lookAt(centre.x, centre.y + 1.2, centre.z);
    this.camera.fov = damp(this.camera.fov, 62, 3, dt);
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ render

  render(dt: number): void {
    this.monitorPerformance(dt);
    if (this.composer && this.bloomEnabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.bloomPass?.setSize(w, h);
  }

  /** Current bloom state (used by the debug overlay). */
  get postProcessingActive(): boolean {
    return this.composer !== null && this.bloomEnabled;
  }
}
