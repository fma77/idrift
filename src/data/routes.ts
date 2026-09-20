import type { RouteData } from '../sim/types.ts';

/**
 * Route registry.
 *
 * Order is the unlock order: finishing route N opens route N+1. Baked route
 * JSON is fetched on demand rather than bundled, so adding a route is a file
 * drop plus one line here, and the initial download does not grow with the
 * content.
 */

export interface RouteEntry {
  id: string;
  name: string;
  location: string;
  /** Path to the baked, immutable route JSON. */
  file: string;
  /** Stylised course poster. Falls back to a drawn minimap when absent. */
  poster?: string;
  /** Short flavour line for the route card. */
  blurb: string;
  /** Credit line for routes built from third-party data. Shown on the route screen. */
  attribution?: string;
}

export const ROUTES: RouteEntry[] = [
  {
    id: 'akari-downhill',
    name: 'AKARI DOWNHILL',
    location: 'Akari Pass, North Face',
    file: 'routes/akari-downhill.json',
    blurb: 'Fast opener, three hairpins, esses in the middle. 1.5km down.',
  },
  {
    id: 'kirisame-ridge',
    name: 'KIRISAME RIDGE',
    location: 'Kirisame Ridge, East Col',
    file: 'routes/kirisame-ridge.json',
    blurb: 'Long radii, linked esses, one hairpin that bites. 1.75km.',
  },
  {
    id: 'shiomi-docks',
    name: 'SHIOMI DOCKS',
    location: 'Shiomi Docks, Berth 9',
    file: 'routes/shiomi-docks.json',
    blurb: 'Wide, slippery and tight. Built for angle, not speed. 1km.',
  },
  {
    id: 'haruna-downhill',
    name: 'HARUNA DOWNHILL',
    location: 'Mount Haruna, Gunma',
    file: 'routes/haruna-downhill.json',
    blurb: 'The real pass, imported from the map. 29 hairpins, 6.9km.',
    attribution: 'Road data from OpenStreetMap contributors (ODbL)',
  },
];

export const ROUTE_IDS = ROUTES.map((r) => r.id);

const cache = new Map<string, RouteData>();

export async function loadRoute(entry: RouteEntry): Promise<RouteData> {
  const cached = cache.get(entry.id);
  if (cached) return cached;
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`Could not load route ${entry.id} (${res.status})`);
  const data = (await res.json()) as RouteData;
  cache.set(entry.id, data);
  return data;
}

export function routeEntryById(id: string): RouteEntry {
  return ROUTES.find((r) => r.id === id) ?? ROUTES[0];
}
