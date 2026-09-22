/**
 * The wire contract between the game and the leaderboard API.
 *
 * Shared by both sides so a change to a field name is a type error rather than
 * a runtime surprise in production.
 */

/** Leaderboards: Time Attack on pedals ('timeAttackPro') has its own. */
export type ApiMode = 'timeAttack' | 'timeAttackPro' | 'driftRun';

/** Leaderboard partition key, per the brief. */
export interface BoardKey {
  routeId: string;
  routeVersion: number;
  mode: ApiMode;
  carClass: string;
  simVersion: number;
}

export interface ScoreSubmission extends BoardKey {
  playerName: string;
  carId: string;
  /** Milliseconds, including penalties. Integer. */
  timeMs: number;
  /** Drift Run only; 0 for Time Attack. */
  points: number;
  grade: string;
  assist: number;
  tickCount: number;
  /** Gzipped, delta-encoded input stream, base64. Optional. */
  replay?: string;
}

export interface LeaderboardRow {
  id: string;
  rank: number;
  playerName: string;
  carId: string;
  timeMs: number;
  points: number;
  grade: string;
  createdAt: number;
  hasReplay: boolean;
}

export interface LeaderboardResponse {
  key: BoardKey;
  rows: LeaderboardRow[];
}

export interface SubmitResponse {
  ok: true;
  id: string;
  rank: number | null;
  inTop20: boolean;
}

export interface ApiError {
  ok: false;
  error: string;
  message: string;
}

/** Top-N kept per board. The brief asks for 20. */
export const BOARD_SIZE = 20;

/**
 * Ranking direction. Time Attack ranks ascending (fastest first), Drift Run
 * descending (most points first). Everything that sorts a board reads this
 * rather than re-deciding, so the client and the SQL cannot disagree.
 */
export function isLowerBetter(mode: ApiMode): boolean {
  return mode === 'timeAttack' || mode === 'timeAttackPro';
}

/** The value a board is ranked on, derived from the submission. */
export function rankValue(mode: ApiMode, timeMs: number, points: number): number {
  return isLowerBetter(mode) ? timeMs : points;
}
