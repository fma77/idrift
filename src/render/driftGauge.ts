import { SWEET_SPOT, type DriftControlParams } from '../sim/types.ts';

/**
 * The drift angle gauge, for Drift Run with throttle controls.
 *
 * With the game steering, the angle is the one thing the player controls, and
 * from a top-down view it is hard to judge by eye. So it is drawn: a half dial
 * from straight to sideways, the sweet spot just under the limit, the spin zone
 * past it in red, a needle for the angle now, and a bar for the throttle.
 */

const SIZE = 160;
const CX = SIZE / 2;
const CY = SIZE / 2 + 6;
const R = 64;
/** The dial covers 0..90 degrees of drift across its half circle. */
const FULL = Math.PI / 2;

function point(angle: number, radius: number): { x: number; y: number } {
  // 0 at the left end of the arc, FULL at the right.
  const t = Math.PI - (Math.min(Math.max(angle, 0), FULL) / FULL) * Math.PI;
  return { x: CX + Math.cos(t) * radius, y: CY - Math.sin(t) * radius };
}

function arc(from: number, to: number, radius: number): string {
  const a = point(from, radius);
  const b = point(to, radius);
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${radius} ${radius} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

export class DriftGauge {
  private readonly root: HTMLElement;
  private readonly sweet: SVGPathElement;
  private readonly spin: SVGPathElement;
  private readonly needle: SVGLineElement;
  private readonly throttleBar: HTMLElement;
  private readonly readout: HTMLElement;
  private limitKey = '';

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <svg viewBox="0 0 ${SIZE} ${SIZE / 2 + 16}" aria-hidden="true">
        <path class="gauge__track" d="${arc(0, FULL, R)}" />
        <path class="gauge__sweet" />
        <path class="gauge__spin" />
        <line class="gauge__needle" x1="${CX}" y1="${CY}" x2="${CX - R}" y2="${CY}" />
        <rect class="gauge__hub" x="${CX - 5}" y="${CY - 5}" width="10" height="10" />
      </svg>
      <div class="gauge__readout"><span class="gauge__angle">0</span>°</div>
      <div class="gauge__throttle"><div class="gauge__throttle-fill"></div></div>`;
    this.sweet = root.querySelector('.gauge__sweet') as SVGPathElement;
    this.spin = root.querySelector('.gauge__spin') as SVGPathElement;
    this.needle = root.querySelector('.gauge__needle') as SVGLineElement;
    this.throttleBar = root.querySelector('.gauge__throttle-fill') as HTMLElement;
    this.readout = root.querySelector('.gauge__angle') as HTMLElement;
  }

  update(angle: number, throttle: number, drifting: boolean, params: DriftControlParams): void {
    // Redraw the bands only when tuning has moved them.
    const key = `${params.limitAngle}|${params.spinAngle}`;
    if (key !== this.limitKey) {
      this.limitKey = key;
      this.sweet.setAttribute('d', arc(params.limitAngle - SWEET_SPOT, params.limitAngle, R));
      this.spin.setAttribute('d', arc(params.limitAngle, Math.min(params.spinAngle, FULL), R));
    }
    const shown = drifting ? Math.max(angle, 0) : 0;
    const tip = point(shown, R - 4);
    this.needle.setAttribute('x2', tip.x.toFixed(1));
    this.needle.setAttribute('y2', tip.y.toFixed(1));
    this.readout.textContent = String(Math.round((shown * 180) / Math.PI));
    this.throttleBar.style.width = `${Math.round(throttle * 100)}%`;

    const zone = !drifting
      ? 'idle'
      : angle > params.limitAngle
        ? 'danger'
        : angle >= params.limitAngle - SWEET_SPOT
          ? 'sweet'
          : 'building';
    this.root.dataset.zone = zone;
  }
}
