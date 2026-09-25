import { checkName, MAX_NAME_LENGTH } from '../shared/moderation.ts';
import {
  API_MODES,
  BOARD_SIZE,
  isTandemBoard,
  isLowerBetter,
  rankValue,
  type ApiMode,
  type LeaderboardResponse,
  type LeaderboardRow,
  type ScoreSubmission,
  type SubmitResponse,
} from '../shared/api.ts';

/**
 * iDrift API.
 *
 * One Worker serves both the static game and the leaderboard API. The brief
 * specified Pages for the frontend and a separate Worker for the API;
 * Cloudflare now recommends Workers with Static Assets for exactly this shape,
 * and it is strictly simpler -- one project, one deploy, one origin, so no CORS
 * and no chance of the two halves drifting to different versions. Same free
 * tier, same unlimited static bandwidth.
 *
 * There is deliberately no auth and no PII beyond a chosen display name.
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Optional: absent in local dev, in which case submissions are not limited. */
  SCORE_LIMITER?: RateLimit;
  /** Art and meme assets. Bound for later use; nothing reads it yet. */
  MEDIA?: R2Bucket;
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await route(request, env, ctx, url);
    } catch (err) {
      // Never leak an internal error to the client; a failed submission should
      // read as "try again", not as a stack trace.
      console.error('unhandled', err);
      return problem(500, 'internal', 'Something went wrong. Try again.');
    }
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/health') {
    return json({ ok: true });
  }

  if (path === '/api/score' && request.method === 'POST') {
    return submitScore(request, env, ctx);
  }

  // /api/leaderboard/:routeId/:mode/:carClass?
  const board = path.match(/^\/api\/leaderboard\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (board && request.method === 'GET') {
    return readBoard(env, url, board[1], board[2], board[3]);
  }

  const replay = path.match(/^\/api\/replay\/([^/]+)$/);
  if (replay && request.method === 'GET') {
    return readReplay(env, replay[1]);
  }

  return problem(404, 'notFound', 'No such endpoint.');
}

// --- POST /api/score --------------------------------------------------------

async function submitScore(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Rate limit first, before any parsing or database work, so a flood costs as
  // little as possible.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (env.SCORE_LIMITER) {
    const { success } = await env.SCORE_LIMITER.limit({ key: ip });
    if (!success) {
      return problem(429, 'rateLimited', 'Slow down a moment, then try again.');
    }
  }

  let body: ScoreSubmission;
  try {
    body = (await request.json()) as ScoreSubmission;
  } catch {
    return problem(400, 'badRequest', 'Could not read that submission.');
  }

  const invalid = validateShape(body);
  if (invalid) return problem(400, 'badRequest', invalid);

  // Moderation runs server-side because the client copy can be edited away.
  const name = body.playerName.trim();
  const check = checkName(name);
  if (!check.ok) {
    return problem(422, check.reason ?? 'profanity', check.message ?? 'Pick a different name.');
  }

  // Sanity bounds, read from the same baked route file the sim drove on. No
  // duplicated constants to fall out of sync: if the route changes, the bound
  // changes with it.
  const bounds = await routeBounds(env, body.routeId);
  if (!bounds) {
    return problem(400, 'unknownRoute', 'Unknown route.');
  }
  if (body.routeVersion !== bounds.version) {
    return problem(409, 'staleRoute', 'That route has been updated. Reload and run again.');
  }

  const timeSeconds = body.timeMs / 1000;
  if (timeSeconds < bounds.minTime) {
    return problem(422, 'impossible', 'That time is below the route minimum.');
  }
  if (body.mode === 'driftRun' && body.points > bounds.maxPoints) {
    return problem(422, 'impossible', 'That score is above the route maximum.');
  }

  // Full server-side re-simulation is explicitly out of scope for v1. These two
  // bounds plus the rate limit are what the brief asks for, and at this scale
  // they are the right amount of effort: they make a fabricated score obvious
  // without making an honest one fragile.

  const id = crypto.randomUUID();
  const value = rankValue(body.mode, body.timeMs, body.points);
  const replay = body.replay ? base64ToBytes(body.replay) : null;

  await env.DB.prepare(
    `INSERT INTO scores (
       id, route_id, route_version, mode, car_class, sim_version,
       player_name, car_id, rank_value, time_ms, points, grade,
       assist, tick_count, replay, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      body.routeId,
      body.routeVersion,
      body.mode,
      body.carClass,
      body.simVersion,
      name,
      body.carId,
      value,
      Math.round(body.timeMs),
      Math.round(body.points),
      body.grade ?? '',
      body.assist ?? 0,
      body.tickCount ?? 0,
      replay,
      Date.now(),
    )
    .run();

  // Rank = how many rows on this board beat it, plus one -- across every car.
  // The game shows one board per route and mode, so the rank has to be the
  // place on that board. Counting only the same car class told a player they
  // were #2 on a board where they sat third.
  const comparator = isLowerBetter(body.mode) ? '<' : '>';
  const better = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM scores
      WHERE route_id = ? AND route_version = ? AND mode = ?
        AND sim_version = ? AND rank_value ${comparator} ?`,
  )
    .bind(body.routeId, body.routeVersion, body.mode, body.simVersion, value)
    .first<{ n: number }>();

  const rank = (better?.n ?? 0) + 1;

  // Trim the board after responding: the player does not need to wait for it.
  ctx.waitUntil(trimBoard(env, body));

  return json<SubmitResponse>({ ok: true, id, rank, inTop20: rank <= BOARD_SIZE });
}

