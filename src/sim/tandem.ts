import { createSimState, stepSim } from './index.ts';
import { InputRecorder, dequantiseInput, type QuantisedInput } from './replay.ts';
import { TICKS_PER_INPUT, DT } from './version.ts';
import { cos, sin, clamp } from './math/trig.ts';
import { findZone } from './model/score.ts';
import { upcomingCornerSign } from './model/throttleDrift.ts';
import { updateProgress } from './model/progress.ts';
import type { CarParams, RouteData, SimConfig, SimInput, SimState } from './types.ts';

/**
 * Tandem: two cars through the same drift zones, one leading and one chasing.
 *
 * Both cars run in the one deterministic sim, stepped together each tick, so a
 * tandem run replays exactly from the player's inputs alone: the opponent is
 * either a recorded run or a computer driver whose every decision is a pure
 * function of the two cars' states. Nothing here reads a clock or a random
 * number.
 *
 * The chasing car -- whichever it is -- is steered onto the leader's line, a
 * little to the inside. In Drift Run the game steers anyway; what the chaser
 * controls is what a real chase driver controls: throttle and angle, and so
 * the gap.
 *
 * Judging, per run and per driver, out of 100:
 *
 *   Lead:  angle and speed through the zones -- the leader sets the standard.
 *   Chase: how close (ideally within one to two car lengths), how well the
 *          angle matches the leader's, and on the same side.
 *
 * Each is the average over the ticks the car spends in drift zones, less
 * penalties: a spin, a wall, contact (the chaser's), or passing in a zone.
 */

export type TandemRole = 'lead' | 'chase';

/** Who drives the other car. */
export type PartnerDriver =
  | { kind: 'leadBot'; skill: number }
  | { kind: 'chaseBot'; skill: number }
  | { kind: 'replay'; inputs: InputRecorder };

/** One driver's judging so far. */
export interface TandemSide {
  role: TandemRole;
  /** Ticks spent in drift zones, and the quality accumulated over them. */
  zoneTicks: number;
  qualitySum: number;
  penalty: number;
  spins: number;
  walls: number;
  contacts: number;
  passes: number;
  /**
   * Where the points went, for the judges' words -- not part of the score.
   * Quality lost per judged tick, summed, by cause: not sideways at all, short
   * of full angle (a leader), too far back and not matching the leader's angle
   * (a chaser). With qualitySum they add up to zoneTicks.
   */
  lostDrift: number;
  lostAngle: number;
  lostGap: number;
  lostMatch: number;
  /** A chaser's bumper gap summed over its judged ticks, car lengths (0..6 each). */
  gapSum: number;
}

export interface TandemState {
  partner: SimState;
  partnerCar: CarParams;
  playerRole: TandemRole;
  driver: PartnerDriver;

  // --- The computer driver's memory ---
  botThrottle: number;
  /** Ticks left holding the drift button. */
  botHold: number;
  /** Chase driver: the leader's side it last saw, and ticks since it changed. */
  seenLeaderDir: number;
  sinceLeaderChange: number;

  // --- Live readouts, for the HUD ---
  /**
   * The gap between the leader's back bumper and the chaser's front one, in
   * car lengths, as a judge would see it. Zero is touching; negative, the
   * chaser is alongside or ahead.
   */
  gapLengths: number;
  /** 0..1: how closely the chaser's angle matches the leader's. */
  angleMatch: number;
  /** Both cars sideways the same way. */
  sameSide: boolean;
  /** The two cars touched this tick (counted once per contact). */
  contactThisTick: boolean;
  contactCooldown: number;
  /** How hard the cars hit each other this tick, m/s of closing speed; 0 if they did not. */
  impact: number;
  /** Ticks since the cars last touched: a leader spun by the chaser is not blamed for it. */
  sinceContact: number;
  /** The zone in which a pass was last penalised, so one pass costs once. */
  passedZone: number;
  /** Walls and spins already counted, per car. */
  playerSpinsSeen: number;
  playerWallsSeen: number;
  partnerSpinsSeen: number;
  partnerWallsSeen: number;

  player: TandemSide;
  opponent: TandemSide;
}

