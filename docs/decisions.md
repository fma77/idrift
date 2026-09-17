# Decisions and deviations

The brief asks to flag clearly where a decision in it turns out to be wrong once code
exists. This is that list. Everything here is a deliberate departure or an addition,
not an oversight.

## Deviations from the brief

### The sine LUT is built from a polynomial, not from `Math.sin`

§4 specifies a lookup-table sin/cos built "once at startup". Built the obvious way —
by calling `Math.sin` for each entry — the table would be non-deterministic across
engines, and the bug would live in table construction where nothing would ever point
at it. `src/sim/math/trig.ts` generates the table from a Taylor kernel using only
`+`, `-` and `*`, which IEEE-754 specifies exactly. There is a test that fails if
anyone reintroduces `Math.sin` there.

### `Math.sqrt` is permitted inside the sim

§4 bans the transcendentals; `sqrt` is not in that list and is deliberately allowed.
Unlike `sin`/`pow`/`exp`, it maps to the hardware `SQRTSD` instruction, which IEEE-754
requires to be correctly rounded, on every engine that matters. Reimplementing it via
Newton iteration would be slower and no more deterministic.

### One thumb steers; the car drives itself, with arcade handling

The brief (§2, §3) specifies a physically based car -- bicycle model, Pacejka tyres,
engine, gearbox, brakes, handbrake -- controlled by a thumb joystick with an optional
throttle assist. All of that was built. It played correctly, and it never looked like a
drift line should: fluid and continuous. The limit was not the model but the controls:
steering, throttle, brakes and handbrake on glass are too much for a thumb to do
smoothly. A detour through five ordinary on-screen buttons confirmed it.

It was replaced with the approach Drifto: Infinite Drifting takes, as described by its
developer:

- **One control.** Touch anywhere and slide sideways to steer; lift to straighten.
  Wherever the thumb lands is centre, and overshooting drags centre along so reversing
  responds at once (`src/input/thumbSteer.ts`). No throttle, brake or handbrake: the
  car always drives itself. Keyboard play is the arrow keys.
- **Steering rotates the body directly.** The slider sets a yaw rate and the body
  follows it within a fraction of a second. No steering geometry and no tyre force
  building up, so no lag between thumb and nose.
- **Sideways friction rises with slide angle.** Constant while gripping; once the tyres
  let go it runs from a low value at a shallow angle to a high one at 90 degrees. A
  wider slide scrubs harder and pulls itself back, so a held thumb gives a held drift
  instead of a spin -- and sliding is the only way to shed speed, which is the skill.

The result is openly unrealistic and every handling number is something a player can
feel. Tests pin the behaviours that matter: gentle input corners on grip, a held slide
settles at a steady angle for every car, wider slides scrub more speed, and letting go
straightens the car.

Tuning is done by feel, on a phone: open the game with `#tune` on the URL and a TUNE
button appears in runs, opening sliders for every handling value that apply live. Tuned
values stay on that device, and nothing driven in tuning mode is saved or posted.
"Copy values" exports them to become the shipped defaults.

Knock-on changes: replays are 2 bytes a sample (steer only); `SIM_VERSION` is 3, so old
boards and bests are separate; the throttle assist setting, the button layout editor
and left-handed mode are gone. The API's `assist` field is kept (always 1) so the
Worker and database need no migration. Scoring and the test driver have not yet been
retuned for the new handling.

### Gameplay is responsive rather than portrait-only or landscape-only

The brief (§2) specifies portrait gameplay. The design system (§5 of
the handoff) specifies "menus portrait, gameplay landscape" with a three-corner HUD.
Confirmed with Filipe: support both. The HUD reflows from viewport aspect ratio and
the control zones move with it. The simulation is unaffected either way — it never
learns which happened.

### Camera zoom is viewport-relative, not pixels-per-metre

§3 asks for zoom that scales out with speed. Implemented as "metres visible across the
short edge of the screen" rather than an absolute pixels-per-metre value. An absolute
value frames the game completely differently on a 390px phone and a 1600px desktop —
the same road is a fifth of the screen on one and a twentieth on the other — which
changes whether a corner is drivable. There is a test asserting both platforms see the
same fraction of road.