/**
 * Keep only the top BOARD_SIZE rows per board: per route, mode and sim
 * version, across all cars, matching the one board the game shows.
 *
 * Without this the table grows without bound and every row keeps its replay
 * blob, which is the part that actually costs storage. Runs after the response.
 */
async function trimBoard(env: Env, key: ScoreSubmission): Promise<void> {
  const order = isLowerBetter(key.mode) ? 'ASC' : 'DESC';
  await env.DB.prepare(
    `DELETE FROM scores
      WHERE route_id = ? AND route_version = ? AND mode = ?
        AND sim_version = ?
        AND id NOT IN (
          SELECT id FROM scores
           WHERE route_id = ? AND route_version = ? AND mode = ?
             AND sim_version = ?
           ORDER BY rank_value ${order}, created_at ASC
           LIMIT ?
        )`,
  )
    .bind(
      key.routeId, key.routeVersion, key.mode, key.simVersion,
      key.routeId, key.routeVersion, key.mode, key.simVersion,
      BOARD_SIZE,
    )
    .run();
}

// --- GET /api/leaderboard/:routeId/:mode/:car? ------------------------------

async function readBoard(
  env: Env,
  url: URL,
  routeId: string,
  mode: string,
  car: string | undefined,
): Promise<Response> {
  if (!API_MODES.includes(mode as ApiMode)) {
    return problem(400, 'badRequest', 'Unknown mode.');
  }

  const bounds = await routeBounds(env, routeId);
  if (!bounds) return problem(404, 'unknownRoute', 'Unknown route.');

  const routeVersion = Number(url.searchParams.get('routeVersion') ?? bounds.version);
  const simVersion = Number(url.searchParams.get('simVersion') ?? 1);
  const order = isLowerBetter(mode as ApiMode) ? 'ASC' : 'DESC';

  // The car is optional in the path: 'all' (or nothing) ranks every car
  // together, and a car's id gives that car's own board.
  if (car && car !== 'all' && !/^[a-z0-9-]{1,40}$/.test(car)) {
    return problem(400, 'badRequest', 'Unknown car.');
  }
  const filterCar = car !== undefined && car !== 'all';
  const sql =
    `SELECT id, player_name, car_id, time_ms, points, grade, created_at,
            (replay IS NOT NULL) AS has_replay
       FROM scores
      WHERE route_id = ? AND route_version = ? AND mode = ? AND sim_version = ?
        ${filterCar ? 'AND car_id = ?' : ''}
      ORDER BY rank_value ${order}, created_at ASC
      LIMIT ?`;

  const params: unknown[] = [routeId, routeVersion, mode, simVersion];
  if (filterCar) params.push(car);
  params.push(BOARD_SIZE);

  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all<{
      id: string;
      player_name: string;
      car_id: string;
      time_ms: number;
      points: number;
      grade: string;
      created_at: number;
      has_replay: number;
    }>();

  const rows: LeaderboardRow[] = (results ?? []).map((r, i) => ({
    id: r.id,
    rank: i + 1,
    playerName: r.player_name,
    carId: r.car_id,
    timeMs: r.time_ms,
    points: r.points,
    grade: r.grade,
    createdAt: r.created_at,
    hasReplay: !!r.has_replay,
  }));

  return json<LeaderboardResponse>(
    {
      key: { routeId, routeVersion, mode: mode as ApiMode, car: car ?? 'all', simVersion },
      rows,
    },
    // Boards change rarely and are read constantly. A short edge cache takes
    // almost all the load off D1 without anyone noticing the staleness.
    { 'Cache-Control': 'public, max-age=20' },
  );
}