/** A "car length" for the gap readout, metres. */
export const CAR_LENGTH = 4.6;
/** How far inside the leader's line the chaser is steered, metres. */
const INSIDE = 1.1;
/** The chaser only follows the leader's line within this distance of it. */
const FOLLOW_RANGE = 60;
/** m/s below which a car is not drifting, whatever its angle. */
const MIN_SPEED = 8;
/** m/s of drift worth full marks for speed. */
const REFERENCE_SPEED = 20;
/** Curvature past which the road under a car is a bend (a 90m radius). */
const BEND = 1 / 90;

function inBend(route: RouteData, i: number): boolean {
  const k = route.samples.curvature[i];
  return k > BEND || k < -BEND;
}
/** Radians under the limit angle at which a leader's angle earns full marks. */
const LEAD_FULL_MARGIN = 0.04;

// Penalties, in points out of 100.
const SPIN_PENALTY = 15;
const WALL_PENALTY = 10;
const CONTACT_PENALTY = 10;
const PASS_PENALTY = 15;
/** Seconds after a contact before another counts. */
const CONTACT_COOLDOWN = 0.6;
/** m/s of closing speed below which cars merely brush, without a penalty. */
const CONTACT_MIN = 0.3;
/** Seconds after contact in which a leader's spin is the chaser's doing. */
const SPIN_FORGIVENESS = 1.5;

/** How far ahead of the chaser the leader starts, centre to centre, metres: a car length of clear road between them. */
export const LEAD_START = 2 * 4.6;

/**
 * Put a car LEAD_START metres up the road. Both cars cannot start on the same
 * spot; the leader starts ahead, the chaser on the line.
 */
export function placeAhead(state: SimState, route: RouteData): void {
  const s = route.samples;
  const j = Math.min(s.x.length - 1, Math.round(LEAD_START / route.sampleSpacing));
  state.x = s.x[j];
  state.y = s.y[j];
  state.heading = s.heading[j];
  state.sampleIndex = j;
  updateProgress(state, route);
}

function side(role: TandemRole): TandemSide {
  return {
    role,
    zoneTicks: 0,
    qualitySum: 0,
    penalty: 0,
    spins: 0,
    walls: 0,
    contacts: 0,
    passes: 0,
    lostDrift: 0,
    lostAngle: 0,
    lostGap: 0,
    lostMatch: 0,
    gapSum: 0,
  };
}

export function createTandem(
  route: RouteData,
  playerRole: TandemRole,
  partnerCar: CarParams,
  driver: PartnerDriver,
): TandemState {
  const partner = createSimState(route, partnerCar);
  if (playerRole === 'chase') placeAhead(partner, route);
  return {
    partner,
    partnerCar,
    playerRole,
    driver,
    botThrottle: 0,
    botHold: 0,
    seenLeaderDir: 0,
    sinceLeaderChange: 0,
    gapLengths: 0,
    angleMatch: 0,
    sameSide: false,
    contactThisTick: false,
    contactCooldown: 0,
    impact: 0,
    sinceContact: 1e9,
    passedZone: -1,
    playerSpinsSeen: 0,
    playerWallsSeen: 0,
    partnerSpinsSeen: 0,
    partnerWallsSeen: 0,
    player: side(playerRole),
    opponent: side(playerRole === 'lead' ? 'chase' : 'lead'),
  };
}

/** A driver's score for the run so far, out of 100. */
export function tandemScore(s: TandemSide): number {
  if (s.zoneTicks === 0) return 0;
  return Math.max(0, Math.round((100 * s.qualitySum) / s.zoneTicks - s.penalty));
}

const partnerIn: SimInput = { steer: 0, throttle: 0, initiate: false };
const playerIn: SimInput = { steer: 0, throttle: 0, initiate: false };
const sample: QuantisedInput = { steer: 0, throttle: 0, flags: 0 };

/**
 * Advance both cars one tick. The player's input is applied as it is, except
 * that a chasing player is steered onto the leader's line.
 */
