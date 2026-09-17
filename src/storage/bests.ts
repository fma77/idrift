import { SIM_VERSION } from '../sim/version.ts';
import type { SimMode } from '../sim/types.ts';

/**
 * Personal bests, unlock progress, and stored replays.
 *
 * Bests and progress live in localStorage (tiny, read at boot). Replay input
 * streams live in IndexedDB, keyed by the same identity as a leaderboard row,
 * because they are binary and a few KB each.
 *
 * Every record carries simVersion. A best set against a different physics build
 * is not comparable to one set against this build, and quietly showing them
 * side by side is worse than showing neither.
 */

const BESTS_KEY = 'idrift.bests.v1';
const PROGRESS_KEY = 'idrift.progress.v1';
const DB_NAME = 'idrift';
const DB_STORE = 'replays';

export interface BestRecord {
  routeId: string;
  routeVersion: number;
  mode: SimMode;
  carId: string;
  simVersion: number;
  /** Seconds, including penalties. */
  timeSeconds: number;
  /** Drift run only. */
  points: number;
  grade: string;
  recordedAt: number;
}

type BestMap = Record<string, BestRecord>;

/** One best per route + mode + sim version. Car is recorded, not partitioned on. */
export function bestKey(routeId: string, routeVersion: number, mode: SimMode): string {
  return `${routeId}@${routeVersion}:${mode}:v${SIM_VERSION}`;
}

function readBests(): BestMap {
  try {
    return JSON.parse(localStorage.getItem(BESTS_KEY) ?? '{}') as BestMap;
  } catch {
    return {};
  }
}

export function getBest(
  routeId: string,
  routeVersion: number,
  mode: SimMode,
): BestRecord | null {
  return readBests()[bestKey(routeId, routeVersion, mode)] ?? null;
}

/**
 * Store the record if it beats the existing one.
 * @returns true if this run is a new personal best.
 */
export function submitBest(record: BestRecord): boolean {
  const all = readBests();
  const key = bestKey(record.routeId, record.routeVersion, record.mode);
  const existing = all[key];

  const better =
    !existing ||
    (record.mode === 'timeAttack'
      ? record.timeSeconds < existing.timeSeconds
      : record.points > existing.points);

  if (!better) return false;

  all[key] = record;
  try {
    localStorage.setItem(BESTS_KEY, JSON.stringify(all));
  } catch {
    // Not persisted, but still a best for this session.
  }
  return true;
}

// --- Progression ------------------------------------------------------------

interface Progress {
  /** Route ids the player has finished at least once, in any mode. */
  completed: string[];
}

function readProgress(): Progress {
  try {
    const p = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}') as Partial<Progress>;
    return { completed: p.completed ?? [] };
  } catch {
    return { completed: [] };
  }
}

export function markCompleted(routeId: string): void {
  const p = readProgress();
  if (p.completed.includes(routeId)) return;
  p.completed.push(routeId);
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function isCompleted(routeId: string): boolean {
  return readProgress().completed.includes(routeId);
}

/**
 * Linear unlock: route N+1 opens when route N is finished.
 *
 * Progress is NOT partitioned by simVersion, unlike bests. Re-tuning the
 * physics should not relock content the player has already played through.
 */
export function isUnlocked(routeIds: string[], index: number): boolean {
  if (index <= 0) return true;
  return isCompleted(routeIds[index - 1]);
}

// --- Replays ----------------------------------------------------------------

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Gzip the delta-encoded stream before storing.
 *
 * CompressionStream is native, so this costs nothing in bundle size, and a
 * 90-second run drops from ~18KB to a few KB -- small enough that storing the
 * replay for every personal best, and later for every top-20 leaderboard row,
 * is simply not a size problem worth engineering around.
 */
export async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function saveReplay(key: string, compressed: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(compressed, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

export async function loadReplay(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  if (!db) return null;
  const result = await new Promise<Uint8Array | null>((resolve) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
    req.onerror = () => resolve(null);
  });
  db.close();
  return result;
}
