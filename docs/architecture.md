# iDrift — technical architecture

Written to be read on its own, and to be handed to an AI as the brief for a
diagram. The node-and-arrow summary at the end says what to draw.

## 1. What it is

A mobile-first, top-down drifting game that runs entirely in a web browser.
There is no app to install, no user accounts and no login. One player's browser
runs the whole game; a small server exists only to keep leaderboards and the
recordings behind them.

## 2. Development machine (Windows, local repository at `C:\dev\idrift`)

- **Source code** in TypeScript, no UI framework. The game draws itself on a
  single HTML canvas.
- **Vite 6** is the build tool. `npm run dev` runs a local server on port 5173
  for development; `npm run build` type-checks and then produces a `dist/`
  folder (one HTML file, hashed JavaScript and CSS bundles, plus everything in
  `public/` copied as-is).
- **TypeScript 5.7** compiles and type-checks two separate projects: the game
  and the server.
- **ESLint 9** enforces house rules, including a custom rule that forbids
  non-deterministic maths (`Math.sin`, `Math.random`, and so on) inside the
  physics code.
- **Node's built-in test runner** runs about 90 tests in seven files, with no
  test framework installed.
- **Art pipeline:** hand-drawn PNGs live in `art/`. `tools/make-posters.mjs`
  converts them with the `sharp` image library into the WebP files the game
  ships: route posters (two sizes), car top-down sprites (320px tall, trimmed),
  car hero images (960px wide) and full-size zoom copies (1920px wide).
- **Route pipeline:** `tools/bake-route.mjs` turns raw OpenStreetMap road data
  (`tools/osm/*.osm.json`) into a baked route JSON: a centreline of samples
  every few metres, each with position, heading, curvature, road half-width and
  grip, plus derived corner lists, clipping points and drift zones. Baked routes
  and their scenery files live in `public/routes/`.
- **Docs generator:** `tools/car-table.mjs` writes `docs/cars.md` and
  `docs/cars.csv` from the car data, so documentation cannot drift from the code.

## 3. GitHub (`github.com/fma77/idrift`)

- Holds the source history on the `main` branch. It is the backup and the record
  of every change.
- **There is no continuous integration and no automated deploy.** GitHub does
  not build or publish anything. Pushing is separate from deploying.

## 4. Deploying (from the local machine, not from GitHub)

