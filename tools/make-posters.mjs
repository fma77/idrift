#!/usr/bin/env node
/**
 * Route posters, from the painted artwork in art/.
 *
 *   node tools/make-posters.mjs
 *
 * Only the picture is baked here. The course trace, start and finish, compass,
 * name and length are drawn over it on the route screen (src/ui/poster.ts), in
 * the game's own fonts, from the trace in src/data/posters.ts -- so they stay
 * sharp at any size and a typo is a one-line fix rather than a re-export.
 *
 * The originals are 1.5-3.5MB each; these ship at about a tenth of that.
 *
 * Also the country flags on the route cards: 2MB paintings shown at 44px, so
 * they ship at 96px, a few KB each.
 */
import sharp from 'sharp';
import { mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const OUT = resolve(root, 'public/art/routes');

/** Twice the width the route screen shows it at on a phone, for 2x screens. */
const WIDTH = 1000;

const POSTERS = [
  ['Estoril.png', 'estoril'],
  ['Nurburg.png', 'nurburg'],
  ['Haruna.png', 'haruna'],
];

mkdirSync(OUT, { recursive: true });
for (const [source, id] of POSTERS) {
  const out = resolve(OUT, `${id}-poster.webp`);
  const input = resolve(root, 'art', source);
  const { width, height } = await sharp(input).metadata();
  await sharp(input).resize({ width: WIDTH, kernel: 'lanczos3' }).webp({ quality: 78, effort: 6 }).toFile(out);
  console.log(`${id}-poster.webp  ${width}x${height} source, ${(statSync(out).size / 1024).toFixed(0)}KB`);
}

const FLAGS = [
  ['Japan.png', 'jp'],
  ['Portugal.png', 'pt'],
  ['Germany.png', 'de'],
];
const FLAG_OUT = resolve(root, 'public/art/flags');
mkdirSync(FLAG_OUT, { recursive: true });
for (const [source, code] of FLAGS) {
  const out = resolve(FLAG_OUT, `${code}.webp`);
  await sharp(resolve(root, 'art', source)).resize(96, 96, { kernel: 'lanczos3' }).webp({ quality: 82 }).toFile(out);
  console.log(`flags/${code}.webp  ${(statSync(out).size / 1024).toFixed(1)}KB`);
}

// Car sprites: top-down, nose up, transparent. Trimmed to the car so the
// game can size it by length alone, and shipped at 320px long -- about twice
// the most a phone ever shows one at.
// [source, car id, degrees to turn it nose-up]
const CAR_SPRITES = [
  ['Hachiroku.png', 'kaido-zen-r', 0],
  ['RX7.png', 'onibi-silhouette', 0],
  ['Godzilla.png', 'tengu-gt-x', 0],
  ['Scooby.png', 'kaze-b4', 0],
  ['Yellowbird.png', 'yellowbird', 0],
  // Drawn nose-down.
  ['Silvia.png', 'silvia', 180],
];
const CAR_OUT = resolve(root, 'public/art/cars');
mkdirSync(CAR_OUT, { recursive: true });
for (const [source, id, turn] of CAR_SPRITES) {
  const out = resolve(CAR_OUT, `${id}.webp`);
  const trimmed = await sharp(resolve(root, 'art', source)).rotate(turn).trim({ threshold: 10 }).toBuffer();
  await sharp(trimmed).resize({ height: 320, kernel: 'lanczos3' }).webp({ quality: 86, alphaQuality: 100 }).toFile(out);
  const { width, height } = await sharp(out).metadata();
  console.log(`cars/${id}.webp  ${width}x${height}, ${(statSync(out).size / 1024).toFixed(1)}KB`);
}

// Garage hero images: 16:9, shipped at 1200px wide.
const CAR_HEROES = [['Hachiroku hero.png', 'kaido-zen-r']];
for (const [source, id] of CAR_HEROES) {
  const out = resolve(CAR_OUT, `${id}-hero.webp`);
  await sharp(resolve(root, 'art', source))
    .resize(1200, 675, { fit: 'cover', kernel: 'lanczos3' })
    .webp({ quality: 82, effort: 6 })
    .toFile(out);
  console.log(`cars/${id}-hero.webp  ${(statSync(out).size / 1024).toFixed(0)}KB`);
}
