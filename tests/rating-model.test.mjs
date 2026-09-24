import assert from "node:assert/strict";
import test from "node:test";
import { calibrate, fitErrorModel } from "../lib/rating-calibration.ts";
import {
  categoryProbabilities,
  classifyTimeControl,
  DEFAULT_ENGINE_ERROR_MODEL,
  estimatePerformance,
  humanModelLogLikelihood,
  RATING_FEATURES,
  ratingFeatureVector,
  ratingGrid,
  regressionFromVector,
} from "../lib/rating-model.ts";

/** Deterministic PRNG so synthetic data is reproducible. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const LOSS_FOR_CATEGORY = [0, 0.01, 0.04, 0.08, 0.15, 0.3];

/** Minimal ReviewedMove-like objects: the rating model only reads these fields. */
function moves(categories, extra = {}) {
  return categories.map((category) => ({
    isTopMove: category === 0,
    expectedPointsLost: LOSS_FOR_CATEGORY[category],
    expectedBefore: 0.5,
    legalMoveCount: 30,
    informativeness: 1,
    ...extra,
  }));
}

test("time controls follow Lichess's base + 40 × increment classes", () => {
  assert.equal(classifyTimeControl("15+0"), "ultrabullet");
  assert.equal(classifyTimeControl("60+0"), "bullet");
  assert.equal(classifyTimeControl("180+2"), "blitz");
  assert.equal(classifyTimeControl("600+0"), "rapid");
  assert.equal(classifyTimeControl("1800+30"), "classical");
  assert.equal(classifyTimeControl("-"), "correspondence");
  assert.equal(classifyTimeControl(undefined), "unknown");
});

test("category probabilities form a distribution and shift toward precision with rating", () => {
  const decision = { category: 0, weight: 1, expectedBefore: 0.5, legalMoves: 30 };
  for (const rating of [600, 1500, 2600]) {
    const total = categoryProbabilities(rating, decision, "rapid").reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(total - 1) < 1e-3, `sum ${total}`);
  }
  const weak = categoryProbabilities(900, decision, "rapid");
  const strong = categoryProbabilities(2400, decision, "rapid");
  assert.ok(strong[0] > weak[0], "strong players match the top move more often");
  assert.ok(strong[5] < weak[5] / 4, "and blunder far less");
});

test("precise play estimates higher than error-prone play; not a fixed accuracy→Elo table", () => {
  const clean = estimatePerformance(moves([...Array(30).fill(0), ...Array(10).fill(1)]), { timeControl: "rapid" });
  const sloppy = estimatePerformance(moves([...Array(18).fill(0), ...Array(8).fill(2), 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 1, 1, 1, 1]), { timeControl: "rapid" });
  assert.ok(clean.estimatedPerformanceRating > sloppy.estimatedPerformanceRating + 500);
  assert.equal(clean.calibrated, false);
  assert.equal(clean.estimatedPerformanceRating % 50, 0, "no fake precision");
});

test("the interval narrows with more meaningful decisions", () => {
  const pattern = [0, 0, 1, 0, 2, 0, 3, 0, 1, 4];
  const short = estimatePerformance(moves(pattern), { timeControl: "rapid" });
  const long = estimatePerformance(moves([...pattern, ...pattern, ...pattern, ...pattern]), { timeControl: "rapid" });
  const width = (estimate) => estimate.confidenceHigh - estimate.confidenceLow;
  assert.ok(width(long) < width(short) * 0.8, `${width(short)} vs ${width(long)}`);
  assert.equal(short.meaningfulMoves, 10);
  assert.equal(long.meaningfulMoves, 40);
});

test("book and forced moves carry no weight; too few decisions give no estimate", () => {
  const base = moves([0, 1, 2, 0, 3, 0, 1, 0, 4, 0]);
  const withTheory = [...base, ...moves(Array(20).fill(0), { informativeness: 0 })];
  assert.deepEqual(
    estimatePerformance(withTheory, { timeControl: "blitz" }),
    estimatePerformance(base, { timeControl: "blitz" }),
  );
  assert.equal(estimatePerformance(moves([0, 0, 0]), { timeControl: "blitz" }), null);
});

test("the same moves in blitz imply a higher rating than in classical", () => {
  const sample = moves([0, 0, 1, 2, 0, 3, 0, 1, 4, 0, 0, 2, 1, 0, 5, 0, 1, 0, 0, 2]);
  const blitz = estimatePerformance(sample, { timeControl: "blitz" });
  const classical = estimatePerformance(sample, { timeControl: "classical" });
  assert.ok(blitz.estimatedPerformanceRating > classical.estimatedPerformanceRating);
});

test("a human move-prediction model plugs into the same likelihood grid", async () => {
  // A fake predictor that explains the played moves best at 2000.
  const predictor = {
    id: "fake",
    ratingSystem: "test",
    async predict({ selfRating }) {
      const p = Math.exp(-(((selfRating - 2000) / 300) ** 2));
      return { e2e4: 0.05 + 0.6 * p, d2d4: 0.95 - 0.6 * p };
    },
  };
  const decisions = Array.from({ length: 25 }, () => ({ fen: "startpos", move: "e2e4", weight: 1 }));
  const curve = await humanModelLogLikelihood(decisions, predictor, { timeControl: "rapid", grid: ratingGrid() });
  const sample = moves([0, 1, 0, 2, 0, 1, 0, 0, 3, 0, 1, 0]);
  const engineOnly = estimatePerformance(sample, { timeControl: "rapid" });
  const combined = estimatePerformance(sample, { timeControl: "rapid", additionalLogLikelihoods: [curve] });
  assert.ok(
    Math.abs(combined.estimatedPerformanceRating - 2000) < Math.abs(engineOnly.estimatedPerformanceRating - 2000),
  );
  assert.match(combined.model, /human-model/);
});

