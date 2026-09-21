/**
 * Painted route posters and the course drawn over them.
 *
 * The paintings are illustrations, not maps: their roads are not to scale and
 * not quite the shape the sim drives. So the course is traced on the painting
 * by hand, and the painting is trusted -- the trace follows the painted road,
 * not the OpenStreetMap geometry. The drawn minimap is still the fallback for
 * routes without a poster.
 *
 * Images are made by tools/make-posters.mjs.
 */
export interface PosterArt {
  src: string;
  /** Size of the original painting. The trace is in these pixels. */
  width: number;
  height: number;
  /** Centreline of the route on the painting, start to finish. */
  trace: [number, number][];
  /** Where north points on the painting, degrees clockwise from straight up. */
  north: number;
  /** Which side of the road the START and FINISH tags go: 1 left of travel, -1 right. */
  startSide: 1 | -1;
  finishSide: 1 | -1;
}

export const ESTORIL_POSTER: PosterArt = {
  src: 'art/routes/estoril-poster.webp',
  width: 1468,
  height: 1071,
  north: -2,
  startSide: 1,
  finishSide: 1,
  trace: [
    [645, 900], [685, 840], [740, 760], [795, 685], [840, 620], [885, 565], [930, 520],
    [962, 470], [978, 420], [968, 385], [940, 360], [905, 352], [865, 365], [820, 397],
    [780, 435], [720, 500], [640, 590], [560, 680], [490, 760], [455, 820], [440, 862],
    [425, 878], [412, 862], [406, 820], [403, 700], [402, 600], [398, 545], [410, 520],
    [445, 495], [485, 470], [520, 445], [535, 415], [525, 390], [500, 375], [475, 360],
    [467, 340], [477, 315], [500, 302], [540, 287], [600, 272], [680, 265], [765, 262],
    [810, 235], [838, 190], [865, 152], [905, 125], [960, 115], [1040, 113], [1095, 125],
    [1125, 175], [1133, 240], [1115, 310], [1085, 375], [1055, 435], [1020, 495],
    [990, 565], [955, 630], [925, 715], [895, 800], [872, 870],
  ],
};
