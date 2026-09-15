import './ui/styles.css';
import './ui/game.css';

import { GameSession, type RunOutcome } from './game.ts';
import { Renderer, type RenderSettings } from './render/renderer.ts';
import { Hud, formatTime } from './render/hud.ts';
import { InputController, ACTIONS, DEFAULT_KEYMAP, keyLabel, type Action } from './input/input.ts';
import { EngineAudio } from './audio/engine.ts';
import { CARS, carById } from './data/cars.ts';
import { ROUTES, ROUTE_IDS, loadRoute, type RouteEntry } from './data/routes.ts';
import { loadSettings, saveSettings, type Settings } from './storage/settings.ts';
import {
  getBest,
  submitBest,
  markCompleted,
  isUnlocked,
  isCompleted,
  saveReplay,
  compress,
  bestKey,
} from './storage/bests.ts';
import { fireMeme } from './ui/memes.ts';
import { SIM_VERSION, TICK_RATE } from './sim/version.ts';
import type { RouteData, SimMode } from './sim/types.ts';

/**
 * App shell: screen routing, settings, and the bridge between the menus and a
 * run. Deliberately plain DOM -- the menus are a dozen static screens in a
 * flat, typographic design system, and a framework would cost more than it
 * returned here.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

type ScreenName = 'title' | 'routes' | 'intro' | 'garage' | 'settings' | 'results';

const SCREENS: Record<ScreenName, HTMLElement> = {
  title: $('screen-title'),
  routes: $('screen-routes'),
  intro: $('screen-intro'),
  garage: $('screen-garage'),
  settings: $('screen-settings'),
  results: $('screen-results'),
};

const gameEl = $('game');
const canvas = $<HTMLCanvasElement>('canvas');
const controlsEl = $('controls');

const settings: Settings = loadSettings();
let currentEntry: RouteEntry = ROUTES[0];
let currentRoute: RouteData | null = null;
let currentMode: SimMode = 'timeAttack';
let session: GameSession | null = null;
let lastOutcome: RunOutcome | null = null;

const renderer = new Renderer(canvas);
const hud = new Hud({
  root: $('game'),
  comboLabel: $('hud-combo-label'),
  comboValue: $('hud-combo'),
  scoreLabel: $('hud-score-label'),
  scoreValue: $('hud-score'),
  driftLabel: $('hud-drift-label'),
  driftValue: $('hud-drift'),
  speedValue: $('hud-speed'),
  gearValue: $('hud-gear'),
  pace: $('pace'),
  flash: $('hud-flash'),
});

const input = new InputController($('steer-zone'), $('handbrake'));
input.setKeymap(settings.keymap);
input.lefty = settings.lefty;

const stick = $('stick');
const stickKnob = $('stick-knob');
input.onStick = (active, x, y, dx, dy) => {
  stick.dataset.active = String(active);
  if (!active) return;
  stick.style.left = `${x}px`;
  stick.style.top = `${y}px`;
  stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
};

// --- Screen routing ---------------------------------------------------------

function showScreen(name: ScreenName): void {
  for (const key of Object.keys(SCREENS) as ScreenName[]) {
    SCREENS[key].hidden = key !== name;
  }
  gameEl.hidden = true;
}

function showGame(): void {
  for (const key of Object.keys(SCREENS) as ScreenName[]) SCREENS[key].hidden = true;
  gameEl.hidden = false;
  // The canvas has no size until it is displayed, so measure now, not at boot.
  renderer.resize();
}

// --- Route list -------------------------------------------------------------

function buildRouteList(): void {
  const list = $('route-list');
  list.replaceChildren(
    ...ROUTES.map((entry, index) => {
      const unlocked = isUnlocked(ROUTE_IDS, index);
      const button = document.createElement('button');
      button.className = 'card';
      button.disabled = !unlocked;

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'card__name';
      name.textContent = entry.name;
      const meta = document.createElement('div');
      meta.className = 'card__meta';

      if (!unlocked) {
        meta.textContent = `Finish ${ROUTES[index - 1].name} to unlock`;
      } else {
        const ta = getBest(entry.id, 1, 'timeAttack');
        const dr = getBest(entry.id, 1, 'driftRun');
        const bits: string[] = [];
        if (ta) bits.push(`Best ${formatTime(ta.timeSeconds)}`);
        if (dr) bits.push(`${dr.points.toLocaleString('en-GB')} pts`);
        meta.textContent = bits.length ? bits.join(' · ') : entry.blurb;
      }

      left.append(name, meta);

      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.textContent = unlocked ? (isCompleted(entry.id) ? 'DONE' : 'NEW') : 'LOCKED';
      if (!unlocked) chip.className = 'chip chip--outline';

      button.append(left, chip);
      button.addEventListener('click', () => void openIntro(entry));
      return button;
    }),
  );
}

// --- Route intro / course map ----------------------------------------------

async function openIntro(entry: RouteEntry): Promise<void> {
  currentEntry = entry;
  currentRoute = await loadRoute(entry);
  $('intro-name').textContent = entry.name;
  $('intro-location').textContent = entry.location;

  const route = currentRoute;
  $('intro-stats').replaceChildren(
    statRow('Length', `${(route.length / 1000).toFixed(2)} km`),
    statRow('Corners', String(route.corners.length)),
    statRow('Drift zones', String(route.driftZones.length)),
    statRow('Car', carById(settings.carId).name),
  );

  const hairpins = route.corners.filter((c) => c.severity >= 5).length;
  $('intro-chips').replaceChildren(
    chip(`${hairpins} HAIRPIN${hairpins === 1 ? '' : 'S'}`, 'chip--outline'),
    chip(carById(settings.carId).carClass + '-CLASS', 'chip'),
    ...(isCompleted(entry.id) ? [] : [chip('NEW', 'chip--red')]),
  );

  drawMinimap(route);
  showScreen('intro');
}

function statRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'row__value';
  v.textContent = value;
  row.append(l, v);
  return row;
}

function chip(text: string, className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `chip ${className}`;
  el.textContent = text;
  return el;
}

/**
 * Course map.
 *
 * Drawn from the same centreline the sim drives on, so it cannot disagree with
 * the road. When a stylised poster image is supplied for a route it replaces
 * this; until then the player still gets an accurate read of the corner
 * sequence, which is the part that actually matters before a first run.
 */
