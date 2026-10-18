import * as THREE from 'three';
import { fbm2, makeNoise2D, mix, ridged2, smoothstep, warpedFbm } from './Noise';

/**
 * Biomes.
 *
 * The biome map is driven by elevation, slope and a coarse climate noise, which
 * is exactly how the terrain mesh, the scatter system and the vegetation all
 * agree on what belongs where without any authored data.
 */
export type BiomeId =
  | 'ocean'
  | 'beach'
  | 'grassland'
  | 'forest'
  | 'desert'
  | 'rock'
  | 'alpine'
  | 'wetland'
  | 'urban';

export interface BiomeInfo {
  id: BiomeId;
  name: string;
  /** Base surface colour used by the terrain vertex colours. */
  ground: THREE.Color;
  /** Secondary colour blended in by the detail noise. */
  accent: THREE.Color;
  /** Visual roughness of the surface. */
  roughness: number;
}

export const BIOMES: Record<BiomeId, BiomeInfo> = {
  ocean: { id: 'ocean', name: '海洋', ground: new THREE.Color(0x1d3a4d), accent: new THREE.Color(0x2b566b), roughness: 0.12 },
  beach: { id: 'beach', name: '海岸', ground: new THREE.Color(0xc9b78d), accent: new THREE.Color(0xa89a72), roughness: 0.85 },
  grassland: { id: 'grassland', name: '草原', ground: new THREE.Color(0x6f7f45), accent: new THREE.Color(0x8d9a58), roughness: 0.92 },
  forest: { id: 'forest', name: '森林', ground: new THREE.Color(0x415c37), accent: new THREE.Color(0x2f4a2c), roughness: 0.95 },
  desert: { id: 'desert', name: '沙漠', ground: new THREE.Color(0xbfa479), accent: new THREE.Color(0xd6c095), roughness: 0.9 },
  rock: { id: 'rock', name: '岩地', ground: new THREE.Color(0x7b766e), accent: new THREE.Color(0x5f5b55), roughness: 0.88 },
  alpine: { id: 'alpine', name: '高山', ground: new THREE.Color(0x9aa3ad), accent: new THREE.Color(0xd9e2ea), roughness: 0.8 },
  wetland: { id: 'wetland', name: '湿地', ground: new THREE.Color(0x4d6250), accent: new THREE.Color(0x37503f), roughness: 0.7 },
  urban: { id: 'urban', name: '城区', ground: new THREE.Color(0x6b6c6e), accent: new THREE.Color(0x55565a), roughness: 0.8 },
};

/** Climate / height bands the biome classifier works from. */
export interface BiomeSample {
  biome: BiomeId;
  /** 0..1 blend weight used to soften transitions between biomes. */
  blend: number;
}

/**
 * Classifies a world position.
 *
 * @param height   terrain height in metres (final, after road flattening)
 * @param slope    0..1 (0 = flat)
 * @param seaLevel the water line
 * @param urban    0..1 weight of the city district
 */
export class BiomeSystem {
  private readonly climateNoise = makeNoise2D(20261017);
  private readonly detailNoise = makeNoise2D(777001);
  /** Cached biome per quantised cell: the terrain mesher asks millions of times. */
  private readonly cache = new Map<number, BiomeId>();

  constructor(private readonly seaLevel: number) {}

  /** 0 = cold/polar, 1 = hot/arid. */
  climateAt(x: number, z: number): number {
    return fbm2(this.climateNoise, x * 0.00018 + 10, z * 0.00018 + 4, 4);
  }

  biomeAt(height: number, slope: number, x: number, z: number, urban = 0): BiomeId {
    if (height < this.seaLevel + 0.4) return 'ocean';
    if (urban > 0.55) return 'urban';
    const relative = height - this.seaLevel;
    const climate = this.climateAt(x, z);

    if (relative < 4 && slope < 0.35) return 'beach';
    if (relative < 10 && slope < 0.2 && climate > 0.55) return 'wetland';
    if (height > 150 || (relative > 95 && slope > 0.45)) return relative > 25 && slope < 0.5 ? 'alpine' : 'rock';
    if (slope > 0.62) return 'rock';
    if (climate > 0.68 && relative < 65) return 'desert';
    if (climate < 0.42 && relative > 22) return 'forest';
    if (slope > 0.4) return 'rock';
    if (climate > 0.52) return 'grassland';
    return 'forest';
  }

