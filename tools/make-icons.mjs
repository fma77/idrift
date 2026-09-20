#!/usr/bin/env node
/**
 * Icons, from the one piece of artwork.
 *
 *   node tools/make-icons.mjs
 *
 * Two different crops, because one image cannot do both jobs:
 *
 * - The full logo, wordmark and all, for anywhere it is shown at 96px or more:
 *   the home-screen icon, the install prompt, a share card.
 * - A crop of the car and the sun for the browser tab. At 16 or 32 pixels the
 *   brush lettering turns to grey mush, and what survives is the red disc and
 *   the shape of the car -- so that is all the small sizes are asked to carry.
 *
 * Source art lives in art/ rather than public/, so the 2MB original is not
 * shipped to every player; only the generated icons are.
 */
import sharp from 'sharp';
import { mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const SOURCE = resolve(root, 'art/idrift-logo.png');
const OUT = resolve(root, 'public');

/** The car and the sun, in the artwork's own pixels. */
const TAB_CROP = { left: 300, top: 420, width: 700, height: 700 };
/** Paper, for padding a maskable icon out to its safe zone. */
const PAPER = { r: 244, g: 241, b: 234, alpha: 1 };

async function main() {
  mkdirSync(OUT, { recursive: true });

  // The artwork, trimmed of its transparent margin and squared off.
  const trimmed = await sharp(SOURCE).trim({ threshold: 10 }).toBuffer();
  const { width, height } = await sharp(trimmed).metadata();
  const side = Math.min(width, height);
  const square = await sharp(trimmed)
    .extract({ left: Math.round((width - side) / 2), top: 0, width: side, height: side })
    .toBuffer();

  const wrote = [];
  const note = (name) => wrote.push(`${name} (${(statSync(resolve(OUT, name)).size / 1024).toFixed(0)}KB)`);
  // Paletted PNG: the artwork is flat colour and a texture, so 256 colours is
  // indistinguishable and a third of the size. These ship to every player.
  const write = async (image, size, name) => {
    await sharp(image)
      .resize(size, size, { kernel: 'lanczos3' })
      .png({ palette: true, quality: 90, effort: 10 })
      .toFile(resolve(OUT, name));
    note(name);
  };

  for (const [size, name] of [
    [180, 'apple-touch-icon.png'],
    [192, 'icon-192.png'],
    [512, 'icon-512.png'],
  ]) {
    await write(square, size, name);
  }

  // Maskable: Android crops icons to its own shape, so the artwork is inset
  // into a paper field and only the middle 80% is relied on.
  const inset = await sharp(square).resize(410, 410, { kernel: 'lanczos3' }).toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: PAPER } })
    .composite([{ input: inset, left: 51, top: 51 }])
    .png({ palette: true, quality: 90, effort: 10 })
    .toFile(resolve(OUT, 'icon-maskable-512.png'));
  note('icon-maskable-512.png');

  const tab = await sharp(SOURCE).extract(TAB_CROP).toBuffer();
  for (const size of [16, 32, 48]) await write(tab, size, `favicon-${size}.png`);

  // The title screen's mark. WebP with a PNG beside it: the page is 30KB of
  // JavaScript, and a 700KB logo above it would be the whole download.
  await sharp(square).resize(640, 640, { kernel: 'lanczos3' }).webp({ quality: 86 }).toFile(resolve(OUT, 'logo-title.webp'));
  note('logo-title.webp');
  await write(square, 640, 'logo-title.png');

  console.log('icons written to public/:');
  for (const line of wrote) console.log('  ' + line);
}

await main();
