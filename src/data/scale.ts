/**
 * The game world is the real world at 60%: roads are baked at this scale, so
 * distances are shown to the player in real units by dividing by it.
 */
export const WORLD_SCALE = 0.6;

/**
 * Cars move PACE times faster than true scale would have them. At exactly
 * 60% of their real speeds a lap took as long as on the real road, and that
 * felt slow. Speeds and 0-100 times are still shown as the real cars' --
 * readouts divide by both factors -- so the one thing that no longer lines up
 * is time: at a shown 100km/h the car covers real distance PACE times faster
 * than a real one would, and laps take about 1/PACE of the real time.
 */
export const PACE = 1.2;

/** Game m/s to the real km/h shown on the speedometer and in the garage. */
export function realKmh(gameMetresPerSecond: number): number {
  return (gameMetresPerSecond * 3.6) / (WORLD_SCALE * PACE);
}

/** Real km/h to game m/s. */
export function gameSpeed(realKmhValue: number): number {
  return (realKmhValue / 3.6) * WORLD_SCALE * PACE;
}
