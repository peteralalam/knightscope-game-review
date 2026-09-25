/**
 * Single-game playing-level estimation.
 *
 * WHAT THIS ACTUALLY ESTIMATES: the supervised target is a player's long-term
 * Lichess rating at the time of the game, but the input is one game's worth of
 * decisions. The output is therefore an "estimated Lichess-equivalent playing
 * level, based on this game only" – the rating whose typical games look like
 * this one – NOT a direct read of that individual game's hypothetical
 * performance Elo, and NOT a claim about the player's actual account rating.
 * A single game is a genuinely noisy sample of how someone plays (see
 * "single-game noise" / within-player game-to-game variance in
 * docs/validation-report.md): the long-term rating label used for training
 * carries real label noise relative to any one game, which is part of why the
 * estimate has an irreducible error floor no amount of feature engineering
 * removes.
 *
 * Default path (when REGRESSION_MODELS has parameters for the time control):
 * a ridge regression on interpretable, rating-independent per-game features,
 * calibrated on rated Lichess games with player-disjoint splits, and an
 * approximate range from Mondrian split-conformal out-of-fold residuals. See
 * scripts/corpus/rating_benchmark.py and docs/validation-report.md for how it
 * was fitted and how well it generalizes.
 *
 * Fallback / research path: an ordered-logit "engine error model",
 * P(error category | rating R, position difficulty, time control), summed over a
 * rating grid with a population prior. Its default parameters are priors
 * (`calibrated: false`); the benchmark fits it too and shows the regression
 * generalizes better. The same grid can absorb log-likelihoods from a human
 * move-prediction model (Maia-style P(played move | position, R)) via
 * `HumanMovePredictor`.
 */
import type { PerformanceEstimate, PerformanceFeatures, ReviewedMove, TimeControlClass } from "./chess-review.ts";
import { CALIBRATED_MODELS, REGRESSION_MODELS } from "./rating-params.ts";
import { LOSS_BANDS } from "./review-config.ts";

export const CATEGORY_COUNT = 6;
export const CATEGORY_LABELS = ["top", "excellent", "good", "inaccuracy", "mistake", "blunder"] as const;

export interface EngineErrorModelParams {
  id: string;
  calibrated: boolean;
  ratingSystem: string;
  /** Intercepts of the cumulative logits P(category ≥ k), k = 1…5, at 1500 and zero difficulty. */
  theta: number[];
  /** Skill slopes per 400 rating points for each cumulative logit. */
  beta: number[];
  difficulty: {
    /** Weight of 4·E·(1−E): balanced positions are harder to play precisely. */
    stakes: number;
    /** Weight of ln(legal moves / 30). */
    legalMoves: number;
  };
  /** Added to every cumulative logit; faster games produce more errors at equal strength. */
  timeControlOffset: Record<TimeControlClass, number>;
  prior: { mean: number; sd: number };
  /** Likelihood tempering for within-game correlation between moves (0–1]. */
  temper: number;
  grid: { min: number; max: number; step: number };
  /** Probability floor per move, so one freak move cannot dominate. */
  floor: number;
}

const logit = (p: number) => Math.log(p / (1 - p));

export const DEFAULT_ENGINE_ERROR_MODEL: EngineErrorModelParams = {
  id: "engine-error-v1-prior",
  calibrated: false,
  ratingSystem: "online (Lichess-like), uncalibrated",
  // At 1500, average difficulty: 45 % top-move agreement, 32 % worse than
  // Excellent, 19 % Inaccuracy or worse, 10 % Mistake or worse, 5 % Blunder.
  theta: [logit(0.55), logit(0.32), logit(0.19), logit(0.1), logit(0.05)],
  // Gross errors fall off with strength faster than engine-match rate rises.
  beta: [0.25, 0.45, 0.6, 0.75, 0.85],
  difficulty: { stakes: 0.6, legalMoves: 0.3 },
  timeControlOffset: {
    ultrabullet: 0.8,
    bullet: 0.5,
    blitz: 0.2,
    rapid: 0,
    classical: -0.15,
    correspondence: -0.4,
    unknown: 0.1,
  },
  prior: { mean: 1500, sd: 500 },
  temper: 0.6,
  grid: { min: 400, max: 3000, step: 10 },
  floor: 1e-4,
};

