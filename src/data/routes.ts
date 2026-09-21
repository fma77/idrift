import type { RouteData } from '../sim/types.ts';
import type { Country } from '../ui/flags.ts';
import {
  ESTORIL_POSTER,
  HARUNA_UPPER_POSTER,
  HARUNA_MIDDLE_POSTER,
  HARUNA_LOWER_POSTER,
  HARUNA_FULL_POSTER,
  NURBURG_POSTER,
  type PosterArt,
} from './posters.ts';

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
  /** Painted course poster. Falls back to a drawn minimap when absent. */
  poster?: PosterArt;
  /** Shown as a flag on the route card. */
  country: Country;
  /** Short flavour line for the route card. */
  blurb: string;
  /** Credit line for routes built from third-party data. Shown on the route screen. */
  attribution?: string;
}

export const ROUTES: RouteEntry[] = [
  {
    id: 'akari-downhill',
    country: 'jp',
    name: 'AKARI DOWNHILL',
    location: 'Akari Pass, North Face',
    file: 'routes/akari-downhill.json',
    blurb: 'Fast opener, three hairpins, esses in the middle. 1.5km down.',
  },
  {
    id: 'estoril',
    country: 'pt',
    name: 'ESTORIL',
    location: 'Estoril, Portugal',
    file: 'routes/estoril.json',
    blurb: 'Recta Interior round to the main straight. 7 corners, 1.4km.',
    poster: ESTORIL_POSTER,
    attribution: OSM_CREDIT,
  },
  {
    id: 'nurburg',
    country: 'de',
    name: 'NURBURG',
    location: 'Nürburg, Eifel',
    file: 'routes/nurburg.json',
    blurb: 'Tiergarten to Quiddelbacher Höhe, through the Hatzenbach esses. 1.6km.',
    poster: NURBURG_POSTER,
    attribution: OSM_CREDIT,
  },
  {
    id: 'haruna-upper',
    country: 'jp',
    name: 'HARUNA UPPER',
    location: 'Mount Haruna, Gunma',
    file: 'routes/haruna-upper.json',
    blurb: 'Off the top of the mountain. 7 hairpins, 1.5km.',
    poster: HARUNA_UPPER_POSTER,
    attribution: OSM_CREDIT,
  },
  {
    id: 'haruna-middle',
    country: 'jp',
    name: 'HARUNA MIDDLE',
    location: 'Mount Haruna, Gunma',
    file: 'routes/haruna-middle.json',
    blurb: 'The middle third, corner after corner. 12 hairpins, 1.6km.',
    poster: HARUNA_MIDDLE_POSTER,
    attribution: OSM_CREDIT,
  },
  {
    id: 'haruna-lower',
    country: 'jp',
    name: 'HARUNA LOWER',
    location: 'Mount Haruna, Gunma',
    file: 'routes/haruna-lower.json',
    blurb: 'The run to the bottom, and the tightest of it. 12 hairpins, 1.6km.',
    poster: HARUNA_LOWER_POSTER,
    attribution: OSM_CREDIT,
  },
  {
    id: 'haruna-downhill',
    country: 'jp',
    name: 'HARUNA FULL PASS',
    location: 'Mount Haruna, Gunma',
    file: 'routes/haruna-downhill.json',
    blurb: 'All three sections in one run. 31 hairpins, 4.7km.',
    poster: HARUNA_FULL_POSTER,
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
