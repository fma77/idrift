import type { CarParams } from '../sim/types.ts';

/**
 * Car roster.
 *
 * Every car is the same code running different numbers -- no per-car special
 * cases anywhere in the sim. With the arcade model a car's character is a
 * handful of things a player can feel directly: how fast the nose swings
 * (turnRate, turnResponse), how easily the rear lets go (grip, breakAngle),
 * and how a slide holds once it has (the two slide frictions).
 *
 * Names are fictional JDM pastiche. No real manufacturer, model, or chassis
 * code appears anywhere in this file, deliberately.
 */

export const CARS: CarParams[] = [
  {
    id: 'kaido-zen-r',
    name: 'KAIDO ZEN-R',
    carClass: 'C',
    // Light and eager: quick to rotate, lets go early, forgiving in a slide.
    handling: {
      topSpeed: 32,
      acceleration: 8,
      turnRate: 2.2,
      turnResponse: 7,
      turnInSpeed: 7,
      grip: 1.05,
      slideFrictionLow: 0.55,
      slideFrictionHigh: 1.45,
      breakAngle: 0.12,
      regripAngle: 0.05,
      selfAlign: 2.2,
    },
    cgToFront: 1.1,
    cgToRear: 1.3,
    bodyLength: 4.2,
    bodyWidth: 1.68,
    maxWheelAngle: 0.6,
    engine: 'na4',
    tint: '#E8402A',
  },
  {
    id: 'onibi-silhouette',
    name: 'ONIBI SILHOUETTE',
    carClass: 'B',
    // Faster, a touch lazier to turn in, holds a slide at a wider angle.
    handling: {
      topSpeed: 36,
      acceleration: 9,
      turnRate: 2.0,
      turnResponse: 6,
      turnInSpeed: 8,
      grip: 1.1,
      slideFrictionLow: 0.5,
      slideFrictionHigh: 1.5,
      breakAngle: 0.13,
      regripAngle: 0.05,
      selfAlign: 2.0,
    },
    cgToFront: 1.22,
    cgToRear: 1.38,
    bodyLength: 4.52,
    bodyWidth: 1.76,
    maxWheelAngle: 0.56,
    engine: 'rotary',
    // Car tints are picked for legibility on the ink-2 tarmac, not for realism.
    // In a top-down game the car is the one object that must never be hard to
    // find.
    tint: '#f4f1ea',
  },
  {
    id: 'tengu-gt-x',
    name: 'TENGU GT-X',
    carClass: 'A',
    // Heavy and fast: grips hard and turns in slowly, but once it goes it
    // carries its speed through the slide.
    handling: {
      topSpeed: 39,
      acceleration: 10,
      turnRate: 1.85,
      turnResponse: 5,
      turnInSpeed: 9,
      grip: 1.25,
      slideFrictionLow: 0.45,
      slideFrictionHigh: 1.4,
      breakAngle: 0.15,
      regripAngle: 0.06,
      selfAlign: 1.8,
    },
    cgToFront: 1.34,
    cgToRear: 1.36,
    bodyLength: 4.68,
    bodyWidth: 1.82,
    maxWheelAngle: 0.52,
    engine: 'turbo6',
    tint: '#e0dbd0',
  },
  {
    id: 'kaze-b4',
    name: 'KAZE B4',
    carClass: 'B',
    // Four-wheel-drive flat four: the most grip in the roster and the most
    // stable in a slide, at the cost of a lazier turn-in.
    handling: {
      topSpeed: 37,
      acceleration: 10,
      turnRate: 1.95,
      turnResponse: 5.5,
      turnInSpeed: 8,
      grip: 1.2,
      slideFrictionLow: 0.6,
      slideFrictionHigh: 1.5,
      breakAngle: 0.14,
      regripAngle: 0.06,
      selfAlign: 2.4,
    },
    cgToFront: 1.2,
    cgToRear: 1.3,
    bodyLength: 4.4,
    bodyWidth: 1.74,
    maxWheelAngle: 0.56,
    engine: 'boxer4',
    tint: '#cdc7bb',
  },
];

export function carById(id: string): CarParams {
  for (let i = 0; i < CARS.length; i++) {
    if (CARS[i].id === id) return CARS[i];
  }
  return CARS[0];
}

export const DEFAULT_CAR_ID = CARS[0].id;
