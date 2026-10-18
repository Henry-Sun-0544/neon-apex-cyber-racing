/**
 * Map modes.
 *
 * `circuit` is the Round 1 closed neon highway; `openworld` is the Round 2
 * Horizon-style road network across a procedural island. Both expose the very
 * same `RaceWorld` contract, so the race director, AI, collision system and HUD
 * work identically in either mode.
 */
export type MapModeId = 'circuit' | 'openworld';

export interface MapModeMeta {
  id: MapModeId;
  name: string;
  short: string;
  tagline: string;
}

export const MAP_MODE_META: Record<MapModeId, MapModeMeta> = {
  circuit: {
    id: 'circuit',
    name: '赛道模式 CIRCUIT',
    short: 'CIRCUIT',
    tagline: '闭环高架赛道 · 原版赛博赛道',
  },
  openworld: {
    id: 'openworld',
    name: '开放世界 OPEN WORLD',
    short: 'OPEN WORLD',
    tagline: '城市 + 山路 + 隧道 + 大桥 + 立交 + 海岸',
  },
};

export const MAP_MODE_IDS: MapModeId[] = ['circuit', 'openworld'];

export class MapModeStore {
  static readonly STORAGE_KEY = 'nacr-mapmode';

  static load(fallback: MapModeId): MapModeId {
    try {
      const raw = localStorage.getItem(MapModeStore.STORAGE_KEY);
      if (raw && (MAP_MODE_IDS as string[]).includes(raw)) return raw as MapModeId;
    } catch {
      /* storage unavailable */
    }
    return fallback;
  }

  static save(id: MapModeId): void {
    try {
      localStorage.setItem(MapModeStore.STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }
}
