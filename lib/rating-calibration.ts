/**
 * Fit the engine error model to games with known ratings.
 *
 * Input: one record per analyzed decision, produced by the same review
 * pipeline the app uses (see scripts/corpus/rating-errormodel.mjs). Each time-control
 * class gets its own parameters – blitz and rapid ratings are different
 * populations and must never share a mapping.
 *
 * Fitting is plain maximum likelihood of the ordered-logit error model by
 * gradient ascent (12 parameters), then:
 *   - the prior is set to the training population's rating mean / sd,
 *   - the likelihood temper is chosen on held-out games so the reported 80 %
 *     interval actually covers ~80 % of true ratings.
 */
import type { TimeControlClass } from "./chess-review.ts";
import {
  CATEGORY_COUNT,
  DEFAULT_ENGINE_ERROR_MODEL,
  engineLogLikelihood,
  posteriorFrom,
  posteriorQuantile,
  ratingGrid,
  type Decision,
  type EngineErrorModelParams,
} from "./rating-model.ts";

export interface CalibrationRecord extends Decision {
  gameId: string;
  color: "w" | "b";
  rating: number;
  timeControl: TimeControlClass;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

interface FitOptions {
  iterations?: number;
  learningRate?: number;
  /** L2 pull towards the prior parameters, per decision. */
  ridge?: number;
}

/** Maximum-likelihood fit of theta / beta / difficulty weights for one population. */
export function fitErrorModel(
  data: Array<Decision & { rating: number }>,
  start: EngineErrorModelParams = DEFAULT_ENGINE_ERROR_MODEL,
  options: FitOptions = {},
): EngineErrorModelParams {
  const iterations = options.iterations ?? 400;
  const learningRate = options.learningRate ?? 0.5;
  const ridge = options.ridge ?? 1e-3;
  const theta = [...start.theta];
  const beta = [...start.beta];
  let ws = start.difficulty.stakes;
  let wl = start.difficulty.legalMoves;
  const K = CATEGORY_COUNT - 1;
  const totalWeight = data.reduce((sum, record) => sum + record.weight, 0) || 1;

  // Adam keeps the step sizes sane across parameters with different scales.
  const size = 2 * K + 2;
  const m = new Array(size).fill(0);
  const v = new Array(size).fill(0);

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const grad = new Array(size).fill(0);
    for (const record of data) {
      const skill = (record.rating - 1500) / 400;
      const stakes = 4 * record.expectedBefore * (1 - record.expectedBefore) - 0.5;
      const legal = Math.log(Math.max(1, record.legalMoves) / 30);
      const shift = ws * stakes + wl * legal;
      const p = [1];
      for (let k = 0; k < K; k += 1) p.push(sigmoid(theta[k] + shift - beta[k] * skill));
      p.push(0);
      const c = record.category;
      const probability = Math.max(1e-9, p[c] - p[c + 1]);
      // d log P / d eta_k for the two cumulative logits bounding category c.
      const upper = c >= 1 ? (p[c] * (1 - p[c])) / probability : 0; // eta index c-1
      const lower = c + 1 <= K ? (-p[c + 1] * (1 - p[c + 1])) / probability : 0; // eta index c
      const w = record.weight / totalWeight;
      for (const [etaIndex, g] of [[c - 1, upper], [c, lower]] as const) {
        if (etaIndex < 0 || etaIndex >= K || g === 0) continue;
        grad[etaIndex] += w * g;
        grad[K + etaIndex] += w * g * -skill;
        grad[2 * K] += w * g * stakes;
        grad[2 * K + 1] += w * g * legal;
      }
    }
    const params = [...theta, ...beta, ws, wl];
    const prior = [...start.theta, ...start.beta, start.difficulty.stakes, start.difficulty.legalMoves];
    for (let index = 0; index < size; index += 1) {
      const g = grad[index] - ridge * (params[index] - prior[index]);
      m[index] = 0.9 * m[index] + 0.1 * g;
      v[index] = 0.999 * v[index] + 0.001 * g * g;
      const mHat = m[index] / (1 - 0.9 ** iteration);
      const vHat = v[index] / (1 - 0.999 ** iteration);
      params[index] += (learningRate * 0.02 * mHat) / (Math.sqrt(vHat) + 1e-8);
    }
    for (let k = 0; k < K; k += 1) {
      theta[k] = params[k];
      beta[k] = Math.max(0, params[K + k]);
    }
    // Cumulative intercepts must decrease with category severity.
    for (let k = 1; k < K; k += 1) theta[k] = Math.min(theta[k], theta[k - 1] - 0.05);
    ws = params[2 * K];
    wl = params[2 * K + 1];
  }

