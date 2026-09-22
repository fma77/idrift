import './ui/styles.css';
import './ui/game.css';

import { GameSession, type RunOutcome } from './game.ts';
import { Renderer, type RenderSettings } from './render/renderer.ts';
import { Hud, formatTime } from './render/hud.ts';
import { InputController, ACTIONS, DEFAULT_KEYMAP, keyLabel, type Action } from './input/input.ts';
import { ThumbSteer } from './input/thumbSteer.ts';
import { PedalTouch } from './input/pedals.ts';
import { ProPedals } from './input/proPedals.ts';
import { DriftGauge } from './render/driftGauge.ts';
import { TunePanel } from './ui/tunePanel.ts';
import { isTuneMode, applyStoredTuning, restoreShippedHandling, isTuned } from './tune/tuning.ts';
import { EngineAudio } from './audio/engine.ts';
import { applySoundOverrides, PROFILES } from './audio/profiles.ts';
import { SoundLab } from './ui/soundLab.ts';
import { CARS, carById } from './data/cars.ts';
import { realKmh } from './data/scale.ts';
import { configFor } from './data/assist.ts';
import { ROUTES, loadRoute, type RouteEntry } from './data/routes.ts';
import { loadSettings, saveSettings, type Settings } from './storage/settings.ts';
import {
  getBest,
  submitBest,
  markCompleted,
  saveReplay,
  compress,
  decompress,
  bestKey,
} from './storage/bests.ts';
import { buildGhost, type GhostTrack } from './ghost.ts';
import { loadDecoration } from './render/decoration.ts';
import { getSprite, preload } from './render/sprites.ts';
import { drawPosterOverlay } from './ui/poster.ts';
import { flagElement } from './ui/flags.ts';
import { submitScore, fetchBoard, fetchReplay, bytesToBase64, LeaderboardError } from './net/leaderboard.ts';
import { checkName } from '../shared/moderation.ts';
import type { ApiMode, LeaderboardRow } from '../shared/api.ts';
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
// Belt and braces for iOS: during a run nothing on the race screen may start a
// text selection, whatever the CSS says.
gameEl.addEventListener('selectstart', (e) => e.preventDefault());
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
// Drift Run is the game's main mode: it is listed first and chosen by default.
let currentMode: SimMode = 'driftRun';
let session: GameSession | null = null;
let lastOutcome: RunOutcome | null = null;
/** Which board the route screen is showing. */
let boardMode: SimMode = 'driftRun';
/** Row id of the score just posted, so it can be highlighted on the board. */
let myLastRowId: string | null = null;

/**
 * The leaderboard run picked to race against. It belongs to one board: a
 * ghost from the Drift Run board is not raced in Time Attack.
 */
interface GhostPick {
  row: LeaderboardRow;
  board: ApiMode;
  routeId: string;
  routeVersion: number;
  /** Fetched as soon as it is picked, so Go does not wait on the network. */
  input: Promise<Uint8Array>;
}
let ghostPick: GhostPick | null = null;
/** The ghost the last run raced, for the results. */
let runGhost: { row: LeaderboardRow; track: GhostTrack } | null = null;

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
  zoneChip: $('zone-chip'),
  zoneMarks: $('zone-marks'),
  gauge: new DriftGauge($('drift-gauge')),
  ghostGap: $('ghost-gap'),
  ghostMark: $('ghost-mark'),
});

const input = new InputController();
input.setKeymap(settings.keymap);

/** Touch anywhere during a run and slide sideways to steer. */
const thumb = new ThumbSteer($('steer-surface'), (value) => input.setTouchSteer(value));
thumb.setSensitivity(settings.steerSensitivity);

/** Drift Run's throttle controls: tap the left half to drift, hold the right. */
const proPedals = new ProPedals($('pro-surface'), {
  onThrottle: (held) => input.setTouchThrottle(held),
  onBrake: (held) => input.setTouchBrake(held),
});

const pedals = new PedalTouch($('pedal-surface'), {
  onThrottle: (held) => input.setTouchThrottle(held),
  onDrift: (held) => (held ? input.pressDrift() : input.releaseDrift()),
});

