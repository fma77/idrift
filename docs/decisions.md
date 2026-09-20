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

### The game drives the pedals, differently per mode

The first play-test of the one-thumb car showed the missing half: at full speed, steering
alone cannot get a car round a touge corner. With no pedals, the game has to manage speed,
so the sim now carries a per-mode assist (`src/sim/model/assist.ts`, values in
`src/data/assist.ts`):

- **Corner braking.** The car reads the centreline ahead, works out the fastest it can be
  going now and still brake to grip speed for every corner in view, and brakes to that.
- **Steering and sliding cost speed.** This is the brake pedal the player does not have.
- **Road keeping.** When the car is predicted to run wide, its path is bent back towards
  the road -- but only while the player steers roughly the right way (into the corner, or
  back towards the road). No steering, or the wrong way, gets no help and still crashes.
- **Per-mode handling.** Time Attack gets more grip, slides that close early and firmer
  braking, so a tidy line is quickest. Drift Run gets less grip, a wide slide limit, speed
  bled through the slide rather than braking, firmer road keeping, and a throttle that
  pulses in a slide (heard in the engine note too).

Being inside the sim, all of it is deterministic, identical for every player, and replays
exactly. Tests hold the promise both ways: a simulated player who reacts late and misjudges
by 40% gets round every route in both modes without touching a wall; a player who never
steers still crashes; and Time Attack is quicker while Drift Run spends more time sideways.

Drift scoring was retuned with it: a combo that ends by straightening up now banks its
points (only a wall or a spin forfeits them), the best-scoring angle is about 52 degrees,
and speed is judged against 90 km/h.

Tuning is done by feel, on a phone: switch on **Settings → Tuning mode** (or open the game
with `#tune` or `?tune`) and a TUNE button appears in runs, opening sliders for the
current mode's help and the current car's handling, applied live. Tuned values stay on
that device, and nothing driven in tuning mode is saved or posted. "Copy values" exports
them to become the shipped defaults.

Knock-on changes: replays are 2 bytes a sample (steer only); `SIM_VERSION` moved to 3 (and 4 with the assists), so old
boards and bests are separate; the throttle assist setting, the button layout editor
and left-handed mode are gone. The API's `assist` field is kept (always 1) so the
Worker and database need no migration.

### Drift Run: the game steers, the player works the throttle

Steering-only drifting played better with the assists, but had a low ceiling on how
much fun there was in it. Drift Run now has a second control scheme, and it is the
default there: the game steers, and the player holds a throttle and taps a drift button
(`src/sim/model/throttleDrift.ts`).

- **Touch:** hold the right half of the screen for throttle, tap the left half to drift.
  Halves rather than buttons so no thumb has to find a target. Phones cannot sense
  pressure, so partial throttle comes from holding and letting go: the throttle builds
  over ~0.45s and falls over ~0.3s, and feathering it is the skill. Keyboard: up arrow
  and space.
- **Until the tap,** the car corners on grip, steered along the road with Time Attack's
  grip and corner braking. The game never starts a drift by itself, and cornering on
  grip never scores.
- **The tap** flicks the car into the next corner -- a short swing the other way, then
  in, with a little handbrake scrub. Tapping again when the road turns the other way
  switches sides. Not tapping in an S-bend unwinds the drift rather than carrying the
  tail into the wall.
- **Throttle sets the angle.** A steady throttle holds a steady angle, in proportion to
  itself -- until the limit angle, past which the slide feeds itself and runs away to a
  spin. A spin costs the combo and most of the speed.
- **Corner exit.** Once the corner is behind and the road ahead is straight, the car
  straightens on its own, whatever the throttle is doing: on a straight the throttle is
  for speed. The first version let the throttle keep adding angle there, so getting back
  on the power out of a corner slid the car on down the straight, bleeding speed while
  looking straight. A drift now also ends at 8 degrees rather than 3, banks its points at
  that moment with a "+points" pop, and the gauge dims whenever no drift is on.
- **The drift line runs round the outside.** The target is where the *tail* runs --
  75% of the way to the outside edge -- with the car's centre inside that by however
  far the angle swings the tail out, and the car sets up on the outside before each
  corner. The first version hugged the apex: its steering compared the car's direction
  with the road's direction ten metres ahead, which on any bend builds in a turn-in
  and settled the car two metres to the inside whatever line was asked for. A test
  now holds the tail on the outside half of the road through every drifted corner.
- **The path** is steered by the game within a sideways-grip budget, and a bigger angle
  takes the line wider. The tail counts for wall contact in this scheme, so a big angle
  on a narrow road is a real risk.
