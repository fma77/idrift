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
 * Names, looks and colours are the owner's.
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
  /** Their name on the dark race display: the main colour, unless that is too dark to read there. */
  accent: string;
  /** Square portrait, on its own painted background. */
  bust?: string;
}

export const CHARACTERS: Character[] = [
  {
    id: 'rookie',
    name: 'KENJI',
    tier: 'Rookie',
    skill: 0.6,
    level: 1,
    colours: { primary: '#1f52e0', secondary: '#ffffff' },
    accent: '#4f7dff',
    bust: 'art/rivals/rookie.webp',
  },
  {
    id: 'street',
    name: 'NORICK',
    tier: 'Street Drifter',
    skill: 0.8,
    level: 2,
    colours: { primary: '#d8232a', secondary: '#ffffff' },
    accent: '#ff4a4f',
    bust: 'art/rivals/street.webp',
  },
  {
    id: 'pro',
    name: 'TAKA',
    tier: 'Pro Drifter',
    skill: 0.9,
    level: 3,
    colours: { primary: '#161616', secondary: '#d8232a' },
    accent: '#ff4a4f',
    bust: 'art/rivals/pro.webp',
  },
  {
    id: 'king',
    name: 'DK',
    tier: 'Drift King',
    skill: 1.0,
    level: 4,
    colours: { primary: '#139a45', secondary: '#141414' },
    accent: '#2fcf6a',
    bust: 'art/rivals/king.webp',
  },
];

export const DEFAULT_CHARACTER: CharacterId = 'street';

export function characterById(id: string): Character {
  for (const c of CHARACTERS) if (c.id === id) return c;
  return CHARACTERS[1];
}
