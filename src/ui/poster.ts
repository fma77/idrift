import type { PosterArt } from '../data/posters.ts';

/**
 * Start, finish, direction arrows and compass, drawn over a painted poster.
 *
 * The course itself is not drawn: the paintings are loose with the layout, and
 * a traced line that disagrees with the painted road looks wrong from any
 * distance. Arrows on the stretches that do match say which way round it goes.
 *
 * SVG in the painting's own pixels, laid over the <img>, so it scales with the
 * picture and the text is set in the game's fonts rather than baked into it.
 */
const INK = '#141414';
const PAPER = '#f4f1ea';
const RED = '#e8402a';

/** Road half-width on the paintings, roughly, in their pixels. */
const HALF_ROAD = 22;

export function drawPosterOverlay(svg: SVGSVGElement, art: PosterArt): void {
  svg.setAttribute('viewBox', `0 0 ${art.width} ${art.height}`);
  // Everything is sized off the painting's width, so a 1400px and a 1700px
  // painting get the same weight of line on the same phone.
  const u = art.width / 1468;
  const pts = art.trace;
  const start = frameAt(pts, 0);
  const finish = frameAt(pts, pts.length - 1);

  svg.innerHTML = `
    ${art.arrows.map((i) => arrow(frameAt(pts, i), u)).join('')}
    ${startLine(start, u)}
    ${chequer(finish, u)}
    ${tag('START', start, art.startSide, u)}
    ${tag('FINISH', finish, art.finishSide, u)}
    ${compass(art, u)}
  `;
}

interface Frame {
  x: number;
  y: number;
  /** Travel direction, unit. */
  tx: number;
  ty: number;
  /** Left of travel, unit (screen coordinates, y down). */
  nx: number;
  ny: number;
  deg: number;
}

function frameAt(pts: [number, number][], i: number): Frame {
  const a = pts[Math.max(0, Math.min(i, pts.length - 2))];
  const b = pts[Math.max(1, Math.min(i + 1, pts.length - 1))];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const tx = (b[0] - a[0]) / len;
  const ty = (b[1] - a[1]) / len;
  return { x: pts[i][0], y: pts[i][1], tx, ty, nx: ty, ny: -tx, deg: (Math.atan2(ty, tx) * 180) / Math.PI };
}

/** A red arrow along the road, pointing the way the route runs. */
function arrow(f: Frame, u: number): string {
  const l = 34 * u;
  const w = 16 * u;
  const shaft = 7 * u;
  return `<g transform="translate(${r(f.x)},${r(f.y)}) rotate(${r(f.deg)})">
    <polygon points="${r(-l)},${r(-shaft)} ${r(l * 0.2)},${r(-shaft)} ${r(l * 0.2)},${r(-w)} ${r(l)},0 ${r(l * 0.2)},${r(w)} ${r(l * 0.2)},${r(shaft)} ${r(-l)},${r(shaft)}"
      fill="${RED}" stroke="${INK}" stroke-width="${4 * u}" stroke-linejoin="round"/>
  </g>`;
}

function r(v: number): string {
  return v.toFixed(1);
}

/** A paper bar across the road. */
function startLine(f: Frame, u: number): string {
  const w = 8 * u;
  const h = HALF_ROAD * 2 * u;
  return `<g transform="translate(${r(f.x)},${r(f.y)}) rotate(${r(f.deg)})">
    <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" fill="${PAPER}" stroke="${INK}" stroke-width="${3 * u}"/>
  </g>`;
}

/** A two-row chequered bar across the road. */
function chequer(f: Frame, u: number): string {
  const n = 6;
  const s = (HALF_ROAD * 2 * u) / n;
  let cells = '';
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < n; i++) {
      const fill = (row + i) % 2 === 0 ? INK : PAPER;
      cells += `<rect x="${r(-s + row * s)}" y="${r(-n * s / 2 + i * s)}" width="${r(s)}" height="${r(s)}" fill="${fill}"/>`;
    }
  }
  return `<g transform="translate(${r(f.x)},${r(f.y)}) rotate(${r(f.deg)})">
    ${cells}
    <rect x="${r(-s)}" y="${r(-n * s / 2)}" width="${r(2 * s)}" height="${r(n * s)}" fill="none" stroke="${INK}" stroke-width="${3 * u}"/>
  </g>`;
}

/** A paper label off to one side of the road, on a short leader. */
function tag(text: string, f: Frame, side: 1 | -1, u: number): string {
  const size = 34 * u;
  const padX = 14 * u;
  const width = text.length * size * 0.6 + padX * 2;
  const height = size * 1.5;
  const reach = HALF_ROAD * u + 70 * u;
  const cx = f.x + f.nx * side * reach;
  const cy = f.y + f.ny * side * reach;
  const lx = f.x + f.nx * side * HALF_ROAD * u;
  const ly = f.y + f.ny * side * HALF_ROAD * u;
  return `
    <line x1="${r(lx)}" y1="${r(ly)}" x2="${r(cx)}" y2="${r(cy)}" stroke="${INK}" stroke-width="${4 * u}"/>
    <rect x="${r(cx - width / 2)}" y="${r(cy - height / 2)}" width="${r(width)}" height="${r(height)}" fill="${PAPER}" stroke="${INK}" stroke-width="${4 * u}"/>
    <text x="${r(cx)}" y="${r(cy)}" fill="${INK}" font-family="'IBM Plex Mono', monospace" font-weight="600" font-size="${r(size)}"
      text-anchor="middle" dominant-baseline="central" letter-spacing="${r(size * 0.04)}">${text}</text>`;
}

/** North arrow, top right. */
function compass(art: PosterArt, u: number): string {
  const rad = 46 * u;
  const cx = art.width - rad - 40 * u;
  const cy = rad + 70 * u;
  const tip = rad * 0.78;
  const half = rad * 0.26;
  return `<g transform="translate(${r(cx)},${r(cy)})">
    <circle r="${r(rad)}" fill="${PAPER}" stroke="${INK}" stroke-width="${4 * u}"/>
    <g transform="rotate(${art.north})">
      <polygon points="0,${r(-tip)} ${r(-half)},0 ${r(half)},0" fill="${RED}" stroke="${INK}" stroke-width="${2.5 * u}" stroke-linejoin="round"/>
      <polygon points="0,${r(tip)} ${r(-half)},0 ${r(half)},0" fill="${INK}" stroke="${INK}" stroke-width="${2.5 * u}" stroke-linejoin="round"/>
      <text y="${r(-rad - 16 * u)}" fill="${INK}" stroke="${PAPER}" stroke-width="${8 * u}" paint-order="stroke"
        font-family="Bungee, 'Arial Black', sans-serif" font-size="${r(34 * u)}" text-anchor="middle">N</text>
    </g>
  </g>`;
}