- **Scoring** pays for angle up to the limit, and a quarter more inside the sweet spot
  just under it. The line factor becomes entry timing: a flick up to 30m before the
  corner is best. An angle gauge (sweet spot, spin zone, needle, throttle bar) replaces
  judging the angle by eye.

The drift phase is kinematic rather than force-based -- direction of travel follows the
road, the body is placed at the drift angle to it -- because the angle has to respond to
the throttle directly and legibly; that response is the whole game.

The steering scheme is still available in Drift Run from Settings, for comparison. Runs
driven that way are not saved or posted, so one board never mixes two games. Replays
grew to 4 bytes a sample (steer, throttle, drift flag), laid out in planes so a steering
run's constant throttle bytes compress away; `SIM_VERSION` is 5.

Tests drive the scheme with stand-in players: one who never taps finishes every route
clean with no drift points; one who balances just under the limit and switches sides in
S-bends finishes every route on every car with no walls and no spins; one who holds the
throttle flat spins repeatedly and scores next to nothing.

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

### Routes can be imported from OpenStreetMap

`tools/bake-route.mjs --osm-route <lat,lon> <lat,lon>` builds a route from a real road
between two points: it pulls every road in the box from Overpass, walks the shortest
path through them (ignoring one-way tags -- it is the shape being imported), projects
to metres, resamples, and hands the centreline to the same baker the hand-written specs
use. HARUNA DOWNHILL is the first: the real Mount Haruna pass, 6.9km and 29 hairpins.

Three things a mapped road needs before it is drivable:

- **Smoothing.** OSM geometry is traced by hand from imagery, so a straight is never
  straight to the metre, and the raw noise reads to the corner detector as dozens of
  kinks.
- **Easing the pinched corners.** Resampling a hairpin that has five nodes in it can
  make it tighter than it is; Haruna came out with a 6-metre-radius turn no car can
  drive. `relaxTightCorners` averages only the samples under the minimum radius and
  leaves the rest of the road as mapped.
- **Widening hairpins.** OSM records one width for a whole way, but hairpins are built
  wider than the road leading to them. Half-width gains up to 1.6m as the radius falls
  below 30m.

Imported routes carry an `attribution` string, shown on the route screen. The ODbL
requires it, and the cached Overpass result is committed under `tools/osm/` so the
route can be re-baked without the network and the source geometry stays reviewable.

The course map now shrinks and thins out clip markers on long routes: at 7km there are
hundreds, and at map scale they drew more red than road.

The pass also ships cut into three sections of roughly 2.2km -- lower, middle and upper
-- alongside the full 6.8km run, all four baked from the same committed Overpass result
with `--osm-file`, so they cannot drift apart. Cuts are placed at the straightest point
within 200m of each third, rather than at the exact third, so no section starts or ends
mid-hairpin. The two invented routes beyond the first were removed: the direction of the
game is real roads, and keeping hand-drawn ones around only splits the leaderboards.


### Engine sound is synthesised, pulse by pulse

Four engines, one per car: a high-revving NA four, a two-rotor rotary, a turbo straight
six and a turbo flat four. No recordings. An audio worklet (`src/audio/engineSynth.ts`)
builds the note the way an engine does -- one short ringing exhaust pulse per firing,
spaced by the firing pattern -- and each engine's character is numbers in
`src/audio/profiles.ts`: the flat four's unequal-length headers are an uneven pulse
pattern, the rotary's brap is firings bunching into groups at idle, the six is three
even pulses a revolution. Separate layers add intake howl, turbo whistle, the flutter of
air surging back through the turbo on lift-off, overrun pops, and tyre squeal.

The sim has no engine, so `src/audio/engineModel.ts` invents one for sound: gears from
road speed, wheelspin revs in a slide, a bouncing limiter, spool, and the lift-off moment
that triggers flutter and pops. It sits entirely outside the sim.

Chosen over recorded loops because the signature sounds asked for are effects that
synthesis does well, it costs nothing, has no licensing questions, follows the throttle
without seams, and the model underneath carries over if recordings replace the voice
later. The trade-off is a ceiling: it sounds like a good arcade game, not an onboard
video. Settings → Sound lab plays each engine with a hold-to-rev button, in neutral or
pulling through the gears, with sliders for the voice and "Copy values" to ship them.

The tyres have two sounds: a harsh locked-wheel skid when the drift button flicks the
car, and a squeal through the slide whose pitch rises with the angle.

Tyre smoke (`src/render/smoke.ts`) grows with both the slide angle and how long the
slide has lasted, so a flick makes a wisp and a held hairpin fills the road. Flat
circles, drawn under the car so it is never lost in its own cloud.

Pausing used to close the audio context, so a resumed run came back silent; it now
suspends and resumes instead.


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
