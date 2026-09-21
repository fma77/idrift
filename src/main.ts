import './ui/styles.css';
import './ui/game.css';

import { GameSession, type RunOutcome } from './game.ts';
import { Renderer, type RenderSettings } from './render/renderer.ts';
import { Hud, formatTime } from './render/hud.ts';
import { InputController, ACTIONS, DEFAULT_KEYMAP, keyLabel, type Action } from './input/input.ts';
import { ThumbSteer } from './input/thumbSteer.ts';
import { PedalTouch } from './input/pedals.ts';
import { DriftGauge } from './render/driftGauge.ts';
import { TunePanel } from './ui/tunePanel.ts';
import { isTuneMode, applyStoredTuning, restoreShippedHandling, isTuned } from './tune/tuning.ts';
import { EngineAudio } from './audio/engine.ts';
import { applySoundOverrides, PROFILES } from './audio/profiles.ts';
import { SoundLab } from './ui/soundLab.ts';
import { CARS, carById } from './data/cars.ts';
import { configFor } from './data/assist.ts';
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
import { loadDecoration } from './render/decoration.ts';
import { getSprite, preload } from './render/sprites.ts';
import { drawPosterOverlay } from './ui/poster.ts';
import { fireMeme } from './ui/memes.ts';
import { submitScore, fetchBoard, bytesToBase64, LeaderboardError } from './net/leaderboard.ts';
import { checkName } from '../shared/moderation.ts';
import type { LeaderboardRow } from '../shared/api.ts';
import { SIM_VERSION, TICK_RATE } from './sim/version.ts';
import type { Controls, RouteData, SimMode } from './sim/types.ts';

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

/**
 * Tuning mode: handling sliders over a paused run, applied live.
 *
 * Hidden for now: #tune or ?tune on the URL switches it on and shows its
 * toggle in Settings. Everything behind it is kept for when handling needs
 * adjusting again.
 */
let tuneMode = false;

function setTuneMode(on: boolean): void {
  tuneMode = on;
  settings.tuneMode = on;
  saveSettings(settings);
  if (on) applyStoredTuning();
  else restoreShippedHandling();
  $('btn-tune').hidden = !on;
}

const settings: Settings = loadSettings();
// Sound lab changes are presentation only, so they apply everywhere.
applySoundOverrides();
let currentEntry: RouteEntry = ROUTES[0];
let currentRoute: RouteData | null = null;
let currentMode: SimMode = 'timeAttack';
let session: GameSession | null = null;
let lastOutcome: RunOutcome | null = null;
/** Which board the route screen is showing. */
let boardMode: SimMode = 'timeAttack';
/** Row id of the score just posted, so it can be highlighted on the board. */
let myLastRowId: string | null = null;

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
  angleValue: $('hud-angle'),
  pace: $('pace'),
  progressFill: $('progress-fill'),
  progressLabel: $('progress-label'),
  flash: $('hud-flash'),
  bankPop: $('bank-pop'),
  gauge: new DriftGauge($('drift-gauge')),
});

const input = new InputController();
input.setKeymap(settings.keymap);

/** Touch anywhere during a run and slide sideways to steer. */
const thumb = new ThumbSteer($('steer-surface'), (value) => input.setTouchSteer(value));
thumb.setSensitivity(settings.steerSensitivity);

/** Drift Run's throttle controls: tap the left half to drift, hold the right. */
const pedals = new PedalTouch($('pedal-surface'), {
  onThrottle: (held) => input.setTouchThrottle(held),
  onDrift: () => input.pressDrift(),
});

/** Which controls the current run uses. */
let currentControls: Controls = 'steer';

/** Runs that are not saved or posted, and why; null when the run counts. */
function unrankedReason(): string | null {
  if (tuneMode) return 'Tuning mode. This run is not saved as a best or posted to the leaderboard.';
  if (currentMode === 'driftRun' && currentControls === 'steer') {
    return 'Steered Drift Run. This run is not saved or posted: the leaderboard is for the throttle controls.';
  }
  return null;
}

// --- Input mode -------------------------------------------------------------

/**
 * Whether to show touch hints or key hints.
 *
 * Decided on the device's primary pointer at boot, then switched on real use:
 * a touch means touch, a bound key means keyboard.
 */
function setInputMode(mode: 'touch' | 'keyboard'): void {
  gameEl.dataset.input = mode;
}

