-- Boards can now be read for one car as well as for every car together.
--
-- The existing board index leads with route, version, mode and sim version, so
-- a per-car read still uses it and then filters; at a few thousand rows that is
-- already fast. This index puts car_id in the key so the per-car board is read
-- straight off it, which keeps it fast as the table grows.

CREATE INDEX IF NOT EXISTS idx_scores_board_car
  ON scores (route_id, route_version, mode, sim_version, car_id, rank_value);
