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
 *   node tools/bake-route.mjs tools/specs/<name>.json --osm-route <lat,lon> <lat,lon>
 *
 * Unlike src/sim/**, this file may use Math.sin and friends freely: its output
 * is committed data, so it is baked once on one machine and every player then
 * reads identical numbers. The determinism rules exist to stop *runtime*
 * divergence between devices, which cannot happen here.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
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
 * Overpass refuses anything without a User-Agent -- with a 406, which reads
 * like a malformed query and is not. It also returns a busy error under load,
 * so this retries a few times before giving up.
 */
async function overpass(query) {
  const headers = { 'user-agent': 'idrift-route-baker/1.0 (hobby game; github.com/fma77/idrift)' };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(OVERPASS + '?data=' + encodeURIComponent(query), { headers });
    if (res.ok) {
      const text = await res.text();
      if (text.startsWith('{')) return { ok: true, json: async () => JSON.parse(text) };
      const error = text.match(/Error<[/]strong>: ([^<]*)/)?.[1] ?? 'unknown error';
      console.log('  overpass       busy (' + error.trim() + '), retrying');
    } else if (res.status !== 429 && res.status !== 504) {
      return res;
    }
    await sleep(4000 * (attempt + 1));
  }
  throw new Error('Overpass kept refusing; try again in a minute');
}

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
  const res = await overpass(query);
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

/** Metres between two lat/lon points, near enough at route scale. */
function metresBetween(a, b) {
  const R = 6378137;
  const lat = ((a.lat + b.lat) / 2) * DEG;
  const dx = (b.lon - a.lon) * DEG * Math.cos(lat) * R;
  const dy = (b.lat - a.lat) * DEG * R;
  return Math.hypot(dx, dy);
}

/**
 * Follow a real road from one point to another.
 *
 * A pass is never one way in OpenStreetMap: it is dozens, split wherever a tag
 * changes or a track joins. So this pulls every road in the box around the two
 * points, builds a graph of them, and walks the shortest path through it. The
 * given points are snapped to the nearest mapped junction or bend.
 *
 * One-way tags are deliberately ignored. What is being imported is the road's
 * shape, and a touge run is often driven in the direction the map forbids.
 */
async function fetchOsmRoute(start, end) {
  // ~450m of padding, so a road that wanders outside the straight line between
  // the two points is still in the box.
  const pad = 0.004;
  const south = Math.min(start.lat, end.lat) - pad;
  const north = Math.max(start.lat, end.lat) + pad;
  const west = Math.min(start.lon, end.lon) - pad;
  const east = Math.max(start.lon, end.lon) + pad;
  const kinds = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|track|service';
  const query =
    '[out:json][timeout:60];' +
    'way["highway"~"^(' + kinds + ')(_link)?$"](' + south + ',' + west + ',' + north + ',' + east + ');' +
    '(._;>;);out body;';

  const res = await overpass(query);
  if (!res.ok) throw new Error('Overpass returned ' + res.status);
  const data = await res.json();

  const nodes = new Map();
  const ways = [];
  for (const el of data.elements) {
    if (el.type === 'node') nodes.set(el.id, { lat: el.lat, lon: el.lon });
    else if (el.type === 'way' && el.nodes) ways.push(el);
  }
  if (ways.length === 0) throw new Error('No roads found in that area');

  // --- Graph of every road in the box ---
  const edges = new Map();
  const used = new Set();
  const link = (a, b, way) => {
    const cost = metresBetween(nodes.get(a), nodes.get(b));
    if (!edges.has(a)) edges.set(a, []);
    edges.get(a).push({ to: b, cost, way });
  };
  for (const way of ways) {
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.nodes[i - 1];
      const b = way.nodes[i];
      if (!nodes.has(a) || !nodes.has(b)) continue;
      link(a, b, way);
      link(b, a, way);
      used.add(a);
      used.add(b);
    }
  }

  const nearest = (point) => {
    let best = null;
    let bestDist = Infinity;
    for (const id of used) {
      const d = metresBetween(nodes.get(id), point);
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    return { id: best, dist: bestDist };
  };
  const from = nearest(start);
  const to = nearest(end);
  if (from.id === null || to.id === null) throw new Error('Could not snap those points to a road');

  // --- Dijkstra: the shortest way round by road ---
  const dist = new Map([[from.id, 0]]);
  const prev = new Map();
  const queue = new Set([from.id]);
  const done = new Set();
  while (queue.size > 0) {
    let current = null;
    let best = Infinity;
    for (const id of queue) {
      const d = dist.get(id) ?? Infinity;
      if (d < best) {
        best = d;
        current = id;
      }
    }
    queue.delete(current);
    done.add(current);
    if (current === to.id) break;
    for (const edge of edges.get(current) ?? []) {
      if (done.has(edge.to)) continue;
      const d = best + edge.cost;
      if (d < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, d);
        prev.set(edge.to, { from: current, way: edge.way });
        queue.add(edge.to);
      }
    }
  }
  if (!dist.has(to.id)) throw new Error('No connected road between those points');

  const path = [to.id];
  const wayTags = [];
  for (let id = to.id; prev.has(id); ) {
    const step = prev.get(id);
    wayTags.push(step.way.tags ?? {});
    id = step.from;
    path.push(id);
  }
  path.reverse();

  return {
    points: path.map((id) => nodes.get(id)),
    snapped: { start: from.dist, end: to.dist },
    roadMetres: dist.get(to.id),
    tags: wayTags,
    names: [...new Set(wayTags.map((t) => t.name || t.ref).filter(Boolean))],
  };
}

