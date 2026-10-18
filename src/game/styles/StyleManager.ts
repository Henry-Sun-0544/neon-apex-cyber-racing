import type { GameStyleId } from './GameStyle';
import { GAME_STYLE_IDS, STYLE_META } from './GameStyle';
import { CyberpunkStyle } from './CyberpunkStyle';
import { RealisticStyle } from './RealisticStyle';
import type { GameStyle } from './GameStyle';

/**
 * Owns the active style instance, the persistence key and the fail-safe switch.
 *
 * A style switch is orchestrated by `Game` (it also has to re-theme the world
 * and rebuild the post chain), but every risky step goes through `safeSwitch`
 * so a failure rolls back to the last style that actually worked — the brief
 * requires that a broken switch can never leave the player with a black screen.
 */
export class StyleManager {
  static readonly STORAGE_KEY = 'nacr-style';

  /** Reads the persisted preference, falling back to the config default. */
  static loadPreference(fallback: GameStyleId): GameStyleId {
    try {
      const raw = localStorage.getItem(StyleManager.STORAGE_KEY);
      if (raw && (GAME_STYLE_IDS as string[]).includes(raw)) return raw as GameStyleId;
    } catch {
      /* private browsing / disabled storage */
    }
    return fallback;
  }

  static savePreference(id: GameStyleId): void {
    try {
      localStorage.setItem(StyleManager.STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }

  static meta(id: GameStyleId) {
    return STYLE_META[id];
  }

  static list() {
    return GAME_STYLE_IDS.map((id) => STYLE_META[id]);
  }

  static create(id: GameStyleId): GameStyle {
    return id === 'realistic' ? new RealisticStyle() : new CyberpunkStyle();
  }

  /** The style that is currently playable. */
  current: GameStyle;
  /** The last style that rendered without throwing (rollback target). */
  lastGood: GameStyle;

  constructor(initial: GameStyleId) {
    this.current = StyleManager.create(initial);
    this.lastGood = this.current;
  }

  get id(): GameStyleId {
    return this.current.id;
  }

  get meta() {
    return STYLE_META[this.current.id];
  }

  /**
   * Runs `apply` for the requested style; on any failure the previous style is
   * re-installed and the error is re-thrown so the caller can toast the user.
   */
  safeSwitch(next: GameStyle, apply: (style: GameStyle) => void, restore: (style: GameStyle) => void): void {
    const previous = this.lastGood;
    try {
      apply(next);
      this.current = next;
      this.lastGood = next;
      StyleManager.savePreference(next.id);
    } catch (error) {
      console.error('[NA:CR] 风格切换失败，正在回滚', error);
      try {
        restore(previous);
        this.current = previous;
      } catch (rollbackError) {
        console.error('[NA:CR] 回滚同样失败', rollbackError);
      }
      throw error;
    }
  }

  /** Cycles to the other style (T hotkey). */
  nextId(): GameStyleId {
    const index = GAME_STYLE_IDS.indexOf(this.current.id);
    return GAME_STYLE_IDS[(index + 1) % GAME_STYLE_IDS.length]!;
  }
}