setInputMode(window.matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'keyboard');

// --- Screen routing ---------------------------------------------------------

const soundLab = new SoundLab($('sound-lab'), () => {
  soundLab.close();
  showScreen('settings');
});

function showScreen(name: ScreenName): void {
  if (!$('sound-lab').hidden) soundLab.close();
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
  // Routes built from someone else's data say whose. Required by the ODbL for
  // the OpenStreetMap ones, and only fair for anything else.
  const credit = currentRoute.attribution ?? entry.attribution ?? '';
  $('intro-credit').textContent = credit;
  $('intro-credit').hidden = credit === '';

  const route = currentRoute;

  showPoster(route);
  void refreshBoard();
  showScreen('intro');

  // Scenery and car art load in the background. Neither blocks the drive
  // button, and neither is required for the route to be playable.
  void loadDecoration(route.decoration).then((deco) => renderer.setDecoration(deco));
  renderer.prepareWorld(route);
  void preload([carById(settings.carId).sprite?.path, entry.poster?.src]).then(() => {
    // The poster arrives after the screen is up; swap it in if we are still here.
    if (currentEntry === entry && !SCREENS.intro.hidden) showPoster(route);
  });
}

// --- Leaderboard ------------------------------------------------------------

function setBoardMode(mode: SimMode): void {
  boardMode = mode;
  $('board-tab-time').setAttribute('aria-selected', String(mode === 'timeAttack'));
  $('board-tab-drift').setAttribute('aria-selected', String(mode === 'driftRun'));
  void refreshBoard();
}

/**
 * Fetch and draw the board for the current route and mode.
 *
 * Every failure here is non-fatal by design. The board is the only part of the
 * game that needs the network, so an outage shows a line of text and the player
 * carries on driving.
 */
async function refreshBoard(): Promise<void> {
  const route = currentRoute;
  const container = $('board-rows');
  if (!route) return;

  container.replaceChildren(caption('Loading…'));

  try {
    const board = await fetchBoard(
      route.id,
      boardMode,
      'all',
      route.version,
      SIM_VERSION,
    );
    if (board.rows.length === 0) {
      container.replaceChildren(caption('No times posted yet. Be first.'));
      return;
    }
    container.replaceChildren(...board.rows.map(boardRow));
  } catch (err) {
    const message =
      err instanceof LeaderboardError ? err.message : 'Could not reach the leaderboard.';
    container.replaceChildren(caption(message));
  }
}

function boardRow(row: LeaderboardRow): HTMLElement {
  const el = document.createElement('div');
  el.className = row.id === myLastRowId ? 'board__row board__row--me' : 'board__row';

  const rank = document.createElement('span');
  rank.className = 'board__rank';
  rank.textContent = String(row.rank);

  const name = document.createElement('span');
  name.className = 'board__name';
  name.textContent = row.playerName;
  const car = document.createElement('span');
  car.className = 'board__car';
  car.textContent = carById(row.carId).name;
  name.appendChild(car);

  const value = document.createElement('span');
  value.className = 'board__value';
  // Time Attack shows only a time; Drift Run shows points, with the time as
  // the secondary value, exactly as the brief specifies.
  value.textContent =
    boardMode === 'timeAttack'
      ? formatTime(row.timeMs / 1000)
      : row.points.toLocaleString('en-GB');
  if (boardMode === 'driftRun') {
    const time = document.createElement('span');
    time.className = 'board__car';
    time.style.textAlign = 'right';
    time.textContent = formatTime(row.timeMs / 1000);
    value.appendChild(time);
  }

  el.append(rank, name, value);
  return el;
}

