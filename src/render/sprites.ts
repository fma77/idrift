/**
 * Sprite loading.
 *
 * Car and decoration art is produced externally and supplied as image files
 * (top-down, transparent, facing "up"). Nothing here blocks on that: every
 * draw path falls back to a placeholder shape, so the game is fully playable
 * and testable before a single asset exists, and drops the art in by editing
 * one path in the car or route data.
 */

const cache = new Map<string, HTMLImageElement | null>();
const pending = new Map<string, Promise<HTMLImageElement | null>>();

/**
 * Returns the loaded image, or null if it is still loading or failed.
 *
 * Deliberately synchronous and non-throwing: a renderer running at 60fps should
 * never await anything, and a missing asset should degrade to the placeholder
 * rather than tear a hole in the frame.
 */
export function getSprite(path: string | undefined): HTMLImageElement | null {
  if (!path) return null;
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  if (!pending.has(path)) pending.set(path, load(path));
  return null;
}

function load(path: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      cache.set(path, img);
      resolve(img);
    };
    img.onerror = () => {
      // Cache the failure so a missing file is not retried every frame.
      cache.set(path, null);
      resolve(null);
    };
    img.src = path;
  });
}

/** Warm the cache ahead of a run so art does not pop in on the first corner. */
export function preload(paths: (string | undefined)[]): Promise<unknown> {
  return Promise.all(paths.filter((p): p is string => !!p).map((p) => pending.get(p) ?? load(p)));
}
