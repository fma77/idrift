import {
  TUNE_SPECS,
  ASSIST_SPECS,
  setHandling,
  setAssist,
  resetTuning,
  describeTuning,
} from '../tune/tuning.ts';
import { MODE_ASSIST } from '../data/assist.ts';
import { MIN_SENSITIVITY, MAX_SENSITIVITY } from '../input/thumbSteer.ts';
import type { CarParams, SimMode } from '../sim/types.ts';

/**
 * The tuning sheet shown over a paused run.
 *
 * Sliders rather than number fields: the question being answered is "more or
 * less than this", and a thumb answers that faster than a keyboard does.
 */

export interface TunePanelOptions {
  getSensitivity: () => number;
  setSensitivity: (value: number) => void;
  onClose: () => void;
}

export class TunePanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly options: TunePanelOptions;
  private car: CarParams | null = null;
  private mode: SimMode = 'timeAttack';

  constructor(root: HTMLElement, options: TunePanelOptions) {
    this.root = root;
    this.options = options;
    root.classList.add('tune');

    const head = document.createElement('div');
    head.className = 'tune__head';
    const label = document.createElement('div');
    label.className = 'mono tune__eyebrow';
    label.textContent = 'TUNING';
    this.title = document.createElement('div');
    this.title.className = 'display tune__title';
    head.append(label, this.title);

    this.body = document.createElement('div');
    this.body.className = 'tune__body';

    const foot = document.createElement('div');
    foot.className = 'tune__foot';
    this.status = document.createElement('div');
    this.status.className = 'tune__status';
    this.status.setAttribute('role', 'status');

    const actions = document.createElement('div');
    actions.className = 'tune__actions';
    const reset = button('Reset', 'btn btn--secondary');
    const copy = button('Copy values', 'btn btn--secondary');
    const drive = button('Drive', 'btn btn--primary');
    reset.addEventListener('click', () => {
      if (!this.car) return;
      resetTuning(this.car, this.mode);
      this.render();
      this.status.textContent = 'This car and this mode are back to the shipped values.';
    });
    copy.addEventListener('click', () => void this.copy());
    drive.addEventListener('click', () => options.onClose());
    actions.append(reset, copy, drive);
    foot.append(this.status, actions);

    root.append(head, this.body, foot);
  }

  open(car: CarParams, mode: SimMode): void {
    this.car = car;
    this.mode = mode;
    this.status.textContent = '';
    this.render();
    this.root.hidden = false;
    this.body.scrollTop = 0;
  }

  close(): void {
    this.root.hidden = true;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  private render(): void {
    const car = this.car;
    if (!car) return;
    this.title.textContent = car.name;

    const rows: HTMLElement[] = [
      row({
        label: 'Steering sensitivity',
        help: 'How far your thumb slides for full steering. Higher means a shorter slide.',
        min: MIN_SENSITIVITY * 100,
        max: MAX_SENSITIVITY * 100,
        step: 5,
        unit: '%',
        value: this.options.getSensitivity() * 100,
        onInput: (v) => this.options.setSensitivity(v / 100),
      }),
    ];

    const modeName = this.mode === 'timeAttack' ? 'Time Attack' : 'Drift Run';
    rows.push(heading(`${modeName} help`, 'Applies to every car in this mode.'));
    const assist = MODE_ASSIST[this.mode];
    for (const spec of ASSIST_SPECS) {
      rows.push(
        row({
          label: spec.label,
          help: spec.help,
          min: spec.min,
          max: spec.max,
          step: spec.step,
          unit: spec.unit,
          value: spec.toDisplay(assist[spec.key]),
          onInput: (v) => setAssist(this.mode, spec.key, spec.fromDisplay(v)),
        }),
      );
    }

    rows.push(heading(`${car.name} handling`, 'Applies to this car in both modes.'));
    for (const spec of TUNE_SPECS) {
      rows.push(
        row({
          label: spec.label,
          help: spec.help,
          min: spec.min,
          max: spec.max,
          step: spec.step,
          unit: spec.unit,
          value: spec.toDisplay(car.handling[spec.key]),
          onInput: (v) => setHandling(car, spec.key, spec.fromDisplay(v)),
        }),
      );
    }
    this.body.replaceChildren(...rows);
  }

  private async copy(): Promise<void> {
    if (!this.car) return;
    const text = describeTuning(this.car, this.mode, this.options.getSensitivity());
    try {
      await navigator.clipboard.writeText(text);
      this.status.textContent = 'Copied. Paste it into the chat to make these the defaults.';
    } catch {
      // No clipboard permission (or not a secure context): show the text so it
      // can be selected by hand instead.
      const area = document.createElement('textarea');
      area.className = 'tune__export';
      area.readOnly = true;
      area.value = text;
      this.body.prepend(area);
      area.focus();
      area.select();
      this.status.textContent = 'Could not copy automatically. Select the text above and copy it.';
    }
  }
}

function heading(title: string, note: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tune__section';
  const t = document.createElement('div');
  t.className = 'tune__section-title';
  t.textContent = title;
  const n = document.createElement('div');
  n.className = 'tune__help';
  n.textContent = note;
  el.append(t, n);
  return el;
}

function button(text: string, className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  return b;
}

interface RowOptions {
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  value: number;
  onInput: (value: number) => void;
}

function row(o: RowOptions): HTMLElement {
  const el = document.createElement('label');
  el.className = 'tune__row';

  const top = document.createElement('div');
  top.className = 'tune__row-top';
  const name = document.createElement('span');
  name.className = 'tune__label';
  name.textContent = o.label;
  const value = document.createElement('span');
  value.className = 'tune__value';
  top.append(name, value);

  const help = document.createElement('div');
  help.className = 'tune__help';
  help.textContent = o.help;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  input.value = String(o.value);

  const decimals = o.step >= 1 ? 0 : o.step >= 0.1 ? 1 : 2;
  const show = (v: number) => {
    value.textContent = `${v.toFixed(decimals)}${o.unit ? ` ${o.unit}` : ''}`;
  };
  show(o.value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    show(v);
    o.onInput(v);
  });

  el.append(top, help, input);
  return el;
}
