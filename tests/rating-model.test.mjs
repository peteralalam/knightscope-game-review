import assert from "node:assert/strict";
import test from "node:test";
import { calibrate, fitErrorModel } from "../lib/rating-calibration.ts";
import {
  categoryProbabilities,
  classifyTimeControl,
  DEFAULT_ENGINE_ERROR_MODEL,
  estimatePerformance,
  humanModelLogLikelihood,
  ratingGrid,
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
