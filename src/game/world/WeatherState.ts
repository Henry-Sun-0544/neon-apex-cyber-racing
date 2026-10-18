/**
 * Weather selection shared between the UI and the realistic style.
 *
 * `auto` lets the style run its own state machine (the default); the explicit
 * states let the player pin a look — useful for showing off wet roads at night.
 */
export type WeatherState = 'auto' | 'clear' | 'hazy' | 'cloudy' | 'rain' | 'storm' | 'snow';

export interface WeatherMeta {
  id: WeatherState;
  name: string;
}

export const WEATHER_META: Record<WeatherState, WeatherMeta> = {
  auto: { id: 'auto', name: '自动 AUTO' },
  clear: { id: 'clear', name: '晴 CLEAR' },
  hazy: { id: 'hazy', name: '薄雾 HAZY' },
  cloudy: { id: 'cloudy', name: '多云 CLOUDY' },
  rain: { id: 'rain', name: '降雨 RAIN' },
  storm: { id: 'storm', name: '暴雨 STORM' },
  snow: { id: 'snow', name: '降雪 SNOW' },
};

export const WEATHER_STATES: WeatherState[] = ['auto', 'clear', 'hazy', 'cloudy', 'rain', 'storm', 'snow'];

export class WeatherStore {
  static readonly STORAGE_KEY = 'nacr-weather';

  static load(fallback: WeatherState = 'auto'): WeatherState {
    try {
      const raw = localStorage.getItem(WeatherStore.STORAGE_KEY);
      if (raw && (WEATHER_STATES as string[]).includes(raw)) return raw as WeatherState;
    } catch {
      /* storage unavailable */
    }
    return fallback;
  }

  static save(id: WeatherState): void {
    try {
      localStorage.setItem(WeatherStore.STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }
}
