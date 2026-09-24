/**
 * Calibrated engine-error-model parameters per time control.
 *
 * REGRESSION_MODELS is written by `python3 scripts/corpus/rating_benchmark.py … --write-lib`.
 * Until it has parameters, estimates use the documented priors in
 * DEFAULT_ENGINE_ERROR_MODEL and are labelled uncalibrated in the UI.
 */
import type { TimeControlClass } from "./chess-review.ts";
import type { EngineErrorModelParams, RegressionModelParams } from "./rating-model.ts";

export const CALIBRATED_MODELS: Partial<Record<TimeControlClass, EngineErrorModelParams>> = {};

/** Written by scripts/corpus/rating_benchmark.py --write-lib. */
export const REGRESSION_MODELS: Partial<Record<"blitz" | "rapid", RegressionModelParams>> = {};
