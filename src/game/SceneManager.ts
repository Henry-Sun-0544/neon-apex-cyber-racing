import * as THREE from 'three';
import { MaterialLibrary } from './MaterialLibrary';
import { PostProcessingStack } from './PostProcessingStack';
import { QualityManager } from './QualityManager';
import type { GameStyle } from './styles/GameStyle';
import { clamp, damp } from './Utils';
import { CONFIG } from './Config';

export type CameraMode = 'chase' | 'hood';

/** What the camera needs from the car each frame. */
export interface CameraTarget {
  position: THREE.Vector3;
  yaw: number;
  speed: number;
  boosting: boolean;
}

/**
 * Everything related to rendering.
 *
 * Round 2 split the old "renderer + fog + sky + bloom" monolith into three
 * collaborators:
 *   - `QualityManager`        the budget (presets + automatic degradation),
 *   - `GameStyle`             the look (sky / lights / fog / grade),
 *   - `PostProcessingStack`   the effect chain,
 * leaving SceneManager with the renderer, the camera rig and the frame glue.
 *
 * A style switch replaces only the style's own objects and rewrites the post-fx
 * request, so no gameplay state can be affected.
 */
export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly quality: QualityManager;
  readonly materials: MaterialLibrary;
  readonly post: PostProcessingStack;

  cameraMode: CameraMode = 'chase';
  style: GameStyle;

  private shake = 0;
  private readonly shakeOffset = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly prevCameraPos = new THREE.Vector3();
  private readonly blurDir = new THREE.Vector2();
  private readonly sunUv = new THREE.Vector2();
  private hasSunUv = false;
  private adaptiveExposure = 1;
  private elapsed = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    quality: QualityManager,
    style: GameStyle,
  ) {
    this.quality = quality;
    this.style = style;
    const settings = quality.settings;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.pixelRatio < 1.5,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES filmic tone mapping is the single most important "photo" ingredient
    // and is shared by both styles.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = settings.shadowMapSize > 0;
    this.renderer.shadowMap.type = settings.shadowSoft ? THREE.VSMShadowMap : THREE.PCFShadowMap;
    this.renderer.info.autoReset = true;

    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, 0.24, 6000);
    this.camera.position.set(0, 8, -14);
    this.scene.add(this.camera);

    this.materials = new MaterialLibrary(quality);
    // Attach first: a style receives its environment there, and only then can
    // it configure shadow maps / light intensities for the quality budget.
    this.style.attach({
      scene: this.scene,
      renderer: this.renderer,
      camera: this.camera,
      materials: this.materials,
      quality: settings,
    });
    this.style.setQuality(settings);

    this.post = new PostProcessingStack(this.renderer, this.scene, this.camera, settings);
    this.post.setFx(this.style.fxRequest(settings));

    this.prevCameraPos.copy(this.camera.position);
  }

  // -------------------------------------------------------------- quality

  /** Applies a new quality budget to every renderer-side consumer. */
  applyQuality(): void {
    const settings = this.quality.settings;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio));
    this.renderer.shadowMap.enabled = settings.shadowMapSize > 0;
    this.renderer.shadowMap.type = settings.shadowSoft ? THREE.VSMShadowMap : THREE.PCFShadowMap;
    this.materials.refresh();
    this.style.setQuality(settings);
    this.post.setQuality(settings);
    this.post.setFx(this.style.fxRequest(settings));
  }

  // ----------------------------------------------------------------- style

  /**
   * Swaps the active style. Only the style's own sky/lights and the effect
   * chain are touched: the world graph, the cars and every race timer survive
   * untouched, which is what makes a mid-race switch safe.
   */
  applyStyle(next: GameStyle): void {
    const settings = this.quality.settings;
    next.rain = this.style.rain;
    next.snow = this.style.snow;
    next.timeOfDay = this.style.timeOfDay;
    this.style.detach(this.scene);
    next.attach({
      scene: this.scene,
      renderer: this.renderer,
      camera: this.camera,
      materials: this.materials,
      quality: settings,
    });
    next.setQuality(settings);
    this.style = next;
    this.post.setQuality(settings);
    this.post.setFx(next.fxRequest(settings));
  }

  /** Re-applies the current style's effect request (weather/quality drift). */
  refreshStyleFx(): void {
    this.post.setFx(this.style.fxRequest(this.quality.settings));
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
    this.prevCameraPos.copy(this.camera.position);
  }

  private computeDesired(target: CameraTarget): void {
    const cfg = CONFIG.camera;
    const forward = this.tmp.set(Math.sin(target.yaw), 0, Math.cos(target.yaw));
    if (this.cameraMode === 'chase') {
      this.desired
        .copy(target.position)
        .addScaledVector(forward, -cfg.chaseDistance)
        .add(this.tmp2.set(0, cfg.chaseHeight, 0));
    } else {
      this.desired
        .copy(target.position)
        .addScaledVector(forward, cfg.hoodDistance)
        .add(this.tmp2.set(0, cfg.hoodHeight, 0));
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
    const desiredLook = this.tmp2
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
    this.elapsed += dt;
    const degraded = this.quality.sample(dt, this.elapsed);
    if (degraded) this.applyQuality();

    // The style animates its own sky/lights/weather.
    this.style.update(dt, this.elapsed, this.camera);
    // Keep the sun shadow camera on the action (cheap, huge visual win).
    this.style.updateShadowFocus(this.lookTarget);

    // ------------------------------------------------- motion blur vector
    this.tmp.subVectors(this.camera.position, this.prevCameraPos);
    this.prevCameraPos.copy(this.camera.position);
    // Camera-space delta -> screen-space direction.
    const local = this.tmp.clone().applyQuaternion(this.camera.quaternion.clone().invert());
    this.blurDir.set(clamp(local.x * 0.02, -0.06, 0.06), clamp(-local.y * 0.02, -0.06, 0.06));

    // --------------------------------------------------- adaptive exposure
    const targetExposure = this.style.exposureAdaptation(this.camera);
    this.adaptiveExposure = damp(this.adaptiveExposure, targetExposure, 1.2, dt);

    // --------------------------------------------------------- god rays UV
    const sun = this.style.sunDirection();
    this.hasSunUv = false;
    if (sun) {
      const world = this.camera.position.clone().addScaledVector(sun, 3000);
      const ndc = world.project(this.camera);
      if (ndc.z < 1 && ndc.x > -1.4 && ndc.x < 1.4 && ndc.y > -1.4 && ndc.y < 1.4) {
        this.sunUv.set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);
        this.hasSunUv = true;
      }
    }

    this.post.update(dt, {
      time: this.elapsed,
      sunUv: this.hasSunUv ? this.sunUv : null,
      blurDir: this.blurDir,
      blur: 0,
      exposure: this.adaptiveExposure,
    });
    this.post.render();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
  }

  /** Current post-processing summary (used by the debug overlay/HUD). */
  get postProcessingActive(): boolean {
    return this.post.usingComposer;
  }

  get postProcessingSummary(): string {
    return this.post.describe();
  }

  /** Releases GPU resources (page teardown / full restart). */
  dispose(): void {
    this.style.detach(this.scene);
    this.post.dispose();
    this.materials.dispose();
  }
}
