import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePgn,
  reviewMove,
  summarizeSide,
  uciToSan,
} from "../lib/chess-review.ts";

const SIMPLE_PGN = `[Event "Test"]
[White "Ada"]
[Black "Turing"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 *`;

function line(expected, pv, cp = 0) {
  return { depth: 12, nodes: 90_000, expected, pv, cp };
}

test("parses headers and preserves replayable positions", () => {
  const game = parsePgn(SIMPLE_PGN);
  assert.equal(game.headers.White, "Ada");
  assert.equal(game.headers.Black, "Turing");
  assert.equal(game.moves.length, 14);
  assert.equal(game.moves[0].uci, "e2e4");
  assert.equal(game.moves[8].san, "O-O");
  assert.match(game.moves[0].before, / w /);
  assert.match(game.moves[0].after, / b /);
  assert.equal(uciToSan(game.moves[0].before, "e2e4"), "e4");
});

test("rejects empty and malformed PGNs with useful errors", () => {
  assert.throws(() => parsePgn(""), /Paste a PGN/);
  assert.throws(() => parsePgn("1. e4 e5 2. Banana"), /not valid/i);
});

test("grades an engine match as best and a large expected-score loss as a blunder", () => {
  const game = parsePgn(SIMPLE_PGN);
  const best = reviewMove(game, 0, {
    bestMove: "e2e4",
    best: line(0.56, ["e2e4", "e7e5"], 22),
    second: line(0.54, ["d2d4", "d7d5"], 13),
    played: line(0.56, ["e2e4", "e7e5"], 22),
    playedRank: 1,
  });
  assert.equal(best.grade, "best");
  assert.equal(best.bestMoveSan, "e4");
  assert.ok(best.accuracy > 99);

  const blunder = reviewMove(game, 1, {
    bestMove: "e7e5",
    best: line(0.62, ["e7e5", "g1f3"], 64),
    second: line(0.58, ["c7c5", "g1f3"], 38),
    played: line(0.37, ["e7e5", "g1f3"], -88),
    playedRank: null,
  });
  assert.equal(blunder.grade, "blunder");
  assert.ok(blunder.loss > 18);
  assert.equal(blunder.expectedWhiteAfter, 0.63);
});

test("builds a broad single-game performance range after enough decisions", () => {
  const game = parsePgn(SIMPLE_PGN);
  const source = reviewMove(game, 10, {
    bestMove: game.moves[10].uci,
    best: line(0.55, [game.moves[10].uci], 20),
    second: line(0.52, ["a2a3"], 8),
    played: line(0.53, [game.moves[10].uci], 12),
    playedRank: 1,
  });
  const reviews = Array.from({ length: 10 }, (_, index) => ({
    ...source,
    index: 8 + index * 2,
    color: "w",
    rawLoss: 2 + (index % 3),
    accuracy: 88 - index,
  }));
  const summary = summarizeSide(reviews, "w", {});
  assert.ok(summary.accuracy > 70 && summary.accuracy < 95);
  assert.ok(summary.estimatedRating);
  assert.ok(summary.estimatedRating.high - summary.estimatedRating.low >= 500);
  assert.ok(summary.estimatedRating.low >= 400);
  assert.ok(summary.estimatedRating.high <= 2800);
});
