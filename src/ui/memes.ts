/**
 * Meme trigger system.
 *
 * A data-driven event -> asset table. The rule that matters is the one about
 * *when*: these only fire at non-interactive moments -- results screens, never
 * mid-drive. A video overlay at the moment a player is catching a slide is not
 * a reward, it is an obstacle.
 *
 * Assets are supplied later. Every event below is wired now with no asset, and
 * the trigger silently does nothing until one is dropped in, so the table can
 * be filled without touching code.
 */

export type MemeEvent =
  | 'personalBest'
  | 'leaderboardTop20'
  | 'spinOut'
  | 'routeComplete'
  | 'sRank';

export interface MemeAsset {
  /** Muted WebM/MP4 preferred over GIF: an order of magnitude smaller. */
  src: string;
  type: 'video' | 'image';
  /** Milliseconds to show. Videos use their own duration when omitted. */
  duration?: number;
  caption?: string;
}

/**
 * Two placeholder cards, drawn as inline SVG so the trigger path is wired and
 * demonstrably working before any art exists. They are meant to look like
 * placeholders -- swapping in a real clip is replacing one entry here with
 * `{ src: 'art/memes/whatever.webm', type: 'video' }` and nothing else.
 *
 * `null` means the event is recognised and deliberately has nothing attached.
 */
function placeholderCard(line: string, sub: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="300" viewBox="0 0 520 300">
    <rect width="520" height="300" fill="#f4f1ea"/>
    <rect x="16" y="16" width="488" height="268" fill="none" stroke="#141414" stroke-width="3"/>
    <text x="260" y="140" text-anchor="middle" font-family="Bungee,Arial Black,sans-serif"
          font-size="48" fill="#e8402a">${line}</text>
    <text x="260" y="182" text-anchor="middle" font-family="Work Sans,sans-serif"
          font-size="15" letter-spacing="2" fill="#6d675c">${sub}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const MEME_TABLE: Record<MemeEvent, MemeAsset | null> = {
  personalBest: {
    src: placeholderCard('BEST YET', 'PLACEHOLDER — SWAP IN MEME_TABLE'),
    type: 'image',
    duration: 1600,
  },
  leaderboardTop20: {
    src: placeholderCard('TOP 20', 'PLACEHOLDER — SWAP IN MEME_TABLE'),
    type: 'image',
    duration: 1600,
  },
  routeComplete: null,
  sRank: null,
  spinOut: null,
};

let overlay: HTMLElement | null = null;

function ensureOverlay(): HTMLElement {
  if (overlay) return overlay;
  const el = document.createElement('div');
  el.className = 'meme';
  el.hidden = true;
  document.body.appendChild(el);
  overlay = el;
  return el;
}

/**
 * Fire a meme event.
 *
 * Safe to call for any event at any results moment: unmapped events are a
 * no-op, so call sites can be written once and the table filled in later.
 */
export function fireMeme(event: MemeEvent): void {
  const asset = MEME_TABLE[event];
  if (!asset) return;

  const el = ensureOverlay();
  el.replaceChildren();

  if (asset.type === 'video') {
    const video = document.createElement('video');
    video.src = asset.src;
    // Muted and playsInline, or mobile browsers refuse to autoplay it at all.
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.loop = false;
    video.onended = () => hide();
    el.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.src = asset.src;
    el.appendChild(img);
    setTimeout(hide, asset.duration ?? 2200);
  }

  if (asset.caption) {
    const caption = document.createElement('div');
    caption.className = 'meme__caption display';
    caption.textContent = asset.caption;
    el.appendChild(caption);
  }

  el.hidden = false;
  if (asset.type === 'video' && asset.duration) setTimeout(hide, asset.duration);
}

function hide(): void {
  if (overlay) overlay.hidden = true;
}
