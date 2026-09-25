import { createSimState, stepSim } from './index.ts';
import { InputRecorder, dequantiseInput, type QuantisedInput } from './replay.ts';
import { TICKS_PER_INPUT, DT } from './version.ts';
import { cos, sin, clamp } from './math/trig.ts';
import { findZone } from './model/score.ts';
import { upcomingCornerSign } from './model/throttleDrift.ts';
import { updateProgress } from './model/progress.ts';
import { SWEET_SPOT } from './types.ts';
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
  /** Touching last tick: one contact is one touch, however long it lasts. */
  touching: boolean;
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
const REFERENCE_SPEED = 25;

// Penalties, in points out of 100.
const SPIN_PENALTY = 15;
const WALL_PENALTY = 10;
const CONTACT_PENALTY = 10;
const PASS_PENALTY = 15;
/** Seconds after a contact before another counts. */
const CONTACT_COOLDOWN = 0.6;

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
  return { role, zoneTicks: 0, qualitySum: 0, penalty: 0, spins: 0, walls: 0, contacts: 0, passes: 0 };
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
    touching: false,
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

/** Seconds of drift button for a full flick. */
const BOT_FLICK_HOLD = 0.22;

function driveBot(t: TandemState, s: SimState, route: RouteData, config: SimConfig, skill: number): void {
  // Throw it in before a corner; switch sides for the next one.
  const next = upcomingCornerSign(s, route, 24);
  let tap = false;
  if (s.driftDir === 0 && s.spinTicks === 0 && next !== 0 && s.speed > 10) tap = true;
  if (s.driftDir !== 0 && next === -s.driftDir) tap = true;
  if (tap && t.botHold === 0 && !s.initiateHeld) t.botHold = Math.round(BOT_FLICK_HOLD / DT);
  // Balance the angle with the throttle, just under the limit -- a better
  // driver runs closer to it.
  const margin = 0.1 + (1 - skill) * 0.15;
  const hold = s.driftDir === 0 || (upcomingCornerSign(s, route, 40) !== 0 && s.driftAngle < config.drift.limitAngle - margin);
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
  const react = Math.round((0.12 + (1 - skill) * 0.3) / DT);
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
    t.botHold = Math.round(BOT_FLICK_HOLD / DT);
  }
  // Hold the gap: mirror the leader's throttle, open it up when dropping
  // back, close it off when too close. A better chaser runs tighter.
  const target = (0.4 + (1 - skill) * 1.0) * CAR_LENGTH;
  let throttle = lead.throttle + 0.06 * (gap - target) + 0.12 * (lead.speed - s.speed);
  // The leader has straightened: so does the chaser, to follow it out.
  if (lead.driftDir === 0 && s.driftDir !== 0) throttle = 0;
  if (s.driftDir !== 0 && s.driftAngle > config.drift.limitAngle - 0.06) throttle = Math.min(throttle, 0.3);
  if (gapL < 0.2) throttle = 0;
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
  const full = config.drift.limitAngle - SWEET_SPOT;
  const angle = clamp(s.driftAngle / full, 0, 1);
  const speed = clamp(s.speed / REFERENCE_SPEED, 0, 1);
  return angle * (0.7 + 0.3 * speed);
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
  t.angleMatch = t.sameSide ? clamp(1 - Math.abs(aC - aL) / 0.6, 0, 1) : 0;

  // Leader: judged through its own zones.
  if (!lead.finished && findZone(route, lead.sampleIndex) >= 0) {
    leadSide.zoneTicks++;
    leadSide.qualitySum += leadQuality(lead, config);
  }
  // Chaser: judged through its zones, against the leader.
  const zone = findZone(route, chase.sampleIndex);
  if (!chase.finished && zone >= 0) {
    chaseSide.zoneTicks++;
    if (drifting(chase)) chaseSide.qualitySum += proximity(t.gapLengths) * (0.35 + 0.65 * t.angleMatch);
    // Passing the leader in a zone.
    if (t.gapLengths < -1.5 && t.passedZone !== zone) {
      t.passedZone = zone;
      chaseSide.passes++;
      chaseSide.penalty += PASS_PENALTY;
    }
  }

  // Contact: the chaser's to avoid.
  t.contactThisTick = false;
  const touchingNow = touching(player, t.partner);
  const newTouch = touchingNow && !t.touching;
  t.touching = touchingNow;
  if (t.contactCooldown > 0) t.contactCooldown--;
  else if (newTouch) {
    t.contactThisTick = true;
    t.contactCooldown = Math.round(CONTACT_COOLDOWN / DT);
    chaseSide.contacts++;
    chaseSide.penalty += CONTACT_PENALTY;
  }

  // Spins and walls, each driver's own.
  const playerSide = t.player;
  const other = t.opponent;
  if (player.drift.spins > t.playerSpinsSeen) {
    playerSide.spins += player.drift.spins - t.playerSpinsSeen;
    playerSide.penalty += SPIN_PENALTY * (player.drift.spins - t.playerSpinsSeen);
    t.playerSpinsSeen = player.drift.spins;
  }
  if (player.wallHits > t.playerWallsSeen) {
    playerSide.walls += player.wallHits - t.playerWallsSeen;
    playerSide.penalty += WALL_PENALTY * (player.wallHits - t.playerWallsSeen);
    t.playerWallsSeen = player.wallHits;
  }
  const p = t.partner;
  if (p.drift.spins > t.partnerSpinsSeen) {
    other.spins += p.drift.spins - t.partnerSpinsSeen;
    other.penalty += SPIN_PENALTY * (p.drift.spins - t.partnerSpinsSeen);
    t.partnerSpinsSeen = p.drift.spins;
  }
  if (p.wallHits > t.partnerWallsSeen) {
    other.walls += p.wallHits - t.partnerWallsSeen;
    other.penalty += WALL_PENALTY * (p.wallHits - t.partnerWallsSeen);
    t.partnerWallsSeen = p.wallHits;
  }
}

/**
 * Whether the two cars overlap: each is three discs along its length, as wide
 * as the car. Close enough for a top-down game, and cheap.
 */
function touching(a: SimState, b: SimState): boolean {
  if (a.finished || b.finished) return false;
  const reach = CAR_LENGTH * 2;
  const dx0 = a.x - b.x;
  const dy0 = a.y - b.y;
  if (dx0 * dx0 + dy0 * dy0 > reach * reach) return false;
  const r = 0.85;
  const along = CAR_LENGTH * 0.32;
  const ca = cos(a.heading);
  const sa = sin(a.heading);
  const cb = cos(b.heading);
  const sb = sin(b.heading);
  for (let i = -1; i <= 1; i++) {
    const ax = a.x + ca * along * i;
    const ay = a.y + sa * along * i;
    for (let j = -1; j <= 1; j++) {
      const dx = ax - (b.x + cb * along * j);
      const dy = ay - (b.y + sb * along * j);
      if (dx * dx + dy * dy < (2 * r) * (2 * r)) return true;
    }
  }
  return false;
}
