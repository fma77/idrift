import { EngineAudio } from '../audio/engine.ts';
import { ENGINE_KINDS, PROFILES, VOICE_SPECS, describeVoice, resetVoice, setVoice } from '../audio/profiles.ts';
import type { EngineKind } from '../sim/types.ts';

/**
 * The sound lab: pick an engine, work the throttle, move the sliders, listen.
 *
 * Two ways to rev. In neutral the revs follow the throttle, which is the
 * quickest way to hear the idle, the rev-up and the lift-off. Driving, a
 * notional car pulls through the gears, which is where the shifts, the boost
 * and the flutter between gears come in -- and a slide slider adds wheelspin
 * and tyre squeal, as in a drift.
 */

/** A notional car for "driving" in the lab, m/s. */
const LAB_TOP_SPEED = 42;
const LAB_ACCELERATION = 9;
/** The lab's throttle is quicker than the game's: here it is for listening. */
const THROTTLE_RISE = 0.2;
const THROTTLE_FALL = 0.12;

export class SoundLab {
  private readonly root: HTMLElement;
  private readonly onBack: () => void;
  private audio: EngineAudio | null = null;
  private kind: EngineKind = 'na4';
  private driving = false;
  private held = false;
  private throttle = 0;
  private speed = 0;
  private slide = 0;
  private raf = 0;
  private lastFrame = 0;

  private readonly body: HTMLElement;
  private readonly picker: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly boostFill: HTMLElement;
  private readonly status: HTMLElement;
  private readonly modeButton: HTMLButtonElement;
  private readonly slideRow: HTMLElement;

  constructor(root: HTMLElement, onBack: () => void) {
    this.root = root;
    this.onBack = onBack;
    root.classList.add('tune', 'lab');
    root.innerHTML = `
      <div class="tune__head lab__head">
        <div>
          <div class="mono tune__eyebrow">SOUND LAB</div>
          <div class="display tune__title lab__title">Engines</div>
        </div>
        <button class="btn--text lab__back" type="button">Back</button>
      </div>
      <div class="lab__picker"></div>
      <div class="lab__meter">
        <div class="lab__readout mono"></div>
        <div class="lab__boost"><div class="lab__boost-fill"></div></div>
      </div>
      <div class="lab__controls">
        <button class="btn btn--secondary lab__mode" type="button"></button>
        <button class="lab__throttle" type="button">HOLD<br />THROTTLE</button>
        <button class="btn btn--secondary lab__lock" type="button">Handbrake</button>
      </div>
      <label class="tune__row lab__slide">
        <div class="tune__row-top"><span class="tune__label">Slide</span><span class="tune__value">0°</span></div>
        <div class="tune__help">Driving only: sideways angle, for wheelspin and tyre squeal.</div>
        <input type="range" min="0" max="70" step="1" value="0" />
      </label>
      <div class="tune__body lab__body"></div>
      <div class="tune__foot">
        <div class="tune__status" role="status"></div>
        <div class="tune__actions lab__actions">
          <button class="btn btn--secondary" type="button" data-act="reset">Reset</button>
          <button class="btn btn--secondary" type="button" data-act="copy">Copy values</button>
        </div>
      </div>`;

    this.body = root.querySelector('.lab__body') as HTMLElement;
    this.picker = root.querySelector('.lab__picker') as HTMLElement;
    this.readout = root.querySelector('.lab__readout') as HTMLElement;
    this.boostFill = root.querySelector('.lab__boost-fill') as HTMLElement;
    this.status = root.querySelector('.tune__status') as HTMLElement;
    this.modeButton = root.querySelector('.lab__mode') as HTMLButtonElement;
    this.slideRow = root.querySelector('.lab__slide') as HTMLElement;

    (root.querySelector('.lab__back') as HTMLElement).addEventListener('click', () => this.onBack());

    for (const kind of ENGINE_KINDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lab__engine';
      b.dataset.kind = kind;
      b.textContent = PROFILES[kind].label;
      b.addEventListener('click', () => this.select(kind));
      this.picker.appendChild(b);
    }

    (root.querySelector('.lab__lock') as HTMLElement).addEventListener('click', () => {
      this.ensureAudio();
      this.audio?.triggerLock();
    });

    this.modeButton.addEventListener('click', () => {
      this.driving = !this.driving;
      this.speed = 0;
      this.syncMode();
    });

    const throttle = root.querySelector('.lab__throttle') as HTMLElement;
    const down = (e: PointerEvent) => {
      e.preventDefault();
      try {
        throttle.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer.
      }
      this.ensureAudio();
      this.held = true;
      throttle.dataset.active = 'true';
    };
    const up = () => {
      this.held = false;
      throttle.dataset.active = 'false';
    };
    throttle.addEventListener('pointerdown', down);
    throttle.addEventListener('pointerup', up);
    throttle.addEventListener('pointercancel', up);
    throttle.addEventListener('lostpointercapture', up);
    throttle.addEventListener('contextmenu', (e) => e.preventDefault());

    const slide = this.slideRow.querySelector('input') as HTMLInputElement;
    const slideValue = this.slideRow.querySelector('.tune__value') as HTMLElement;
    slide.addEventListener('input', () => {
      this.slide = (Number(slide.value) * Math.PI) / 180;
      slideValue.textContent = `${slide.value}°`;
    });

    (root.querySelector('[data-act="reset"]') as HTMLElement).addEventListener('click', () => {
      resetVoice(this.kind);
      this.audio?.setVoice(PROFILES[this.kind].voice);
      this.renderSliders();
      this.status.textContent = 'Back to the shipped sound.';
    });
    (root.querySelector('[data-act="copy"]') as HTMLElement).addEventListener('click', () => void this.copy());

    // Keyboard: up arrow or space is the throttle, while the lab is open.
    window.addEventListener('keydown', (e) => {
      if (this.root.hidden || e.repeat) return;
      if (e.code === 'ArrowUp' || e.code === 'Space') {
        e.preventDefault();
        this.ensureAudio();
        this.held = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'ArrowUp' || e.code === 'Space') this.held = false;
    });

    this.syncMode();
  }