export function stepTandem(
  t: TandemState,
  player: SimState,
  input: SimInput,
  playerCar: CarParams,
  route: RouteData,
  config: SimConfig,
): void {
  const partner = t.partner;
  const lead = t.playerRole === 'lead' ? player : partner;
  const chase = t.playerRole === 'lead' ? partner : player;

  // The other car's input, decided from where both cars are now.
  drivePartner(t, lead, route, config);

  // The chaser follows the leader's line.
  const line = chaseLine(lead, chase, route);
  playerIn.steer = input.steer;
  playerIn.throttle = input.throttle;
  playerIn.initiate = input.initiate;
  playerIn.brake = input.brake;
  playerIn.line = t.playerRole === 'chase' ? line : undefined;
  partnerIn.line = t.playerRole === 'lead' ? line : undefined;

  stepSim(player, playerIn, playerCar, route, config);
  if (!partner.finished) stepSim(partner, partnerIn, t.partnerCar, route, config);
  closeUpAssist(lead, chase);
  slipstream(lead, chase);
  t.impact = player.finished || partner.finished ? 0 : collide(player, playerCar, partner, t.partnerCar);

  judge(t, player, lead, chase, route, config);
}

/** Bumper gap, in car lengths, inside which the chaser is helped not to run into the leader. */
const ASSIST_GAP = 0.7;

/** Leader's back bumper to chaser's front bumper, along the road, in car lengths. */
export function bumperGap(lead: SimState, chase: SimState): number {
  return (lead.distance - chase.distance - CAR_LENGTH) / CAR_LENGTH;
}

/**
 * Drift Run has no brake: lifting off is the only way to slow, and it is not
 * enough when a leader scrubs speed into a hairpin. Without help a chaser --
 * the player or the computer -- rear-ended the leader in every slow corner,
 * whatever it did. So a chaser closing on the leader within a car length or so
 * sheds speed, the way a driver dabs the brake. Coming in hot still ends in
 * contact; it is simply no longer unavoidable.
 */
function closeUpAssist(lead: SimState, chase: SimState): void {
  if (lead.finished || chase.finished || chase.speed < 1) return;
  const gap = bumperGap(lead, chase);
  const closing = chase.speed - lead.speed;
  if (gap < 0 || gap > ASSIST_GAP || closing <= 0) return;
  const decel = closing * 4 + (ASSIST_GAP - gap) * 4;
  const v = Math.max(lead.speed - 0.5, chase.speed - decel * DT);
  if (v >= chase.speed) return;
  const scale = v / chase.speed;
  chase.vx *= scale;
  chase.vy *= scale;
  chase.speed = v;
}

/** m/s^2 a car tucked in behind gains from the leader's slipstream. */
const SLIPSTREAM = 1.2;

/**
 * Slipstream: a chaser within a few car lengths, not sideways, is pulled along
 * by the hole the leader punches in the air. With the same car on both ends a
 * gap opened in a hairpin could otherwise never be closed on the straight
 * after it; this gives the chaser -- player or computer -- a way back.
 */
function slipstream(lead: SimState, chase: SimState): void {
  if (lead.finished || chase.finished || chase.driftDir !== 0 || chase.speed < 5) return;
  const gap = bumperGap(lead, chase);
  if (gap < 0.3 || gap > 5) return;
  const v = Math.min(chase.speed + SLIPSTREAM * DT, lead.speed + 3);
  if (v <= chase.speed) return;
  const scale = v / chase.speed;
  chase.vx *= scale;
  chase.vy *= scale;
  chase.speed = v;
}

/** The line a chaser should hold: the leader's, a car's width to the inside. Undefined when too far back. */
function chaseLine(lead: SimState, chase: SimState, route: RouteData): number | undefined {
  const behind = lead.distance - chase.distance;
  if (behind < 0 || behind > FOLLOW_RANGE) return undefined;
  const i = chase.sampleIndex;
  const k = route.samples.curvature[i];
  const inside = k > 1 / 90 ? 1 : k < -1 / 90 ? -1 : 0;
  const half = route.samples.halfWidth[i] - 1;
  return clamp(lead.lateralOffset + inside * INSIDE, -half, half);
}

// --- The other driver --------------------------------------------------------

/**
 * What a driver's skill (0.6 Rookie .. 1.0 Drift King) means in practice. Each
 * is drawn straight between the Rookie's and the Drift King's value.
 */