/** Project lat/lon to local metres about the first point. */
function projectToMetres(points) {
  const R = 6378137;
  const lat0 = points[0].lat * DEG;
  const lon0 = points[0].lon * DEG;
  return points.map((p) => ({
    x: (p.lon * DEG - lon0) * Math.cos(lat0) * R,
    y: (p.lat * DEG - lat0) * R,
  }));
}

/**
 * Take the jitter out of a mapped road.
 *
 * OSM geometry is traced by hand from aerial imagery, so a straight is rarely
 * straight to the metre. Left alone, that noise becomes a stream of tiny
 * curvature spikes and the corner detector reads a clean straight as a dozen
 * kinks. Each pass is a three-point average; it rounds hairpins very slightly,
 * which is a fair price.
 */
function smoothPolyline(points, passes) {
  let out = points;
  for (let p = 0; p < passes; p++) {
    out = out.map((pt, i) => {
      if (i === 0 || i === out.length - 1) return pt;
      return {
        x: (out[i - 1].x + 2 * pt.x + out[i + 1].x) / 4,
        y: (out[i - 1].y + 2 * pt.y + out[i + 1].y) / 4,
      };
    });
  }
  return out;
}

/**
 * Ease any corner tighter than the cars can take.
 *
 * Tracing a hairpin from aerial imagery puts a handful of nodes round a tight
 * bend, and resampling them can pinch the turn tighter than the road really
 * is: Mount Haruna came out with a 6-metre-radius hairpin, which no car can
 * drive at any speed. This finds those spots and averages only them, leaving
 * the rest of the road exactly as mapped.
 */
function relaxTightCorners(points, ds, minRadius, maxPasses = 40) {
  let out = points;
  for (let pass = 0; pass < maxPasses; pass++) {
    const { k } = derivePolylineGeometry(out, ds);
    const tight = new Set();
    for (let i = 0; i < k.length; i++) {
      const radius = Math.abs(k[i]) < 1e-9 ? Infinity : 1 / Math.abs(k[i]);
      if (radius < minRadius) for (let j = i - 3; j <= i + 3; j++) tight.add(j);
    }
    if (tight.size === 0) return { points: out, passes: pass };
    out = out.map((pt, i) => {
      if (i === 0 || i === out.length - 1 || !tight.has(i)) return pt;
      return {
        x: (out[i - 1].x + 2 * pt.x + out[i + 1].x) / 4,
        y: (out[i - 1].y + 2 * pt.y + out[i + 1].y) / 4,
      };
    });
  }
  return { points: out, passes: maxPasses };
}