function drawMinimap(route: RouteData): void {
  const el = $<HTMLCanvasElement>('minimap');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = el.clientWidth || 480;
  const height = Math.round(width * 0.62);
  el.width = Math.round(width * dpr);
  el.height = Math.round(height * dpr);
  el.style.height = `${height}px`;

  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const s = route.samples;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < s.x.length; i++) {
    if (s.x[i] < minX) minX = s.x[i];
    if (s.x[i] > maxX) maxX = s.x[i];
    if (s.y[i] < minY) minY = s.y[i];
    if (s.y[i] > maxY) maxY = s.y[i];
  }

  const pad = 18;
  const scale = Math.min((width - pad * 2) / (maxX - minX || 1), (height - pad * 2) / (maxY - minY || 1));
  const ox = (width - (maxX - minX) * scale) / 2 - minX * scale;
  // Flip y: world y is up, canvas y is down.
  const oy = (height + (maxY - minY) * scale) / 2 + minY * scale;
  const px = (i: number) => s.x[i] * scale + ox;
  const py = (i: number) => -s.y[i] * scale + oy;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.strokeStyle = '#141414';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  for (let i = 1; i < s.x.length; i++) ctx.lineTo(px(i), py(i));
  ctx.stroke();

  // Clipping points, not whole drift zones.
  //
  // Drawing the zones as red overlay swallowed most of the route -- on a touge
  // nearly every corner is a scoring zone -- and a map that is 70% red breaks
  // the one rule the design system is most insistent about. The clip points
  // carry the same information a player actually needs from a course map:
  // where the apexes are and how they are strung together.
  ctx.fillStyle = '#e8402a';
  for (const clip of route.clipPoints) {
    ctx.fillRect(px(clip.index) - 2.5, py(clip.index) - 2.5, 5, 5);
  }

  // Start and finish.
  const last = s.x.length - 1;
  ctx.fillStyle = '#141414';
  ctx.fillRect(px(0) - 4, py(0) - 4, 8, 8);
  ctx.fillStyle = '#e8402a';
  ctx.fillRect(px(last) - 4, py(last) - 4, 8, 8);

  ctx.fillStyle = '#6d675c';
  ctx.font = '600 10px "IBM Plex Mono", monospace';
  ctx.fillText('START', px(0) + 8, py(0) + 4);
  ctx.fillText('FINISH', px(last) + 8, py(last) + 4);
}

