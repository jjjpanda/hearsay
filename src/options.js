import { SPEEDS } from './playback.js';
import { DEFAULTS, DEFAULT_CONDITIONS, ENGINE_CONFIG } from './model.js';

export const PRESETS = {
  balanced: { ...DEFAULT_CONDITIONS },
  trend: { ...DEFAULT_CONDITIONS, liquidity: 70, trend: 85, uncertainty: 45, activity: 45 },
  thin: { ...DEFAULT_CONDITIONS, liquidity: 20, uncertainty: 55, activity: 15 }
};

export const OPTION_NAMES = ['seed', 'population', 'preset', 'speed', 'autoplay', 'theme', 'embed',
  'transparent', 'autofocus', 'width', 'height', 'panels', 'emit-events'];

export const enabled = value => value === '' || value === 'true';

export function applyPageOptions(element, search = location.search) {
  const params = new URLSearchParams(search);
  for (const name of OPTION_NAMES) {
    if (params.has(name) && (name !== 'embed' || !element.hasAttribute('embed'))) {
      element.setAttribute(name, params.get(name));
    }
  }
}

export function readOptions(get) {
  const seed = get('seed');
  const pop = get('population');
  const popNum = pop !== null && /^\d+$/.test(pop) ? Number(pop) : NaN;
  const dimension = (name, max) => {
    const value = Number(get(name));
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(max, Math.round(value))) : null;
  };
  return {
    seed: seed !== null && /^\d+$/.test(seed) && Number(seed) <= ENGINE_CONFIG.SEED_MAX ? Number(seed) : DEFAULTS.seed,
    population: Number.isInteger(popNum) && popNum >= ENGINE_CONFIG.POPULATION_MIN && popNum <= ENGINE_CONFIG.POPULATION_MAX
      ? popNum : DEFAULTS.population,
    preset: Object.hasOwn(PRESETS, get('preset')) ? get('preset') : 'balanced',
    speed: SPEEDS.includes(Number(get('speed'))) ? Number(get('speed')) : 64,
    autoplay: get('autoplay') !== 'false',
    theme: get('theme') === 'light' ? 'light' : 'dark',
    embed: enabled(get('embed')),
    transparent: enabled(get('transparent')),
    autofocus: enabled(get('autofocus')),
    width: dimension('width', 4096),
    height: dimension('height', 2160),
    panels: get('panels') ? get('panels').split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null,
    emitEvents: enabled(get('emit-events'))
  };
}