interface Skill {
  /** Radians under the limit angle it holds a drift at: the Rookie's 38 degrees to the King's 53. */
  margin: number;
  /** Metres before a corner it throws the car in: late and hurried, or early and set up. */
  flickAhead: number;
  /** Seconds it holds the drift button: a soft flick, or a full one. */
  flickHold: number;
  /** Bumper gap it chases at, car lengths. */
  gap: number;
  /** Seconds to answer the leader's change of side. */
  react: number;
  /** How hard it steers its angle towards the leader's, chasing. */
  mirror: number;
  /** The share of the throttle it dares to use mid-drift. */
  commit: number;
  /** How well, 0..1, it matches the force of the leader's flick. */
  read: number;
}

function skillOf(skill: number): Skill {
  const k = clamp((skill - 0.6) / 0.4, 0, 1);
  const between = (rookie: number, king: number) => rookie + (king - rookie) * k;
  return {
    margin: between(0.3, 0.035),
    flickAhead: between(13, 27),
    flickHold: between(0.13, 0.24),
    gap: between(2.4, 0.5),
    react: between(0.45, 0.08),
    mirror: between(0.3, 1.0),
    commit: between(0.82, 1),
    read: between(0, 1),
  };
}

function driveBot(t: TandemState, s: SimState, route: RouteData, config: SimConfig, skill: number): void {
  const k = skillOf(skill);
  // Throw it in before a corner; switch sides for the next one.
  const next = upcomingCornerSign(s, route, k.flickAhead);
  let tap = false;
  if (s.driftDir === 0 && s.spinTicks === 0 && next !== 0 && s.speed > 10) tap = true;
  if (s.driftDir !== 0 && next === -s.driftDir) tap = true;
  if (tap && t.botHold === 0 && !s.initiateHeld) t.botHold = Math.round(k.flickHold / DT);
  // Balance the angle with the throttle, under the limit -- a better driver
  // runs closer to it.
  const hold = s.driftDir === 0 || (upcomingCornerSign(s, route, 40) !== 0 && s.driftAngle < config.drift.limitAngle - k.margin);
  rampThrottle(t, hold ? 1 : 0, skill);
}

function driveChaser(
  t: TandemState,
  s: SimState,
  lead: SimState,
  route: RouteData,
  config: SimConfig,
  skill: number,
): void {
  const gapL = bumperGap(lead, s);
  const gap = gapL * CAR_LENGTH;
  // Too far back to chase: drive its own run until it catches up.
  if (gapL > 8 || gapL < -1) {
    driveBot(t, s, route, config, skill);
    return;
  }
  // Follow the leader's changes of side, after a reaction time.
  if (lead.driftDir !== t.seenLeaderDir) {
    t.seenLeaderDir = lead.driftDir;
    t.sinceLeaderChange = 0;
  } else {
    t.sinceLeaderChange++;
  }
  const k = skillOf(skill);
  const react = Math.round(k.react / DT);
  const wantSide = lead.driftDir;
  if (
    wantSide !== 0 &&
    s.driftDir !== wantSide &&
    t.sinceLeaderChange >= react &&
    t.botHold === 0 &&
    !s.initiateHeld &&
    s.spinTicks === 0 &&
    s.speed > 10
  ) {
    // How hard to throw it in: as hard as the leader did. A good chaser reads
    // a soft flick and answers softly; a full flick behind a gentle leader
    // overshot its angle and dropped it back. The Rookie cannot read it, and
    // always flicks the same.
    const leaderSoft = clamp(lead.driftAngle / config.drift.flickAngle, 0.45, 1);
    const hold = k.flickHold * (1 - k.read + k.read * leaderSoft);
    t.botHold = Math.max(1, Math.round(hold / DT));
  }
  // Hold the gap: mirror the leader's throttle, open it up when dropping
  // back, close it off when too close; and steer the angle towards the
  // leader's. A better chaser runs tighter and copies the angle closer.
  const target = k.gap * CAR_LENGTH;
  let throttle = lead.throttle + 0.06 * (gap - target) + 0.12 * (lead.speed - s.speed);
  // Copy the leader's angle, up to what this driver can hold: at its own
  // ceiling it stops asking for more angle, but keeps its power.
  const ceiling = config.drift.limitAngle - k.margin;
  // Falling back, it trades a little angle for speed -- a tenth of a radian
  // per car length too far back -- because closeness counts for more.
  const behind = Math.max(0, gapL - k.gap - 0.3);
  const wanted = Math.min(lead.driftAngle, ceiling) - 0.1 * behind;
  if (s.driftDir !== 0 && lead.driftDir === s.driftDir) throttle += k.mirror * (wanted - s.driftAngle);
  // The leader has straightened: so does the chaser, to follow it out.
  if (lead.driftDir === 0 && s.driftDir !== 0) throttle = 0;
  // A less confident driver holds back mid-drift.
  if (s.driftDir !== 0) throttle *= k.commit;
  // Close to the limit itself, whoever it is, it backs off before it spins.
  if (s.driftDir !== 0 && s.driftAngle > config.drift.limitAngle - 0.03) throttle = Math.min(throttle, 0.3);
  // Right on the leader's bumper it eases off: on grip it lifts, but in a
  // drift lifting kills the angle and the speed with it, so it only trims.
  if (gapL < 0.2) throttle = s.driftDir === 0 ? 0 : Math.min(throttle, lead.throttle * 0.8);
  rampThrottle(t, clamp(throttle, 0, 1), skill);
}

