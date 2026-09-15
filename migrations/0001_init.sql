-- iDrift leaderboards.
--
-- One table. A "board" is the tuple (route_id, route_version, mode, car_class,
-- sim_version) -- the partition key from the brief. Partitioning on
-- sim_version is the important part: a physics change makes every earlier time
-- incomparable, and showing them on one board would be quietly wrong in a way
-- no player could detect.

CREATE TABLE IF NOT EXISTS scores (
  id             TEXT    PRIMARY KEY,
  route_id       TEXT    NOT NULL,
  route_version  INTEGER NOT NULL,
  mode           TEXT    NOT NULL CHECK (mode IN ('timeAttack', 'driftRun')),
  car_class      TEXT    NOT NULL,
  sim_version    INTEGER NOT NULL,

  player_name    TEXT    NOT NULL,
  car_id         TEXT    NOT NULL,

  -- The value this row is ranked on: milliseconds for timeAttack (ascending),
  -- points for driftRun (descending). Denormalised from time_ms/points so the
  -- board index can be a plain sorted scan in either direction.
  rank_value     INTEGER NOT NULL,
  time_ms        INTEGER NOT NULL,
  points         INTEGER NOT NULL,
  grade          TEXT    NOT NULL DEFAULT '',
  assist         REAL    NOT NULL DEFAULT 0,
  tick_count     INTEGER NOT NULL DEFAULT 0,

  -- Gzipped, delta-encoded input stream. A ~90s run is a few KB, small enough
  -- to keep for every row rather than only the top ones. Nullable: a score is
  -- still valid without one.
  replay         BLOB,

  created_at     INTEGER NOT NULL
);

-- Covers the only two queries that exist: read a board in rank order, and
-- count how many rows beat a given value on that board.
CREATE INDEX IF NOT EXISTS idx_scores_board
  ON scores (route_id, route_version, mode, car_class, sim_version, rank_value);

-- Used by the retention sweep to find the oldest rows outside the top N.
CREATE INDEX IF NOT EXISTS idx_scores_created
  ON scores (created_at);
