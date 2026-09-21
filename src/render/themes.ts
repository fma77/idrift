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
};

const THEMES: Record<string, WorldTheme> = {
  nurburg: NURBURG_THEME,
};

export function themeFor(routeId: string): WorldTheme | null {
  return THEMES[routeId] ?? null;
}