function rampThrottle(t: TandemState, target: number, skill: number): void {
  const rise = (1 / 0.45) * (0.8 + 0.4 * skill) * DT;
  const fall = (1 / 0.3) * DT;
  t.botThrottle = target > t.botThrottle ? Math.min(target, t.botThrottle + rise) : Math.max(target, t.botThrottle - fall);
}

function driveReplay(t: TandemState, inputs: InputRecorder): void {
  const tick = t.partner.tick;
  inputs.at(Math.floor(tick / TICKS_PER_INPUT), sample);
  dequantiseInput(sample, partnerIn);
}

function driveBotInput(t: TandemState): void {
  partnerIn.steer = 0;
  partnerIn.throttle = t.botThrottle;
  partnerIn.initiate = t.botHold > 0;
  partnerIn.brake = false;
  if (t.botHold > 0) t.botHold--;
}

function drivePartner(t: TandemState, lead: SimState, route: RouteData, config: SimConfig): void {
  if (t.partner.finished) return;
  const d = t.driver;
  if (d.kind === 'replay') {
    driveReplay(t, d.inputs);
    return;
  }
  if (d.kind === 'leadBot') driveBot(t, t.partner, route, config, d.skill);
  else driveChaser(t, t.partner, lead, route, config, d.skill);
  driveBotInput(t);
}

// --- Judging -----------------------------------------------------------------

function drifting(s: SimState): boolean {
  return s.driftDir !== 0 && s.spinTicks === 0 && s.speed >= MIN_SPEED;
}

/** How well a leader is drifting this tick, 0..1: angle up to the sweet spot, and speed. */
function leadQuality(s: SimState, config: SimConfig): number {
  if (!drifting(s)) return 0;
  // Full marks only right at the limit: the bravest angle is the best lead.
  // (They came at 40 degrees, which paid a Rookie the same as a Drift King.)
  const full = config.drift.limitAngle - LEAD_FULL_MARGIN;
  const share = clamp(s.driftAngle / full, 0, 1);
  // Steeper than straight: the last few degrees before the limit are the
  // hardest to hold, and worth the most.
  const angle = share * Math.sqrt(share);
  const speed = clamp(s.speed / REFERENCE_SPEED, 0, 1);
  return angle * (0.8 + 0.2 * speed);
}

/**
 * Closeness, 0..1, from the bumper gap in car lengths: full marks within one,
 * falling to a fifth at three, nothing past six. Level with or ahead of the
 * leader earns nothing -- that is passing, not chasing.
 */
export function proximity(gapLengths: number): number {
  if (gapLengths < -0.5) return 0;
  if (gapLengths <= 1) return 1;
  if (gapLengths <= 3) return 1 - 0.8 * ((gapLengths - 1) / 2);
  return Math.max(0, 0.2 * (1 - (gapLengths - 3) / 3));
}

