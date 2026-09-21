/**
 * Country flags for the route list, cropped close so each reads as a patch of
 * colour at card size rather than a tiny, fussy flag.
 */
export type Country = 'jp' | 'pt' | 'de';

const INK = '#141414';

const FLAGS: Record<Country, string> = {
  // The sun, big and off-centre: most of the tile is the disc.
  jp: `<rect width="48" height="48" fill="#ffffff"/>
       <circle cx="30" cy="27" r="22" fill="#bc002d"/>`,
  // The seam between green and red, with the armillary sphere sitting on it.
  pt: `<rect width="48" height="48" fill="#da291c"/>
       <rect width="20" height="48" fill="#046a38"/>
       <circle cx="20" cy="24" r="13" fill="none" stroke="#ffe900" stroke-width="4"/>
       <path d="M13 17h14v9a7 7 0 0 1-14 0z" fill="#ffffff"/>
       <path d="M16 20h8v6a4 4 0 0 1-8 0z" fill="#da291c"/>`,
  // The three bands, tipped a little so the stripes read as a flag and not a bar.
  de: `<g transform="rotate(-12 24 24)">
         <rect x="-12" y="-6" width="72" height="20" fill="#000000"/>
         <rect x="-12" y="14" width="72" height="20" fill="#dd0000"/>
         <rect x="-12" y="34" width="72" height="22" fill="#ffce00"/>
       </g>`,
};

export function flagElement(country: Country, label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'flag';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true">
    <defs><clipPath id="flag-clip-${country}"><rect width="48" height="48"/></clipPath></defs>
    <g clip-path="url(#flag-clip-${country})">${FLAGS[country]}</g>
    <rect x="1" y="1" width="46" height="46" fill="none" stroke="${INK}" stroke-width="2"/>
  </svg>`;
  return el;
}