hud.setDriftPad(pedals.driftZone);

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
    ...ROUTES.map((entry) => {
      const button = document.createElement('button');
      button.className = 'card';

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'card__name';
      name.textContent = entry.name;
      const meta = document.createElement('div');
      meta.className = 'card__meta';

      // Every route is open from the start, and the card always carries the
      // route's own line rather than a best time.
      meta.textContent = entry.blurb;

      left.append(name, meta);
      button.append(left, flagElement(entry.country, entry.location));
      button.addEventListener('click', () => void openIntro(entry));
      return button;
    }),
  );
}

// --- Route intro / course map ----------------------------------------------

async function openIntro(entry: RouteEntry): Promise<void> {
  currentEntry = entry;
  currentRoute = await loadRoute(entry);
  if (ghostPick && ghostPick.routeId !== currentRoute.id) setGhostPick(null);
  $('intro-name').textContent = entry.name;
  $('intro-location').textContent = entry.location;
  // Routes built from someone else's data say whose. Required by the ODbL for
  // the OpenStreetMap ones, and only fair for anything else.
  const credit = currentRoute.attribution ?? entry.attribution ?? '';
  $('intro-credit').textContent = credit;
  $('intro-credit').hidden = credit === '';

  const route = currentRoute;

  showPoster(route);
  showIntroCar();
  // The board opens on the mode last driven, so coming back from a Drift Run
  // shows the drift scores.
  setBoardMode(currentMode);
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

/**
 * The mode picked on a route's page. It is also the leaderboard shown there:
 * choosing Drift Run shows the drift scores, with a label saying so.
 */
function setBoardMode(mode: SimMode): void {
  boardMode = mode;
  const pro = settings.timeAttackLevel === 'pro';
  $('btn-time-attack').setAttribute('aria-pressed', String(mode === 'timeAttack'));
  $('btn-drift-run').setAttribute('aria-pressed', String(mode === 'driftRun'));
  $('level-row').hidden = mode !== 'timeAttack';
  $('btn-level-easy').setAttribute('aria-pressed', String(!pro));
  $('btn-level-pro').setAttribute('aria-pressed', String(pro));
  $('level-note').textContent = pro ? 'You work the gas and brake.' : 'The car brakes for corners.';
  $('board-title').textContent = `Leaderboard · ${boardTitle(pageBoard())}`;
  // A ghost belongs to the board it was picked from.
  if (ghostPick && ghostPick.board !== pageBoard()) setGhostPick(null);
  void refreshBoard();
}

function setTimeAttackLevel(level: 'easy' | 'pro'): void {
  settings.timeAttackLevel = level;
  saveSettings(settings);
  setBoardMode(boardMode);
}

/** The board a run belongs to: Time Attack on pedals has its own. */
function boardFor(mode: SimMode, controls: Controls): ApiMode {
  return mode === 'timeAttack' && controls === 'pedals' ? 'timeAttackPro' : mode;
}

/** The board the route page is showing: its mode, and for Time Attack the level. */
function pageBoard(): ApiMode {
  return boardFor(boardMode, settings.timeAttackLevel === 'pro' ? 'pedals' : 'steer');
}

function boardTitle(board: ApiMode): string {
  return board === 'driftRun' ? 'Drift Run' : board === 'timeAttackPro' ? 'Time Attack · Pro' : 'Time Attack · Easy';
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
  // Taken now: the player can switch mode or level while this is in flight.
  const mode = boardMode;
  const key = pageBoard();

  container.replaceChildren(caption('Loading…'));

  try {
    const board = await fetchBoard(
      route.id,
      key,
      'all',
      route.version,
      SIM_VERSION,
    );
    if (key !== pageBoard()) return;
    if (board.rows.length === 0) {
      container.replaceChildren(caption('No times posted yet. Be first.'));
      return;
    }
    container.replaceChildren(...board.rows.map((row) => boardRow(row, mode, key)));
  } catch (err) {
    const message =
      err instanceof LeaderboardError ? err.message : 'Could not reach the leaderboard.';
    container.replaceChildren(caption(message));
  }
}

/** One leaderboard row, formatted for the board it is on -- not for whichever tab the route page last showed. */
function boardRow(row: LeaderboardRow, mode: SimMode, board: ApiMode): HTMLElement {
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
    mode === 'timeAttack'
      ? formatTime(row.timeMs / 1000)
      : row.points.toLocaleString('en-GB');
  if (mode === 'driftRun') {
    const time = document.createElement('span');
    time.className = 'board__car';
    time.style.textAlign = 'right';
    time.textContent = formatTime(row.timeMs / 1000);
    value.appendChild(time);
  }

  el.append(rank, name, value);

  // Race this run: its stored inputs, driven again beside the player.
  if (row.hasReplay) {
    const ghost = document.createElement('button');
    ghost.type = 'button';
    ghost.className = 'board__ghost';
    ghost.textContent = 'Ghost';
    ghost.dataset.ghostId = row.id;
    ghost.setAttribute('aria-label', `Race ${row.playerName}'s ghost`);
    ghost.setAttribute('aria-pressed', String(ghostPick?.row.id === row.id));
    ghost.addEventListener('click', () => toggleGhost(row, board));
    el.append(ghost);
  } else {
    el.append(document.createElement('span'));
  }
  return el;
}

// --- Ghosts -----------------------------------------------------------------

function toggleGhost(row: LeaderboardRow, board: ApiMode): void {
  const route = currentRoute;
  if (!route) return;
  if (ghostPick?.row.id === row.id) {
    setGhostPick(null);
    return;
  }
  const input = fetchReplay(row.id).then((gz) => decompress(gz));
  const pick: GhostPick = { row, board, routeId: route.id, routeVersion: route.version, input };
  // The ghost's car art, so it is there when the race starts.
  void preload([carById(row.carId).sprite?.path]);
  input.catch(() => {
    if (ghostPick !== pick) return;
    setGhostPick(null);
    showGhostNote(`Could not load ${row.playerName}'s ghost.`);
  });
  setGhostPick(pick);
}

function setGhostPick(pick: GhostPick | null): void {
  ghostPick = pick;
  for (const button of document.querySelectorAll<HTMLElement>('.board__ghost')) {
    button.setAttribute('aria-pressed', String(!!pick && button.dataset.ghostId === pick.row.id));
  }
  if (pick) {
    const r = pick.row;
    const value = pick.board === 'driftRun' ? r.points.toLocaleString('en-GB') : formatTime(r.timeMs / 1000);
    showGhostNote(`Racing ${r.playerName}'s ghost · ${carById(r.carId).name} · ${value}`, true);
  } else {
    showGhostNote('');
  }
}

/** The line under the mode buttons saying which ghost Go will race. */
function showGhostNote(text: string, removable = false): void {
  $('ghost-note-text').textContent = text;
  $('btn-ghost-clear').hidden = !removable;
  $('ghost-note').hidden = text === '';
}

/** The picked ghost, driven in full, if it belongs to this run's route and board. */
async function loadGhostFor(route: RouteData, board: ApiMode, mode: SimMode): Promise<GhostTrack | null> {
  const pick = ghostPick;
  if (!pick || pick.board !== board || pick.routeId !== route.id || pick.routeVersion !== route.version) return null;
  try {
    const bytes = await pick.input;
    // The controls the ghost was driven with: only throttle Drift Runs are
    // posted, and Time Attack's board says which level.
    const controls: Controls = board === 'driftRun' ? 'throttle' : board === 'timeAttackPro' ? 'pedals' : 'steer';
    return buildGhost(pick.row.playerName, carById(pick.row.carId), route, configFor(mode, controls), bytes);
  } catch {
    return null;
  }
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

/**
 * Where the garage goes back to. From a route's page it is a detour: picking a
 * car returns to that route rather than to the main menu.
 */
let garageReturn: 'title' | 'intro' = 'title';

function openGarage(from: 'title' | 'intro'): void {
  garageReturn = from;
  buildCarList();
  showScreen('garage');
}

function leaveGarage(): void {
  if (garageReturn === 'intro') {
    showIntroCar();
    showScreen('intro');
  } else {
    showScreen('title');
  }
}

/** The selected car on a route's page: its hero image (or top-down drawing) and name. */
function showIntroCar(): void {
  const car = carById(settings.carId);
  $('intro-car-name').textContent = car.name;
  const img = $<HTMLImageElement>('intro-car-sprite');
  const src = car.hero ?? car.sprite?.path;
  img.hidden = !src;
  if (src) img.src = src;
  // The top-down drawing is laid on its side to fit; the hero is already wide.
  img.classList.toggle('intro-car__img--sprite', !car.hero);
}

// --- Route poster, zoomed ---------------------------------------------------

/**
 * The route's painting full screen, at a size a phone can actually read: as
 * tall as the screen and as wide as that makes it, to drag across. The full
 * resolution copy loads only here.
 */
function openPosterZoom(): void {
  const art = currentEntry.poster;
  if (!art) return;
  const box = $('poster-lightbox');
  const img = $<HTMLImageElement>('lightbox-img');
  drawPosterOverlay($('lightbox-overlay') as unknown as SVGSVGElement, art);
  // Start on the smaller copy, already loaded, and swap in the sharp one.
  img.src = art.src;
  const sharp = new Image();
  sharp.onload = () => {
    if (!box.hidden) img.src = art.full;
  };
  sharp.src = art.full;
  box.hidden = false;
  // Centre the view on the painting.
  requestAnimationFrame(() => {
    const scroller = $('lightbox-scroll');
    scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) / 2;
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
  });
}

function closePosterZoom(): void {
  $('poster-lightbox').hidden = true;
}

function buildCarList(): void {
  $('car-list').replaceChildren(
    ...CARS.map((car) => {
      const button = document.createElement('button');
      button.className = 'car-card';
      if (car.id === settings.carId) button.classList.add('car-card--selected');

      const body = document.createElement('div');
      body.className = 'car-card__body';
      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'card__name';
      name.textContent = car.name;
      const meta = document.createElement('div');
      meta.className = 'card__meta';
      meta.textContent =
        `${PROFILES[car.engine].label} · top ${Math.round(realKmh(car.handling.topSpeed))} km/h` +
        (car.zeroTo100 ? ` · 0-100 in ${car.zeroTo100}s` : '') +
        (tuneMode && isTuned(car) ? ' · tuned' : '');
      left.append(name, meta);
      if (car.tagline) {
        const line = document.createElement('div');
        line.className = 'car-card__tagline';
        line.textContent = car.tagline;
        left.appendChild(line);
      }
      if (car.stats) left.appendChild(carStats(car.stats));
      body.append(left);
      // The selected car is already marked by its border; its card offers the
      // next step instead. Tapping it again goes to the routes -- or, when the
      // garage was opened from a route, back to that route.
      const selected = car.id === settings.carId;
      if (selected) {
        const go = document.createElement('span');
        go.className = 'go-race';
        go.textContent = garageReturn === 'intro' ? 'Use this car' : 'Go race';
        body.appendChild(go);
      }

      button.append(carHero(car), body);
      button.addEventListener('click', () => {
        if (!selected) {
          settings.carId = car.id;
          saveSettings(settings);
        }
        if (garageReturn === 'intro') {
          // Picked from a route's page: straight back to it.
          leaveGarage();
          return;
        }
        if (selected) {
          buildRouteList();
          showScreen('routes');
          return;
        }
        buildCarList();
      });
      return button;
    }),
  );
}

/** The car's character, as six rows of 1-5 pips. */
function carStats(stats: NonNullable<(typeof CARS)[number]['stats']>): HTMLElement {
  const el = document.createElement('div');
  el.className = 'car-stats';
  const rows: [string, number][] = [
    ['Acceleration', stats.accel],
    ['Top speed', stats.topSpeed],
    ['Grip', stats.grip],
    ['Drift', stats.drift],
    ['Agility', stats.agility],
    ['Stability', stats.stability],
  ];
  for (const [label, value] of rows) {
    const name = document.createElement('span');
    name.className = 'car-stats__label';
    name.textContent = label;
    const pips = document.createElement('span');
    pips.className = 'car-stats__pips';
    pips.setAttribute('aria-label', `${value} of 5`);
    for (let i = 1; i <= 5; i++) {
      const pip = document.createElement('span');
      pip.className = i <= value ? 'car-stats__pip car-stats__pip--on' : 'car-stats__pip';
      pips.appendChild(pip);
    }
    el.append(name, pips);
  }
  return el;
}

/**
 * A car's hero image, or a placeholder in its place: the top-down drawing (if
 * there is one) laid on its side over a hatched panel, in the car's colour.
 */
function carHero(car: (typeof CARS)[number]): HTMLElement {
  const hero = document.createElement('div');
  hero.className = 'car-hero';
  if (car.hero) {
    const img = document.createElement('img');
    img.src = car.hero;
    img.alt = car.name;
    img.decoding = 'async';
    img.loading = 'lazy';
    hero.appendChild(img);
    return hero;
  }
  hero.classList.add('car-hero--placeholder');
  hero.style.setProperty('--car-tint', car.tint ?? '#e8402a');
  if (car.sprite) {
    const img = document.createElement('img');
    img.className = 'car-hero__sprite';
    img.src = car.sprite.path;
    img.alt = '';
    hero.appendChild(img);
  } else {
    const shape = document.createElement('div');
    shape.className = 'car-hero__shape';
    hero.appendChild(shape);
  }
  const label = document.createElement('div');
  label.className = 'mono car-hero__label';
  label.textContent = 'HERO ART TO COME';
  hero.appendChild(label);
  return hero;
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
    ['hint-gas', 'throttle'],
    ['hint-brake', 'brake'],
    ['hint-drift', 'drift'],
  ];
  for (const [id, action] of map) {
    $(id).textContent = keyLabel(settings.keymap[action][0]);
  }
}

