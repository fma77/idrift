import type {
  ApiError,
  LeaderboardResponse,
  ScoreSubmission,
  SubmitResponse,
} from '../../shared/api.ts';

/**
 * Leaderboard client.
 *
 * Every call here is allowed to fail. The game is fully playable offline apart
 * from the board itself, so a network error must degrade to "we could not
 * reach the board" and never block a results screen or lose a run -- the
 * personal best is already saved locally before any of this is attempted.
 */

const TIMEOUT_MS = 8000;

export class LeaderboardError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LeaderboardError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, { ...init, signal: controller.signal });
    if (!res.ok) {
      let payload: ApiError | null = null;
      try {
        payload = (await res.json()) as ApiError;
      } catch {
        // Non-JSON error body; fall through to a generic message.
      }
      throw new LeaderboardError(
        payload?.message ?? 'The leaderboard is not reachable right now.',
        payload?.error ?? 'network',
        res.status,
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof LeaderboardError) throw err;
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    throw new LeaderboardError(
      aborted ? 'The leaderboard took too long to answer.' : 'Could not reach the leaderboard.',
      aborted ? 'timeout' : 'network',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function submitScore(submission: ScoreSubmission): Promise<SubmitResponse> {
  return request<SubmitResponse>('/api/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submission),
  });
}

export function fetchBoard(
  routeId: string,
  mode: string,
  carClass: string,
  routeVersion: number,
  simVersion: number,
  /**
   * Skip the browser's copy. Boards are cached for 20s, which is right for
   * browsing and wrong straight after posting: the player's own run was
   * missing from the board shown under it.
   */
  fresh = false,
): Promise<LeaderboardResponse> {
  const query = `?routeVersion=${routeVersion}&simVersion=${simVersion}`;
  return request<LeaderboardResponse>(
    `/api/leaderboard/${encodeURIComponent(routeId)}/${encodeURIComponent(mode)}/${encodeURIComponent(carClass)}${query}`,
    fresh ? { cache: 'no-store' } : undefined,
  );
}

/** Fetch a stored input stream for ghost playback. Returns the gzipped bytes. */
export async function fetchReplay(runId: string): Promise<Uint8Array> {
  const res = await fetch(`/api/replay/${encodeURIComponent(runId)}`);
  if (!res.ok) throw new LeaderboardError('No replay stored for that run.', 'notFound', res.status);
  return new Uint8Array(await res.arrayBuffer());
}

/** Base64 for the wire. Chunked so a few-KB replay cannot blow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
