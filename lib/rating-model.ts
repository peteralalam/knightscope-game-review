/**
 * Single-game performance estimation.
 *
 * This does NOT map accuracy to Elo. Every meaningful decision contributes a
 * likelihood term  P(error category | rating R, position difficulty, time
 * control)  from an ordered-logit "engine error model". Summing the (weighted,
 * tempered) log-likelihoods over a rating grid and multiplying by a population
 * prior gives a posterior over R; the estimate is its median and the interval
 * its 10th–90th percentile. A short game with few real decisions therefore gets
 * a wide interval automatically.
 *
 * The same grid can absorb log-likelihoods from a human move-prediction model
 * (Maia-style P(played move | position, R)) via `HumanMovePredictor`.
 *
 * DEFAULT PARAMETERS ARE PRIORS, NOT A FIT. They encode rough, publicly
 * observable error rates and are clearly flagged `calibrated: false`. Fit them
 * on rated games with `scripts/calibrate-rating.mjs` and replace
 * `DEFAULT_ENGINE_ERROR_MODEL` (per time control) with the output.
 */
import type { PerformanceEstimate, ReviewedMove, TimeControlClass } from "./chess-review.ts";
import { CALIBRATED_MODELS } from "./rating-params.ts";
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

export interface EstimateOptions {
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
  const params = options.params ?? CALIBRATED_MODELS[timeControl] ?? DEFAULT_ENGINE_ERROR_MODEL;
  const decisions = decisionsFromReviews(sideMoves);
  const effective = decisions.reduce((sum, decision) => sum + decision.weight, 0);
  if (effective < (options.minimumEffectiveMoves ?? 4)) return null;

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
