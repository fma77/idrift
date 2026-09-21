import { TICK_RATE } from '../sim/version.ts';
import type { RouteData, SimConfig, SimState } from '../sim/types.ts';
import type { DriftGauge } from './driftGauge.ts';
import { holdPhase, HOLD_OVER } from '../sim/model/throttleDrift.ts';

/** Seconds the hold meter spans: past HOLD_OVER, with room to see it overshoot. */
const HOLD_SCALE = HOLD_OVER * 1.6;
const HOLD_WORDS = { soft: 'SOFT', full: 'FULL', over: 'TOO LONG' } as const;

/**
 * HUD, in DOM rather than on the canvas.
 *
 * The design system is heavily typographic -- Bungee display, Work Sans with
 * tabular numerals, square ink panels, hairline rules. Reproducing that in
 * canvas text would mean reimplementing font loading, letter-spacing and safe
 * areas by hand and getting it slightly wrong. DOM gets it exactly right, reads
 * correctly to a screen reader, and the canvas keeps the whole frame budget for
 * the world.
 */

export interface HudElements {
  root: HTMLElement;
  comboLabel: HTMLElement;
  comboValue: HTMLElement;
  scoreLabel: HTMLElement;
  scoreValue: HTMLElement;
  driftLabel: HTMLElement;
  driftValue: HTMLElement;
  speedValue: HTMLElement;
  angleValue: HTMLElement;
  pace: HTMLElement;
  progressFill: HTMLElement;
  progressLabel: HTMLElement;
  flash: HTMLElement;
  /** "+2,340" when a drift ends and its points are banked. */
  bankPop: HTMLElement;
  /** Zones cleared and missed so far, and how many are left. */
  zoneChip: HTMLElement;
  /** Holds one mark per drift zone, laid over the progress bar. */
  zoneMarks: HTMLElement;
  /** Shown in Drift Run with throttle controls only. */
  gauge: DriftGauge;
}

/** Severity 1-6 to a chevron count. Six is a hairpin. */
const SEVERITY_GLYPH = ['', '>', '>>', '>>>', '>>>>', '>>>>>', '>>>>>>'];

export class Hud {
  private lastScore = 0;
  private lastBanked = 0;
  private lastPaceKey = '';
  /** Game metres to real metres, for the distance left: real roads are driven at 60%. */
  private realFactor = 1;
  /** The touch drift pad, filled while the button is held. */
  private driftPad: HTMLElement | null = null;
  private holdWasOn = false;
  private holdTimer = 0;
  private lastZone = -1;
  private lastCleared = 0;
  private zoneTimer = 0;
  private lastTick = 0;
  private zoneRoute: RouteData | null = null;
  /** What became of each zone this run. */
  private zoneResults: ('ahead' | 'in' | 'cleared' | 'missed')[] = [];

  private readonly el: HudElements;

  constructor(el: HudElements) {
    this.el = el;
  }

  /** The scale this route is driven at, so distances read as on the real road. */
  setRealScale(scale: number): void {
    this.realFactor = scale > 0 ? 1 / scale : 1;
  }

  setDriftPad(pad: HTMLElement): void {
    this.driftPad = pad;
  }

