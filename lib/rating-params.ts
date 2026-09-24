/**
 * Calibrated engine-error-model parameters per time control.
 *
 * Empty until `node scripts/calibrate-rating.mjs fit … --write-lib` is run on
 * rated games; until then every estimate uses the documented priors in
 * DEFAULT_ENGINE_ERROR_MODEL and is labelled uncalibrated in the UI.
 */
import type { TimeControlClass } from "./chess-review.ts";
import type { EngineErrorModelParams, RegressionModelParams } from "./rating-model.ts";

export const CALIBRATED_MODELS: Partial<Record<TimeControlClass, EngineErrorModelParams>> = {};

/** Written by scripts/corpus/rating_benchmark.py --write-lib. */
export const REGRESSION_MODELS: Partial<Record<"blitz" | "rapid", RegressionModelParams>> = {};
