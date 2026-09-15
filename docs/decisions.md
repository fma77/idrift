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

### Gameplay is responsive rather than portrait-only or landscape-only

The brief (§2) specifies portrait with a thumb-drag joystick. The design system (§5 of
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

### Assist level is stored in the run header, not in local settings

§2 calls for the assist slider to be a real input to the physics rather than a
difficulty flag. It is: the automatic throttle is computed and then blended with the
player's before going through the same engine and tyre equations. The consequence is
that a run recorded at assist 0.6 only replays identically at assist 0.6, so the value
must travel with the replay. It lives in `SimConfig` and in the stored run record.
There is a test asserting that changing assist changes the run — if it ever stops
changing it, the assist has quietly become a no-op.

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
- Cloudflare Workers + D1 leaderboards (§10), art integration beyond the loader and
  fallbacks (§8), and meme assets (§8) — the trigger system and table are wired with
  no assets attached.
- Server-side re-simulation — explicitly not required for v1. The state-hash stream is
  recorded anyway, so it is cheap to add later.
