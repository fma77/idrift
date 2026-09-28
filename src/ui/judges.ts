import { tandemScore, type TandemSide } from '../sim/tandem.ts';

/**
 * A word from the judges: a line per tandem run saying who took it and why --
 * the biggest thing the loser's run lost points to, with what it cost -- and
 * every incident that cost points besides, whoever it was:
 *
 *   Run 1 to DK: you sat about 2.1 car lengths back (−14), against DK's near-perfect lead.
 *   Run 2 to you: DK knocked you into a spin (−10). Also: you hit the wall (−10).
 *
 * Then, around One More Time, where the battle stands: why it was too close to
 * split, and what the earlier round had finished at.
 *
 * Everything comes from the judging itself (TandemSide's lost* and penalty
 * counts), so the reason given is the one the score was actually made of.
 */

/** Points lost below which a run is called near-perfect. */
const NEAR_PERFECT = 8;
/** Points lost below which the loser did nothing wrong worth naming. */
const NOTHING_IN_IT = 3;
/** The most incidents listed after a run's main reason. */
const MAX_INCIDENTS = 3;

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

/** Something that cost points: what it cost, and the clause that says so. */
interface Reason {
  points: number;
  text: string;
  /** A penalty (a spin, a hit...) rather than a shortfall in the driving itself. */
  incident: boolean;
}

/** The penalties a driver ran up, at what the judging charges for each (see sim/tandem.ts). */
function incidents(d: Driver, other: Driver): Reason[] {
  const s = d.side;
  const crashes = s.contacts - s.knocks;
  const list: Reason[] = [
    { points: 10 * s.knocks, text: `${d.subject} knocked ${other.subject} into a spin${times(s.knocks)}`, incident: true },
    { points: 10 * crashes, text: `${d.subject} crashed into ${other.subject}${times(crashes)}`, incident: true },
    { points: 15 * s.spins, text: `${d.subject} spun${times(s.spins)}`, incident: true },
    { points: 10 * s.walls, text: `${d.subject} hit the wall${times(s.walls)}`, incident: true },
    { points: 15 * s.passes, text: `${d.subject} passed ${other.subject}${times(s.passes)}`, incident: true },
  ];
  return list.filter((r) => r.points > 0);
}

/** What cost this driver the most points; null if nothing much did. */
function biggestLoss(d: Driver, other: Driver): Reason | null {
  const s = d.side;
  const ticks = Math.max(1, s.zoneTicks);
  const points = (lost: number) => Math.round((100 * lost) / ticks);
  const reasons: Reason[] = [];
  const add = (lost: number, text: string) => reasons.push({ points: points(lost), text, incident: false });
  if (s.role === 'lead') {
    add(s.lostDrift, `${d.subject} straightened up in the bends`);
    add(s.lostAngle, `${d.subject} ran short of full angle`);
  } else {
    add(s.lostGap, `${d.subject} sat about ${(s.gapSum / ticks).toFixed(1)} car lengths back`);
    add(s.lostMatch, `${d.possessive} angle didn't match ${other.standalone}`);
    add(s.lostDrift, `${d.subject} straightened up while ${other.subject} was still sideways`);
  }
  reasons.push(...incidents(d, other));
  let best = reasons[0];
  for (const r of reasons) if (r.points > best.points) best = r;
  return best.points < NOTHING_IN_IT ? null : best;
}

const cost = (r: Reason) => `${r.text} (−${r.points})`;

/**
 * The judges' line on one run: who took it, and why; then any other incident.
 * `title` is "Run 1", "OMT run 2", "The chase"...; `name` the opponent's.
 */
export function runVerdict(title: string, name: string, you: TandemSide, them: TandemSide): string {
  const yours = tandemScore(you);
  const theirs = tandemScore(them);
  const me = driver(you, null);
  const other = driver(them, name);

  let line: string;
  let named: Reason | null = null;
  if (yours === theirs) {
    line = `${title} level at ${yours}: nothing between you.`;
  } else {
    const [winner, loser] = yours > theirs ? [me, other] : [other, me];
    const head = `${title} to ${winner === me ? 'you' : name}`;
    named = biggestLoss(loser, winner);
    if (named === null) {
      line = `${head} by a hair: both runs close to perfect.`;
    } else {
      const role = winner.side.role === 'lead' ? 'lead' : 'chase';
      const praise = 100 - tandemScore(winner.side) <= NEAR_PERFECT ? `, against ${winner.possessive} near-perfect ${role}` : '';
      line = `${head}: ${cost(named)}${praise}.`;
    }
  }

  // The rest of what cost points, either driver: decisive moments are worth a mention.
  const rest = [...incidents(me, other), ...incidents(other, me)]
    .filter((r) => r.text !== named?.text)
    .sort((a, b) => b.points - a.points)
    .slice(0, MAX_INCIDENTS);
  if (rest.length > 0) line += ` Also: ${rest.map(cost).join('; ')}.`;
  return line;
}

/** A tandem battle as far as the judges need it. */
export interface JudgedBattle {
  kind: 'house' | 'chase';
  name: string;
  /** One-more-time rounds so far. */
  omt: number;
  /** This round's runs, so far: [run 1, run 2]. */
  runs: { you: TandemSide; them: TandemSide }[];
  outcome?: 'win' | 'loss' | 'omt';
  /** The totals of each earlier round that went to One More Time, [yours, theirs]. */
  rounds: [number, number][];
}

/** Why a round went to One More Time: where each driver made their points, and how little was left between them. */
function tooCloseToSplit(b: JudgedBattle): string {
  const [r1, r2] = b.runs;
  const chase = tandemScore(r1.you) - tandemScore(r1.them);
  const lead = tandemScore(r2.you) - tandemScore(r2.them);
  if (chase < 0 && lead > 0) {
    return `What you gave away chasing (${-chase}), you won back leading (${lead}): too close to split.`;
  }
  if (chase > 0 && lead < 0) {
    return `What you won chasing (${chase}), ${b.name} won back leading (${-lead}): too close to split.`;
  }
  const yours = tandemScore(r1.you) + tandemScore(r2.you);
  const theirs = tandemScore(r1.them) + tandemScore(r2.them);
  return `${yours}–${theirs} over two runs: nothing the judges could split.`;
}

function ordinal(n: number): string {
  return n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`;
}

/** The judges' word on the battle so far: a line per run, and where One More Time stands. */
export function battleVerdict(b: JudgedBattle): string[] {
  const lines: string[] = [];
  const last = b.rounds[b.rounds.length - 1];
  // In a rerun, and not yet decided: remind what the last round finished at.
  if (b.omt > 0 && last && !b.outcome) {
    lines.push(`One More Time: the last round finished ${last[0]}–${last[1]}, too close to call. This one starts from zero.`);
  }
  b.runs.forEach((r, i) => {
    const title = b.kind === 'chase' ? 'The chase' : `${b.omt > 0 ? 'OMT run' : 'Run'} ${i + 1}`;
    lines.push(runVerdict(title, b.name, r.you, r.them));
  });
  if (b.outcome === 'omt' && b.runs.length === 2) lines.push(tooCloseToSplit(b));
  if ((b.outcome === 'win' || b.outcome === 'loss') && b.omt > 0 && last) {
    lines.push(`Settled at the ${ordinal(b.omt)} One More Time, after ${last[0]}–${last[1]} the round before.`);
  }
  return lines;
}
