/**
 * The game world is the real world at 60%: roads are baked at this scale, and
 * cars move at this fraction of their real speeds, so a lap takes as long as
 * it would on the real road. Distances and speeds are shown to the player in
 * real units by dividing by it.
 */
export const WORLD_SCALE = 0.6;

/** Game m/s to the real km/h shown on the speedometer and in the garage. */
export function realKmh(gameMetresPerSecond: number): number {
  return (gameMetresPerSecond * 3.6) / WORLD_SCALE;
}

/** Real km/h to game m/s. */
export function gameSpeed(realKmhValue: number): number {
  return (realKmhValue / 3.6) * WORLD_SCALE;
}
