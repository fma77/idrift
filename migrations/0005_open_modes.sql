-- Boards are no longer listed in the database. The worker checks a
-- submission's mode against shared/api.ts, so a new board -- one per tandem
-- opponent now -- needs no schema change. Rebuilt without the CHECK, every row
-- copied across unchanged.

CREATE TABLE scores_new (
  id             TEXT    PRIMARY KEY,
  route_id       TEXT    NOT NULL,
  route_version  INTEGER NOT NULL,
  mode           TEXT    NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_scores_board_car
  ON scores (route_id, route_version, mode, sim_version, car_id, rank_value);

CREATE INDEX IF NOT EXISTS idx_scores_created
  ON scores (created_at);