export function classifyTimeControl(header?: string): TimeControlClass {
  if (!header || header === "?") return "unknown";
  if (header === "-" || header.includes("/")) return "correspondence";
  const match = header.match(/^(\d+)(?:\+(\d+))?$/);
  if (!match) return "unknown";
  // Lichess's estimated game duration: base + 40 × increment.
  const estimate = Number(match[1]) + 40 * Number(match[2] ?? 0);
  if (estimate < 30) return "ultrabullet";
  if (estimate < 180) return "bullet";
  if (estimate < 480) return "blitz";
  if (estimate < 1500) return "rapid";
  return "classical";
}

export function errorCategory(move: Pick<ReviewedMove, "isTopMove" | "expectedPointsLost">) {
  if (move.isTopMove) return 0;
  const loss = move.expectedPointsLost;
  if (loss <= LOSS_BANDS.excellent) return 1;
  if (loss <= LOSS_BANDS.good) return 2;
  if (loss <= LOSS_BANDS.inaccuracy) return 3;
  if (loss <= LOSS_BANDS.mistake) return 4;
  return 5;
}

export interface Decision {
  category: number;
  weight: number;
  /** Mover's best expected score before the move. */
  expectedBefore: number;
  legalMoves: number;
}

export function decisionsFromReviews(moves: ReviewedMove[]): Decision[] {
  return moves
    .filter((move) => move.informativeness > 0)
    .map((move) => ({
      category: errorCategory(move),
      weight: move.informativeness,
      expectedBefore: move.expectedBefore,
      legalMoves: move.legalMoveCount,
    }));
}