function judge(t: TandemState, player: SimState, lead: SimState, chase: SimState, route: RouteData, config: SimConfig): void {
  const leadSide = t.playerRole === 'lead' ? t.player : t.opponent;
  const chaseSide = t.playerRole === 'lead' ? t.opponent : t.player;

  // Readouts.
  t.gapLengths = bumperGap(lead, chase);
  t.sameSide = lead.driftDir !== 0 && lead.driftDir === chase.driftDir;
  const aL = lead.driftDir !== 0 ? lead.driftAngle : 0;
  const aC = chase.driftDir !== 0 ? chase.driftAngle : 0;
  // Within about ten degrees is a good match; forty apart is none.
  t.angleMatch = t.sameSide ? clamp(1 - Math.abs(aC - aL) / 0.7, 0, 1) : 0;

  // Leader: judged where its zones bend. A zone runs on over the straight
  // between two bends, and counting that as a failure to drift capped even a
  // perfect lead at about 75.
  if (!lead.finished && findZone(route, lead.sampleIndex) >= 0 && inBend(route, lead.sampleIndex)) {
    leadSide.zoneTicks++;
    const q = leadQuality(lead, config);
    leadSide.qualitySum += q;
    if (drifting(lead)) leadSide.lostAngle += 1 - q;
    else leadSide.lostDrift += 1;
  }
  // Chaser: judged through its zones while the leader is drifting -- the chase
  // is judged against the lead, and nobody can be asked to be sideways when
  // the car they are following is not.
  const zone = findZone(route, chase.sampleIndex);
  if (!chase.finished && zone >= 0 && drifting(lead)) {
    chaseSide.zoneTicks++;
    chaseSide.gapSum += clamp(t.gapLengths, 0, 6);
    if (drifting(chase)) {
      const near = proximity(t.gapLengths);
      const match = 0.45 + 0.55 * t.angleMatch;
      chaseSide.qualitySum += near * match;
      chaseSide.lostGap += (1 - near) * match;
      chaseSide.lostMatch += 1 - match;
    } else {
      chaseSide.lostDrift += 1;
    }
  }
  if (!chase.finished && zone >= 0) {
    // Passing the leader in a zone.
    if (t.gapLengths < -1.5 && t.passedZone !== zone) {
      t.passedZone = zone;
      chaseSide.passes++;
      chaseSide.penalty += PASS_PENALTY;
    }
  }

  // Contact: the chaser's to avoid.
  t.contactThisTick = false;
  if (t.impact > 0) t.sinceContact = 0;
  else t.sinceContact++;
  if (t.contactCooldown > 0) t.contactCooldown--;
  else if (t.impact > CONTACT_MIN) {
    t.contactThisTick = true;
    t.contactCooldown = Math.round(CONTACT_COOLDOWN / DT);
    chaseSide.contacts++;
    chaseSide.penalty += CONTACT_PENALTY;
  }

  // Spins and walls, each driver's own -- except a leader spun by the chaser
  // hitting it, which the judges put down to the chaser.
  const playerSide = t.player;
  const other = t.opponent;
  const knocked = t.sinceContact < SPIN_FORGIVENESS / DT;
  if (player.drift.spins > t.playerSpinsSeen) {
    if (!(knocked && t.playerRole === 'lead')) {
      playerSide.spins += player.drift.spins - t.playerSpinsSeen;
      playerSide.penalty += SPIN_PENALTY * (player.drift.spins - t.playerSpinsSeen);
    }
    t.playerSpinsSeen = player.drift.spins;
  }
  if (player.wallHits > t.playerWallsSeen) {
    playerSide.walls += player.wallHits - t.playerWallsSeen;
    playerSide.penalty += WALL_PENALTY * (player.wallHits - t.playerWallsSeen);
    t.playerWallsSeen = player.wallHits;
  }
  const p = t.partner;
  if (p.drift.spins > t.partnerSpinsSeen) {
    if (!(knocked && t.playerRole === 'chase')) {
      other.spins += p.drift.spins - t.partnerSpinsSeen;
      other.penalty += SPIN_PENALTY * (p.drift.spins - t.partnerSpinsSeen);
    }
    t.partnerSpinsSeen = p.drift.spins;
  }
  if (p.wallHits > t.partnerWallsSeen) {
    other.walls += p.wallHits - t.partnerWallsSeen;
    other.penalty += WALL_PENALTY * (p.wallHits - t.partnerWallsSeen);
    t.partnerWallsSeen = p.wallHits;
  }
}

/** How bouncy a car-to-car hit is: 0 dead, 1 elastic. Cars crumple; mostly dead. */
const RESTITUTION = 0.3;
/** How much a hit off-centre twists a car, radians per (metre x m/s). */
const TWIST = 0.035;