  open(kind: EngineKind): void {
    this.root.hidden = false;
    this.status.textContent = '';
    this.select(kind);
    this.lastFrame = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  close(): void {
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
    this.audio?.stop();
    this.audio = null;
    this.held = false;
  }

  private select(kind: EngineKind): void {
    this.kind = kind;
    for (const b of Array.from(this.picker.children) as HTMLElement[]) {
      b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    }
    // A new engine is a new AudioContext. Picking one is a click, which is the
    // gesture a browser wants before it will play anything.
    this.audio?.stop();
    this.audio = null;
    this.speed = 0;
    this.ensureAudio();
    this.renderSliders();
  }

  private ensureAudio(): void {
    if (this.audio) return;
    this.audio = new EngineAudio(true);
    void this.audio.start(this.kind);
  }

  private syncMode(): void {
    this.modeButton.textContent = this.driving ? 'Driving: pulls through the gears' : 'Neutral: revs follow the throttle';
    this.slideRow.hidden = !this.driving;
  }

  private frame(now: number): void {
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    const rate = this.held ? 1 / THROTTLE_RISE : -1 / THROTTLE_FALL;
    this.throttle = Math.min(1, Math.max(0, this.throttle + rate * dt));

    if (this.driving) {
      const pull = LAB_ACCELERATION * (1 - this.speed / LAB_TOP_SPEED) * this.throttle;
      const drag = (1 - this.throttle) * 3 + (this.slide > 0 ? 2 : 0);
      this.speed = Math.max(0, this.speed + (pull - drag) * dt);
    }

    this.audio?.drive(
      {
        speed: this.speed,
        topSpeed: LAB_TOP_SPEED,
        throttle: this.throttle,
        sliding: this.driving && this.slide > 0.1,
        slip: this.slide,
        neutral: !this.driving,
      },
      this.driving ? this.slide : 0,
    );

    const r = this.audio?.reading;
    if (r) {
      const kmh = Math.round(this.speed * 3.6);
      this.readout.textContent = this.driving
        ? `${Math.round(r.rpm)} RPM · GEAR ${r.gear + 1} · ${kmh} KM/H`
        : `${Math.round(r.rpm)} RPM · NEUTRAL`;
      this.boostFill.style.width = `${Math.round(r.boost * 100)}%`;
    }
  }

  private renderSliders(): void {
    const voice = PROFILES[this.kind].voice;
    const rows = VOICE_SPECS.map((spec) => {
      const el = document.createElement('label');
      el.className = 'tune__row';
      const decimals = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : spec.step >= 0.01 ? 2 : 4;
      el.innerHTML = `
        <div class="tune__row-top"><span class="tune__label"></span><span class="tune__value"></span></div>
        <div class="tune__help"></div>
        <input type="range" />`;
      (el.querySelector('.tune__label') as HTMLElement).textContent = spec.label;
      (el.querySelector('.tune__help') as HTMLElement).textContent = spec.help;
      const value = el.querySelector('.tune__value') as HTMLElement;
      const input = el.querySelector('input') as HTMLInputElement;
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(voice[spec.key]);
      value.textContent = Number(voice[spec.key]).toFixed(decimals);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        value.textContent = v.toFixed(decimals);
        setVoice(this.kind, spec.key, v);
        this.audio?.setVoice(PROFILES[this.kind].voice);
      });
      return el;
    });
    this.body.replaceChildren(...rows);
  }

  private async copy(): Promise<void> {
    const text = describeVoice(this.kind);
    try {
      await navigator.clipboard.writeText(text);
      this.status.textContent = 'Copied. Paste it into the chat to make this the shipped sound.';
    } catch {
      const area = document.createElement('textarea');
      area.className = 'tune__export';
      area.readOnly = true;
      area.value = text;
      this.body.prepend(area);
      area.select();
      this.status.textContent = 'Could not copy automatically. Select the text above and copy it.';
    }
  }
}