// --- Garage -----------------------------------------------------------------

function buildCarList(): void {
  $('car-list').replaceChildren(
    ...CARS.map((car) => {
      const button = document.createElement('button');
      button.className = 'card';

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'card__name';
      name.textContent = car.name;
      const meta = document.createElement('div');
      meta.className = 'card__meta';
      const power = Math.max(...car.engine.torqueCurve);
      meta.textContent = `${car.mass}kg · ${power}Nm · ${car.engine.gearRatios.length}-speed`;
      left.append(name, meta);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.gap = '8px';
      right.style.alignItems = 'center';
      if (car.id === settings.carId) right.appendChild(chip('SELECTED', 'chip--red'));
      right.appendChild(chip(car.carClass, 'chip'));

      button.append(left, right);
      button.addEventListener('click', () => {
        settings.carId = car.id;
        saveSettings(settings);
        buildCarList();
      });
      return button;
    }),
  );
}

// --- Settings ---------------------------------------------------------------

function bindToggle(id: string, get: () => boolean, set: (value: boolean) => void): void {
  const el = $(id);
  const sync = () => el.setAttribute('aria-pressed', String(get()));
  sync();
  el.addEventListener('click', () => {
    set(!get());
    saveSettings(settings);
    sync();
  });
}

function buildSettings(): void {
  const assist = $<HTMLInputElement>('set-assist');
  const assistValue = $('assist-value');
  assist.value = String(Math.round(settings.assist * 100));
  assistValue.textContent = assist.value;
  assist.addEventListener('input', () => {
    settings.assist = Number(assist.value) / 100;
    assistValue.textContent = assist.value;
    saveSettings(settings);
  });

  bindToggle(
    'set-lefty',
    () => settings.lefty,
    (v) => {
      settings.lefty = v;
      input.lefty = v;
      controlsEl.dataset.lefty = String(v);
    },
  );
  bindToggle('set-north', () => settings.fixedNorth, (v) => (settings.fixedNorth = v));
  bindToggle('set-skids', () => settings.showSkidMarks, (v) => (settings.showSkidMarks = v));
  bindToggle('set-sound', () => settings.soundOn, (v) => (settings.soundOn = v));

  buildKeybinds();
  $('btn-reset-keys').addEventListener('click', () => {
    settings.keymap = structuredClone(DEFAULT_KEYMAP);
    input.setKeymap(settings.keymap);
    saveSettings(settings);
    buildKeybinds();
    syncKeyHints();
  });
}

/**
 * Rebinding: click a row, press a key.
 *
 * Captures on keydown at the window level while listening, so a bind can target
 * any key including ones the browser would otherwise act on.
 */
let listeningFor: Action | null = null;