export function difficultyOf(decision: Decision, params: EngineErrorModelParams) {
  const stakes = 4 * decision.expectedBefore * (1 - decision.expectedBefore);
  return (
    params.difficulty.stakes * (stakes - 0.5) +
    params.difficulty.legalMoves * Math.log(Math.max(1, decision.legalMoves) / 30)
  );
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Category probabilities for one decision at rating R. */
export function categoryProbabilities(
  rating: number,
  decision: Decision,
  timeControl: TimeControlClass,
  params: EngineErrorModelParams = DEFAULT_ENGINE_ERROR_MODEL,
) {
  const skill = (rating - 1500) / 400;
  const shift = difficultyOf(decision, params) + (params.timeControlOffset[timeControl] ?? 0);
  const cumulative = [1];
  for (let k = 0; k < CATEGORY_COUNT - 1; k += 1) {
    const p = sigmoid(params.theta[k] + shift - params.beta[k] * skill);
    cumulative.push(Math.min(p, cumulative[cumulative.length - 1]));
  }
  cumulative.push(0);
  const probabilities: number[] = [];
  for (let c = 0; c < CATEGORY_COUNT; c += 1) {
    probabilities.push(Math.max(params.floor, cumulative[c] - cumulative[c + 1]));
  }
  return probabilities;
}

export function ratingGrid(params: EngineErrorModelParams = DEFAULT_ENGINE_ERROR_MODEL) {
  const grid: number[] = [];
  for (let rating = params.grid.min; rating <= params.grid.max; rating += params.grid.step) grid.push(rating);
  return grid;
}

export function engineLogLikelihood(
  decisions: Decision[],
  timeControl: TimeControlClass,
  params: EngineErrorModelParams = DEFAULT_ENGINE_ERROR_MODEL,
  grid = ratingGrid(params),
) {
  return grid.map((rating) => {
    let total = 0;
    for (const decision of decisions) {
      const probabilities = categoryProbabilities(rating, decision, timeControl, params);
      total += decision.weight * Math.log(probabilities[decision.category]);
    }
    return params.temper * total;
  });
}

export interface Posterior {
  grid: number[];
  probabilities: number[];
}

export function posteriorFrom(
  logLikelihoods: number[][],
  params: EngineErrorModelParams = DEFAULT_ENGINE_ERROR_MODEL,
  grid = ratingGrid(params),
): Posterior {
  const logPosterior = grid.map((rating, index) => {
    const z = (rating - params.prior.mean) / params.prior.sd;
    return -0.5 * z * z + logLikelihoods.reduce((sum, curve) => sum + (curve[index] ?? 0), 0);
  });
  const peak = Math.max(...logPosterior);
  const unnormalized = logPosterior.map((value) => Math.exp(value - peak));
  const total = unnormalized.reduce((sum, value) => sum + value, 0);
  return { grid, probabilities: unnormalized.map((value) => value / total) };
}

export function posteriorQuantile(posterior: Posterior, q: number) {
  let cumulative = 0;
  for (let index = 0; index < posterior.grid.length; index += 1) {
    cumulative += posterior.probabilities[index];
    if (cumulative >= q) return posterior.grid[index];
  }
  return posterior.grid[posterior.grid.length - 1];
}

// --- Calibrated regression (the default when parameters exist) -------------
//
// A ridge regression from interpretable, rating-independent per-game features
// to the player's Lichess rating, fitted separately for blitz and rapid on
// rated Lichess games with player-disjoint splits
// (scripts/corpus/rating_benchmark.py). Optionally followed by a monotone
// (isotonic) calibration layer fitted on out-of-fold predictions.
//
// The range is a Mondrian split-conformal interval: the out-of-fold residuals
// of players with a similar ESTIMATE and a similar number of meaningful
// decisions (both known here – never the true rating) give its 10th / 90th
// percentiles. It is therefore calibrated conditional on the estimate, not on
// the player's true rating: at the rating extremes the estimate regresses
// toward the middle and the range covers the true rating less often. The UI
// calls it an "approximate performance range" for that reason.

/** Raw regression inputs, in order. `null` = not measurable in this game. */
export const RATING_FEATURES = [
  "logMeanLoss",
  "logMedianLoss",
  "logP75Loss",
  "logP90Loss",
  "logComplexityWeightedLoss",
  "severeLossRate",
  "largeLossRate",
  "moderateLossRate",
  "top1Agreement",
  "top3Agreement",
  "criticalAccuracy",
  "onlyMoveSuccess",
  "punishRate",
  "defensiveAccuracy",
  "conversionAccuracy",
  "middlegameAccuracy",
  "endgameAccuracy",
  "logMeaningfulDecisions",
  "logGameLength",
] as const;

const LOSS_FLOOR = 0.005;
const percentOrNull = (value: number | null) => (value === null ? null : value / 100);

export function ratingFeatureVector(features: PerformanceFeatures): Array<number | null> {
  return [
    Math.log(features.meanLoss + LOSS_FLOOR),
    Math.log(features.medianLoss + LOSS_FLOOR),
    Math.log(features.p75Loss + LOSS_FLOOR),
    Math.log(features.p90Loss + LOSS_FLOOR),
    Math.log(features.complexityWeightedLoss + LOSS_FLOOR),
    features.severeLossRate,
    features.largeLossRate,
    features.moderateLossRate,
    features.top1Agreement,
    features.topNAgreement,
    percentOrNull(features.criticalAccuracy),
    features.onlyMoveSuccess,
    features.punishRate,
    percentOrNull(features.defensiveAccuracy),
    percentOrNull(features.conversionAccuracy),
    percentOrNull(features.middlegameAccuracy),
    percentOrNull(features.endgameAccuracy),
    Math.log(1 + features.meaningfulMoves),
    Math.log(Math.max(1, features.gameLength)),
  ];
}

export interface RegressionModelParams {
  id: string;
  calibrated: true;
  ratingSystem: string;
  trainedOn: string;
  /** Train-set mean used for a missing raw feature (by RATING_FEATURES index). */
  imputation: number[];
  /** Raw features that get a 0/1 "was missing" indicator appended, by index. */
  missingIndicators: number[];
  /** Optional second-order terms: squares of the standardized raw features and their products with one feature. */
  expansion: { rawMean: number[]; rawScale: number[]; interactWith: number } | null;
  mean: number[];
  scale: number[];
  coefficients: number[];
  intercept: number;
  /** Monotone calibration map (isotonic knots, linear in between, clipped at the ends). */
  calibration: { x: number[]; y: number[] } | null;
  clamp: [number, number];
  conformal: { level: number; groups: ConformalGroup[] };
  heldOut: { mae: number; coverage80: number; samples: number } | null;
}

export interface ConformalGroup {
  /** Calibration cell on the (calibrated) estimate and the meaningful-decision count; null = open. */
  predLow: number | null;
  predHigh: number | null;
  decisionsLow: number;
  decisionsHigh: number | null;
  /** Residual (true − estimate) quantiles of this cell. */
  qLow: number;
  qHigh: number;
  n: number;
}

/** Imputed raw features, the 0/1 missing indicators, then any second-order terms. */
export function expandedFeatures(raw: Array<number | null>, params: RegressionModelParams) {
  const filled = raw.map((value, index) => value ?? params.imputation[index]);
  const values = [...filled];
  for (const index of params.missingIndicators) values.push(raw[index] === null ? 1 : 0);
  if (params.expansion) {
    const { rawMean, rawScale, interactWith } = params.expansion;
    const z = filled.map((value, index) => (value - rawMean[index]) / rawScale[index]);
    for (const value of z) values.push(value * value);
    for (const value of z) values.push(value * z[interactWith]);
  }
  return values;
}

/** Piecewise-linear evaluation of the isotonic calibration knots. */
export function applyCalibration(value: number, calibration: RegressionModelParams["calibration"]) {
  if (!calibration || calibration.x.length === 0) return value;
  const { x, y } = calibration;
  if (value <= x[0]) return y[0];
  if (value >= x[x.length - 1]) return y[y.length - 1];
  let index = 1;
  while (x[index] < value) index += 1;
  const t = (value - x[index - 1]) / (x[index] - x[index - 1] || 1);
  return y[index - 1] + t * (y[index] - y[index - 1]);
}

export function conformalGroup(center: number, meaningfulMoves: number, groups: ConformalGroup[]) {
  return groups.find((group) =>
    (group.predLow === null || center >= group.predLow) &&
    (group.predHigh === null || center < group.predHigh) &&
    meaningfulMoves >= group.decisionsLow &&
    (group.decisionsHigh === null || meaningfulMoves < group.decisionsHigh)) ?? groups[groups.length - 1];
}

/** Estimate and conformal range from a raw feature vector (see ratingFeatureVector). */
export function regressionFromVector(raw: Array<number | null>, meaningfulMoves: number, params: RegressionModelParams) {
  const values = expandedFeatures(raw, params);
  let prediction = params.intercept;
  values.forEach((value, index) => {
    prediction += params.coefficients[index] * ((value - params.mean[index]) / params.scale[index]);
  });
  const clamped = Math.min(params.clamp[1], Math.max(params.clamp[0], prediction));
  const center = applyCalibration(clamped, params.calibration);
  const group = conformalGroup(center, meaningfulMoves, params.conformal.groups);
  return { center, low: center + group.qLow, high: center + group.qHigh };
}

export function regressionEstimate(features: PerformanceFeatures, params: RegressionModelParams) {
  return regressionFromVector(ratingFeatureVector(features), features.meaningfulMoves, params);
}

/** Which calibrated population a time control is estimated against. */
export function regressionModelFor(timeControl: TimeControlClass) {
  const key = timeControl === "blitz" || timeControl === "bullet" || timeControl === "ultrabullet" ? "blitz" : "rapid";
  return { key, params: REGRESSION_MODELS[key], extrapolated: timeControl !== key };
}

export interface EstimateOptions {
  /** Per-game features (extractFeatures); enables the calibrated regression. */
  features?: PerformanceFeatures | null;
  timeControl?: TimeControlClass;
  params?: EngineErrorModelParams;
  /** Extra log-likelihood curves on the same grid, e.g. from a human move model. */
  additionalLogLikelihoods?: number[][];
  /** Minimum informativeness-weighted decisions before an estimate is shown. */
  minimumEffectiveMoves?: number;
}

export function estimatePerformance(
  sideMoves: ReviewedMove[],
  options: EstimateOptions = {},
): PerformanceEstimate | null {
  const timeControl = options.timeControl ?? "unknown";
  const decisions = decisionsFromReviews(sideMoves);
  const effective = decisions.reduce((sum, decision) => sum + decision.weight, 0);
  if (effective < (options.minimumEffectiveMoves ?? 4)) return null;

  const regression = regressionModelFor(timeControl);
  if (options.features && regression.params && !options.params && !options.additionalLogLikelihoods?.length) {
    const { center, low, high } = regressionEstimate(options.features, regression.params);
    const width = high - low;
    return {
      estimatedPerformanceRating: Math.round(center / 50) * 50,
      confidenceLow: Math.floor(low / 50) * 50,
      confidenceHigh: Math.ceil(high / 50) * 50,
      confidence: width <= 500 ? "high" : width <= 800 ? "medium" : "low",
      meaningfulMoves: options.features.meaningfulMoves,
      timeControl,
      ratingSystem: regression.params.ratingSystem,
      model: regression.params.id,
      calibrated: true,
      extrapolated: regression.extrapolated,
      heldOutMae: regression.params.heldOut?.mae,
      heldOutCoverage: regression.params.heldOut?.coverage80,
    };
  }

  const params = options.params ?? CALIBRATED_MODELS[timeControl] ?? DEFAULT_ENGINE_ERROR_MODEL;

  const grid = ratingGrid(params);
  const curves = [engineLogLikelihood(decisions, timeControl, params, grid), ...(options.additionalLogLikelihoods ?? [])];
  const posterior = posteriorFrom(curves, params, grid);
  const median = posteriorQuantile(posterior, 0.5);
  const low = posteriorQuantile(posterior, 0.1);
  const high = posteriorQuantile(posterior, 0.9);
  const width = high - low;
  return {
    estimatedPerformanceRating: Math.round(median / 50) * 50,
    confidenceLow: Math.floor(low / 50) * 50,
    confidenceHigh: Math.ceil(high / 50) * 50,
    confidence: width <= 350 ? "high" : width <= 600 ? "medium" : "low",
    meaningfulMoves: decisions.filter((decision) => decision.weight >= 0.5).length,
    timeControl,
    ratingSystem: params.ratingSystem,
    model: options.additionalLogLikelihoods?.length ? `${params.id}+human-model` : params.id,
    calibrated: params.calibrated,
  };
}

/**
 * Optional human move-prediction model (e.g. Maia-2 / Maia-3 behind a service
 * or an ONNX export). It must return a probability distribution over legal
 * moves in UCI for the side to move at the given rating.
 */
export interface HumanMovePredictor {
  readonly id: string;
  /** The rating pool the model was trained on, e.g. "lichess-rapid". */
  readonly ratingSystem: string;
  predict(request: {
    fen: string;
    selfRating: number;
    opponentRating?: number;
    timeControl: TimeControlClass;
  }): Promise<Record<string, number>>;
}

export interface HumanDecision {
  fen: string;
  move: string;
  weight: number;
}

/**
 * log L(R) = temper · Σ wᵢ · log max(floor, P(playedᵢ | positionᵢ, R)) on the grid.
 * The floor clips the influence of any single unexpected move.
 */
export async function humanModelLogLikelihood(
  decisions: HumanDecision[],
  predictor: HumanMovePredictor,
  options: {
    timeControl: TimeControlClass;
    opponentRating?: number;
    grid?: number[];
    floor?: number;
    temper?: number;
  },
) {
  const grid = options.grid ?? ratingGrid();
  const floor = options.floor ?? 1e-3;
  const temper = options.temper ?? DEFAULT_ENGINE_ERROR_MODEL.temper;
  const curve = new Array<number>(grid.length).fill(0);
  for (const decision of decisions) {
    if (decision.weight <= 0) continue;
    for (let index = 0; index < grid.length; index += 1) {
      const distribution = await predictor.predict({
        fen: decision.fen,
        selfRating: grid[index],
        opponentRating: options.opponentRating,
        timeControl: options.timeControl,
      });
      curve[index] += decision.weight * Math.log(Math.max(floor, distribution[decision.move] ?? 0));
    }
  }
  return curve.map((value) => temper * value);
}
