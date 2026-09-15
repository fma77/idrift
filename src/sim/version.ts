/**
 * Bump on ANY change to physics, scoring, or the deterministic math helpers.
 *
 * Leaderboards are partitioned by this value. A retuned tyre curve makes every
 * previously recorded time incomparable, and silently mixing them is worse than
 * resetting the board: it makes the board wrong in a way nobody can see.
 *
 * Changing a car's parameters, a route's geometry, or the renderer does NOT
 * require a bump -- those are versioned separately by carId, routeVersion, and
 * not at all, respectively.
 */
export const SIM_VERSION = 2;

/** Fixed simulation rate, Hz. */
export const TICK_RATE = 120;

/** Fixed timestep, seconds. */
export const DT = 1 / TICK_RATE;

/**
 * Input sampling rate, Hz. The sim runs at 120Hz but inputs are recorded at
 * 60Hz and held across both steps: human thumbs do not contain 120Hz of
 * information, and halving the rate halves the replay size for free.
 */
export const INPUT_RATE = 60;

/** Sim ticks per recorded input sample. */
export const TICKS_PER_INPUT = TICK_RATE / INPUT_RATE;