test("calibration recovers a known model from synthetic rated games", () => {
  const random = rng(7);
  const truth = { ...DEFAULT_ENGINE_ERROR_MODEL, beta: [0.4, 0.6, 0.8, 0.95, 1.1] };
  const records = [];
  for (let game = 0; game < 400; game += 1) {
    const rating = Math.round(900 + random() * 1500);
    for (let move = 0; move < 30; move += 1) {
      const decision = { category: 0, weight: 1, expectedBefore: 0.2 + 0.6 * random(), legalMoves: 10 + Math.floor(random() * 30) };
      const probabilities = categoryProbabilities(rating, decision, "blitz", { ...truth, timeControlOffset: { ...truth.timeControlOffset, blitz: 0 } });
      let draw = random();
      let category = 0;
      while (category < probabilities.length - 1 && draw > probabilities[category]) {
        draw -= probabilities[category];
        category += 1;
      }
      records.push({ ...decision, category, gameId: `g${game}`, color: "w", rating, timeControl: "blitz" });
    }
  }
  const fitted = fitErrorModel(records, DEFAULT_ENGINE_ERROR_MODEL, { iterations: 300 });
  for (let k = 0; k < 5; k += 1) {
    assert.ok(Math.abs(fitted.beta[k] - truth.beta[k]) < 0.2, `beta[${k}] ${fitted.beta[k]} vs ${truth.beta[k]}`);
  }
  const result = calibrate(records, "blitz", { iterations: 300 });
  assert.equal(result.params.calibrated, true);
  assert.ok(result.holdout.correlation > 0.7, `r ${result.holdout.correlation}`);
  assert.ok(Math.abs(result.holdout.coverage80 - 0.8) < 0.15, `coverage ${result.holdout.coverage80}`);
});

test("calibrated regression: interval is residual-derived and widens for short games", () => {
  const params = {
    id: "test-ridge",
    calibrated: true,
    ratingSystem: "Lichess rapid (equivalent)",
    trainedOn: "test",
    imputation: RATING_FEATURES.map(() => 0),
    missingIndicators: [9],
    mean: [...RATING_FEATURES.map(() => 0), 0],
    scale: [...RATING_FEATURES.map(() => 1), 1],
    coefficients: [-300, ...RATING_FEATURES.slice(1).map(() => 0), 0],
    intercept: 1500,
    interval: { a: 40_000, b: 2_000_000, qLow: -1.3, qHigh: 1.3 },
    clamp: [800, 2800],
    heldOut: { mae: 250, coverage80: 0.8, samples: 100 },
  };
  const raw = RATING_FEATURES.map(() => 0);
  raw[0] = Math.log(0.02 + 0.005);
  const better = regressionFromVector(raw, 30, params);
  raw[0] = Math.log(0.08 + 0.005);
  const worse = regressionFromVector(raw, 30, params);
  assert.ok(better.center > worse.center, "lower loss → higher estimate");
  const short = regressionFromVector(raw, 8, params);
  const long = regressionFromVector(raw, 60, params);
  assert.ok(short.high - short.low > (long.high - long.low) * 1.5, "fewer decisions → wider range");
  assert.equal(short.center, long.center);
});

test("feature vector: log-loss transforms and nulls for unmeasurable features", () => {
  const vector = ratingFeatureVector({
    meaningfulMoves: 20, effectiveMoves: 18, gameLength: 60, meanLoss: 0.03, medianLoss: 0.01, p75Loss: 0.03, p90Loss: 0.08,
    complexityWeightedLoss: 0.035, blunderRate: 0.05, mistakeRate: 0.05, inaccuracyRate: 0.1, top1Agreement: 0.4,
    topNAgreement: 0.7, criticalAccuracy: null, onlyMoveSuccess: null, conversionAccuracy: 80, defensiveAccuracy: null,
    opportunityConversion: 0.5, openingAccuracy: 90, middlegameAccuracy: 75, endgameAccuracy: null,
  });
  assert.equal(vector.length, RATING_FEATURES.length);
  assert.ok(Math.abs(vector[0] - Math.log(0.035)) < 1e-12);
  assert.equal(vector[RATING_FEATURES.indexOf("criticalAccuracy")], null);
  assert.equal(vector[RATING_FEATURES.indexOf("conversionAccuracy")], 0.8);
  assert.ok(Math.abs(vector[RATING_FEATURES.indexOf("logMeaningfulDecisions")] - Math.log(21)) < 1e-12);
});

test("shipped regression parameters reproduce the offline benchmark's predictions", async () => {
  const { REGRESSION_MODELS } = await import("../lib/rating-params.ts");
  const { readFileSync, existsSync } = await import("node:fs");
  const benchmarkPath = new URL("../data/rating-corpus/benchmark.json", import.meta.url);
  const samplesPath = new URL("../data/rating-corpus/samples.jsonl", import.meta.url);
  if (!Object.keys(REGRESSION_MODELS).length || !existsSync(benchmarkPath)) return;
  const benchmark = JSON.parse(readFileSync(benchmarkPath, "utf8"));
  const samples = new Map(
    readFileSync(samplesPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((row) => [`${row.gameId}:${row.color}`, row]),
  );
  let checked = 0;
  for (const [tc, report] of Object.entries(benchmark.timeControls)) {
    for (const expected of report.parityCheck) {
      const row = samples.get(`${expected.gameId}:${expected.color}`);
      const { center } = regressionFromVector(row.x, row.meaningfulMoves, REGRESSION_MODELS[tc]);
      assert.ok(Math.abs(center - expected.prediction) < 0.01, `${tc} ${expected.gameId}: ${center} vs ${expected.prediction}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 10);
});
