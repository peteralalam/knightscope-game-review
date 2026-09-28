import assert from "node:assert/strict";
import test from "node:test";
import { extractFeatures } from "../lib/chess-review.ts";
import { makeEvaluation } from "../lib/evaluation.ts";
import { ratedExpectedScore, regradeForRating } from "../lib/outcome-model.ts";

// Shape of a fitted model (values only illustrative): flatter for weaker players.
const MODEL = {
  id: "test",
  form: "rating+sat",
  spec: { tc: true, rating: true, sat: true },
  slope: [-1.2, 0.1, 0.5, -0.05, 0.02, 0.0],
  saturation: [-1.5, 0.0, 0.3, 0.0, 0.0, 0.0],
  ratingDifference: 0.3,
  ratingRange: [800, 2700],
};

test("rated curve: neutral at 0, symmetric, increasing, tends to 0 / 1", () => {
  for (const tc of ["blitz", "rapid"]) {
    for (let rating = 600; rating <= 3000; rating += 100) {
      assert.equal(ratedExpectedScore(0, rating, tc, MODEL), 0.5);
      let previous = 0;
      for (let cp = -5000; cp <= 5000; cp += 25) {
        const value = ratedExpectedScore(cp, rating, tc, MODEL);
        assert.ok(Math.abs(value + ratedExpectedScore(-cp, rating, tc, MODEL) - 1) < 1e-12);
        if (cp > -2000 && cp <= 2000) assert.ok(value > previous, `increasing at ${cp}`);
        previous = value;
      }
      assert.ok(ratedExpectedScore(2000, rating, tc, MODEL) > 0.9);
    }
  }
  // Ratings are clamped to the fitted range.
  assert.equal(ratedExpectedScore(300, 400, "blitz", MODEL), ratedExpectedScore(300, 800, "blitz", MODEL));
});

const evalCp = (cp) => makeEvaluation({ cp, pv: [] });

test("regrading only touches ordinary grades on centipawn scores", () => {
  const move = { grade: "mistake", isTopMove: false, bestEvaluation: evalCp(50), resultingEvaluation: evalCp(-250) };
  const low = regradeForRating(move, 900, "blitz", MODEL);
  const high = regradeForRating(move, 2400, "blitz", MODEL);
  assert.ok(["best", "excellent", "good", "inaccuracy", "mistake", "blunder"].includes(low));
  assert.notEqual(low, high, "a flatter low-rating curve grades the same cp loss more leniently");
  for (const grade of ["book", "great", "brilliant", "miss"]) {
    assert.equal(regradeForRating({ ...move, grade }, 900, "blitz", MODEL), grade);
  }
  const mate = { ...move, resultingEvaluation: makeEvaluation({ mate: -3, pv: [] }) };
  assert.equal(regradeForRating(mate, 900, "blitz", MODEL), "mistake");
});

test("no feedback loop: rating features ignore displayed grades", () => {
  const moves = Array.from({ length: 30 }, (_, i) => ({
    index: i * 2,
    color: "w",
    informativeness: 1,
    expectedPointsLost: (i % 5) * 0.04,
    expectedBefore: 0.5,
    isTopMove: i % 5 === 0,
    playedRank: i % 5 === 0 ? 1 : null,
    phase: i < 10 ? "opening" : "middlegame",
    accuracy: 80,
    criticality: { gap: 0.05, onlyMove: false },
    grade: "good",
    objectiveGrade: "good",
  }));
  const before = extractFeatures(moves, moves);
  const relabelled = moves.map((move) => ({ ...move, grade: "blunder", objectiveGrade: "blunder", miss: { missedOpportunityType: "x" } }));
  assert.deepEqual(extractFeatures(relabelled, relabelled), before);
});
