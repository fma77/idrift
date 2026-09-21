/**
 * Painted world themes, taken from each route's poster.
 *
 * A route without one keeps the original ink-and-paper look. Presentation only:
 * nothing here reaches the sim.
 */
export interface WorldTheme {
  /** Base grass, and the brush strokes laid over it. */
  ground: string;
  grassStrokes: string[];
  /** Large soft patches: sunlit meadow and shaded forest floor. */
  meadow: string;
  shade: string;
  /** Shoulder between grass and tarmac. */
  verge: string;
  vergeWidth: number;
  tarmac: string;
  outline: string;
  edgeLine: string;
  centreLine: string;
  /** Tree canopy: shadow side, body, sunlit side. */
  leaf: [string, string, string];
  conifer: [string, string, string];
  treeShadow: string;
  /** Share of trees that are conifers, 0..1. */
  coniferShare: number;
  /** How much of the roadside is forest, 0..1. */
  forest: number;
  /** Haze at the edge of the view, as r,g,b. */
  haze: [number, number, number];
  guardrail: string;
  post: string;
  /** Dirt thrown up off the road: earth, and torn grass. */
  dirt: [string, string];
  /** Open ground between the shoulder and the first trees, metres. A circuit's run-off. */
  treeClearance: number;
  /** Red and white kerbs on the corners, as on a circuit. */
  kerbs: boolean;
}

/** The Eifel on the Nurburg poster: pine forest, bright meadows, summer light. */
export const NURBURG_THEME: WorldTheme = {
  ground: '#6fae3f',
  grassStrokes: ['#5d9a33', '#83c04c', '#4f8a2c', '#9ccf5c'],
  meadow: '#b9d86a',
  shade: '#2f6a2a',
  verge: '#bdd47c',
  vergeWidth: 2.4,
  tarmac: '#6d6e73',
  outline: '#1d2418',
  edgeLine: '#f4f1ea',
  centreLine: 'rgba(244,241,234,0.75)',
  leaf: ['#2f6b2c', '#4f9a3a', '#86c455'],
  conifer: ['#1c4a2a', '#2d6a37', '#4f8f45'],
  treeShadow: 'rgba(24,52,20,0.38)',
  coniferShare: 0.6,
  forest: 0.72,
  haze: [226, 236, 214],
  guardrail: '#d8dad6',
  post: '#f4f1ea',
  dirt: ['#6b4a2b', '#4f8a2c'],
  treeClearance: 0,
  kerbs: false,
};

/** Estoril on its poster: bright run-off, broadleaf woods, dark circuit tarmac. */
export const ESTORIL_THEME: WorldTheme = {
  ground: '#7cb84a',
  grassStrokes: ['#6aa73d', '#8fca58', '#5c9634', '#a8d86a'],
  meadow: '#cfe07c',
  shade: '#3d7a30',
  verge: '#a6d27a',
  vergeWidth: 3.2,
  tarmac: '#56585f',
  outline: '#1d2418',
  edgeLine: '#f4f1ea',
  centreLine: 'rgba(244,241,234,0)',
  leaf: ['#2f6f2c', '#4e9c3b', '#8acb58'],
  conifer: ['#24562c', '#357a3a', '#5a9c48'],
  treeShadow: 'rgba(24,52,20,0.34)',
  coniferShare: 0.12,
  forest: 0.55,
  haze: [236, 238, 222],
  guardrail: '#e6e6e0',
  post: '#f4f1ea',
  dirt: ['#cbb487', '#8fca58'],
  treeClearance: 12,
  kerbs: true,
};

/** Mount Haruna on its poster: dense broadleaf forest on steep green slopes. */
export const HARUNA_THEME: WorldTheme = {
  ground: '#5f9f36',
  grassStrokes: ['#4f8c2c', '#72b244', '#437a26', '#8cc453'],
  meadow: '#a9cf5c',
  shade: '#2a5e24',
  verge: '#a3c565',
  vergeWidth: 1.6,
  tarmac: '#6f7076',
  outline: '#1b2415',
  edgeLine: '#f4f1ea',
  centreLine: 'rgba(244,241,234,0.7)',
  leaf: ['#2c6428', '#4a9236', '#7fbd4e'],
  conifer: ['#1d4a27', '#2c6734', '#4b8a42'],
  treeShadow: 'rgba(20,46,18,0.4)',
  coniferShare: 0.3,
  forest: 0.88,
  haze: [224, 234, 216],
  guardrail: '#dcdcd6',
  post: '#f4f1ea',
  dirt: ['#5b4128', '#4a9236'],
  treeClearance: 0,
  kerbs: false,
};

const THEMES: Record<string, WorldTheme> = {
  estoril: ESTORIL_THEME,
  nurburg: NURBURG_THEME,
  'haruna-upper': HARUNA_THEME,
  'haruna-middle': HARUNA_THEME,
  'haruna-lower': HARUNA_THEME,
  'haruna-downhill': HARUNA_THEME,
};

export function themeFor(routeId: string): WorldTheme | null {
  return THEMES[routeId] ?? null;
}
