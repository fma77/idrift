#!/usr/bin/env node
/**
 * Route baker.
 *
 * Turns a route *spec* -- either a plain-language corner sequence or an
 * OpenStreetMap way -- into the baked, immutable route JSON the sim consumes.
 *
 * This is a one-off conversion script, not a live in-app editor, and that is
 * deliberate: routes are immutable once a leaderboard exists against them, so
 * the authoring step should be an explicit, reviewable, committed artefact.
 * Iteration happens by editing the spec and re-baking with a bumped version,
 * or by hand-editing numbers in the baked file.
 *
 * Usage:
 *   node tools/bake-route.mjs tools/specs/<name>.json
 *   node tools/bake-route.mjs --osm <overpass-way-id> --out public/routes/<id>.json
 *
 * Unlike src/sim/**, this file may use Math.sin and friends freely: its output
 * is committed data, so it is baked once on one machine and every player then
 * reads identical numbers. The determinism rules exist to stop *runtime*
 * divergence between devices, which cannot happen here.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Centreline generation from a corner-sequence description
// ---------------------------------------------------------------------------

/**
 * Build a curvature profile, one entry per arc-length sample.
 *
 * Corners get a clothoid-style easing ramp at each end rather than a step
 * change in curvature. A step would be undrivable (the front tyre would be
 * asked for infinite lateral force in one tick) and would also defeat the apex
 * detection below, which looks for a curvature maximum.
 */
function curvatureProfile(segments, ds) {
  const k = [];
  const widths = [];
  const grips = [];

  for (const seg of segments) {
    const width = seg.width ?? null;
    const grip = seg.grip ?? null;

    if (seg.type === 'straight') {
      const n = Math.max(1, Math.round(seg.length / ds));
      for (let i = 0; i < n; i++) {
        k.push(0);
        widths.push(width);
        grips.push(grip);
      }
      continue;
    }

    if (seg.type !== 'corner') {
      throw new Error(`Unknown segment type: ${seg.type}`);
    }

    const sign = seg.direction === 'left' ? 1 : -1;
    const peak = sign / seg.radius;
    const arcLength = seg.radius * seg.angle * DEG;
    // Easing length defaults to a third of the arc, capped so tight hairpins
    // still spend real distance at full lock.
    const ease = Math.min(seg.ease ?? arcLength / 3, arcLength / 2);
    const total = arcLength + ease; // easing adds length either side
    const n = Math.max(3, Math.round(total / ds));

    for (let i = 0; i < n; i++) {
      const s = (i / (n - 1)) * total;
      let factor;
      if (s < ease) factor = s / ease;
      else if (s > total - ease) factor = (total - s) / ease;
      else factor = 1;
      // Smoothstep the ramp so curvature has a continuous first derivative.
      const f = factor * factor * (3 - 2 * factor);
      k.push(peak * f);
      widths.push(width);
      grips.push(grip);
    }
  }

  return { k, widths, grips };
}

/** Integrate a curvature profile into positions and headings. */
function integrate(k, ds, startHeading = 0) {
  const x = [];
  const y = [];
  const heading = [];
  let h = startHeading;
  let px = 0;
  let py = 0;
  for (let i = 0; i < k.length; i++) {
    x.push(px);
    y.push(py);
    heading.push(h);
    // Midpoint heading over the step keeps the path from drifting outward on
    // tight corners the way plain forward Euler does.
    const hMid = h + (k[i] * ds) / 2;
    px += Math.cos(hMid) * ds;
    py += Math.sin(hMid) * ds;
    h += k[i] * ds;
  }
  return { x, y, heading };
}

// ---------------------------------------------------------------------------
// OpenStreetMap import
// ---------------------------------------------------------------------------

const OVERPASS = 'https://overpass-api.de/api/interpreter';

/**
 * Pull a way's node geometry from Overpass and project it to local metres.
 *
 * OSM coverage for touge and drift venues is patchy -- many are private land,
 * unnamed forestry roads, or simply not mapped in enough detail to drive. When
 * this returns something unusable, fall back to describing the corner sequence
 * instead; the baked output is the same either way.
 */
async function fetchOsmWay(wayId) {
  const query = `[out:json][timeout:30];way(${wayId});(._;>;);out body;`;
  const res = await fetch(OVERPASS, { method: 'POST', body: query });
  if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
  const data = await res.json();

  const nodes = new Map();
  let wayNodes = null;
  for (const el of data.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way' && el.id === Number(wayId)) wayNodes = el.nodes;
  }
  if (!wayNodes) throw new Error(`Way ${wayId} not found in Overpass response`);

  const pts = wayNodes.map((id) => nodes.get(id)).filter(Boolean);
  if (pts.length < 2) throw new Error(`Way ${wayId} has too few nodes`);

  // Equirectangular projection about the first node. Fine at route scale
  // (a few km); the distortion is far below the resampling interval.
  const lat0 = pts[0].lat * DEG;
  const R = 6378137;
  return pts.map((p) => ({
    x: (p.lon * DEG - pts[0].lon * DEG) * Math.cos(lat0) * R,
    y: (p.lat * DEG - lat0) * R,
  }));
}