`npm run deploy` does three things in order: type-check, Vite build into
`dist/`, then **Wrangler** (Cloudflare's command-line tool) uploads both the
built files and the server code to Cloudflare in one step. Database schema
changes are applied separately with `npm run db:remote`, which runs numbered SQL
migration files (`migrations/0001…0004`).

## 5. Cloudflare (the only hosting, one project called `idrift`)

A single **Cloudflare Worker** is both the web server and the API. Configuration
lives in `wrangler.jsonc`.

- **Static assets binding (`ASSETS`):** the built game files, served straight
  from Cloudflare's edge. Any request that is not `/api/...` is served from
  here, with a single-page-app fallback so unknown paths still load the game.
- **The Worker's own code** (`worker/index.ts`) handles only paths starting with
  `/api/`, configured to run before the asset server for those paths.
- **D1 database `idrift-db`:** Cloudflare's SQLite-based database. One table,
  `scores`.
- **Rate limiter binding (`SCORE_LIMITER`):** 10 score submissions per 60
  seconds per IP address.
- **Custom domains:** `idrift.win` and `www.idrift.win`, bought through
  Cloudflare Registrar, with Cloudflare's own name servers and TLS certificates
  issued automatically. The original `idrift.idrift-game.workers.dev` address
  still works.
- **Observability** is switched on for logs.

## 6. What the Worker actually is, and what it does

A Worker is a small program that Cloudflare runs in its own data centres,
in whichever one is nearest the player, and only while a request is being
answered. There is no machine to keep running, no operating system to patch and
nothing to restart: between requests nothing of it exists. It starts in about a
millisecond, so the first player of the day waits no longer than the hundredth.

Everything the game's server side does lives in one file, `worker/index.ts`,
about 400 lines. Every request to `idrift.win` arrives at it, and the first
decision is the simplest one:

- **Not `/api/...`?** Hand the request to the static asset store and stop. That
  covers the page itself, the JavaScript, the CSS, the route data, the car art
  and the posters. The Worker does not read or process these; Cloudflare serves
  them from the edge cache.
- **`/api/...`?** The Worker answers it itself. There are four:
  1. **`GET /api/health`** — a liveness check that returns "ok".
  2. **`GET /api/leaderboard/:routeId/:mode/:car`** — reads the top 20 of one
     board out of the database and returns it as JSON. `:car` is a car's id, for
     that car's own records, or `all` for every car together. The reply is
     marked cacheable for 20 seconds, so a popular board is usually answered by
     the edge cache without the database being touched at all.
  3. **`POST /api/score`** — the only place anything is written. In order, the
     Worker: checks the request's shape and every field's type and range;
     checks the player name against the shared moderation rules; asks the rate
     limiter whether this IP address has posted more than 10 times in the last
     minute; stores the row, including the compressed input recording;
     calculates what rank the run earned; replies with that rank; and then,
     after the reply is on its way, deletes anything past the top 20 of that
     board so the table cannot grow without bound.
  4. **`GET /api/replay/:runId`** — returns one stored recording, which is how a
     ghost car is loaded.

Three things worth knowing about why it is shaped this way:

- **One Worker serves both the page and the API.** So both are always the same
  version, they share one domain, and the browser never makes a cross-origin
  request: no CORS, no second deployment, nothing to keep in step.
- **It is the trust boundary.** Everything the browser sends is treated as
  untrusted: names are moderated, numbers are bounds-checked, the recording has
  a size limit, and submissions are rate-limited by IP. An unexpected error is
  caught and returned as a plain "try again" rather than a stack trace.
- **It holds no state of its own.** Anything that must be remembered is in D1 or
  on the player's device. Two requests may be answered by two different
  machines on two continents, and nothing depends on them being the same one.

What it deliberately does *not* do: it does not run the game, it does not
re-simulate or verify submitted runs (the recordings and state hashes needed for
that are stored, so it could be added later), it does not render anything, and
it has no session, cookie or account to manage.

## 7. The API surface

Four endpoints, all on the same origin, so no CORS:

- `GET /api/health` — liveness check.
- `GET /api/leaderboard/:routeId/:mode/:car` — a board's top 20. `:mode` is one
  of `timeAttack`, `timeAttackPro`, `driftRun`, `tandem`; `:car` is a car's id or `all`.
  The query string carries route version and simulation version.
- `POST /api/score` — submit a run: name, car, mode, time, points, route and
  versions, plus the compressed input recording.
- `GET /api/replay/:runId` — the stored input recording for one score.

## 8. The database

One table, `scores`, with: id, route id and version, mode, car id, car class,
simulation version, player name, ranking value, time, points, a compressed input
recording stored as a binary blob, and a timestamp. Indexes cover reading a board
overall and per car. A board is the combination of route + route version + mode +
simulation version, ranked ascending for the two time modes and descending for
Drift Run.

## 9. Inside the browser (the game itself)

Five layers, deliberately separated:

- **Deterministic simulation (`src/sim/`)** — the physics. Fixed 120 steps per
  second, player input sampled 60 times per second and held between samples. It
  uses its own lookup-table trigonometry and its own random number generator, so
  the same inputs produce bit-identical results on every device, forever. It
  never touches the browser, the screen or the clock. Two driving models share
  it: a steering model (Time Attack Easy and Pro) and a throttle-drift model
  (Drift Run).
- **Game loop (`src/game.ts`)** — an accumulator that steps the simulation at a
  fixed rate whatever the screen's refresh rate, records the input stream, and
  hashes the state periodically so divergence can be detected.
- **Rendering (`src/render/`)** — canvas 2D. Camera, painted world (grass, trees,
  kerbs generated from the route and a per-route theme), road, skid marks, tyre
  smoke, dirt, car sprites with soft shadows, and a DOM-based heads-up display
  laid over the canvas.
- **Audio (`src/audio/`)** — the engine note is synthesised live, sample by
  sample, in an AudioWorklet on its own thread: exhaust pulses, intake, turbo
  whistle and flutter, supercharger whine, overrun pops. Nothing is a recording.
- **Input (`src/input/`)** — a thumb-slide steering surface, Drift Run's
  drift/throttle pads, and Time Attack Pro's brake/gas pedals, plus a keyboard
  mapping.

## 10. Storage on the player's device

- **localStorage:** settings (name, car, controls, sensitivity, sound), personal
  bests, route progress, and any sound-lab tweaks. Small, and read at start-up.
- **IndexedDB:** the input recording of each personal best, far too large for
  localStorage.
- Both are per-address, so the workers.dev site and idrift.win keep separate
  copies.

## 11. Replays and ghosts (the reason determinism matters)

A run is stored as its inputs only, not positions: steering, throttle and button
flags, quantised, delta-encoded, then gzip-compressed in the browser. About 6KB
for a 90-second run. The same bytes replay to the same run anywhere, which gives
ghost cars (any leaderboard row with a recording can be driven again beside the
player), personal-best replays, and the option of server-side verification later.
The simulation version number partitions the leaderboards, so a physics change
never mixes runs driven under different rules.

## 12. What is deliberately absent

No accounts, no authentication, no cookies, no analytics, no ad network, no CDN
besides Cloudflare's own edge, no server-side rendering, no framework (no
React/Vue), no object storage yet (R2 is configured but commented out), and no
CI/CD.

## Node-and-arrow summary, for a diagram

**Groups:** "Developer machine", "GitHub", "Cloudflare", "Player's device".

**Nodes**

1. Developer machine: source code, art files, OSM data, Vite build, TypeScript,
   ESLint, tests, asset tools, route baker, Wrangler CLI.
2. GitHub: repository `fma77/idrift`, branch `main`.
3. Cloudflare: Worker `idrift` (API + router), static assets store, D1 database
   `idrift-db`, rate limiter, DNS and TLS for idrift.win.
4. Player's device: browser running the game (simulation, renderer, audio
   worklet, input), localStorage, IndexedDB.

**Arrows**

- Art files and OSM data → asset tools and route baker → built files in
  `public/` (inside the developer machine).
- Source code → `git push` → GitHub (history only; nothing flows out of GitHub).
- Source code → `npm run deploy` (type-check → Vite build → Wrangler upload) →
  Cloudflare Worker + static assets.
- Migration files → `npm run db:remote` → D1.
- Player's browser → HTTPS request to idrift.win → Worker: non-API requests →
  static assets; `/api/...` → Worker code.
- Worker ↔ D1 for reading boards and writing scores.
- Worker → rate limiter (on score submission only).
- Game → localStorage and IndexedDB (settings, bests, replays, all local).
- Leaderboard reads and ghost downloads → back to the game.
- Developer machine → `npm run db:scores` / `db:sql` via Wrangler → D1 (a direct
  maintenance path, bypassing the Worker).

**Two things worth emphasising visually:** GitHub is *not* in the deployment
path, and the Worker is a single box that serves both the web page and the API.