// --- GET /api/replay/:runId -------------------------------------------------

async function readReplay(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT replay FROM scores WHERE id = ?')
    .bind(id)
    .first<{ replay: unknown }>();

  const bytes = toBytes(row?.replay);
  if (!bytes) return problem(404, 'notFound', 'No replay stored for that run.');

  // Already gzipped by the client. Served as an opaque blob rather than with
  // Content-Encoding: gzip, so the browser hands us the compressed bytes and
  // the game decompresses them itself -- the same bytes the sim recorded.
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

// --- Route bounds -----------------------------------------------------------

interface RouteBounds {
  version: number;
  minTime: number;
  maxPoints: number;
}

const boundsCache = new Map<string, RouteBounds>();

/**
 * Read a route's sanity bounds from the baked JSON served as a static asset.
 *
 * Deliberately not a copy of the numbers in the Worker: the bounds were
 * computed by the baker from the same geometry the sim drives, and any other
 * source would eventually disagree with it. Cached per isolate.
 */
async function routeBounds(env: Env, routeId: string): Promise<RouteBounds | null> {
  if (!/^[a-z0-9-]{1,64}$/.test(routeId)) return null;

  const cached = boundsCache.get(routeId);
  if (cached) return cached;

  const res = await env.ASSETS.fetch(new Request(`https://assets.local/routes/${routeId}.json`));
  if (!res.ok) return null;

  const route = (await res.json()) as {
    version: number;
    theoreticalMinTime: number;
    theoreticalMaxPoints: number;
  };

  const bounds: RouteBounds = {
    version: route.version,
    minTime: route.theoreticalMinTime,
    maxPoints: route.theoreticalMaxPoints,
  };
  boundsCache.set(routeId, bounds);
  return bounds;
}

// --- Validation and helpers -------------------------------------------------

/** Returns an error message, or null when the shape is acceptable. */
function validateShape(b: ScoreSubmission): string | null {
  if (typeof b !== 'object' || b === null) return 'Malformed submission.';
  if (typeof b.routeId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(b.routeId)) return 'Bad route.';
  if (!Number.isInteger(b.routeVersion) || b.routeVersion < 1) return 'Bad route version.';
  if (!API_MODES.includes(b.mode)) return 'Bad mode.';
  // A tandem battle is two runs judged out of 100 each.
  if (isTandemBoard(b.mode) && b.points > 200) return 'Bad points.';
  if (typeof b.carClass !== 'string' || !/^[A-Z]{1,2}$/.test(b.carClass)) return 'Bad car class.';
  if (!Number.isInteger(b.simVersion) || b.simVersion < 1) return 'Bad sim version.';
  if (typeof b.playerName !== 'string' || b.playerName.length > MAX_NAME_LENGTH * 2) return 'Bad name.';
  if (typeof b.carId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(b.carId)) return 'Bad car.';
  if (!Number.isFinite(b.timeMs) || b.timeMs <= 0 || b.timeMs > 3_600_000) return 'Bad time.';
  if (!Number.isFinite(b.points) || b.points < 0 || b.points > 1e12) return 'Bad points.';
  if (typeof b.assist !== 'number' || b.assist < 0 || b.assist > 1) return 'Bad assist value.';
  // A replay is a few KB; anything far larger is not a replay.
  if (b.replay !== undefined && (typeof b.replay !== 'string' || b.replay.length > 400_000)) {
    return 'Bad replay.';
  }
  return null;
}

/**
 * Normalise whatever D1 hands back for a BLOB column into bytes.
 *
 * D1 returns BLOBs as a plain array of byte values, not as an ArrayBuffer.
 * Passing that array straight to `new Response(...)` is not an error -- it
 * produces a 200 with an empty body, which is exactly the kind of failure that
 * reaches production, because the status code looks fine.
 */
function toBytes(value: unknown): Uint8Array | null {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return value.byteLength ? new Uint8Array(value) : null;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.byteLength
      ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      : null;
  }
  if (Array.isArray(value)) return value.length ? new Uint8Array(value) : null;
  return null;
}

function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function json<T>(body: T, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function problem(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error, message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
