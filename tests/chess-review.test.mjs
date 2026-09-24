import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateAccuracy,
  formatReviewEvaluation,
  moveAccuracy,
  parsePgn,
  reviewMove,
  summarizeSide,
  uciToSan,
} from "../lib/chess-review.ts";
import {
  invertEvaluation,
  makeEvaluation,
  parseInfoLine,
  stockfishWdl,
} from "../lib/evaluation.ts";
import { EXPECTED_SCORE } from "../lib/review-config.ts";

const SIMPLE_PGN = `[Event "Test"]
[White "Ada"]
[Black "Turing"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 *`;

const OPERA_PGN = `[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5
6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5
11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6
15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

const TRADE_PGN = `1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 *`;
const MISSED_MATE_PGN = `1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. d3 g6 *`;

/** An evaluation whose grading expected score is exactly `expected`. */
function withE(expected, pv) {
  const cp = Math.log(expected / (1 - expected)) / EXPECTED_SCORE.humanSlopePerCp;
  return makeEvaluation({ cp, pv, depth: 20, nodes: 150_000 });
}

function mate(moves, pv) {
  return makeEvaluation({ mate: moves, pv, depth: 30, nodes: 150_000 });
}

/** Engine facts for a move where the played move is the engine's top choice. */
function topMove(game, index, line, extra = {}) {
  return { bestMove: game.moves[index].uci, best: line, played: line, playedRank: 1, ...extra };
}

/** Engine facts for a move that is not the engine's choice. */
function otherMove(game, index, bestUci, best, playedE) {
  return {
    bestMove: bestUci,
    best: withE(best, [bestUci]),
    played: withE(playedE, [game.moves[index].uci]),
    playedRank: null,
  };
}

test("parses headers and preserves replayable positions", () => {
  const game = parsePgn(SIMPLE_PGN);
  assert.equal(game.headers.White, "Ada");
  assert.equal(game.moves.length, 14);
  assert.equal(game.moves[0].uci, "e2e4");
  assert.equal(game.moves[8].san, "O-O");
  assert.equal(uciToSan(game.moves[0].before, "e2e4"), "e4");
});

test("rejects empty and malformed PGNs with useful errors", () => {
  assert.throws(() => parsePgn(""), /Paste a PGN/);
  assert.throws(() => parsePgn("1. e4 e5 2. Banana"), /not valid/i);
});

test("UCI parsing ignores aspiration bound lines and normalizes WDL", () => {
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  assert.equal(parseInfoLine("info depth 12 score cp 900 lowerbound nodes 10 pv e2e4", fen), null);
  assert.equal(parseInfoLine("info depth 12 score cp -900 upperbound nodes 10 pv e2e4", fen), null);
  assert.equal(parseInfoLine("info depth 12 currmove e2e4 currmovenumber 1", fen), null);
  const info = parseInfoLine(
    "info depth 18 seldepth 25 multipv 2 score cp 31 wdl 60 920 20 nodes 150000 nps 1 pv d2d4 d7d5",
    fen,
    "Stockfish 19",
  );
  assert.equal(info.multipv, 2);
  assert.equal(info.evaluation.cp, 31);
  assert.equal(info.evaluation.depth, 18);
  assert.equal(info.evaluation.winProbability, 0.06);
  assert.equal(info.evaluation.drawProbability, 0.92);
  assert.ok(Math.abs(info.evaluation.engineExpectedScore - 0.52) < 1e-9);
  assert.deepEqual(info.evaluation.pv, ["d2d4", "d7d5"]);
  assert.equal(info.evaluation.engineVersion, "Stockfish 19");
});

test("mate and tablebase scores are decisive, never giant centipawns", () => {
  const mating = makeEvaluation({ mate: 3, pv: [] });
  assert.equal(mating.expectedScore, 1);
  assert.equal(makeEvaluation({ mate: -2, pv: [] }).expectedScore, 0);
  const tb = makeEvaluation({ cp: 19_950, pv: [] });
  assert.deepEqual(tb.tablebase, { win: true, plies: 50 });
  assert.equal(tb.cp, undefined);
  assert.equal(tb.expectedScore, 1);
  const lostTb = invertEvaluation(tb);
  assert.equal(lostTb.tablebase.win, false);
  assert.equal(lostTb.expectedScore, 0);
});

test("perspective flips swap win/loss, cp and mate signs", () => {
  const white = makeEvaluation({ cp: 120, wdl: { win: 400, draw: 550, loss: 50 }, pv: ["e2e4"] });
  const black = invertEvaluation(white);
  assert.equal(black.cp, -120);
  assert.equal(black.winProbability, white.lossProbability);
  assert.ok(Math.abs(black.expectedScore + white.expectedScore - 1) < 1e-12);
  assert.ok(Math.abs(black.engineExpectedScore + white.engineExpectedScore - 1) < 1e-12);
  assert.equal(invertEvaluation(makeEvaluation({ mate: 4, pv: [] })).mate, -4);
});

test("Stockfish's WDL model reproduces its own normalization anchor (100 cp ≈ 50% wins at 58 material)", () => {
  // 58 material: e.g. both sides with R, B, N and 8 pawns minus a knight each side.
  const fen = "r1b1kb1r/pppppppp/8/8/8/8/PPPPPPPP/R1B1KB1R w - - 0 1";
  const wdl = stockfishWdl(100, fen);
  assert.ok(Math.abs(wdl.win - 0.5) < 0.03, `win ${wdl.win}`);
  assert.ok(Math.abs(wdl.win + wdl.draw + wdl.loss - 1) < 1e-9);
});

test("grades Black's moves from Black's own perspective", () => {
  const game = parsePgn(SIMPLE_PGN);
  // 1...e5: Black's best keeps 45 %, the move played drops to 20 %.
  const review = reviewMove(game, 1, otherMove(game, 1, "c7c5", 0.45, 0.2), { useBook: false });
  assert.equal(review.color, "b");
  assert.equal(review.grade, "blunder");
  assert.ok(Math.abs(review.expectedPointsLost - 0.25) < 1e-9);
  assert.ok(Math.abs(review.expectedWhiteBefore - 0.55) < 1e-9);
  assert.ok(Math.abs(review.expectedWhiteAfter - 0.8) < 1e-9);
  assert.ok(review.cpWhiteAfter > 0, "a bad Black move must show a White-favourable eval");
});

test("expected-points bands: best / excellent / good / inaccuracy / mistake / blunder", () => {
  const game = parsePgn(SIMPLE_PGN);
  const grade = (best, played) =>
    reviewMove(game, 10, otherMove(game, 10, "a2a3", best, played), { useBook: false }).grade;
  assert.equal(grade(0.55, 0.548), "best", "a 0.2-point difference is engine noise: co-best");
  assert.equal(grade(0.55, 0.54), "excellent");
  assert.equal(grade(0.55, 0.52), "good");
  assert.equal(grade(0.55, 0.48), "inaccuracy");
  assert.equal(grade(0.55, 0.4), "mistake");
  assert.equal(grade(0.55, 0.3), "blunder");
  const top = reviewMove(game, 10, topMove(game, 10, withE(0.55, [game.moves[10].uci])), { useBook: false });
  assert.equal(top.grade, "best");
  assert.equal(top.accuracy, 100);
});

test("the same centipawn loss matters far more near equality than when already winning", () => {
  const game = parsePgn(SIMPLE_PGN);
  const cp = (value) => makeEvaluation({ cp: value, pv: ["a2a3"] });
  const nearEqual = reviewMove(game, 10, { bestMove: "a2a3", best: cp(20), played: cp(-130), playedRank: null }, { useBook: false });
  const winning = reviewMove(game, 10, { bestMove: "a2a3", best: cp(900), played: cp(750), playedRank: null }, { useBook: false });
  assert.equal(nearEqual.cpLoss, winning.cpLoss);
  assert.ok(["mistake", "blunder"].includes(nearEqual.grade), nearEqual.grade);
  assert.ok(["excellent", "good"].includes(winning.grade), winning.grade);
});

test("opening theory is Book with zero rating weight, but a bad theory-looking move keeps its grade", () => {
  const game = parsePgn(SIMPLE_PGN);
  const book = reviewMove(game, 4, topMove(game, 4, withE(0.55, [game.moves[4].uci])));
  assert.equal(book.grade, "book");
  assert.equal(book.informativeness, 0);
  assert.equal(book.objectiveGrade, "best");
  const bad = reviewMove(game, 4, otherMove(game, 4, "d2d4", 0.55, 0.3));
  assert.equal(bad.grade, "blunder");
  assert.equal(bad.isBook, false);
});

test("only legal move is Best with no weight in the performance model", () => {
  const game = parsePgn(OPERA_PGN);
  const index = game.moves.findIndex((move) => move.san === "Nxb8");
  const review = reviewMove(game, index, otherMove(game, index, "d7b8", 0.0, 0.0));
  assert.equal(review.legalMoveCount, 1);
  assert.equal(review.grade, "best");
  assert.equal(review.informativeness, 0);
});

test("Brilliant: Morphy's queen sacrifice 16.Qb8+ forcing mate", () => {
  const game = parsePgn(OPERA_PGN);
  const index = game.moves.findIndex((move) => move.san === "Qb8+");
  const line = mate(2, ["b3b8", "d7b8", "d1d8"]);
  const review = reviewMove(
    game,
    index,
    topMove(game, index, line, { candidates: [line, withE(0.93, ["g5e7", "f8e7"]), withE(0.9, ["b5d7"])] }),
  );
  assert.equal(review.grade, "brilliant");
  assert.equal(review.sacrifice.kind, "queen");
  assert.equal(review.sacrifice.accepted, true);
  assert.match(review.brilliantReason, /^Best move\. Sacrifices the queen\./);
  assert.match(review.brilliantReason, /forced mate in 2/);
});

test("Brilliant is withheld without candidate verification or when any move wins", () => {
  const game = parsePgn(OPERA_PGN);
  const index = game.moves.findIndex((move) => move.san === "Qb8+");
  const line = mate(2, ["b3b8", "d7b8", "d1d8"]);
  assert.notEqual(reviewMove(game, index, topMove(game, index, line)).grade, "brilliant", "unverified by candidate pass");

  const crushing = withE(0.995, ["b3b8", "d7b8", "d1d8", "e6e7"]);
  const review = reviewMove(
    game,
    index,
    topMove(game, index, crushing, { candidates: [crushing, withE(0.99, ["g5e7"])] }),
  );
  assert.notEqual(review.grade, "brilliant", "a non-mating sac when the alternative also wins is cleanup");
});

test("ordinary trades and losing sacrifices are never Brilliant", () => {
  const trade = parsePgn(TRADE_PGN);
  const line = withE(0.52, ["b5c6", "d7c6", "e1g1"]);
  const exchange = reviewMove(trade, 6, topMove(trade, 6, line, { candidates: [line, withE(0.45, ["b5a4"])] }));
  assert.notEqual(exchange.grade, "brilliant");
  assert.equal(exchange.sacrifice, undefined);

  const hang = parsePgn("1. e4 e5 2. Qh5 Nc6 3. Qxf7+ Kxf7 *");
  const blunder = reviewMove(hang, 4, {
    bestMove: "f1c4",
    best: withE(0.5, ["f1c4"]),
    played: withE(0.02, ["h5f7", "e8f7"]),
    playedRank: null,
    candidates: [withE(0.5, ["f1c4"]), withE(0.48, ["b1c3"])],
  });
  assert.equal(blunder.grade, "blunder");
});

test("Great: only move keeps the position; obvious recaptures are not Great", () => {
  const game = parsePgn(OPERA_PGN);
  const index = game.moves.findIndex((move) => move.san === "Rd1");
  const line = withE(0.94, ["h1d1", "e7e6"]);
  const great = reviewMove(game, index, topMove(game, index, line, { candidates: [line, withE(0.68, ["b5d7"]), withE(0.6, ["b3b8"])] }));
  assert.equal(great.grade, "great");
  assert.match(great.greatReason, /^Only move/);

  const trade = parsePgn(TRADE_PGN);
  const recapture = withE(0.48, ["d7c6", "e1g1"]);
  const review = reviewMove(trade, 7, topMove(trade, 7, recapture, { candidates: [recapture, withE(0.15, ["d8e7"])] }), { useBook: false });
  assert.equal(review.grade, "best", "recapturing a piece is forced, not Great");
  assert.equal(review.forcedReason, "recapture");
  assert.ok(review.informativeness < 0.5);
});

test("Miss vs Blunder: failing to cash in vs also losing ground", () => {
  const game = parsePgn(MISSED_MATE_PGN);
  const previous = reviewMove(game, 5, otherMove(game, 5, "g7g6", 0.53, 0.0), { useBook: false });
  assert.equal(previous.grade, "blunder");

  const facts = (playedE) => ({
    bestMove: "h5f7",
    best: mate(1, ["h5f7"]),
    played: withE(playedE, ["d2d3", "f6h5"]),
    playedRank: null,
  });
  const miss = reviewMove(game, 6, facts(0.6), { previous, useBook: false });
  assert.equal(miss.grade, "miss");
  assert.equal(miss.miss.missedOpportunityType, "mate");
  assert.equal(miss.miss.missedMoveSan, "Qxf7#");
  assert.deepEqual(miss.miss.missedPV, ["h5f7"]);

  const blunder = reviewMove(game, 6, facts(0.03), { previous, useBook: false });
  assert.equal(blunder.grade, "blunder");
  assert.equal(blunder.miss.missedOpportunityType, "mate");
  assert.match(blunder.classificationReason, /also missed a forced mate in 1/);
});

test("Miss of a material win after the opponent's blunder", () => {
  const game = parsePgn(MISSED_MATE_PGN);
  const previous = reviewMove(game, 6, {
    bestMove: "h5f7",
    best: mate(1, ["h5f7"]),
    played: withE(0.03, ["d2d3", "f6h5"]),
    playedRank: null,
  }, { useBook: false });
  const review = reviewMove(game, 7, {
    bestMove: "f6h5",
    best: withE(0.97, ["f6h5", "g1f3", "d7d6", "b1c3"]),
    played: withE(0.53, ["g7g6", "h5f3"]),
    playedRank: null,
  }, { previous, useBook: false });
  assert.equal(review.grade, "miss");
  assert.equal(review.miss.missedOpportunityType, "material");
});

test("Lichess accuracy curve and robust game aggregation", () => {
  assert.equal(moveAccuracy(0), 100);
  assert.ok(Math.abs(moveAccuracy(0.1) - 64.58) < 0.05);
  const game = parsePgn(SIMPLE_PGN);
  const reviews = game.moves.map((move, index) =>
    reviewMove(game, index, topMove(game, index, withE(0.5, [move.uci])), { useBook: false }),
  );
  assert.equal(aggregateAccuracy(reviews, "w"), 100);
  // One catastrophe dominates a short game (volatility weighting, as on Lichess)
  // but the harmonic floor stops it from zeroing the result.
  reviews[10] = reviewMove(game, 10, otherMove(game, 10, "a2a3", 1, 0.0), { useBook: false });
  assert.equal(reviews[10].accuracy, 0);
  const accuracy = aggregateAccuracy(reviews, "w");
  assert.ok(accuracy > 25 && accuracy < 60, `accuracy ${accuracy}`);
  // Forced moves are not part of the precision measure.
  const forced = { ...reviews[10], legalMoveCount: 1 };
  assert.equal(aggregateAccuracy([...reviews.slice(0, 10), forced, ...reviews.slice(11)], "w"), 100);
});

test("tablebase results are labelled explicitly", () => {
  const game = parsePgn(SIMPLE_PGN);
  const line = makeEvaluation({ cp: 19_990, pv: [game.moves[10].uci] });
  const review = reviewMove(game, 10, topMove(game, 10, line), { useBook: false });
  assert.equal(formatReviewEvaluation(review), "TB 1-0");
});

test("summary exposes accuracy, phase accuracy, features and the legacy rating shape", () => {
  const game = parsePgn(SIMPLE_PGN);
  const reviews = game.moves.map((move, index) =>
    reviewMove(game, index, topMove(game, index, withE(0.5, [move.uci])), { useBook: false }),
  );
  const summary = summarizeSide(reviews, "w", { TimeControl: "600+0" });
  assert.equal(summary.moveCount, 7);
  assert.equal(summary.counts.best, 7);
  assert.equal(summary.features.top1Agreement, 1);
  assert.ok(summary.performance);
  assert.equal(summary.performance.timeControl, "rapid");
  assert.equal(summary.performance.calibrated, false);
  assert.equal(summary.estimatedRating.center, summary.performance.estimatedPerformanceRating);
});
