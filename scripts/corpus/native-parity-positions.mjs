// Expanded native/WASM equivalence check at the position level.
//
//   KS_NATIVE_ENGINE=.cache/native/stockfish node scripts/corpus/native-parity-positions.mjs \
//     --games data/rating-corpus/games.jsonl --count 300 --nodes 60000 --multipv 3 \
//     --json data/golden/native-parity-positions.json
//
// Samples representative positions (opening / middlegame / endgame, spread
// across many games) and searches each with both transports at IDENTICAL
// options: same node budget, MultiPV, Hash, Threads=1, UCI_ShowWDL. Compares
// what the models actually consume:
//   - root best move
//   - root evaluation (cp or mate)
//   - candidate ORDER by rank (not exact cp of every line)
//   - baselineExpectedScore derived from the root cp
// Does not require PV strings to match beyond the first move; deeper search
// order can differ without affecting anything the pipeline reads.
import { readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { baselineCurveExpectedScore } from "../../lib/evaluation.ts";
import { createNativeEngine, createNodeEngine } from "../node-engine.mjs";
import { priority } from "./sample-lichess-db.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const count = Number(argument("count", "300"));
const nodes = Number(argument("nodes", "60000"));
const multiPv = Number(argument("multipv", "3"));
const games = readFileSync(argument("games", "data/rating-corpus/games.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
games.sort((a, b) => priority(23, a.id) - priority(23, b.id));

// Spread positions across opening/middlegame/endgame phases and many distinct games.
const PHASE_PLY = [0.15, 0.4, 0.65, 0.85]; // fraction of game length
const positions = [];
outer: for (const game of games) {
  const sans = game.san.split(" ");
  if (sans.length < 16) continue;
  for (const frac of PHASE_PLY) {
    if (positions.length >= count) break outer;
    const ply = Math.max(6, Math.min(sans.length - 2, Math.round(frac * sans.length)));
    const chess = new Chess();
    const moves = [];
    try {
      for (const san of sans.slice(0, ply)) moves.push(chess.move(san));
    } catch {
      continue;
    }
    if (chess.isGameOver()) continue;
    positions.push({
      id: `${game.id}#${ply}`,
      phase: frac < 0.3 ? "opening" : frac < 0.7 ? "middlegame" : "endgame",
      rootFen: new Chess().fen(),
      moves: moves.map((m) => `${m.from}${m.to}${m.promotion ?? ""}`),
    });
  }
}

console.log(`comparing ${positions.length} positions, nodes=${nodes}, multiPv=${multiPv}`);
const wasm = createNodeEngine();
const native = createNativeEngine();
const rows = [];
let started = Date.now();
for (const [index, position] of positions.entries()) {
  const request = { rootFen: position.rootFen, moves: position.moves, nodes, multiPv, searchMoves: undefined };
  await wasm.newGame();
  await native.newGame();
  const a = await wasm.search(request);
  const b = await native.search(request);
  const cpA = a.lines[0]?.cp;
  const cpB = b.lines[0]?.cp;
  const mateA = a.lines[0]?.mate;
  const mateB = b.lines[0]?.mate;
  const orderA = a.lines.map((line) => line.pv[0]);
  const orderB = b.lines.map((line) => line.pv[0]);
  const besA = baselineCurveExpectedScore(cpA ?? (mateA !== undefined ? (mateA > 0 ? 10_000 : -10_000) : 0));
  const besB = baselineCurveExpectedScore(cpB ?? (mateB !== undefined ? (mateB > 0 ? 10_000 : -10_000) : 0));
  rows.push({
    id: position.id,
    phase: position.phase,
    bestMoveA: a.bestMove,
    bestMoveB: b.bestMove,
    bestMoveMatch: a.bestMove === b.bestMove,
    cpA: cpA ?? null,
    cpB: cpB ?? null,
    mateA: mateA ?? null,
    mateB: mateB ?? null,
    cpDiff: cpA !== undefined && cpB !== undefined ? Math.abs(cpA - cpB) : null,
    orderMatch: JSON.stringify(orderA) === JSON.stringify(orderB),
    orderA,
    orderB,
    baselineExpectedScoreA: Math.round(besA * 1e6) / 1e6,
    baselineExpectedScoreB: Math.round(besB * 1e6) / 1e6,
    baselineDiff: Math.round(Math.abs(besA - besB) * 1e6) / 1e6,
  });
  if ((index + 1) % 25 === 0) {
    const rate = (Date.now() - started) / (index + 1) / 1000;
    console.log(`${index + 1}/${positions.length} (${rate.toFixed(2)} s/position)`);
  }
}
wasm.dispose();
native.dispose();

const bestMoveMismatches = rows.filter((row) => !row.bestMoveMatch);
const orderMismatches = rows.filter((row) => !row.orderMatch);
const cpDiffs = rows.filter((row) => row.cpDiff !== null).map((row) => row.cpDiff);
const besDiffs = rows.map((row) => row.baselineDiff);
const summary = {
  positions: rows.length,
  nodes,
  multiPv,
  engineVersionWasm: wasm.engineVersion,
  engineVersionNative: native.engineVersion,
  byPhase: Object.fromEntries(["opening", "middlegame", "endgame"].map((phase) => [phase, rows.filter((row) => row.phase === phase).length])),
  bestMoveMismatchCount: bestMoveMismatches.length,
  bestMoveMismatchRate: Math.round((bestMoveMismatches.length / rows.length) * 10000) / 10000,
  candidateOrderMismatchCount: orderMismatches.length,
  candidateOrderMismatchRate: Math.round((orderMismatches.length / rows.length) * 10000) / 10000,
  cpDiff: {
    max: cpDiffs.length ? Math.max(...cpDiffs) : null,
    mean: cpDiffs.length ? Math.round((cpDiffs.reduce((a, b) => a + b, 0) / cpDiffs.length) * 100) / 100 : null,
    nonZeroCount: cpDiffs.filter((d) => d !== 0).length,
  },
  baselineExpectedScoreDiff: {
    max: Math.max(...besDiffs),
    mean: Math.round((besDiffs.reduce((a, b) => a + b, 0) / besDiffs.length) * 1e6) / 1e6,
    nonZeroCount: besDiffs.filter((d) => d !== 0).length,
  },
  mateFieldMismatches: rows.filter((row) => row.mateA !== row.mateB).length,
};
console.log(JSON.stringify(summary, null, 1));
const json = argument("json");
if (json) writeFileSync(json, `${JSON.stringify({ summary, mismatches: [...bestMoveMismatches, ...orderMismatches].slice(0, 50), rows }, null, 1)}\n`);
process.exit(bestMoveMismatches.length > 0 || summary.cpDiff.max > 5 ? 1 : 0);
