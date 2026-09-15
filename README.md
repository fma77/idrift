# iDrift

A mobile-first, top-down 2D touge drifting game. Time Attack and Drift Run, fictional
JDM-pastiche cars, hand-authored mountain routes.

```bash
npm install
npm run dev      # http://localhost:5173 (also on your LAN, for testing on a phone)
npm test         # headless sim + camera tests, no browser needed
npm run lint     # includes the src/sim determinism rules
npm run build    # typecheck + production bundle
```

## Where things are

```
src/sim/          The quarantined, deterministic simulation. Read the rules below.
  math/           Deterministic trig, seeded PRNG, state hashing
  model/          Tyre, engine, vehicle, route progress, scoring
src/render/       Canvas renderer, camera, DOM HUD. Reads sim state, writes nothing.
src/input/        Touch + keyboard into one abstract input struct
src/audio/        Procedural engine synthesis. No samples.
src/data/         Car and route registries
src/bot/          Pure-pursuit driver: test fixture and future attract mode
src/storage/      Settings, personal bests, unlocks, replay blobs
tools/            Route baker and headless telemetry
public/routes/    Baked, immutable route JSON
```

## The determinism rule

Everything under `src/sim/**` must produce bit-identical output from identical input,
on every JS engine, forever. That property is what buys ghosts, replays, reproducible
bug reports, and the option of server-side verification later. It is easy to break by
accident and almost impossible to notice when you do, so it is enforced mechanically
by `eslint.config.js` rather than by discipline:

- **No `Math.sin/cos/tan/atan2/pow/exp/log/hypot`** — implementation-defined in
  ECMA-262. Use `src/sim/math/trig.ts`.
- **No `Math.random`** — use the seeded PRNG, seeded from the route's `seed`.
- **No wall-clock time** — the sim knows only its tick count.
- **No DOM** — it must run headless in Node, and does, in `npm test`.
- **No `Map`/`Set`/`Object.keys` iteration order** affecting output.

`Math.sqrt`, `abs`, `min`, `max`, `floor` and `sign` *are* allowed: unlike the
transcendentals they are exactly specified or map to a correctly-rounded hardware
instruction on every engine.

One subtlety worth keeping: the sine lookup table is built from a Taylor kernel, not
from `Math.sin`. Building it with `Math.sin` would move the non-determinism from every
call into table construction, where it is far harder to find. There is a test that
fails if anyone "optimises" this.

### Versioning

`SIM_VERSION` in `src/sim/version.ts` must be bumped by **any** physics or scoring
change. Leaderboards and personal bests are partitioned by it, so old scores are never
silently compared against a retuned model. Renderer, audio and car-art changes do not
require a bump. Route geometry is versioned separately by `routeVersion`, and a route
is immutable once any leaderboard entry exists against it.

## Adding a route

Routes are baked once, by a script, into immutable JSON — not authored live in-engine.

```bash
node tools/bake-route.mjs tools/specs/akari-downhill.json --out public/routes/akari-downhill.json
```

Write a spec as a corner sequence (`tools/specs/*.json`) or pass `--osm <way-id>` to
pull a real road centreline from the Overpass API. Iterate by editing the spec and
re-baking; if a leaderboard already exists for that route, bump its `version` instead
of overwriting it. Then add an entry to `src/data/routes.ts` — order there is the
unlock order.

Apexes, corner boundaries, clipping points and drift zones are derived automatically
from curvature analysis as a first pass, then hand-tunable by editing numbers in the
baked file.

## Tuning handling

Do it headlessly first. A full lap takes ~40ms and the numbers are exact:

```bash
node tools/telemetry.mjs accel kaido-zen-r     # 0-100, top speed, gearing
node tools/telemetry.mjs lap   tengu-gt-x      # full lap, walls, peak slip
node tools/telemetry.mjs drift kaido-zen-r     # drift zones, combo, grade
```

Cars are pure data in `src/data/cars.ts` — no per-car code anywhere in the sim. The
single most important number for feel is the front/rear tyre `d` split: a rear tyre
slightly weaker than the front is what makes a car want to oversteer.

## Design system

Option 2A, "Touge Paper / Arcade Type". Paper `#F4F1EA` for menus, ink `#141414` for
the gameplay surface, one red `#E8402A` that is *earned* — one primary button per
screen, score numerals, combo multipliers, failure states. Radius 0 everywhere.
Bungee for display, Work Sans for everything else with tabular numerals on anything
that counts. Tokens are in `src/ui/styles.css`.

See `docs/decisions.md` for where the implementation deviates from the brief and why.
