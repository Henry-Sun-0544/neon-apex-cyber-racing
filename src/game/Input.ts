/**
 * Keyboard input with edge detection.
 *
 * `update()` must be called once at the end of every frame to clear the
 * one-shot "just pressed" set.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Stop the page from scrolling while racing.
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (!this.down.has(e.code)) this.pressed.add(e.code);
    this.down.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private readonly onBlur = (): void => {
    // Losing focus must not leave a key stuck down.
    this.down.clear();
    this.pressed.clear();
  };

  constructor(target: Window = window) {
    target.addEventListener('keydown', this.onKeyDown, { passive: false });
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  /** Forward throttle 0..1. */
  get throttle(): number {
    return this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0;
  }

  /** Brake / reverse 0..1. */
  get brake(): number {
    return this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0;
  }

  /** Steering: -1 left, +1 right. */
  get steer(): number {
    const left = this.isDown('KeyA') || this.isDown('ArrowLeft') ? 1 : 0;
    const right = this.isDown('KeyD') || this.isDown('ArrowRight') ? 1 : 0;
    return right - left;
  }

  get nitro(): boolean {
    return this.isDown('Space');
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Clears the edge-triggered set; call at the end of each frame. */
  update(): void {
    this.pressed.clear();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
