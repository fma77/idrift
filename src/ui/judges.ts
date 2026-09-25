import { tandemScore, type TandemSide } from '../sim/tandem.ts';

/**
 * A word from the judges: one line per tandem run, saying who took it and why
 * -- the biggest thing the loser's run lost points to, with what it cost.
 *
 *   Run 1 to DK: you sat about 2.1 car lengths back (−14), against DK's near-perfect lead.
 *
 * Everything comes from the judging itself (TandemSide's lost* and penalty
 * counts), so the reason given is the one the score was actually made of.
 */

/** Points lost below which a run is called near-perfect. */
const NEAR_PERFECT = 8;
/** Points lost below which the loser did nothing wrong worth naming. */
const NOTHING_IN_IT = 3;

interface Driver {
  side: TandemSide;
  /** "you" or the opponent's name, as the subject of a sentence. */
  subject: string;
  /** "your" or "DK's". */
  possessive: string;
  /** "yours" or "DK's", standing alone. */
  standalone: string;
}

function driver(side: TandemSide, name: string | null): Driver {
  return name === null
    ? { side, subject: 'you', possessive: 'your', standalone: 'yours' }
    : { side, subject: name, possessive: `${name}'s`, standalone: `${name}'s` };
}

function times(n: number): string {
  return n === 1 ? '' : n === 2 ? ' twice' : ` ${n} times`;
}

/** What cost this driver the most points, as a clause with its cost; null if nothing much did. */
export function biggestLoss(d: Driver, other: Driver): string | null {
  const s = d.side;
  const ticks = Math.max(1, s.zoneTicks);
  const points = (lost: number) => Math.round((100 * lost) / ticks);
  const reasons: [number, string][] = [];
  if (s.role === 'lead') {
    reasons.push([points(s.lostDrift), `${d.subject} straightened up in the bends`]);
    reasons.push([points(s.lostAngle), `${d.subject} ran short of full angle`]);
  } else {
    const gap = (s.gapSum / ticks).toFixed(1);
    reasons.push([points(s.lostGap), `${d.subject} sat about ${gap} car lengths back`]);
    reasons.push([points(s.lostMatch), `${d.possessive} angle didn't match ${other.standalone}`]);
    reasons.push([points(s.lostDrift), `${d.subject} straightened up while ${other.subject} was still sideways`]);
  }
  // The penalties, at what the judging charges for each (see sim/tandem.ts).
  reasons.push([15 * s.spins, `${d.subject} spun${times(s.spins)}`]);
  reasons.push([10 * s.walls, `${d.subject} hit the wall${times(s.walls)}`]);
  reasons.push([10 * s.contacts, `${d.subject} tagged ${other.subject}${times(s.contacts)}`]);
  reasons.push([15 * s.passes, `${d.subject} passed ${other.subject}${times(s.passes)}`]);

  let best = reasons[0];
  for (const r of reasons) if (r[0] > best[0]) best = r;
  return best[0] < NOTHING_IN_IT ? null : `${best[1]} (−${best[0]})`;
}

/**
 * The judges' line on one run: who took it, and why.
 * `title` is "Run 1", "Run 2" or "The chase"; `name` the opponent's.
 */
export function runVerdict(title: string, name: string, you: TandemSide, them: TandemSide): string {
  const yours = tandemScore(you);
  const theirs = tandemScore(them);
  const me = driver(you, null);
  const other = driver(them, name);
  if (yours === theirs) {
    return `${title} level at ${yours}: nothing between you.`;
  }
  const [winner, loser] = yours > theirs ? [me, other] : [other, me];
  const head = `${title} to ${winner === me ? 'you' : name}`;
  const why = biggestLoss(loser, winner);
  if (why === null) return `${head} by a hair: both runs close to perfect.`;
  const role = winner.side.role === 'lead' ? 'lead' : 'chase';
  const praise = 100 - tandemScore(winner.side) <= NEAR_PERFECT ? `, against ${winner.possessive} near-perfect ${role}` : '';
  return `${head}: ${why}${praise}.`;
}
