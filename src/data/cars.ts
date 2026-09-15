import type { CarParams } from '../sim/types.ts';

/**
 * Car roster.
 *
 * Every car is the same code running different numbers -- no per-car special
 * cases anywhere in the sim. A car's character comes from mass distribution,
 * the torque curve's shape, and the front/rear tyre split. Making the rear
 * tyre slightly weaker than the front is what makes a car want to oversteer;
 * that one number does more for feel than anything else here.
 *
 * Names are fictional JDM pastiche. No real manufacturer, model, or chassis
 * code appears anywhere in this file, deliberately.
 */

/** Torque curves are sampled evenly from 0 rpm to redline. Newton-metres. */

export const CARS: CarParams[] = [
  {
    id: 'kaido-zen-r',
    name: 'KAIDO ZEN-R',
    carClass: 'C',
    mass: 1080,
    inertiaZ: 2750,
    cgToFront: 1.1,
    cgToRear: 1.3,
    cgHeight: 0.5,
    bodyLength: 4.2,
    bodyWidth: 1.68,
    wheelRadius: 0.3,
    maxSteerAngle: 0.6,
    steerRate: 4.2,
    // Front grip > rear grip: the car rotates willingly and holds a slide.
    tyreFront: { b: 9.0, c: 1.45, d: 1.35, e: 0.95, loadSensitivity: 0.28 },
    tyreRear: { b: 8.2, c: 1.42, d: 1.28, e: 0.97, loadSensitivity: 0.32 },
    engine: {
      idleRpm: 900,
      redlineRpm: 7800,
      // Naturally aspirated: broad, mild, peaks late. Forgiving to learn on.
      torqueCurve: [55, 92, 122, 142, 151, 150, 143, 128, 100],
      gearRatios: [3.3, 2.05, 1.42, 1.06, 0.84],
      finalDrive: 4.1,
      shiftUpFraction: 0.93,
      shiftDownFraction: 0.42,
      shiftTime: 0.18,
      drivetrainEfficiency: 0.88,
    },
    dragCoeff: 0.38,
    rollingResistance: 12,
    brakeTorque: 2400,
    handbrakeTorque: 1350,
    brakeBias: 0.62,
    audio: {
      cylinders: 4,
      basePitch: 42,
      distortion: 0.35,
      filterBase: 420,
      filterRange: 3600,
      whine: 0.12,
    },
    tint: '#E8402A',
  },
  {
    id: 'onibi-silhouette',
    name: 'ONIBI SILHOUETTE',
    carClass: 'B',
    mass: 1265,
    inertiaZ: 3730,
    cgToFront: 1.22,
    cgToRear: 1.38,
    cgHeight: 0.48,
    bodyLength: 4.52,
    bodyWidth: 1.76,
    wheelRadius: 0.315,
    maxSteerAngle: 0.56,
    steerRate: 4.0,
    tyreFront: { b: 9.4, c: 1.46, d: 1.42, e: 0.94, loadSensitivity: 0.26 },
    tyreRear: { b: 8.4, c: 1.43, d: 1.34, e: 0.96, loadSensitivity: 0.3 },
    engine: {
      idleRpm: 850,
      redlineRpm: 7200,
      // Turbo: nothing below 2500, then a step. Punishes lazy gear choice,
      // rewards keeping it on boost through a corner.
      torqueCurve: [60, 95, 175, 268, 295, 292, 272, 240, 190],
      gearRatios: [3.21, 1.93, 1.3, 1.0, 0.78],
      finalDrive: 3.9,
      shiftUpFraction: 0.94,
      shiftDownFraction: 0.44,
      shiftTime: 0.16,
      drivetrainEfficiency: 0.87,
    },
    dragCoeff: 0.42,
    rollingResistance: 14,
    brakeTorque: 3000,
    handbrakeTorque: 1650,
    brakeBias: 0.63,
    audio: {
      cylinders: 4,
      basePitch: 38,
      distortion: 0.5,
      filterBase: 360,
      filterRange: 3200,
      whine: 0.34,
    },
    // Car tints are picked for legibility on the ink-2 tarmac, not for realism.
    // The first pass gave two of the three cars ink and ink-2 fills, which made
    // them all but invisible against the road they drive on -- only the paper
    // outline gave them away. In a top-down game the car is the one object that
    // must never be hard to find.
    tint: '#f4f1ea',
  },
  {
    id: 'tengu-gt-x',
    name: 'TENGU GT-X',
    carClass: 'A',
    mass: 1470,
    inertiaZ: 4650,
    cgToFront: 1.34,
    cgToRear: 1.36,
    cgHeight: 0.46,
    bodyLength: 4.68,
    bodyWidth: 1.82,
    wheelRadius: 0.33,
    maxSteerAngle: 0.52,
    steerRate: 3.7,
    // Heaviest and most powerful: wide tyres hold on longer, but the mass means
    // that once it goes it takes real commitment to bring back.
    tyreFront: { b: 9.8, c: 1.48, d: 1.5, e: 0.93, loadSensitivity: 0.24 },
    tyreRear: { b: 8.8, c: 1.45, d: 1.44, e: 0.95, loadSensitivity: 0.27 },
    engine: {
      idleRpm: 800,
      redlineRpm: 8000,
      torqueCurve: [90, 160, 280, 380, 412, 408, 385, 345, 280],
      gearRatios: [3.15, 2.0, 1.47, 1.14, 0.9, 0.72],
      finalDrive: 3.55,
      shiftUpFraction: 0.95,
      shiftDownFraction: 0.45,
      shiftTime: 0.12,
      drivetrainEfficiency: 0.86,
    },
    dragCoeff: 0.45,
    rollingResistance: 16,
    brakeTorque: 3600,
    handbrakeTorque: 1900,
    brakeBias: 0.64,
    audio: {
      cylinders: 6,
      basePitch: 34,
      distortion: 0.42,
      filterBase: 300,
      filterRange: 4200,
      whine: 0.22,
    },
    tint: '#e0dbd0',
  },
];

export function carById(id: string): CarParams {
  for (let i = 0; i < CARS.length; i++) {
    if (CARS[i].id === id) return CARS[i];
  }
  return CARS[0];
}

export const DEFAULT_CAR_ID = CARS[0].id;
