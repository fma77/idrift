import type { CarParams } from '../sim/types.ts';

/**
 * Car roster.
 *
 * Every car is the same code running different numbers -- no per-car special
 * cases anywhere in the sim. Top speeds and 0-100 times are the real cars',
 * at the world's scale and pace (src/data/scale.ts: 60% x 1.2), and
 * acceleration is fitted to the 0-100 time. The rest comes from a 1-5 rating per trait -- grip, drift,
 * agility, stability -- mapped to the handling numbers the same way for every
 * car: how fast the nose swings (turnRate, turnResponse), how easily the rear
 * lets go (grip, breakAngle), how a slide holds (the two slide frictions),
 * how hard the car straightens itself (selfAlign), and, with throttle
 * controls, driftFeel.
 *
 * Names are the nicknames the cars are known by, chosen by the owner of the
 * game. Ids are stable and never shown, so renaming a car keeps its bests.
 */

export const CARS: CarParams[] = [
  {
    id: 'kaido-zen-r',
    name: 'HACHIROKU',
    carClass: 'C',
    // AE86. Very light, agile and predictable: easy to throw in and to hold,
    // slow to build speed. A momentum car.
    handling: {
      topSpeed: 42.00,
      acceleration: 4.18,
      turnRate: 2.3,
      turnResponse: 7.5,
      turnInSpeed: 6.5,
      grip: 1.08,
      slideFrictionLow: 0.5,
      slideFrictionHigh: 1.45,
      breakAngle: 0.12,
      regripAngle: 0.06,
      selfAlign: 2.6,
    },
    cgToFront: 1.1,
    cgToRear: 1.3,
    bodyLength: 4.2,
    bodyWidth: 1.68,
    maxWheelAngle: 0.6,
    engine: 'na4',
    driftFeel: { hold: 1, runaway: 0.85, rate: 1, swing: 1.1, pivot: 0.85, momentum: 1.3, response: 1.3 },
    stats: { accel: 2, topSpeed: 2, grip: 3, drift: 4, agility: 5, stability: 5 },
    zeroTo100: 6.5,
    tagline:
      'Light, agile and predictable. Easy to throw sideways and to hold there, but slow to build speed: keep your momentum.',
    tint: '#E8402A',
    sprite: { path: 'art/cars/kaido-zen-r.webp', pixelsPerMetre: 76 },
    hero: 'art/cars/kaido-zen-r-hero.webp',
    heroFull: 'art/cars/kaido-zen-r-hero-full.webp',
  },
  {
    id: 'onibi-silhouette',
    name: 'ROTARY',
    carClass: 'B',
    // RX-7 FC. Balanced front-engined rear-drive with a turbo punch; holds long
    // slides and flicks between them quickly.
    handling: {
      topSpeed: 47.00,
      acceleration: 5.21,
      turnRate: 2.15,
      turnResponse: 6.5,
      turnInSpeed: 7.5,
      grip: 1.08,
      slideFrictionLow: 0.45,
      slideFrictionHigh: 1.35,
      breakAngle: 0.11,
      regripAngle: 0.055,
      selfAlign: 2.2,
    },
    cgToFront: 1.22,
    cgToRear: 1.38,
    bodyLength: 4.52,
    bodyWidth: 1.76,
    maxWheelAngle: 0.56,
    engine: 'rotary',
    driftFeel: { hold: 1.05, runaway: 1, rate: 1.1, swing: 1.15, pivot: 0.85, momentum: 1, response: 1.15 },
    stats: { accel: 3, topSpeed: 3, grip: 3, drift: 5, agility: 4, stability: 4 },
    zeroTo100: 5,
    tagline:
      'Balanced rear-drive with a turbo punch. Holds long slides more easily than the Hachiroku, and flicks quickly from one to the next.',
    // Car tints are picked for legibility on the ink-2 tarmac, not for realism.
    // In a top-down game the car is the one object that must never be hard to
    // find.
    tint: '#f4f1ea',
    sprite: { path: 'art/cars/onibi-silhouette.webp', pixelsPerMetre: 70 },
    hero: 'art/cars/onibi-silhouette-hero.webp',
    heroFull: 'art/cars/onibi-silhouette-hero-full.webp',
  },
  {
    id: 'tengu-gt-x',
    name: 'GODZILLA',
    carClass: 'A',
    // R34 GT-R. Extremely fast and planted all-wheel drive; heavy, and slow to
    // change direction.
    handling: {
      topSpeed: 58.00,
      acceleration: 7.01,
      turnRate: 1.85,
      turnResponse: 4.5,
      turnInSpeed: 9.5,
      grip: 1.24,
      slideFrictionLow: 0.6,
      slideFrictionHigh: 1.55,
      breakAngle: 0.14,
      regripAngle: 0.06,
      selfAlign: 2.6,
    },
    cgToFront: 1.34,
    cgToRear: 1.36,
    bodyLength: 4.68,
    bodyWidth: 1.82,
    maxWheelAngle: 0.52,
    engine: 'turbo6',
    driftFeel: { hold: 0.85, runaway: 0.85, rate: 0.9, swing: 0.7, pivot: 0.8, momentum: 1.2, response: 0.8 },
    stats: { accel: 5, topSpeed: 5, grip: 5, drift: 3, agility: 2, stability: 5 },
    zeroTo100: 3.5,
    tagline:
      'Extremely fast and planted. All-wheel drive gives enormous traction, but it is heavy and slow to change direction.',
    tint: '#e0dbd0',
    sprite: { path: 'art/cars/tengu-gt-x.webp', pixelsPerMetre: 70 },
    hero: 'art/cars/tengu-gt-x-hero.webp',
    heroFull: 'art/cars/tengu-gt-x-hero-full.webp',
  },
  {
    id: 'kaze-b4',
    name: 'SCOOBY',
    carClass: 'B',
    // Impreza WRC. Rally-geared all-wheel drive: huge traction and the hardest
    // launch in the game, short gearing that tops out early, and a car that
    // would rather grip than hang its tail out.
    handling: {
      topSpeed: 41.00,
      acceleration: 6.85,
      turnRate: 2.15,
      turnResponse: 6.5,
      turnInSpeed: 7.5,
      grip: 1.24,
      slideFrictionLow: 0.6,
      slideFrictionHigh: 1.55,
      breakAngle: 0.14,
      regripAngle: 0.06,
      selfAlign: 2.6,
    },
    cgToFront: 1.2,
    cgToRear: 1.3,
    bodyLength: 4.4,
    bodyWidth: 1.74,
    maxWheelAngle: 0.56,
    engine: 'boxer4',
    driftFeel: { hold: 0.85, runaway: 0.85, rate: 0.9, swing: 0.9, pivot: 0.75, momentum: 0.9, response: 1.05 },
    stats: { accel: 5, topSpeed: 2, grip: 5, drift: 3, agility: 4, stability: 5 },
    zeroTo100: 4,
    tagline:
      'A rally car: all-wheel drive and short gearing. Among the quickest off the line and out of every corner, but it runs out of top speed early, and it would rather grip than stay sideways.',
    tint: '#cdc7bb',
    sprite: { path: 'art/cars/kaze-b4.webp', pixelsPerMetre: 70 },
    hero: 'art/cars/kaze-b4-hero.webp',
    heroFull: 'art/cars/kaze-b4-hero-full.webp',
  },
  {
    id: 'yellowbird',
    name: 'YELLOWBIRD',
    carClass: 'A',
    // RUF CTR. Light, rear-engined and brutally fast: powerful oversteer and a
    // nervous rear end.
    handling: {
      topSpeed: 68.40,
      acceleration: 5.92,
      turnRate: 2,
      turnResponse: 5.5,
      turnInSpeed: 8.5,
      grip: 1.16,
      slideFrictionLow: 0.45,
      slideFrictionHigh: 1.35,
      breakAngle: 0.11,
      regripAngle: 0.04,
      selfAlign: 1.8,
    },
    // Weight over the rear: the centre of mass sits well back.
    cgToFront: 1.35,
    cgToRear: 1.1,
    bodyLength: 4.3,
    bodyWidth: 1.84,
    maxWheelAngle: 0.55,
    engine: 'flat6tt',
    driftFeel: { hold: 1.05, runaway: 1.6, rate: 1.15, swing: 1.2, pivot: 1, momentum: 1, response: 1.1 },
    stats: { accel: 5, topSpeed: 5, grip: 4, drift: 5, agility: 3, stability: 1 },
    zeroTo100: 4,
    tagline:
      'Light, rear-engined and brutally fast. Powerful oversteer and a nervous tail when pushed: difficult, and hugely rewarding.',
    tint: '#f2c230',
    sprite: { path: 'art/cars/yellowbird.webp', pixelsPerMetre: 70 },
    hero: 'art/cars/yellowbird-hero.webp',
    heroFull: 'art/cars/yellowbird-hero-full.webp',
  },
  {
    id: 'silvia',
    name: 'SILVIA',
    carClass: 'B',
    // S15. Purpose-built drift car: balance, steering angle and oversteer that
    // does what it is told.
    handling: {
      topSpeed: 50.00,
      acceleration: 5.68,
      turnRate: 2.15,
      turnResponse: 6.5,
      turnInSpeed: 7.5,
      grip: 1.08,
      slideFrictionLow: 0.45,
      slideFrictionHigh: 1.35,
      breakAngle: 0.11,
      regripAngle: 0.055,
      selfAlign: 2.2,
    },
    cgToFront: 1.2,
    cgToRear: 1.35,
    bodyLength: 4.52,
    bodyWidth: 1.7,
    maxWheelAngle: 0.62,
    engine: 'turbo4',
    driftFeel: { hold: 1.05, runaway: 1, rate: 1.05, swing: 1.1, pivot: 0.9, momentum: 1.1, response: 1.15 },
    stats: { accel: 4, topSpeed: 4, grip: 3, drift: 5, agility: 4, stability: 4 },
    zeroTo100: 4.5,
    tagline:
      'Built to drift: balanced, with a big steering angle and oversteer that does exactly what it is told. The most natural drift car here.',
    tint: '#3a6ea5',
    sprite: { path: 'art/cars/silvia.webp', pixelsPerMetre: 70 },
    hero: 'art/cars/silvia-hero.webp',
    heroFull: 'art/cars/silvia-hero-full.webp',
  },
  {
    id: 'hellcat',
    name: 'HELLCAT',
    carClass: 'A',
    // Challenger SRT Hellcat, drift-built: 717hp through the rear wheels of a
    // two-tonne muscle car. Huge speed and huge slides, the laziest steering
    // here, and power that swings the tail round if it is given the chance.
    handling: {
      topSpeed: 64.00,
      acceleration: 6.15,
      turnRate: 1.7,
      turnResponse: 3.5,
      turnInSpeed: 10.5,
      grip: 1.0,
      slideFrictionLow: 0.5,
      slideFrictionHigh: 1.45,
      breakAngle: 0.12,
      regripAngle: 0.05,
      selfAlign: 2.0,
    },
    // Long, wide and nose-heavy.
    cgToFront: 1.3,
    cgToRear: 1.65,
    bodyLength: 5.03,
    bodyWidth: 1.92,
    // An angle kit: as much lock as the Silvia.
    maxWheelAngle: 0.62,
    engine: 'scv8',
    driftFeel: { hold: 1, runaway: 1.35, rate: 0.85, swing: 0.75, pivot: 0.8, momentum: 1.35, response: 0.75 },
    stats: { accel: 5, topSpeed: 5, grip: 2, drift: 4, agility: 1, stability: 3 },
    zeroTo100: 3.9,
    tagline:
      'A supercharged muscle car built to drift. Enormous speed and long, smoky slides, but it is heavy and slow to turn in, and too much throttle swings the tail round.',
    tint: '#c8102e',
    sprite: { path: 'art/cars/hellcat.webp', pixelsPerMetre: 70 },
    hero: 'art/cars/hellcat-hero.webp',
    heroFull: 'art/cars/hellcat-hero-full.webp',
  },
  {
    id: 'toms-gt500',
    name: "TOM'S",
    carClass: 'S',
    // Castrol TOM'S Supra, #36, 1997 JGTC GT500 champion (Krumm and de la Rosa).
    // A race car: slicks and downforce, about 490hp from a 2-litre turbo four
    // moved back in the chassis for balance, about 1,100kg. Grip beyond any
    // road car -- past the top of the scale the others were rated on -- and a
    // car that fights every attempt to get it sideways.
    handling: {
      topSpeed: 60.00,
      acceleration: 7.37,
      turnRate: 2.15,
      turnResponse: 6.5,
      turnInSpeed: 7.5,
      grip: 1.32,
      slideFrictionLow: 0.65,
      slideFrictionHigh: 1.65,
      breakAngle: 0.15,
      regripAngle: 0.065,
      selfAlign: 2.8,
    },
    // Engine set back: slightly more weight over the rear than the front.
    cgToFront: 1.3,
    cgToRear: 1.25,
    bodyLength: 4.6,
    bodyWidth: 1.95,
    // Race steering: precise, and not much lock.
    maxWheelAngle: 0.5,
    engine: 'race4',
    driftFeel: { hold: 0.8, runaway: 0.8, rate: 0.9, swing: 1.05, pivot: 0.8, momentum: 0.9, response: 1.25 },
    stats: { accel: 5, topSpeed: 5, grip: 5, drift: 2, agility: 4, stability: 5 },
    zeroTo100: 3.3,
    tagline:
      "A 1997 championship-winning GT500 race car: slicks, downforce and a 490hp turbo four. Grips like nothing else and flies against the clock, but it hates going sideways.",
    tint: '#f4f1ea',
    sprite: { path: 'art/cars/toms-gt500.webp', pixelsPerMetre: 70 },
    hero: 'art/cars/toms-gt500-hero.webp',
    heroFull: 'art/cars/toms-gt500-hero-full.webp',
  },
  {
    id: 'drift-supra',
    name: 'DRIFT SUPRA',
    carClass: 'A',
    // Fictional: a Mk4 Supra built the way the film's orange car was said to
    // be, a 2JZ straight six on one big turbo, then set up to drift -- about
    // 600hp, an angle kit, around 1,500kg. Heavier than the Silvia, with turbo
    // lag and then a surge that swings the tail.
    handling: {
      topSpeed: 57.00,
      acceleration: 5.87,
      turnRate: 2,
      turnResponse: 5.5,
      turnInSpeed: 8.5,
      grip: 1.08,
      slideFrictionLow: 0.45,
      slideFrictionHigh: 1.35,
      breakAngle: 0.11,
      regripAngle: 0.055,
      selfAlign: 2.2,
    },
    // The long straight six sits well forward.
    cgToFront: 1.2,
    cgToRear: 1.35,
    bodyLength: 4.52,
    bodyWidth: 1.81,
    maxWheelAngle: 0.62,
    engine: 'bigturbo6',
    driftFeel: { hold: 1.05, runaway: 1.15, rate: 1, swing: 0.95, pivot: 0.85, momentum: 1.2, response: 1 },
    stats: { accel: 4, topSpeed: 5, grip: 3, drift: 5, agility: 3, stability: 4 },
    zeroTo100: 4.2,
    tagline:
      'Orange, loud and built for angle: a big single-turbo straight six in a Mk4. Heavier than the Silvia, with turbo lag and then a surge that swings the tail, and huge speed on the straights.',
    tint: '#f28a1e',
    sprite: { path: 'art/cars/drift-supra.webp', pixelsPerMetre: 70 },
    hero: 'art/cars/drift-supra-hero.webp',
    heroFull: 'art/cars/drift-supra-hero-full.webp',
  },
];

export function carById(id: string): CarParams {
  for (let i = 0; i < CARS.length; i++) {
    if (CARS[i].id === id) return CARS[i];
  }
  return CARS[0];
}

export const DEFAULT_CAR_ID = CARS[0].id;