// --- Running ----------------------------------------------------------------

let audio: EngineAudio | null = null;

/**
 * Start a run. A restart keeps the engine sound of the run it replaces: it may
 * come from holding the pause button, which is not a tap, and a phone will not
 * start new sound without one.
 */
async function startRun(mode: SimMode, restart = false): Promise<void> {
  if (!currentRoute) return;
  currentMode = mode;

  const car = carById(settings.carId);
  currentControls =
    mode === 'driftRun' ? settings.driftControls : settings.timeAttackLevel === 'pro' ? 'pedals' : 'steer';
  gameEl.dataset.controls = currentControls;
  gameEl.dataset.mode = currentMode;
  const renderSettings: RenderSettings = {
    fixedNorth: settings.fixedNorth,
    showSkidMarks: settings.showSkidMarks,
    showSmoke: settings.showSmoke,
  };

  syncKeyHints();

  if (!restart || !audio) audio = new EngineAudio(settings.soundOn);
  // Started from the click that got us here, which is the gesture the browser
  // requires before an AudioContext will run.
  void audio.start(car.engine);

  // After the audio: that has to start inside the tap on Go, before any wait.
  const ghostTrack = await loadGhostFor(currentRoute, boardFor(mode, currentControls), mode);
  runGhost = ghostTrack && ghostPick ? { row: ghostPick.row, track: ghostTrack } : null;
  if (ghostPick && !ghostTrack) showGhostNote(`${ghostPick.row.playerName}'s ghost could not be replayed.`);
  hud.setGhost(ghostTrack);

  session = new GameSession(
    currentRoute,
    car,
    configFor(mode, currentControls),
    input,
    renderer,
    hud,
    audio,
    renderSettings,
    ghostTrack,
  );

  const countdownOverlay = $('overlay-countdown');
  const countdownEl = $('countdown');
  $('countdown-mode').textContent =
    mode === 'driftRun' ? 'DRIFT RUN' : currentControls === 'pedals' ? 'TIME ATTACK · PRO' : 'TIME ATTACK';
  const keys = gameEl.dataset.input === 'keyboard';
  const key = (a: Action) => keyLabel(settings.keymap[a][0]);
  $('countdown-hint').textContent =
    currentControls === 'throttle'
      ? keys
        ? `Hold ${key('throttle')} for throttle. Press ${key('drift')} before a corner to drift: a tap is a soft kick, a short press a full one, too long and you spin. Then balance the angle with the throttle.`
        : 'Hold the right side for throttle. Press the left side before a corner to drift: a tap is a soft kick, a short press a full one, too long and you spin. Then balance the angle with the throttle.'
      : currentControls === 'pedals'
        ? keys
          ? `${key('left')} ${key('right')} to steer, ${key('throttle')} for gas, ${key('brake')} to brake. No help with speed: brake for the corners yourself.`
          : 'Left half: slide to steer. Right half: gas on the outside, brake on the inside. No help with speed: brake for the corners yourself.'
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
  proPedals.releaseAll();
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
    mode: boardFor(currentMode, currentControls),
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
      await saveReplay(bestKey(route.id, route.version, boardFor(currentMode, currentControls)), gz);
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
  const rows: HTMLElement[] = [statRow('Time', formatTime(result.timeSeconds))];

  if (currentMode === 'driftRun') {
    // The score as a sum the player can follow: what drifting earned, what the
    // run's record added and took away, and the total.
    rows.push(
      scoreRow('Points earned', 'drifting', result.earned, false),
      scoreRow('Zones cleared', `${result.zonesCleared} / ${result.zonesTotal}`, result.zoneBonus, true),
      scoreRow('Transitions', String(result.reversals), result.transitionBonus, true),
      scoreRow('Spins', String(result.spins), -result.spinPenalty, true),
      scoreRow('Wall hits', String(result.wallHits), -result.wallPenalty, true),
      totalRow('Final score', result.points.toLocaleString('en-GB')),
    );
  } else {
    rows.push(statRow('Wall hits', String(result.wallHits)));
    if (result.wallHits > 0) rows.push(statRow('Time penalty', `+${(result.wallHits * 2).toFixed(0)}s`));
  }

  if (runGhost) {
    const g = runGhost.row;
    if (currentMode === 'driftRun') {
      const diff = result.points - g.points;
      rows.push(
        statRow(
          `vs ${g.playerName}'s ghost`,
          diff >= 0 ? `Won by ${diff.toLocaleString('en-GB')}` : `Lost by ${(-diff).toLocaleString('en-GB')}`,
        ),
      );
    } else {
      const diff = result.timeSeconds - g.timeMs / 1000;
      rows.push(
        statRow(`vs ${g.playerName}'s ghost`, diff <= 0 ? `Won by ${(-diff).toFixed(2)}s` : `Lost by ${diff.toFixed(2)}s`),
      );
    }
  }

  const best = getBest(route.id, route.version, boardFor(currentMode, currentControls));
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
  if (!unranked) void showResultBoard();
}