/**
 * Two cars hitting each other. Each car is three discs along its length, as
 * wide as the car. Where they overlap, the cars are pushed apart, exchange
 * momentum along the line of the hit (equal masses, mostly dead), and a hit off
 * a car's centre twists it -- so a chaser that runs into the leader's rear
 * quarter can spin it, as it would for real. Returns the closing speed, 0 when
 * they are not touching or already separating.
 */
function collide(a: SimState, carA: CarParams, b: SimState, carB: CarParams): number {
  const reach = (carA.bodyLength + carB.bodyLength) * 0.6;
  const dx0 = a.x - b.x;
  const dy0 = a.y - b.y;
  if (dx0 * dx0 + dy0 * dy0 > reach * reach) return 0;

  const ca = cos(a.heading);
  const sa = sin(a.heading);
  const cb = cos(b.heading);
  const sb = sin(b.heading);
  const alongA = carA.bodyLength * 0.32;
  const alongB = carB.bodyLength * 0.32;
  const reachAB = (carA.bodyWidth + carB.bodyWidth) * 0.47;

  // The deepest overlap between the two cars' discs.
  let depth = 0;
  let nx = 0;
  let ny = 0;
  let cx = 0;
  let cy = 0;
  for (let i = -1; i <= 1; i++) {
    const ax = a.x + ca * alongA * i;
    const ay = a.y + sa * alongA * i;
    for (let j = -1; j <= 1; j++) {
      const bx = b.x + cb * alongB * j;
      const by = b.y + sb * alongB * j;
      const dx = ax - bx;
      const dy = ay - by;
      const d2 = dx * dx + dy * dy;
      if (d2 >= reachAB * reachAB) continue;
      const d = Math.sqrt(d2);
      const pen = reachAB - d;
      if (pen <= depth) continue;
      depth = pen;
      if (d > 1e-6) {
        nx = dx / d;
        ny = dy / d;
      } else {
        const d0 = Math.sqrt(dx0 * dx0 + dy0 * dy0) || 1;
        nx = dx0 / d0;
        ny = dy0 / d0;
      }
      cx = (ax + bx) / 2;
      cy = (ay + by) / 2;
    }
  }
  if (depth === 0) return 0;

  // Apart: half each, along the line of the hit.
  a.x += (nx * depth) / 2;
  a.y += (ny * depth) / 2;
  b.x -= (nx * depth) / 2;
  b.y -= (ny * depth) / 2;

  // Momentum: world velocities from the body frame.
  const awx = a.vx * ca - a.vy * sa;
  const awy = a.vx * sa + a.vy * ca;
  const bwx = b.vx * cb - b.vy * sb;
  const bwy = b.vx * sb + b.vy * cb;
  const closing = (awx - bwx) * nx + (awy - bwy) * ny;
  if (closing >= 0) return 0;
  const j = (-(1 + RESTITUTION) * closing) / 2;
  setWorldVelocity(a, awx + j * nx, awy + j * ny, ca, sa);
  setWorldVelocity(b, bwx - j * nx, bwy - j * ny, cb, sb);

  // Twist: the hit's lever about each car's centre.
  twist(a, (cx - a.x) * (j * ny) - (cy - a.y) * (j * nx));
  twist(b, (cx - b.x) * (-j * ny) - (cy - b.y) * (-j * nx));
  return -closing;
}

function setWorldVelocity(s: SimState, wx: number, wy: number, c: number, sn: number): void {
  s.vx = wx * c + wy * sn;
  s.vy = -wx * sn + wy * c;
  s.speed = Math.sqrt(wx * wx + wy * wy);
}

/**
 * Turn a car by a hit's lever (metres x m/s; positive turns it left). Drifting,
 * the body is placed at the drift angle to its path, so the twist goes into
 * that angle -- past the limit, it spins. On grip it goes into the yaw rate.
 */
function twist(s: SimState, lever: number): void {
  const turn = lever * TWIST;
  if (s.driftDir !== 0) {
    s.driftAngle = Math.max(-0.3, s.driftAngle + s.driftDir * turn);
  } else {
    s.yawRate += turn / 0.25;
  }
}