function buildKeybinds(): void {
  $('keybinds').replaceChildren(
    ...ACTIONS.map(({ id, label }) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.cursor = 'pointer';

      const name = document.createElement('span');
      name.textContent = label;

      const value = document.createElement('span');
      value.className = 'row__value';
      value.dataset.action = id;
      value.textContent = settings.keymap[id].map(keyLabel).join(' / ');

      row.append(name, value);
      row.addEventListener('click', () => {
        listeningFor = id;
        value.textContent = 'PRESS A KEY';
        value.style.color = 'var(--red)';
      });
      return row;
    }),
  );
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!listeningFor) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== 'Escape') {
      settings.keymap[listeningFor] = [e.code];
      input.setKeymap(settings.keymap);
      saveSettings(settings);
    }
    listeningFor = null;
    buildKeybinds();
    syncKeyHints();
  },
  true,
);

function syncKeyHints(): void {
  const map: [string, Action][] = [
    ['hint-left', 'left'],
    ['hint-right', 'right'],
    ['hint-accel', 'accelerate'],
    ['hint-brake', 'brake'],
    ['hint-handbrake', 'handbrake'],
  ];
  for (const [id, action] of map) {
    $(id).textContent = keyLabel(settings.keymap[action][0]);
  }
}

// --- Running ----------------------------------------------------------------

let audio: EngineAudio | null = null;

async function startRun(mode: SimMode): Promise<void> {
  if (!currentRoute) return;
  currentMode = mode;

  const car = carById(settings.carId);
  const renderSettings: RenderSettings = {
    fixedNorth: settings.fixedNorth,
    showSkidMarks: settings.showSkidMarks,
  };

  controlsEl.dataset.lefty = String(settings.lefty);
  gameEl.dataset.input = input.mode;
  syncKeyHints();

  audio = new EngineAudio(settings.soundOn);
  // Started from the click that got us here, which is the gesture the browser
  // requires before an AudioContext will run.
  void audio.start(car.audio);

  session = new GameSession(
    currentRoute,
    car,
    { mode, assist: settings.assist },
    input,
    renderer,
    hud,
    audio,
    renderSettings,
  );

  const countdownOverlay = $('overlay-countdown');
  const countdownEl = $('countdown');
  $('countdown-mode').textContent = mode === 'timeAttack' ? 'TIME ATTACK' : 'DRIFT RUN';
  countdownOverlay.hidden = false;

  session.onCountdown = (value) => {
    if (value <= 0) {
      countdownOverlay.hidden = true;
      return;
    }
    const n = Math.ceil(value);
    countdownEl.textContent = n <= 0 ? 'GO' : String(n);
    countdownEl.classList.toggle('overlay__count--go', n <= 0);
  };

  session.onFinish = (outcome) => void finishRun(outcome);

  showGame();
  session.start();
}

async function finishRun(outcome: RunOutcome): Promise<void> {
  lastOutcome = outcome;
  const route = currentRoute;
  if (!route) return;

  const car = carById(settings.carId);
  const { result } = outcome;

  markCompleted(route.id);

  const isBest = submitBest({
    routeId: route.id,
    routeVersion: route.version,
    mode: currentMode,
    carId: car.id,
    simVersion: SIM_VERSION,
    timeSeconds: result.timeSeconds,
    points: result.points,
    grade: result.grade,
    assist: settings.assist,
    recordedAt: Date.now(),
  });

  // Store the replay for the personal best only. Everything needed to replay it
  // exactly -- sim version, route version, car, assist, seed -- is in the best
  // record above; this is just the input stream.
  if (isBest) {
    try {
      const gz = await compress(outcome.recorder.encode());
      await saveReplay(bestKey(route.id, route.version, currentMode), gz);
    } catch {
      // Replay not stored. The score still stands.
    }
  }

  showResults(result, isBest);
}

