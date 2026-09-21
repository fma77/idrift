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
  /**
   * The route on the painting, start to finish. Only its ends and the arrow
   * points are drawn, so it needs to be right there and nowhere else.
   */
  trace: [number, number][];
  /** Trace points to put a direction arrow on. */
  arrows: number[];
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
  arrows: [3, 24, 46],
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

/**
 * The whole Haruna pass on its painting, top of the mountain (bottom left) to
 * the town (right). The painting follows the real road closely, so each
 * section is a slice of this one trace, cut where the real sections split.
 */
const HARUNA_TRACE: [number, number][] = [
  [440, 1018], [470, 985], [506, 950], [537, 894], [556, 850], [587, 800], [575, 762],
  [544, 719], [541, 688], [553, 674], [566, 700], [594, 738], [612, 769], [625, 783],
  [632, 766], [612, 719], [606, 675], [631, 638], [653, 616], [666, 625], [687, 625],
  [725, 586],
  // 22: upper ends, middle starts.
  [745, 577],
  [775, 561], [812, 546], [825, 530], [816, 514], [787, 505], [750, 510], [706, 517],
  [662, 527], [639, 530], [642, 502], [681, 486], [744, 480], [806, 474], [856, 479],
  [884, 489], [870, 468], [850, 455], [831, 430], [806, 420], [787, 405], [772, 380],
  [772, 343],
  // 45: middle ends, lower starts.
  [777, 330],
  [781, 318], [793, 293], [806, 268], [831, 249], [860, 228], [840, 208], [820, 212],
  [870, 212], [940, 228], [960, 250], [945, 290], [965, 305], [990, 300], [1030, 340],
  [1050, 320], [1070, 290], [1090, 310], [1100, 330], [1140, 290],
];
const HARUNA_SPLIT_UPPER = 22;
const HARUNA_SPLIT_LOWER = 45;

function haruna(from: number, to: number, arrows: number[]): PosterArt {
  // From the foot of the painting there is only room for a label up-slope.
  const startSide = from === 0 ? 1 : -1;
  return {
    src: 'art/routes/haruna-poster.webp',
    width: 1439,
    height: 1093,
    north: 0,
    startSide,
    finishSide: -1,
    arrows: arrows.map((i) => i - from),
    trace: HARUNA_TRACE.slice(from, to + 1),
  };
}

export const HARUNA_UPPER_POSTER = haruna(0, HARUNA_SPLIT_UPPER, [2, 16]);
export const HARUNA_MIDDLE_POSTER = haruna(HARUNA_SPLIT_UPPER, HARUNA_SPLIT_LOWER, [33, 41]);
export const HARUNA_LOWER_POSTER = haruna(HARUNA_SPLIT_LOWER, HARUNA_TRACE.length - 1, [48, 56]);
export const HARUNA_FULL_POSTER = haruna(0, HARUNA_TRACE.length - 1, [2, 34, 56]);

/**
 * Nurburg on its painting: the pink ribbon along the valley, from the east
 * (Tiergarten, by the town) west and then north-west up the grey road to
 * Quiddelbacher Höhe.
 */
export const NURBURG_POSTER: PosterArt = {
  src: 'art/routes/nurburg-poster.webp',
  width: 1665,
  height: 945,
  north: -10,
  startSide: 1,
  finishSide: -1,
  arrows: [6, 17, 26],
  trace: [
    [1330, 748], [1256, 772], [1217, 788], [1183, 797], [1175, 763], [1161, 724], [1133, 686],
    [1100, 666], [1072, 691], [1044, 747], [1006, 786], [933, 802], [850, 791], [800, 755],
    [710, 750], [650, 730], [610, 700], [580, 660], [550, 630], [490, 605], [450, 595],
    [420, 570], [410, 530], [380, 505], [330, 470], [270, 430], [210, 380], [150, 310],
    [110, 260], [78, 205],
  ],
};
