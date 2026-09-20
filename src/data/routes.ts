import type { RouteData } from '../sim/types.ts';

/**
 * Route registry.
 *
 * Order is the unlock order: finishing route N opens route N+1. Baked route
 * JSON is fetched on demand rather than bundled, so adding a route is a file
 * drop plus one line here, and the initial download does not grow with the
 * content.
 */

/** Required by the ODbL for anything built from OpenStreetMap data. */
const OSM_CREDIT = 'Road data from OpenStreetMap contributors (ODbL)';

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
    id: 'quiddelbacher',
    name: 'QUIDDELBACHER HÖHE',
    location: 'Nürburg, Eifel',
    file: 'routes/quiddelbacher.json',
    blurb: 'Tiergarten to Quiddelbacher Höhe, through the Hatzenbach esses. 2.4km.',
    attribution: OSM_CREDIT,
  },
  {
    id: 'haruna-lower',
    name: 'HARUNA LOWER',
    location: 'Mount Haruna, Gunma',
    file: 'routes/haruna-lower.json',
    blurb: 'The bottom third of the real pass. 7 hairpins, 2.2km.',
    attribution: OSM_CREDIT,
  },
  {
    id: 'haruna-middle',
    name: 'HARUNA MIDDLE',
    location: 'Mount Haruna, Gunma',
    file: 'routes/haruna-middle.json',
    blurb: 'The middle third, corner after corner. 8 hairpins, 2.1km.',
    attribution: OSM_CREDIT,
  },
  {
    id: 'haruna-upper',
    name: 'HARUNA UPPER',
    location: 'Mount Haruna, Gunma',
    file: 'routes/haruna-upper.json',
    blurb: 'The top third, and the tightest of it. 13 hairpins, 2.5km.',
    attribution: OSM_CREDIT,
  },
  {
    id: 'haruna-downhill',
    name: 'HARUNA FULL PASS',
    location: 'Mount Haruna, Gunma',
    file: 'routes/haruna-downhill.json',
    blurb: 'All three sections in one run. 28 hairpins, 6.8km.',
    attribution: OSM_CREDIT,
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
