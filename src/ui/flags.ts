/**
 * Country flags for the route list: the painted flags in art/, shrunk by
 * tools/make-posters.mjs to card size.
 */
export type Country = 'jp' | 'pt' | 'de';

export function flagElement(country: Country, label: string): HTMLElement {
  const img = document.createElement('img');
  img.className = 'flag';
  img.src = `art/flags/${country}.webp`;
  img.alt = label;
  img.width = 44;
  img.height = 44;
  img.decoding = 'async';
  return img;
}
