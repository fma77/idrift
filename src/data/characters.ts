/**
 * The house drivers: the four characters a tandem battle can be fought
 * against, from Rookie to Drift King. Any of them, on any route.
 *
 * A character always drives the same car as the player, in its own colours.
 * With the cars matched, a battle is decided by driving -- and the colours are
 * how the player tells the two cars apart.
 *
 * Skill (0.6..1.0) is what sets them apart: how close to the limit they run
 * their angle, how early and how hard they throw the car in, how tight they
 * chase, how fast they answer a change of side (see skillOf in sim/tandem.ts).
 *
 * Names, colours and art are provisional until the owner's arrive.
 */
export type CharacterId = 'rookie' | 'street' | 'pro' | 'king';

export interface Character {
  id: CharacterId;
  name: string;
  /** Their rank, shown under the name. */
  tier: string;
  skill: number;
  /** 1..4, for the difficulty pips. */
  level: number;
  /** Their car and suit: the main colour, and the stripes. */
  colours: { primary: string; secondary: string };
  /** Head-and-shoulders art, square, transparent. A placeholder until supplied. */
  bust?: string;
}

export const CHARACTERS: Character[] = [
  { id: 'rookie', name: 'MIKA', tier: 'Rookie', skill: 0.6, level: 1, colours: { primary: '#3fa9f5', secondary: '#ffffff' } },
  { id: 'street', name: 'KENJI', tier: 'Street Drifter', skill: 0.8, level: 2, colours: { primary: '#e8402a', secondary: '#141414' } },
  { id: 'pro', name: 'LENA', tier: 'Pro Drifter', skill: 0.9, level: 3, colours: { primary: '#f2c230', secondary: '#141414' } },
  { id: 'king', name: 'TAKA', tier: 'Drift King', skill: 1.0, level: 4, colours: { primary: '#6a3fd6', secondary: '#f2c230' } },
];

export const DEFAULT_CHARACTER: CharacterId = 'street';

export function characterById(id: string): Character {
  for (const c of CHARACTERS) if (c.id === id) return c;
  return CHARACTERS[1];
}