  return {
    ...start,
    theta,
    beta,
    difficulty: { stakes: ws, legalMoves: wl },
  };
}

export interface GameSample {
  rating: number;
  decisions: Decision[];
}

export function groupGames(records: CalibrationRecord[]): GameSample[] {
  const games = new Map<string, GameSample>();
  for (const record of records) {
    const key = `${record.gameId}:${record.color}`;
    const game = games.get(key) ?? { rating: record.rating, decisions: [] };
    game.decisions.push(record);
    games.set(key, game);
  }
  return [...games.values()];
}

export interface EstimatorReport {
  games: number;
  meanAbsoluteError: number;
  /** Share of true ratings inside the reported 80 % interval. */
  coverage80: number;
  meanIntervalWidth: number;
  correlation: number;
}

export function evaluateEstimator(
  games: GameSample[],
  params: EngineErrorModelParams,
  timeControl: TimeControlClass,
): EstimatorReport {
  const grid = ratingGrid(params);
  let absolute = 0;
  let covered = 0;
  let width = 0;
  const truths: number[] = [];
  const estimates: number[] = [];
  for (const game of games) {
    const posterior = posteriorFrom([engineLogLikelihood(game.decisions, timeControl, params, grid)], params, grid);
    const median = posteriorQuantile(posterior, 0.5);
    const low = posteriorQuantile(posterior, 0.1);
    const high = posteriorQuantile(posterior, 0.9);
    absolute += Math.abs(median - game.rating);
    if (game.rating >= low && game.rating <= high) covered += 1;
    width += high - low;
    truths.push(game.rating);
    estimates.push(median);
  }
  const n = Math.max(1, games.length);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const mt = mean(truths);
  const me = mean(estimates);
  let cov = 0;
  let vt = 0;
  let ve = 0;
  truths.forEach((truth, index) => {
    cov += (truth - mt) * (estimates[index] - me);
    vt += (truth - mt) ** 2;
    ve += (estimates[index] - me) ** 2;
  });
  return {
    games: games.length,
    meanAbsoluteError: absolute / n,
    coverage80: covered / n,
    meanIntervalWidth: width / n,
    correlation: vt && ve ? cov / Math.sqrt(vt * ve) : 0,
  };
}

/** Deterministic split so re-running a calibration reproduces the same holdout. */
export function isHoldout(gameId: string, share = 0.2) {
  let hash = 2166136261;
  for (let index = 0; index < gameId.length; index += 1) {
    hash ^= gameId.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 2 ** 32 < share;
}

export interface CalibrationResult {
  timeControl: TimeControlClass;
  params: EngineErrorModelParams;
  train: EstimatorReport;
  holdout: EstimatorReport;
  decisions: number;
}

export function calibrate(records: CalibrationRecord[], timeControl: TimeControlClass, options: FitOptions = {}): CalibrationResult {
  const population = records.filter((record) => record.timeControl === timeControl);
  const train = population.filter((record) => !isHoldout(record.gameId));
  const holdout = population.filter((record) => isHoldout(record.gameId));
  const ratings = groupGames(train).map((game) => game.rating);
  const mean = ratings.reduce((sum, value) => sum + value, 0) / Math.max(1, ratings.length);
  const sd = Math.sqrt(ratings.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, ratings.length - 1));

  const base: EngineErrorModelParams = {
    ...DEFAULT_ENGINE_ERROR_MODEL,
    timeControlOffset: { ...DEFAULT_ENGINE_ERROR_MODEL.timeControlOffset, [timeControl]: 0 },
    prior: { mean: Math.round(mean) || 1500, sd: Math.round(sd) || 500 },
  };
  let params = fitErrorModel(train, base, options);

  // Choose the temper whose holdout 80 % intervals are best calibrated.
  const holdoutGames = groupGames(holdout.length ? holdout : train);
  let bestTemper = params.temper;
  let bestGap = Infinity;
  for (const temper of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
    const report = evaluateEstimator(holdoutGames, { ...params, temper }, timeControl);
    const gap = Math.abs(report.coverage80 - 0.8);
    if (gap < bestGap) {
      bestGap = gap;
      bestTemper = temper;
    }
  }
  params = {
    ...params,
    temper: bestTemper,
    id: `engine-error-v1-${timeControl}`,
    calibrated: true,
    ratingSystem: `fit on ${groupGames(train).length} ${timeControl} game-sides`,
  };
  return {
    timeControl,
    params,
    train: evaluateEstimator(groupGames(train), params, timeControl),
    holdout: evaluateEstimator(holdoutGames, params, timeControl),
    decisions: population.length,
  };
}
