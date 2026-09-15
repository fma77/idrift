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
 * Populate with real assets as they arrive. An entry of `null` means the event
 * is recognised and deliberately has nothing attached yet.
 */
export const MEME_TABLE: Record<MemeEvent, MemeAsset | null> = {
  personalBest: null,
  leaderboardTop20: null,
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
