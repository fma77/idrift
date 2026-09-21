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