### The fog-of-war uses a gradient

The design system says no gradients. This is the one exception, confined to the
gameplay surface: a hard-edged reveal circle reads as a rendering artefact rather than
as distance, and the whole point of progressive reveal is that the road ahead fades out
of knowledge. No menu uses a gradient.

### Drift zones cover corners of severity 3 and above

The first pass marked every corner with severity ≥ 2, which on a touge is essentially
the entire route, and made the course map ~70% red — breaking the rule the design
system is most insistent about. Zones now start at severity 3, and the course map marks
clipping points rather than shading whole zones.

### Hosting is one Worker with Static Assets, not Pages plus an API Worker

The brief (§10) specifies Cloudflare Pages for the frontend and separate
Workers for the API. Cloudflare now recommends Workers with Static Assets for
exactly this shape, and it is simpler where it counts: one project, one deploy,
one origin (so no CORS), and no way for the game and the API to end up on
different versions. Same free tier, and static asset bandwidth is still
unmetered. D1, R2 and the rate limiter are unchanged.

### Sanity bounds are read from the route file, not duplicated in the Worker

The brief asks the API to reject times below the route's theoretical minimum
and points above its maximum. Rather than copying those numbers into the
Worker, it reads them from the baked route JSON through the ASSETS binding, so
they cannot drift from the geometry the sim actually drove.

### Car tints were changed for legibility

Two of the three cars originally used the design system's ink and ink-2 as
their body fill, which is very nearly the colour of the tarmac they drive on.
Only the paper outline made them findable. In a top-down game the car is the
one object that must never be hard to see, so the roster is now red, paper and
paper-2.

## Additions not in the brief

- **Skid marks.** Cosmetic, and worth the cost: in a top-down view a player otherwise
  cannot see where the car has actually been sliding, which makes the drift scoring
  feel arbitrary. Toggleable in settings.
- **`tools/telemetry.mjs`.** Headless handling tuning. A lap takes ~40ms and the
  numbers are exact, so physics changes get evaluated there before they are judged by
  feel.
- **`src/bot/autopilot.ts`.** A pure-pursuit driver, used as a test fixture so the
  physics can be exercised over a whole route in CI with no browser and no human. It
  is deterministic, so a bot run can be stored as a ghost replay. It is *not* the
  deferred Drift Duels chase controller (§7.3), which remains unbuilt.

## Bugs worth remembering

Four were caught by the headless harness and would have been miserable to find by eye:

1. `sin()` indexed one past the end of the lookup table for tiny negative angles — and
   heading is routinely around `-5e-17` when driving straight. Reading past a
   `TypedArray` yields `undefined`, not an error, so this silently poisoned car
   position with `NaN`.
2. Yaw inertia was roughly half realistic for all three cars, making every car
   snap-spin at the limit.
3. The replay's throttle delta was *clamped* rather than wrapped, corrupting any input
   stream containing a violent full-lock reversal — an input nobody would think to test
   by hand.
4. `CanvasRenderingContext2D.setTransform` **replaces** the current transform rather
   than multiplying into it, so the camera was discarding the device-pixel-ratio scale
   the renderer had just set. Invisible on a 1x display; misplaces the entire world on
   every retina device. Now covered by `tests/camera.test.mjs`.

## Not built (v1 scope)

- Drift Duels / tandem (§7.3) — deferred by the brief. The ghost-replay half is
  already free from the determinism work; the pursuit controller is not started.
- Server-side re-simulation — explicitly not required for v1. The state-hash stream is
  recorded anyway, so it is cheap to add later.
- Ghost playback. Replays are recorded, compressed, stored and served
  byte-identically, and the sim replays them exactly; nothing yet draws a second
  car from one. This is the cheapest remaining feature by a distance.
- Supplied art. The loading, rotation and fallback paths all exist and are
  exercised; there are simply no image files yet.