/** Resample an arbitrary polyline to fixed arc-length intervals. */
function resamplePolyline(points, ds) {
  const out = [{ x: points[0].x, y: points[0].y }];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1].x;
    const ay = points[i - 1].y;
    const bx = points[i].x;
    const by = points[i].y;
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen === 0) continue;
    let t = carry;
    while (t + ds <= segLen) {
      t += ds;
      out.push({ x: ax + ((bx - ax) * t) / segLen, y: ay + ((by - ay) * t) / segLen });
    }
    carry = t + ds - segLen;
    carry = ds - (segLen - t);
  }
  return out;
}

/** Heading and curvature from a resampled polyline, by finite difference. */
function derivePolylineGeometry(points, ds) {
  const n = points.length;
  const heading = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    heading[i] = Math.atan2(b.y - a.y, b.x - a.x);
  }
  const k = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    let dh = heading[i + 1] - heading[i - 1];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    k[i] = dh / (2 * ds);
  }
  return { heading, k };
}

// ---------------------------------------------------------------------------
// Scoring-data derivation from curvature
// ---------------------------------------------------------------------------

/** Moving average. Removes finite-difference noise before apex detection. */
function smooth(values, halfWindow) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(values.length - 1, i + halfWindow); j++) {
      sum += values[j];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

function severityFromRadius(radius) {
  if (radius < 20) return 6;
  if (radius < 30) return 5;
  if (radius < 45) return 4;
  if (radius < 70) return 3;
  if (radius < 100) return 2;
  return 1;
}

/**
 * Find corners as contiguous runs of significant curvature, and their apexes as
 * the local curvature maximum within each run.
 *
 * This is the "first pass, then hand-tune" step the brief asks for: the output
 * is written into the baked JSON as plain numbers, so a corner that feels wrong
 * is fixed by editing those numbers, not by changing this heuristic.
 */
function deriveCorners(k, ds) {
  // 1/90m: anything straighter than a 90m radius is a kink, not a corner.
  const THRESHOLD = 1 / 90;
  const smoothed = smooth(k, 3);
  const corners = [];

  let i = 0;
  while (i < smoothed.length) {
    if (Math.abs(smoothed[i]) < THRESHOLD) {
      i++;
      continue;
    }
    const sign = smoothed[i] >= 0 ? 1 : -1;
    const start = i;
    let apex = i;
    let peak = Math.abs(smoothed[i]);
    while (
      i < smoothed.length &&
      Math.abs(smoothed[i]) >= THRESHOLD * 0.6 &&
      (smoothed[i] >= 0 ? 1 : -1) === sign
    ) {
      if (Math.abs(smoothed[i]) > peak) {
        peak = Math.abs(smoothed[i]);
        apex = i;
      }
      i++;
    }
    const end = i - 1;
    // Ignore blips shorter than 8 metres of arc.
    if ((end - start) * ds < 8) continue;

    corners.push({
      startIndex: start,
      apexIndex: apex,
      endIndex: end,
      sign,
      severity: severityFromRadius(1 / peak),
      peakCurvature: peak,
    });
  }
  return corners;
}

function deriveClipPoints(corners, halfWidth) {
  return corners.map((c) => ({
    index: c.apexIndex,
    // Inside of the corner: left turn (sign +1) clips on the left.
    offset: c.sign * halfWidth[c.apexIndex] * 0.65,
    radius: 3.5,
  }));
}

function deriveDriftZones(corners, ds) {
  // Lead-in so initiation before the corner counts, and a run-out so the exit
  // drift is still being scored as the car straightens.
  const leadIn = Math.round(18 / ds);
  const runOut = Math.round(12 / ds);
  return corners
    .filter((c) => c.severity >= 3)
    .map((c, i) => ({
      entryIndex: Math.max(0, c.startIndex - leadIn),
      exitIndex: c.endIndex + runOut,
      cornerIndex: i,
      baseMultiplier: Number((0.8 + c.severity * 0.12).toFixed(2)),
    }));
}

/**
 * Lower bound on lap time: drive every sample at the cornering limit, with no
 * time lost to braking, transitions or reaction. Nothing human can reach it,
 * which is exactly what a sanity bound needs -- it rejects impossible
 * submissions without ever rejecting a real one.
 */
function theoreticalMinTime(k, ds, grip) {
  const MU = 1.6 * grip; // generous: more grip than any car in the game has
  const G = 9.80665;
  const V_MAX = 75; // m/s, beyond any car's top speed
  let t = 0;
  for (let i = 0; i < k.length; i++) {
    const kk = Math.abs(k[i]);
    const v = kk < 1e-6 ? V_MAX : Math.min(V_MAX, Math.sqrt((MU * G) / kk));
    t += ds / v;
  }
  return Number(t.toFixed(2));
}

/** Upper bound on drift points, using the same generous logic in reverse. */
function theoreticalMaxPoints(zones, ds) {
  const PER_SECOND = 900 * 1.4 * 1 * 1; // angle, speed, line factors all maxed
  const MAX_MULT = 8;
  const MAX_STYLE = 1.5;
  let total = 0;
  for (const z of zones) {
    const metres = (z.exitIndex - z.entryIndex) * ds;
    // Assume the whole zone is taken at a barely-drifting 8 m/s, which
    // maximises time-in-zone and therefore points.
    const seconds = metres / 8;
    total += PER_SECOND * z.baseMultiplier * MAX_MULT * seconds;
  }
  return Math.round(total * MAX_STYLE);
}

// ---------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------

/**
 * Small deterministic PRNG so re-baking a route produces the same scenery.
 * Nothing here reaches the sim, but a baked file that changes on every run is
 * a miserable thing to keep in version control.
 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Generate the decoration layer.
 *
 * Written to a SEPARATE file from the route, and never merged into it. The
 * brief is firm about this and it is the right call: decoration must not be
 * able to affect physics or scoring, so that re-scattering the trees can never
 * invalidate a leaderboard. Keeping it in its own file makes that structural
 * rather than a rule someone has to remember.
 *
 * Every object carries the centreline index it sits nearest to, so the renderer
 * can cull it with the same window it uses for the road instead of doing a
 * spatial query every frame.
 */
function bakeDecoration(route) {
  const rand = lcg(route.seed ^ 0x5eed);
  const s = route.samples;
  const objects = [];

  for (let i = 0; i < s.x.length; i++) {
    const h = s.heading[i];
    const w = s.halfWidth[i];
    const k = Math.abs(s.curvature[i]);

    // Guardrail on the outside of anything tighter than a 60m radius. Cosmetic
    // only -- the wall that actually stops the car is the route's halfWidth.
    if (k > 1 / 60 && i % 3 === 0) {
      const side = s.curvature[i] > 0 ? -1 : 1;
      const off = (w + 1.9) * side;
      objects.push({
        kind: 'guardrail',
        index: i,
        x: round3(s.x[i] - Math.sin(h) * off),
        y: round3(s.y[i] + Math.cos(h) * off),
        rotation: round3(h),
        scale: 1,
      });
    }

    // Trees and posts scattered beyond the shoulder, thinned out so the sides
    // read as texture rather than a hedge.
    if (i % 4 === 0) {
      for (const side of [1, -1]) {
        if (rand() > 0.45) continue;
        const off = (w + 4 + rand() * 11) * side;
        objects.push({
          kind: rand() > 0.22 ? 'tree' : 'post',
          index: i,
          x: round3(s.x[i] - Math.sin(h) * off),
          y: round3(s.y[i] + Math.cos(h) * off),
          rotation: round3(rand() * 6.283),
          scale: round3(0.7 + rand() * 0.8),
        });
      }
    }
  }

  // A marker board at each corner entry, which doubles as a visual pace note.
  for (const corner of route.corners) {
    const i = Math.max(0, corner.startIndex - 6);
    const h = s.heading[i];
    const side = corner.sign > 0 ? -1 : 1;
    const off = (s.halfWidth[i] + 1.4) * side;
    objects.push({
      kind: 'marker',
      index: i,
      x: round3(s.x[i] - Math.sin(h) * off),
      y: round3(s.y[i] + Math.cos(h) * off),
      rotation: round3(h),
      scale: 1,
      severity: corner.severity,
      sign: corner.sign,
    });
  }

  return {
    routeId: route.id,
    routeVersion: route.version,
    // Bumped independently of routeVersion: changing the scenery is explicitly
    // NOT a change to the route, and must never reset a leaderboard.
    decorationVersion: 1,
    palette: { tree: '#1f1f1f', post: '#3a3a3a', guardrail: '#5a564c', marker: '#e8402a' },
    objects,
  };
}

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

function bakeFromSpec(spec) {
  const ds = spec.sampleSpacing ?? 2;
  const { k, widths, grips } = curvatureProfile(spec.segments, ds);
  const { x, y, heading } = integrate(k, ds, (spec.startHeading ?? 0) * DEG);

  const defaultWidth = spec.width ?? 7;
  const defaultGrip = spec.grip ?? 1;
  const halfWidth = widths.map((w) => (w ?? defaultWidth) / 2);
  const grip = grips.map((g) => g ?? defaultGrip);

  const corners = deriveCorners(k, ds);
  const clipPoints = deriveClipPoints(corners, halfWidth);
  const driftZones = deriveDriftZones(corners, ds);

  return {
    id: spec.id,
    version: spec.version ?? 1,
    name: spec.name,
    location: spec.location ?? '',
    seed: spec.seed ?? 1,
    sampleSpacing: ds,
    length: Number(((k.length - 1) * ds).toFixed(2)),
    samples: {
      x: x.map(round3),
      y: y.map(round3),
      heading: heading.map(round5),
      curvature: k.map(round6),
      halfWidth: halfWidth.map(round3),
      grip: grip.map(round3),
    },
    corners,
    clipPoints: clipPoints.map((c) => ({ ...c, offset: round3(c.offset) })),
    driftZones,
    theoreticalMinTime: theoreticalMinTime(k, ds, defaultGrip),
    theoreticalMaxPoints: theoreticalMaxPoints(driftZones, ds),
    decoration: spec.decoration ?? `${spec.id}.deco.json`,
    poster: spec.poster ?? `art/routes/${spec.id}-poster.png`,
  };
}

async function bakeFromOsm(wayId, spec) {
  const ds = spec.sampleSpacing ?? 2;
  const raw = await fetchOsmWay(wayId);
  const points = resamplePolyline(raw, ds);
  const { heading, k } = derivePolylineGeometry(points, ds);
  const defaultWidth = spec.width ?? 7;
  const defaultGrip = spec.grip ?? 1;
  const halfWidth = points.map(() => defaultWidth / 2);
  const grip = points.map(() => defaultGrip);
  const corners = deriveCorners(k, ds);

  return {
    id: spec.id,
    version: spec.version ?? 1,
    name: spec.name,
    location: spec.location ?? '',
    seed: spec.seed ?? 1,
    sampleSpacing: ds,
    length: Number(((points.length - 1) * ds).toFixed(2)),
    samples: {
      x: points.map((p) => round3(p.x)),
      y: points.map((p) => round3(p.y)),
      heading: heading.map(round5),
      curvature: k.map(round6),
      halfWidth: halfWidth.map(round3),
      grip: grip.map(round3),
    },
    corners,
    clipPoints: deriveClipPoints(corners, halfWidth).map((c) => ({ ...c, offset: round3(c.offset) })),
    driftZones: deriveDriftZones(corners, ds),
    theoreticalMinTime: theoreticalMinTime(k, ds, defaultGrip),
    theoreticalMaxPoints: theoreticalMaxPoints(deriveDriftZones(corners, ds), ds),
    decoration: `${spec.id}.deco.json`,
    poster: `art/routes/${spec.id}-poster.png`,
  };
}

const round3 = (v) => Number(v.toFixed(3));
const round5 = (v) => Number(v.toFixed(5));
const round6 = (v) => Number(v.toFixed(6));

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node tools/bake-route.mjs <spec.json> [--out <path>]');
    process.exit(1);
  }

  const osmIndex = args.indexOf('--osm');
  const outIndex = args.indexOf('--out');
  const specPath = resolve(args[0]);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));

  const route =
    osmIndex >= 0 ? await bakeFromOsm(args[osmIndex + 1], spec) : bakeFromSpec(spec);

  const out =
    outIndex >= 0
      ? resolve(args[outIndex + 1])
      : resolve(dirname(specPath), '../../public/routes', `${route.id}.json`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(route));

  const deco = bakeDecoration(route);
  const decoOut = resolve(dirname(out), `${route.id}.deco.json`);
  writeFileSync(decoOut, JSON.stringify(deco));

  const bytes = Buffer.byteLength(JSON.stringify(route));
  console.log(`baked ${basename(out)}`);
  console.log(`  samples        ${route.samples.x.length} @ ${route.sampleSpacing}m`);
  console.log(`  length         ${route.length}m`);
  console.log(`  corners        ${route.corners.length}`);
  console.log(`  drift zones    ${route.driftZones.length}`);
  console.log(`  min time       ${route.theoreticalMinTime}s (theoretical bound)`);
  console.log(`  max points     ${route.theoreticalMaxPoints} (theoretical bound)`);
  console.log(`  file size      ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`  decoration     ${deco.objects.length} objects -> ${basename(decoOut)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