/** A line of the score: what it was for, how many, and what it added or took. */
function scoreRow(label: string, detail: string, amount: number, signed: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = 'score-row';
  const name = document.createElement('span');
  name.className = 'score-row__label';
  name.textContent = label;
  const count = document.createElement('span');
  count.className = 'score-row__detail';
  count.textContent = detail;
  const value = document.createElement('span');
  value.className = 'score-row__value';
  const n = Math.abs(amount).toLocaleString('en-GB');
  value.textContent = !signed ? n : amount > 0 ? `+${n}` : amount < 0 ? `−${n}` : '0';
  if (signed && amount > 0) value.classList.add('score-row__value--plus');
  if (signed && amount < 0) value.classList.add('score-row__value--minus');
  el.append(name, count, value);
  return el;
}

function totalRow(label: string, value: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'score-total';
  const name = document.createElement('span');
  name.className = 'label';
  name.textContent = label;
  const v = document.createElement('span');
  v.className = 'display score-total__value';
  v.textContent = value;
  el.append(name, v);
  return el;
}

/** The top 20 for this route and mode, under the results, with the player's row marked. */
async function showResultBoard(fresh = false): Promise<void> {
  const route = currentRoute;
  const container = $('result-board-rows');
  if (!route) return;
  const mode = currentMode;
  const key = boardFor(currentMode, currentControls);
  $('result-board-title').textContent = `Top 20 · ${boardTitle(key)}`;
  container.replaceChildren(caption('Loading…'));
  try {
    const board = await fetchBoard(route.id, key, 'all', route.version, SIM_VERSION, fresh);
    container.replaceChildren(
      ...(board.rows.length === 0
        ? [caption('No scores posted yet. Be first.')]
        : board.rows.map((row) => boardRow(row, mode, key))),
    );
  } catch (err) {
    container.replaceChildren(
      caption(err instanceof LeaderboardError ? err.message : 'Could not reach the leaderboard.'),
    );
  }
}