  /** Terrain surface colour for a vertex (biome ground blended with detail). */
  colourAt(height: number, slope: number, x: number, z: number, urban: number, out: THREE.Color): THREE.Color {
    const biome = this.biomeAt(height, slope, x, z, urban);
    const info = BIOMES[biome];
    const detail = fbm2(this.detailNoise, x * 0.02, z * 0.02, 3);
    out.copy(info.ground).lerp(info.accent, detail * 0.75);
    // Extra life: moss on flat grass, exposed stone on steep rock.
    if (biome === 'grassland' || biome === 'forest') {
      out.lerp(BIOMES.rock.ground, smoothstep(0.45, 0.8, slope) * 0.6);
    }
    if (biome === 'alpine') {
      out.lerp(BIOMES.rock.ground, smoothstep(0.5, 0.9, slope) * 0.5);
    }
    out.lerp(BIOMES.urban.ground, urban * 0.7);
    return out;
  }

  /** Cache-friendly biome lookup for the scatter system. */
  biomeAtCached(height: number, slope: number, x: number, z: number, urban: number): BiomeId {
    const key = ((Math.round(x / 32) + 4096) * 16384 + (Math.round(z / 32) + 4096)) | 0;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const value = this.biomeAt(height, slope, x, z, urban);
    if (this.cache.size > 40000) this.cache.clear();
    this.cache.set(key, value);
    return value;
  }

  /** Roughness for the terrain material in a given biome (used by scatter/LOD). */
  roughnessFor(biome: BiomeId): number {
    return BIOMES[biome].roughness;
  }

  /** Scatter density per biome: how many props a hectare should get. */
  scatterDensity(biome: BiomeId): number {
    switch (biome) {
      case 'forest':
        return 1;
      case 'grassland':
        return 0.3;
      case 'alpine':
        return 0.12;
      case 'beach':
        return 0.08;
      case 'wetland':
        return 0.35;
      case 'desert':
        return 0.06;
      case 'urban':
        return 0.02;
      default:
        return 0;
    }
  }

  /** Terrain colour ramp reused by the minimap/backdrop tint. */
  static readonly SEA_COLOR = new THREE.Color(0x1b3a4b);

  /** Blends two biome ids by weight (used for smooth LOD transitions). */
  static blend(a: BiomeId, b: BiomeId, t: number): BiomeId {
    return t < 0.5 ? a : b;
  }
}

/** Height field shaping constants, shared by the terrain and the road network. */
export const TERRAIN_SHAPE = {
  /** Sea level in metres. */
  seaLevel: -26,
  /**
   * Island radius (metres). The race route reaches ~1.8 km from the origin, so
   * the coastline has to start well beyond that or the whole race would run
   * over open water.
   */
  islandRadius: 3000,
  /** Amplitude of the rolling plains. */
  plainAmplitude: 34,
  /** Peak amplitude of the mountain ridges. */
  mountainAmplitude: 210,
  /** Ridges are concentrated in a band; this controls how wide it is. */
  ridgeFrequency: 0.00095,
  /** Domain warp strength for natural coastlines. */
  coastWarp: 0.55,
};

/** Small helper so the terrain and the roads share the same "is this water" test. */
export function isWater(height: number, seaLevel = TERRAIN_SHAPE.seaLevel): boolean {
  return height < seaLevel + 0.4;
}

/** Unused-but-handy shaper kept for tuning sessions. */
export function shapePlateau(h: number, plateau: number): number {
  return mix(h, plateau, smoothstep(0.2, 0.6, ridged2(makeNoise2D(1), h * 0.01, plateau * 0.01, 2)));
}

void warpedFbm;