  /**
   * How long the drift button is being held, and what that gives: the pad
   * fills and changes colour -- soft, full, too long -- and on release shows
   * the press it got, so the player can learn the timing. Read from the sim,
   * so it is the hold the car actually felt.
   */
  private updateHold(state: SimState): void {
    const on = state.handbrakeOn;
    const seconds = state.handbrakeTicks / TICK_RATE;
    if (!on && !this.holdWasOn) return;
    const phase = holdPhase(seconds);
    const fill = Math.min(1, seconds / HOLD_SCALE);
    const text = on ? `${seconds.toFixed(2)}s` : `${HOLD_WORDS[phase]} · ${seconds.toFixed(2)}s`;

    for (const target of [this.driftPad, this.el.gauge.holdEl]) {
      if (!target) continue;
      target.dataset.hold = phase;
      const bar = target.querySelector('.pedal-meter__fill, .gauge__hold-fill') as HTMLElement | null;
      if (bar) bar.style.width = `${(fill * 100).toFixed(1)}%`;
    }
    const hint = this.driftPad?.querySelector('.pedal-zone__hint');
    if (hint) hint.textContent = text;
    this.el.gauge.holdText(text);

    if (!on && this.holdWasOn) {
      // Let go: keep the result up for a moment, then clear it.
      window.clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => {
        for (const target of [this.driftPad, this.el.gauge.holdEl]) {
          if (!target) continue;
          delete target.dataset.hold;
          const bar = target.querySelector('.pedal-meter__fill, .gauge__hold-fill') as HTMLElement | null;
          if (bar) bar.style.width = '0%';
        }
        const h = this.driftPad?.querySelector('.pedal-zone__hint');
        if (h) h.textContent = 'Tap · hold';
        this.el.gauge.holdText('');
      }, 1300);
    } else if (on) {
      window.clearTimeout(this.holdTimer);
    }
    this.holdWasOn = on;
  }

  /**
   * Update the HUD from sim state.
   *
   * Every value shown here is read from the sim, never recomputed: the number
   * on screen during the run has to be the same number the sim banked, or a
   * replay would disagree with what the player remembers seeing.
   */
  update(state: SimState, route: RouteData, config: SimConfig): void {
    const el = this.el;
    const mode = config.mode;

    // How far through the route, and how much is left. On a 7km pass the
    // difference between "nearly there" and "a third of the way" is the whole
    // shape of a run, and from a top-down view with the road fogged out a few
    // hundred metres ahead there is no other way to tell.
    const remaining = Math.max(0, route.length - state.distance) * this.realFactor;
    el.progressFill.style.width = `${Math.min(100, Math.max(0, (state.distance / route.length) * 100)).toFixed(1)}%`;
    el.progressLabel.textContent =
      remaining >= 1000 ? `${(remaining / 1000).toFixed(1)}km` : `${Math.round(remaining / 10) * 10}m`;
    if (config.controls === 'throttle') {
      this.updateHold(state);
      el.gauge.update(state.driftAngle, state.throttle, state.driftDir !== 0 || state.spinTicks > 0, config.drift);
    }

    el.speedValue.textContent = String(Math.round(state.speed * 3.6));
    // Drift angle in place of the old gear readout: with no gearbox left, the
    // angle is the number that says whether a slide is working.
    el.angleValue.textContent = String(Math.round(Math.min(Math.abs(state.slipAngle), Math.PI / 2) * 57.29578));

    if (mode === 'driftRun') {
      const total = Math.round(state.drift.banked + state.drift.pending);
      el.comboLabel.textContent = 'Combo';
      el.comboValue.textContent = `x${state.drift.multiplier.toFixed(1)}`;
      el.scoreLabel.textContent = 'Score';
      el.scoreValue.textContent = total.toLocaleString('en-GB');
      el.driftLabel.textContent = 'Drift';
      el.driftValue.textContent = `${(state.drift.driftTicks / TICK_RATE).toFixed(1)}s`;

      // Score pop, retriggered by removing and re-adding the class.
      if (total > this.lastScore + 250) {
        el.scoreValue.classList.remove('hud__value--pop');
        void el.scoreValue.offsetWidth;
        el.scoreValue.classList.add('hud__value--pop');
        this.lastScore = total;
      } else if (total < this.lastScore) {
        this.lastScore = total;
      }

      if (state.drift.brokeThisTick) this.flash();

      // A drift ending is a moment, so it gets one: the points it banked, big,
      // for a second. Without it the only sign a drift was over was the combo
      // quietly resetting.
      const banked = Math.round(state.drift.banked);
      if (banked > this.lastBanked) {
        el.bankPop.textContent = `+${(banked - this.lastBanked).toLocaleString('en-GB')}`;
        el.bankPop.classList.remove('bank-pop--show');
        void el.bankPop.offsetWidth;
        el.bankPop.classList.add('bank-pop--show');
      }
      this.lastBanked = banked;
      this.updateZone(state, route);
    } else {
      const seconds = (state.raceTicks + state.penaltyTicks) / TICK_RATE;
      el.comboLabel.textContent = 'Penalty';
      el.comboValue.textContent =
        state.penaltyTicks > 0 ? `+${(state.penaltyTicks / TICK_RATE).toFixed(0)}s` : '--';
      el.scoreLabel.textContent = 'Time';
      el.scoreValue.textContent = formatTime(seconds);
      // Distance left moved to the progress bar; this cell shows what it cost.
      el.driftLabel.textContent = 'Hits';
      el.driftValue.textContent = String(state.wallHits);
      if (state.hitThisTick) this.flash();
    }

    this.updatePace(state, route);
  }

  /**
   * Drift zones, live. Scoring only counts inside them, so the player needs to
   * know when they are in one, whether the last one counted, and how the run
   * stands overall -- a bare "6/11" could be a perfect run so far or three
   * misses. So there are two views:
   *
   * - A mark on the progress bar for every zone, where it is on the route:
   *   hollow ahead, red outline while in it, then filled green (cleared) or red
   *   (missed). The whole run's record at a glance, and what is left.
   * - The zone box: cleared and missed so far, and how many are left, with a
   *   flash of the result on the way out of each one.
   *
   * A zone is cleared by banking any points inside it.
   */
  private updateZone(state: SimState, route: RouteData): void {
    const chip = this.el.zoneChip;
    const d = state.drift;
    const total = route.driftZones.length;

    // A new run, or a different route: start the record again.
    if (state.tick < this.lastTick || route !== this.zoneRoute) {
      this.zoneRoute = route;
      this.lastZone = -1;
      this.lastCleared = 0;
      this.zoneResults = new Array(total).fill('ahead');
      window.clearTimeout(this.zoneTimer);
      chip.dataset.state = '';
      this.buildZoneMarks(route);
    }
    this.lastTick = state.tick;

    const zone = d.inZone ? d.activeZone : -1;
    if (zone !== this.lastZone) {
      window.clearTimeout(this.zoneTimer);
      if (this.lastZone >= 0) {
        const cleared = d.zonesCleared > this.lastCleared;
        this.zoneResults[this.lastZone] = cleared ? 'cleared' : 'missed';
        chip.dataset.state = cleared ? 'cleared' : 'missed';
        this.zoneTimer = window.setTimeout(() => {
          if (chip.dataset.state !== 'in') chip.dataset.state = '';
        }, 1400);
      }
      if (zone >= 0) {
        this.zoneResults[zone] = 'in';
        chip.dataset.state = 'in';
      }
      this.lastZone = zone;
      this.paintZoneMarks();
    }
    this.lastCleared = d.zonesCleared;

    const passed = this.zoneResults.filter((r) => r === 'cleared' || r === 'missed').length;
    const missed = this.zoneResults.filter((r) => r === 'missed').length;
    const left = total - passed;
    (chip.querySelector('.zone-box__cleared') as HTMLElement).textContent = String(d.zonesCleared);
    (chip.querySelector('.zone-box__missed') as HTMLElement).textContent = String(missed);
    const label = chip.querySelector('.hud__unit') as HTMLElement;
    const state_ = chip.dataset.state;
    label.textContent =
      state_ === 'in' ? 'in zone' : state_ === 'cleared' ? 'cleared!' : state_ === 'missed' ? 'missed' : `${left} left`;
  }

  /** One mark per zone on the progress bar, placed and sized as on the route. */
  private buildZoneMarks(route: RouteData): void {
    const host = this.el.zoneMarks;
    const spacing = route.sampleSpacing;
    host.replaceChildren(
      ...route.driftZones.map((z) => {
        const mark = document.createElement('span');
        mark.className = 'zone-mark';
        const from = (z.entryIndex * spacing) / route.length;
        const to = (z.exitIndex * spacing) / route.length;
        mark.style.left = `${(from * 100).toFixed(2)}%`;
        mark.style.width = `${(Math.max(0.012, to - from) * 100).toFixed(2)}%`;
        return mark;
      }),
    );
  }

  private paintZoneMarks(): void {
    const marks = this.el.zoneMarks.children;
    for (let i = 0; i < marks.length; i++) (marks[i] as HTMLElement).dataset.state = this.zoneResults[i] ?? 'ahead';
  }

  /** Combo break / wall contact: a 2-frame red flash, per the design system. */
  private flash(): void {
    this.el.flash.classList.remove('hud--break');
    void this.el.flash.offsetWidth;
    this.el.flash.classList.add('hud--break');
  }

  /**
   * Pace notes.
   *
   * Progressive reveal means the player cannot see round a blind corner, which
   * without this strip would make the first run of a route a memorisation
   * exercise rather than a driving one. Two notes: what you are arriving at,
   * and what follows it.
   */
  private updatePace(state: SimState, route: RouteData): void {
    const spacing = route.sampleSpacing;
    const notes: { sign: number; severity: number; distance: number }[] = [];

    for (let i = 0; i < route.corners.length && notes.length < 2; i++) {
      const corner = route.corners[i];
      // Measure to the corner's entry, not its apex: that is the point the
      // player has to have finished braking by.
      const distance = corner.startIndex * spacing - state.distance;
      if (distance < -12) continue;
      notes.push({ sign: corner.sign, severity: corner.severity, distance: Math.max(0, distance) });
    }

    // Rebuild only when the corner list changes; the distance readout updates
    // in place. Rewriting this subtree every frame would thrash layout.
    const key = notes.map((n) => `${n.sign}:${n.severity}`).join('|');
    if (key !== this.lastPaceKey) {
      this.lastPaceKey = key;
      this.el.pace.replaceChildren(
        ...notes.map((note, index) => {
          const div = document.createElement('div');
          div.className = index === 0 ? 'pace__note pace__note--next' : 'pace__note';

          const arrow = document.createElement('div');
          arrow.className = 'pace__arrow';
          const glyph = SEVERITY_GLYPH[note.severity] || '>';
          arrow.textContent = note.sign > 0 ? mirror(glyph) : glyph;

          const sev = document.createElement('div');
          sev.className = 'pace__sev';
          sev.textContent = `${note.sign > 0 ? 'L' : 'R'}${note.severity}`;

          const dist = document.createElement('div');
          dist.className = 'pace__dist';
          dist.dataset.role = 'dist';

          div.append(arrow, sev, dist);
          return div;
        }),
      );
    }

    const distEls = this.el.pace.querySelectorAll<HTMLElement>('[data-role="dist"]');
    for (let i = 0; i < distEls.length; i++) {
      const note = notes[i];
      distEls[i].textContent = note ? `${Math.round(note.distance / 5) * 5}m` : '';
    }
  }
}

function mirror(glyph: string): string {
  return glyph.split('').map((c) => (c === '>' ? '<' : c)).reverse().join('');
}

/** m:ss.mmm, always the same width so the timer does not jitter. */
export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