function showResults(result: RunOutcome['result'], isBest: boolean): void {
  const route = currentRoute;
  if (!route) return;

  $('result-title').textContent = isBest ? 'Best yet' : 'Run over';
  $('result-route').textContent = `${currentEntry.name} · ${currentEntry.location} · ${carById(settings.carId).name}`;
  $('result-grade').textContent = result.grade;

  const rows: HTMLElement[] = [statRow('Time', formatTime(result.timeSeconds))];

  if (currentMode === 'driftRun') {
    rows.push(
      statRow('Points', result.points.toLocaleString('en-GB')),
      statRow('Style', `${result.grade} · x${result.styleModifier.toFixed(2)}`),
      statRow('Zones cleared', `${result.zonesCleared} / ${result.zonesTotal}`),
      statRow('Reversals', String(result.reversals)),
    );
  }

  rows.push(statRow('Wall hits', String(result.wallHits)));
  if (result.wallHits > 0 && currentMode === 'timeAttack') {
    rows.push(statRow('Time penalty', `+${(result.wallHits * 2).toFixed(0)}s`));
  }

  const best = getBest(route.id, route.version, currentMode);
  if (best && !isBest) {
    rows.push(
      statRow(
        'Personal best',
        currentMode === 'timeAttack'
          ? formatTime(best.timeSeconds)
          : best.points.toLocaleString('en-GB'),
      ),
    );
  }

  $('result-stats').replaceChildren(...rows);
  showScreen('results');

  // Meme triggers fire here -- on a results screen, never mid-drive.
  if (isBest) fireMeme('personalBest');
  else fireMeme('routeComplete');
  if (result.grade === 'S') fireMeme('sRank');
}

function quitRun(): void {
  session?.abort();
  session = null;
  $('overlay-countdown').hidden = true;
  $('overlay-paused').hidden = true;
  buildRouteList();
  showScreen('routes');
}

// --- Wiring -----------------------------------------------------------------

$('btn-drive').addEventListener('click', () => {
  buildRouteList();
  showScreen('routes');
});
$('btn-garage').addEventListener('click', () => {
  buildCarList();
  showScreen('garage');
});
$('btn-settings').addEventListener('click', () => showScreen('settings'));
$('btn-routes-back').addEventListener('click', () => showScreen('title'));
$('btn-garage-back').addEventListener('click', () => showScreen('title'));
$('btn-settings-back').addEventListener('click', () => showScreen('title'));
$('btn-intro-back').addEventListener('click', () => {
  buildRouteList();
  showScreen('routes');
});
$('btn-time-attack').addEventListener('click', () => void startRun('timeAttack'));
$('btn-drift-run').addEventListener('click', () => void startRun('driftRun'));
$('btn-retry').addEventListener('click', () => void startRun(currentMode));
$('btn-result-routes').addEventListener('click', () => {
  buildRouteList();
  showScreen('routes');
});
$('btn-result-title').addEventListener('click', () => showScreen('title'));
$('btn-quit').addEventListener('click', quitRun);
$('btn-resume').addEventListener('click', () => {
  $('overlay-paused').hidden = true;
  session?.start();
});

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || listeningFor) return;
  if (!gameEl.hidden && session && session.phase !== 'finished') {
    e.preventDefault();
    const paused = $('overlay-paused');
    if (paused.hidden) {
      session.stop();
      paused.hidden = false;
    } else {
      paused.hidden = true;
      session.start();
    }
  }
});

window.addEventListener('resize', () => {
  if (!gameEl.hidden) renderer.resize();
  if (!SCREENS.intro.hidden && currentRoute) drawMinimap(currentRoute);
});

// Touch anywhere switches the control hints over to the on-screen layout.
window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'touch') gameEl.dataset.input = 'touch';
  },
  { capture: true },
);

buildRouteList();
buildCarList();
buildSettings();
syncKeyHints();
controlsEl.dataset.lefty = String(settings.lefty);
showScreen('title');

// Expose a little state for debugging in the console during tuning.
Object.assign(window as unknown as Record<string, unknown>, {
  idrift: {
    get settings() {
      return settings;
    },
    get outcome() {
      return lastOutcome;
    },
    TICK_RATE,
    SIM_VERSION,
  },
});
