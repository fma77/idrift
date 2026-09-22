-- Time Attack on pedals ('timeAttackPro') gets its own boards.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt:
-- same columns, the mode list widened, every row copied across unchanged.
--
-- The board index also drops car_class: boards are read and ranked across all
-- cars now, so the index follows the query.

CREATE TABLE scores_new (
  id             TEXT    PRIMARY KEY,
  route_id       TEXT    NOT NULL,
  route_version  INTEGER NOT NULL,
  mode           TEXT    NOT NULL CHECK (mode IN ('timeAttack', 'timeAttackPro', 'driftRun')),
  car_class      TEXT    NOT NULL,
  sim_version    INTEGER NOT NULL,

  player_name    TEXT    NOT NULL,
  car_id         TEXT    NOT NULL,

  rank_value     INTEGER NOT NULL,
  time_ms        INTEGER NOT NULL,
  points         INTEGER NOT NULL,
  grade          TEXT    NOT NULL DEFAULT '',
  assist         REAL    NOT NULL DEFAULT 0,
  tick_count     INTEGER NOT NULL DEFAULT 0,

  replay         BLOB,

  created_at     INTEGER NOT NULL
);

INSERT INTO scores_new (
  id, route_id, route_version, mode, car_class, sim_version,
  player_name, car_id, rank_value, time_ms, points, grade,
  assist, tick_count, replay, created_at
)
SELECT
  id, route_id, route_version, mode, car_class, sim_version,
  player_name, car_id, rank_value, time_ms, points, grade,
  assist, tick_count, replay, created_at
FROM scores;

DROP TABLE scores;
ALTER TABLE scores_new RENAME TO scores;

CREATE INDEX IF NOT EXISTS idx_scores_board
  ON scores (route_id, route_version, mode, sim_version, rank_value);

CREATE INDEX IF NOT EXISTS idx_scores_created
  ON scores (created_at);
