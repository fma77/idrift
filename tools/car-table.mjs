/**
 * The car comparison table, written from the roster itself so it cannot go
 * stale: docs/cars.md for reading, docs/cars.csv for a spreadsheet.
 *
 *   node --experimental-strip-types tools/car-table.mjs
 *
 * Re-run after changing any car in src/data/cars.ts.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CARS } from '../src/data/cars.ts';
import { realKmh } from '../src/data/scale.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// [group, characteristic, used in, note number or '', value of a car]
const ROWS = [
  ['What the garage shows', 'Top speed, km/h', 'All modes', 1, (c) => Math.round(realKmh(c.handling.topSpeed))],
  ['What the garage shows', '0-100, s', 'Display', 2, (c) => c.zeroTo100],
  ['What the garage shows', '★ Acceleration', 'Display', 3, (c) => c.stats.accel],
  ['What the garage shows', '★ Top speed', 'Display', 3, (c) => c.stats.topSpeed],
  ['What the garage shows', '★ Grip', 'Display', 3, (c) => c.stats.grip],
  ['What the garage shows', '★ Drift', 'Display', 3, (c) => c.stats.drift],
  ['What the garage shows', '★ Agility', 'Display', 3, (c) => c.stats.agility],
  ['What the garage shows', '★ Stability', 'Display', 3, (c) => c.stats.stability],

  ['Speed and steering', 'Top speed (game units)', 'All modes', '', (c) => c.handling.topSpeed],
  ['Speed and steering', 'Acceleration', 'All modes', '', (c) => c.handling.acceleration],
  ['Speed and steering', 'Turn rate: how fast the nose can swing', 'All modes', '', (c) => c.handling.turnRate],
  ['Speed and steering', 'Turn-in speed: speed above which steering gets harder', 'All modes', '', (c) => c.handling.turnInSpeed],
  ['Speed and steering', 'Steering lock (radians)', 'All modes', '', (c) => c.maxWheelAngle],
  ['Speed and steering', 'Turn response: how quickly steering takes effect', 'Time Attack', '', (c) => c.handling.turnResponse],

  ['Grip and sliding', 'Grip', 'Time Attack', 4, (c) => c.handling.grip],
  ['Grip and sliding', 'Break angle: how far before the rear lets go', 'Time Attack', '', (c) => c.handling.breakAngle],
  ['Grip and sliding', 'Regrip angle: how straight before it grips again', 'Time Attack', '', (c) => c.handling.regripAngle],
  ['Grip and sliding', 'Slide friction, low speed', 'Time Attack', '', (c) => c.handling.slideFrictionLow],
  ['Grip and sliding', 'Slide friction, high speed', 'Time Attack', '', (c) => c.handling.slideFrictionHigh],
  ['Grip and sliding', 'Self-align: how hard it straightens itself', 'Time Attack', '', (c) => c.handling.selfAlign],

  ['Body', 'Centre of mass to front axle (m)', 'All modes', 5, (c) => c.cgToFront],
  ['Body', 'Centre of mass to rear axle (m)', 'All modes', 5, (c) => c.cgToRear],
  ['Body', 'Width (m)', 'All modes', 5, (c) => c.bodyWidth],
  ['Body', 'Length (m)', 'Drift Run', 6, (c) => c.bodyLength],

  ['Drift feel (1.00 is neutral, higher is more)', 'Hold: how easily a slide holds its angle', 'Drift Run', '', (c) => c.driftFeel?.hold ?? 1],
  ['Drift feel (1.00 is neutral, higher is more)', 'Runaway: too much throttle swings the tail round', 'Drift Run', '', (c) => c.driftFeel?.runaway ?? 1],
  ['Drift feel (1.00 is neutral, higher is more)', 'Rate: how fast the angle builds', 'Drift Run', '', (c) => c.driftFeel?.rate ?? 1],
  ['Drift feel (1.00 is neutral, higher is more)', 'Swing: speed of a side-to-side change of direction', 'Drift Run', '', (c) => c.driftFeel?.swing ?? 1],
  ['Drift feel (1.00 is neutral, higher is more)', 'Pivot: how far forward it turns (higher, wider tail)', 'Drift Run', '', (c) => c.driftFeel?.pivot ?? 0.85],
  ['Drift feel (1.00 is neutral, higher is more)', 'Momentum: how much it keeps its line while sliding', 'Drift Run', '', (c) => c.driftFeel?.momentum ?? 1],
  ['Drift feel (1.00 is neutral, higher is more)', 'Response: how quickly the tyres build and reverse sideways force', 'Drift Run', '', (c) => c.driftFeel?.response ?? 1],
];

const NOTES = [
  'The garage figure is the car\'s real top speed, converted from the game\'s own number to real-world km/h.',
  'The 0-100 time is only shown as text, but each car\'s acceleration is set so that it reaches 100 km/h in that time. A test checks this for every car.',
  'The stars change nothing in the game. They are the guide the real numbers were set from, but the game never reads them: change a star, and the real numbers have to be moved to match.',
  'Grip also sets how fast Time Attack Easy lets the car take a corner before it brakes for you.',
  'These position the four wheels: when wheels count as off the road (dirt, and the off-road slowdown in Time Attack) and where the wheels are drawn. The front distance also sets the turning point for Pivot in Drift Run.',
  'Length decides when the tail hits the wall at big drift angles in Drift Run. In all modes it also sets the size the car is drawn at.',
];

const USED_IN = [
  ['Display', 'Shown in the garage only; never changes how a car drives.'],
  ['Time Attack', 'Read by the Easy and Pro driving model, where the player steers.'],
  ['Drift Run', 'Read by the throttle-drift model, where the game steers and the player works the throttle and drift button.'],
  ['All modes', 'Read by both.'],
];

const names = CARS.map((c) => c.name.charAt(0) + c.name.slice(1).toLowerCase());
const fmt = (v) => (typeof v === 'number' && !Number.isInteger(v) ? String(Number(v.toFixed(3))) : String(v));

// --- Markdown ---------------------------------------------------------------

const md = [
  '# Cars',
  '',
  '<!-- Generated by tools/car-table.mjs from src/data/cars.ts. Do not edit by hand: change the cars, then re-run it. -->',
  '',
  'Every characteristic of every car, and what it actually affects.',
  '',
  '| Used in | Meaning |',
  '|---|---|',
  ...USED_IN.map(([k, v]) => `| **${k}** | ${v} |`),
];
let group = '';
for (const [g, name, used, note, value] of ROWS) {
  if (g !== group) {
    group = g;
    md.push('', `## ${g}`, '', `| Characteristic | Used in | ${names.join(' | ')} |`, `|---|---|${names.map(() => '---').join('|')}|`);
  }
  md.push(`| ${name} | ${used}${note ? `<sup>${note}</sup>` : ''} | ${CARS.map((c) => fmt(value(c))).join(' | ')} |`);
}
md.push('', '## Notes', '', ...NOTES.map((n, i) => `${i + 1}. ${n}`));
md.push(
  '',
  '## Cosmetic only',
  '',
  'Not in the tables: the name, the one-line description, the engine sound, the placeholder colour (used only when a car has no drawing), and the car class (still sent with each score, but no longer shown or used for ranking).',
  '',
  'In Drift Run the grip and sliding rows do nothing: the slide there is shaped by the drift feel rows, with speed and steering.',
  '',
);
writeFileSync(resolve(root, 'docs/cars.md'), md.join('\n'));

// --- CSV --------------------------------------------------------------------

const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = [['Group', 'Characteristic', 'Used in', 'Note', ...names].map(cell).join(',')];
for (const [g, name, used, note, value] of ROWS) {
  csv.push([g, name, used, String(note), ...CARS.map((c) => fmt(value(c)))].map(cell).join(','));
}
csv.push('', ['Note', 'Text'].join(','), ...NOTES.map((n, i) => [String(i + 1), n].map(cell).join(',')));
// A byte-order mark, so Excel reads the stars as UTF-8.
writeFileSync(resolve(root, 'docs/cars.csv'), '﻿' + csv.join('\r\n') + '\r\n');

console.log(`docs/cars.md and docs/cars.csv: ${ROWS.length} characteristics, ${CARS.length} cars`);