function caption(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'caption';
  el.textContent = text;
  return el;
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
/**
 * Route intro artwork.
 *
 * Uses the supplied poster when one has loaded, and the drawn course map
 * otherwise. Both answer the same question -- what shape is this route -- and
 * the drawn one is generated from the centreline the sim drives, so it can
 * never disagree with the road even when the poster does.
 */
function showPoster(route: RouteData): void {
  const art = currentEntry.poster;
  const poster = getSprite(art?.src);
  const frame = $('poster-art');
  const canvas = $<HTMLCanvasElement>('minimap');
  if (art && poster) {
    $<HTMLImageElement>('poster-img').src = poster.src;
    drawPosterOverlay($('poster-overlay') as unknown as SVGSVGElement, art);
    frame.hidden = false;
    canvas.hidden = true;
    return;
  }
  frame.hidden = true;
  canvas.hidden = false;
  drawMinimap(route);
}

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
  //
  // On a long route there are hundreds of them, and at map scale they merge
  // into a red snake thicker than the road -- the imported 7km pass drew more
  // red than ink. So they shrink, and any that would overlap the last one
  // drawn are skipped: the shape of the route has to stay readable.
  ctx.fillStyle = '#e8402a';
  const size = route.clipPoints.length > 40 ? 3 : 5;
  let lastX = -100;
  let lastY = -100;
  for (const clip of route.clipPoints) {
    const cx = px(clip.index);
    const cy = py(clip.index);
    if (Math.hypot(cx - lastX, cy - lastY) < size * 2) continue;
    ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    lastX = cx;
    lastY = cy;
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
      meta.textContent =
        `${PROFILES[car.engine].label} · top ${Math.round(car.handling.topSpeed * 3.6)} km/h` +
        (tuneMode && isTuned(car) ? ' · tuned' : '');
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

let syncSettingsSensitivity: () => void = () => {};
let syncTuneToggle: () => void = () => {};

function setSensitivity(value: number): void {
  settings.steerSensitivity = value;
  thumb.setSensitivity(value);
  saveSettings(settings);
  syncSettingsSensitivity();
}

function buildSettings(): void {
  const sensitivity = $<HTMLInputElement>('set-sensitivity');
  const sensitivityValue = $('sensitivity-value');
  const syncSensitivity = () => {
    sensitivity.value = String(Math.round(settings.steerSensitivity * 100));
    sensitivityValue.textContent = `${sensitivity.value}%`;
  };
  syncSensitivity();
  sensitivity.addEventListener('input', () => setSensitivity(Number(sensitivity.value) / 100));
  syncSettingsSensitivity = syncSensitivity;

  bindToggle('set-north', () => settings.fixedNorth, (v) => (settings.fixedNorth = v));
  bindToggle('set-skids', () => settings.showSkidMarks, (v) => (settings.showSkidMarks = v));
  bindToggle('set-smoke', () => settings.showSmoke, (v) => (settings.showSmoke = v));
  bindToggle('set-sound', () => settings.soundOn, (v) => (settings.soundOn = v));
  bindToggle(
    'set-drift-steer',
    () => settings.driftControls === 'steer',
    (v) => (settings.driftControls = v ? 'steer' : 'throttle'),
  );
  bindToggle('set-tune', () => tuneMode, (v) => {
    // Only reachable from Settings, never mid-run, so a run is driven entirely
    // on shipped or entirely on tuned handling.
    setTuneMode(v);
    buildCarList();
  });
  syncTuneToggle = () => $('set-tune').setAttribute('aria-pressed', String(tuneMode));

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
    ['hint-throttle', 'throttle'],
    ['hint-drift', 'drift'],
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
  currentControls = mode === 'driftRun' ? settings.driftControls : 'steer';
  gameEl.dataset.controls = currentControls;
  const renderSettings: RenderSettings = {
    fixedNorth: settings.fixedNorth,
    showSkidMarks: settings.showSkidMarks,
    showSmoke: settings.showSmoke,
  };

  syncKeyHints();

  audio = new EngineAudio(settings.soundOn);
  // Started from the click that got us here, which is the gesture the browser
  // requires before an AudioContext will run.
  void audio.start(car.engine);

  session = new GameSession(
    currentRoute,
    car,
    configFor(mode, currentControls),
    input,
    renderer,
    hud,
    audio,
    renderSettings,
  );

  const countdownOverlay = $('overlay-countdown');
  const countdownEl = $('countdown');
  $('countdown-mode').textContent = mode === 'timeAttack' ? 'TIME ATTACK' : 'DRIFT RUN';
  const keys = gameEl.dataset.input === 'keyboard';
  const key = (a: Action) => keyLabel(settings.keymap[a][0]);
  $('countdown-hint').textContent =
    currentControls === 'throttle'
      ? keys
        ? `Hold ${key('throttle')} for throttle. Tap ${key('drift')} before a corner to drift, then balance the angle with the throttle. Too much and you spin.`
        : 'Hold the right side for throttle. Tap the left side before a corner to drift, then balance the angle with the throttle. Too much and you spin.'
      : keys
        ? `${key('left')} ${key('right')} to steer. The car drives itself.`
        : 'Touch anywhere and slide to steer. The car drives itself.';
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
  thumb.releaseAll();
  pedals.releaseAll();
  tunePanel.close();
  lastOutcome = outcome;
  const route = currentRoute;
  if (!route) return;

  const car = carById(settings.carId);
  const { result } = outcome;

  // Tuned handling is not the game everyone else is playing, so nothing driven
  // with it counts: no best, no replay, no unlock, no leaderboard. Nor does a
  // Drift Run steered the old way, which is kept for comparison only.
  if (unrankedReason()) {
    showResults(result, false);
    return;
  }

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
    recordedAt: Date.now(),
  });

  // Store the replay for the personal best only. Everything needed to replay it
  // exactly -- sim version, route version, car, seed -- is in the best
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
  resetSubmitPanel();
  const unranked = unrankedReason();
  $('result-tune-note').textContent = unranked ?? '';
  $('result-tune-note').hidden = !unranked;
  $('result-submit').hidden = !!unranked;
  showScreen('results');

  // Meme triggers fire here -- on a results screen, never mid-drive.
  if (unranked) return;
  if (isBest) fireMeme('personalBest');
  else fireMeme('routeComplete');
  if (result.grade === 'S') fireMeme('sRank');
}