function quitRun(): void {
  thumb.releaseAll();
  pedals.releaseAll();
  proPedals.releaseAll();
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
  delete $('post-status').dataset.top;
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
      mode: boardFor(currentMode, currentControls),
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
      ? `You're #${response.rank} in the top 20.`
      : `You're #${response.rank} — the top 20 make the board.`;
    status.dataset.top = String(response.inTop20);
    void showResultBoard(true);
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
$('btn-garage').addEventListener('click', () => openGarage('title'));
$('btn-intro-car').addEventListener('click', () => openGarage('intro'));
$('poster-art').addEventListener('click', openPosterZoom);
$('poster-art').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') openPosterZoom();
});
// A tap closes it; a drag only looks around (a drag does not produce a click).
$('poster-lightbox').addEventListener('click', closePosterZoom);
$('btn-settings').addEventListener('click', () => showScreen('settings'));
$('btn-sound-lab').addEventListener('click', () => {
  for (const key of Object.keys(SCREENS) as ScreenName[]) SCREENS[key].hidden = true;
  soundLab.open(carById(settings.carId).engine);
});
$('btn-routes-back').addEventListener('click', () => showScreen('title'));
$('btn-garage-back').addEventListener('click', leaveGarage);
$('btn-settings-back').addEventListener('click', () => showScreen('title'));
$('btn-intro-back').addEventListener('click', () => {
  buildRouteList();
  showScreen('routes');
});
$('btn-time-attack').addEventListener('click', () => setBoardMode('timeAttack'));
$('btn-drift-run').addEventListener('click', () => setBoardMode('driftRun'));
$('btn-go').addEventListener('click', () => void startRun(boardMode));
$('btn-ghost-clear').addEventListener('click', () => setGhostPick(null));
$('btn-level-easy').addEventListener('click', () => setTimeAttackLevel('easy'));
$('btn-level-pro').addEventListener('click', () => setTimeAttackLevel('pro'));
$('btn-retry').addEventListener('click', () => void startRun(currentMode));
$('btn-result-routes').addEventListener('click', () => {
  buildRouteList();
  showScreen('routes');
});
$('btn-result-title').addEventListener('click', () => showScreen('title'));
$('btn-post').addEventListener('click', () => void postScore());
$('player-name').addEventListener('input', validateNameField);
$('btn-quit').addEventListener('click', quitRun);
$('btn-resume').addEventListener('click', resumeRun);
$('btn-restart').addEventListener('click', restartRun);