/** Road width in metres from OSM tags, or null when the tags do not say. */
function widthFromTags(tags) {
  const widths = [];
  for (const t of tags) {
    const w = Number.parseFloat(t.width ?? t.est_width ?? '');
    if (Number.isFinite(w) && w > 2 && w < 20) {
      widths.push(w);
      continue;
    }
    const lanes = Number.parseInt(t.lanes ?? '', 10);
    if (Number.isFinite(lanes) && lanes > 0 && lanes < 5) widths.push(lanes * 3.1);
  }
  if (widths.length === 0) return null;
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
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
  // Angle (1.25 in the throttle-controls sweet spot), speed and line factors all maxed.
  const PER_SECOND = 900 * 1.25 * 1.4 * 1;
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

/**
 * Bake a route from a real road between two points.
 *
 * The spec supplies what OSM cannot: the name, the width when the tags are
 * silent, the grip, and how much of the road to use.
 */
async function bakeFromOsmRoute(start, end, spec) {
  const ds = spec.sampleSpacing ?? 2;
  const road = await fetchOsmRoute(start, end);
  console.log('  osm            ' + road.points.length + ' nodes, ' + road.roadMetres.toFixed(0) + 'm of road');
  console.log('  snapped        start ' + road.snapped.start.toFixed(0) + 'm, end ' + road.snapped.end.toFixed(0) + 'm from the given points');
  if (road.names.length > 0) console.log('  road names     ' + road.names.join(', '));

  let points = resamplePolyline(projectToMetres(road.points), ds);
  points = smoothPolyline(points, spec.smoothing ?? 6);

  // Trimming, in metres off each end, for cutting a run out of a longer road.
  const skipStart = Math.round((spec.trimStart ?? 0) / ds);
  const skipEnd = Math.round((spec.trimEnd ?? 0) / ds);
  const maxSamples = spec.maxLength ? Math.round(spec.maxLength / ds) : Infinity;
  points = points.slice(skipStart, Math.min(points.length - skipEnd, skipStart + maxSamples));
  if (spec.reverse) points.reverse();
  if (points.length < 20) throw new Error('Too little road left after trimming');

  const relaxed = relaxTightCorners(points, ds, spec.minRadius ?? 9);
  points = relaxed.points;
  if (relaxed.passes > 0) console.log('  eased          ' + relaxed.passes + ' passes over corners tighter than ' + (spec.minRadius ?? 9) + 'm');

  const { heading, k } = derivePolylineGeometry(points, ds);
  const tagged = widthFromTags(road.tags);
  const defaultWidth = spec.width ?? tagged ?? 6.5;
  if (spec.width === undefined) {
    console.log('  width          ' + defaultWidth + 'm ' + (tagged ? '(from OSM tags)' : '(default)'));
  }
  const defaultGrip = spec.grip ?? 1;

  // Hairpins are built wider than the road that leads to them -- they have to
  // be, for anything longer than a car to get round -- and OSM records one
  // width for the whole way. Without this the tightest turns on an imported
  // pass are a car and a half wide, which is not what is there in real life.
  const extra = spec.hairpinWidening ?? 1.6;
  const tightRadius = spec.hairpinRadius ?? 30;
  const widen = smooth(
    k.map((c) => {
      const radius = Math.abs(c) < 1e-6 ? Infinity : 1 / Math.abs(c);
      if (radius >= tightRadius) return 0;
      return extra * Math.min(1, (tightRadius - radius) / (tightRadius - 10));
    }),
    Math.round(15 / ds),
  );
  const halfWidth = widen.map((w) => defaultWidth / 2 + w);
  const grip = points.map(() => defaultGrip);
  const corners = deriveCorners(k, ds);
  const driftZones = deriveDriftZones(corners, ds);

  return {
    id: spec.id,
    version: spec.version ?? 1,
    name: spec.name,
    location: spec.location ?? '',
    // Required by the ODbL: anything built from OpenStreetMap has to say so.
    attribution: spec.attribution ?? 'Road data from OpenStreetMap contributors (ODbL)',
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
    driftZones,
    theoreticalMinTime: theoreticalMinTime(k, ds, defaultGrip),
    theoreticalMaxPoints: theoreticalMaxPoints(driftZones, ds),
    decoration: spec.decoration ?? (spec.id + '.deco.json'),
    poster: spec.poster ?? ('art/routes/' + spec.id + '-poster.png'),
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
  const routeIndex = args.indexOf('--osm-route');
  const outIndex = args.indexOf('--out');
  const specPath = resolve(args[0]);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));

  const latLon = (text) => {
    const [lat, lon] = String(text).split(',').map((v) => Number.parseFloat(v.trim()));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Bad coordinate: ' + text);
    return { lat, lon };
  };

  const route =
    routeIndex >= 0
      ? await bakeFromOsmRoute(latLon(args[routeIndex + 1]), latLon(args[routeIndex + 2]), spec)
      : osmIndex >= 0
        ? await bakeFromOsm(args[osmIndex + 1], spec)
        : bakeFromSpec(spec);

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
