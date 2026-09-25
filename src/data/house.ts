/**
 * The house drivers: the computer opponent in each route's tandem battles.
 *
 * A house driver always drives the same car as the player. With the cars
 * matched, a battle is decided by driving, not by picking the faster car --
 * which a computer chaser in a slower car could never keep up with anyway.
 *
 * Skill (0..1) is how close to the limit it runs its angle, how quickly it
 * answers the leader's changes of side, and how tight a gap it chases at.
 */
export interface HouseDriver {
  name: string;
  skill: number;
}

const DRIVERS: { routes: string[]; driver: HouseDriver }[] = [
  { routes: ['akari-downhill'], driver: { name: 'KENJI', skill: 0.8 } },
  { routes: ['estoril'], driver: { name: 'RUI', skill: 0.8 } },
  { routes: ['nurburg'], driver: { name: 'LENA', skill: 0.8 } },
  {
    routes: ['haruna-upper', 'haruna-middle', 'haruna-lower', 'haruna-downhill'],
    driver: { name: 'TAKA', skill: 0.8 },
  },
];

export function houseDriver(routeId: string): HouseDriver {
  for (const entry of DRIVERS) {
    if (entry.routes.includes(routeId)) return entry.driver;
  }
  return { name: 'HOUSE', skill: 0.8 };
}