// The pause button: a tap pauses; holding it fills a ring round the button
// and restarts the run when the ring closes. The run carries on meanwhile, so
// a restart costs no more than the two seconds.
const RESTART_HOLD_MS = 2000;
const pauseBtn = $('btn-pause');
let restartTimer = 0;
let holdPointer: number | null = null;

function endHold(): void {
  window.clearTimeout(restartTimer);
  restartTimer = 0;
  holdPointer = null;
  pauseBtn.classList.remove('pause-btn--holding');
  gameEl.classList.remove('restart-holding');
}

pauseBtn.addEventListener('pointerdown', (e) => {
  if (!isRunActive() || holdPointer !== null) return;
  e.preventDefault();
  holdPointer = e.pointerId;
  try {
    pauseBtn.setPointerCapture(e.pointerId);
  } catch {
    // Synthetic pointer; the hold still works.
  }
  pauseBtn.classList.add('pause-btn--holding');
  gameEl.classList.add('restart-holding');
  restartTimer = window.setTimeout(() => {
    endHold();
    restartRun();
  }, RESTART_HOLD_MS);
});
pauseBtn.addEventListener('pointerup', (e) => {
  if (e.pointerId !== holdPointer) return;
  // Let go before the ring closed: that was a tap, or a change of mind.
  endHold();
  pauseRun();
});
pauseBtn.addEventListener('pointercancel', (e) => {
  if (e.pointerId === holdPointer) endHold();
});
pauseBtn.addEventListener('contextmenu', (e) => e.preventDefault());
// Keyboard activation still pauses; pointer taps are handled above.
pauseBtn.addEventListener('click', (e) => {
  if (e.detail === 0) pauseRun();
});

/** Start the same run again from the line: same route, mode, car and ghost. */
function restartRun(): void {
  if (!isRunActive()) return;
  endHold();
  thumb.releaseAll();
  pedals.releaseAll();
  proPedals.releaseAll();
  input.releaseAll();
  session?.abandon();
  session = null;
  $('overlay-paused').hidden = true;
  void startRun(currentMode, true);
}

function isRunActive(): boolean {
  return !gameEl.hidden && !!session && session.phase !== 'finished' && session.phase !== 'aborted';
}

function pauseRun(): void {
  if (!isRunActive() || !$('overlay-paused').hidden) return;
  session?.stop();
  // A thumb resting on the screen must not come back steering on resume.
  thumb.releaseAll();
  pedals.releaseAll();
  proPedals.releaseAll();
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
  proPedals.releaseAll();
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