function quitRun(): void {
  thumb.releaseAll();
  pedals.releaseAll();
  tunePanel.close();
  session?.abort();
  session = null;
  $('overlay-countdown').hidden = true;
  $('overlay-paused').hidden = true;
  buildRouteList();
  showScreen('routes');
}

// --- Posting a score --------------------------------------------------------

function resetSubmitPanel(): void {
  const input = $<HTMLInputElement>('player-name');
  input.value = settings.playerName;
  input.removeAttribute('aria-invalid');
  $('name-error').textContent = '';
  $('post-status').textContent = '';
  const post = $<HTMLButtonElement>('btn-post');
  post.disabled = false;
  post.textContent = 'Post score';
}

/** Live feedback as the player types. The server check is the one that counts. */
function validateNameField(): boolean {
  const input = $<HTMLInputElement>('player-name');
  const error = $('name-error');
  const value = input.value.trim();
  if (value.length === 0) {
    input.removeAttribute('aria-invalid');
    error.textContent = '';
    return false;
  }
  const check = checkName(value);
  input.setAttribute('aria-invalid', String(!check.ok));
  error.textContent = check.ok ? '' : (check.message ?? '');
  return check.ok;
}

async function postScore(): Promise<void> {
  const route = currentRoute;
  const outcome = lastOutcome;
  const status = $('post-status');
  const post = $<HTMLButtonElement>('btn-post');

  if (!route || !outcome) {
    status.textContent = 'Nothing to post.';
    return;
  }
  if (!validateNameField()) {
    $('player-name').focus();
    if (!$('name-error').textContent) $('name-error').textContent = 'Pick a name first.';
    return;
  }

  const name = $<HTMLInputElement>('player-name').value.trim();
  settings.playerName = name;
  saveSettings(settings);

  post.disabled = true;
  post.textContent = 'Posting…';
  status.textContent = '';

  const car = carById(settings.carId);
  const { result } = outcome;

  try {
    // The replay rides along with the score. A gzipped 90-second run is a few
    // KB, which is small enough to send for every submission rather than only
    // for a record -- and it is what makes ghost playback possible later.
    let replay: string | undefined;
    try {
      replay = bytesToBase64(await compress(outcome.recorder.encode()));
    } catch {
      // Compression unavailable: post the score without a ghost.
    }

    const response = await submitScore({
      routeId: route.id,
      routeVersion: route.version,
      mode: currentMode,
      carClass: car.carClass,
      simVersion: SIM_VERSION,
      playerName: name,
      carId: car.id,
      timeMs: Math.round(result.timeSeconds * 1000),
      points: result.points,
      grade: result.grade,
      // No throttle assist any more: the car always drives itself. The field
      // stays in the API so the worker and database need no migration.
      assist: 1,
      tickCount: result.totalTicks,
      replay,
    });

    myLastRowId = response.id;
    post.textContent = 'Posted';
    status.textContent = response.inTop20
      ? `Posted — #${response.rank} on the board.`
      : `Posted — #${response.rank}. Top ${20} to make the board.`;
    if (response.inTop20) fireMeme('leaderboardTop20');
  } catch (err) {
    post.disabled = false;
    post.textContent = 'Post score';
    if (err instanceof LeaderboardError) {
      status.textContent = err.message;
      // A name the server rejects should land on the field, not in a status line.
      if (err.code === 'profanity' || err.code === 'reserved') {
        $('name-error').textContent = err.message;
        $('player-name').setAttribute('aria-invalid', 'true');
        status.textContent = '';
      }
    } else {
      status.textContent = 'Could not post that score.';
    }
  }
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
$('btn-sound-lab').addEventListener('click', () => {
  for (const key of Object.keys(SCREENS) as ScreenName[]) SCREENS[key].hidden = true;
  soundLab.open(carById(settings.carId).engine);
});
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
$('btn-post').addEventListener('click', () => void postScore());
$('player-name').addEventListener('input', validateNameField);
$('board-tab-time').addEventListener('click', () => setBoardMode('timeAttack'));
$('board-tab-drift').addEventListener('click', () => setBoardMode('driftRun'));
$('btn-quit').addEventListener('click', quitRun);
$('btn-resume').addEventListener('click', resumeRun);
$('btn-pause').addEventListener('click', pauseRun);

function isRunActive(): boolean {
  return !gameEl.hidden && !!session && session.phase !== 'finished' && session.phase !== 'aborted';
}

function pauseRun(): void {
  if (!isRunActive() || !$('overlay-paused').hidden) return;
  session?.stop();
  // A thumb resting on the screen must not come back steering on resume.
  thumb.releaseAll();
  pedals.releaseAll();
  $('overlay-paused').hidden = false;
}

function resumeRun(): void {
  if (!isRunActive() || $('overlay-paused').hidden) return;
  $('overlay-paused').hidden = true;
  session?.start();
}

// --- Tuning -----------------------------------------------------------------

const tunePanel = new TunePanel($('tune-panel'), {
  getSensitivity: () => settings.steerSensitivity,
  setSensitivity,
  onClose: closeTuning,
});

function openTuning(): void {
  if (!isRunActive() || tunePanel.isOpen) return;
  session?.stop();
  thumb.releaseAll();
  $('overlay-paused').hidden = true;
  pedals.releaseAll();
  tunePanel.open(carById(settings.carId), currentMode, currentControls);
}

function closeTuning(): void {
  if (!tunePanel.isOpen) return;
  tunePanel.close();
  if (isRunActive()) session?.start();
}

$('btn-tune').addEventListener('click', openTuning);
// Tuning is parked: its Settings row only appears when #tune or ?tune is on
// the URL, and a setting left on from before does not bring it back.
setTuneMode(isTuneMode());
$('tune-row').hidden = !tuneMode;
window.addEventListener('hashchange', () => {
  if (isTuneMode() && !tuneMode && !isRunActive()) {
    setTuneMode(true);
    $('tune-row').hidden = false;
    syncTuneToggle();
  }
});

window.addEventListener('keydown', (e) => {
  // Using a bound key means the keyboard is in use, whatever the device.
  if (input.isBound(e.code)) setInputMode('keyboard');

  if (e.code !== 'Escape' || listeningFor || !isRunActive()) return;
  e.preventDefault();
  if (tunePanel.isOpen) closeTuning();
  else if ($('overlay-paused').hidden) pauseRun();
  else resumeRun();
});

// Losing the app to a call or a notification pauses rather than leaving the
// car driving unattended into a wall.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !tunePanel.isOpen) pauseRun();
});

window.addEventListener('resize', () => {
  if (!gameEl.hidden) renderer.resize();
  if (!SCREENS.intro.hidden && currentRoute) showPoster(currentRoute);
});

// A real touch anywhere switches to touch hints.
window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'touch') setInputMode('touch');
  },
  { capture: true },
);

buildRouteList();
buildCarList();
buildSettings();
setBoardMode('timeAttack');
syncKeyHints();
showScreen('title');

// Expose live state for tuning from the console: camera framing and handling
// are judged by eye, and being able to read the actual numbers behind a frame
// is the difference between tuning and guessing.
Object.assign(window as unknown as Record<string, unknown>, {
  idrift: {
    get settings() {
      return settings;
    },
    get outcome() {
      return lastOutcome;
    },
    get session() {
      return session;
    },
    get route() {
      return currentRoute;
    },
    renderer,
    TICK_RATE,
    SIM_VERSION,
  },
});
