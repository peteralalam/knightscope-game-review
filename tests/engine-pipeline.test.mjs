import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { analyzeGame } from "../lib/analysis-pipeline.ts";
import { parsePgn } from "../lib/chess-review.ts";
import { EngineCrashedError, InvalidPositionError, UciEngine, validateSearchRequest } from "../lib/uci-engine.ts";
import { createNodeEnginePool } from "../scripts/node-engine.mjs";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const OPERA_PGN = `[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5
6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5
11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6
15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;
const SHORT_PGN = `[TimeControl "600+0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Nxf7 Qxg2 6. Rf1 Qxe4+ 7. Be2 Nf3# 0-1`;

/**
 * A scripted UCI engine: deterministic scores from the position, an aspiration
 * bound line that must be ignored, and optional crashes / critical errors.
 */
function fakeEngine({ crashOnGo = new Set(), critical = false, failHigh = false } = {}) {
  const commands = [];
  let goCount = 0;
  let starts = 0;
  const engine = new UciEngine(
    ({ onLine, onFailure }) => {
      starts += 1;
      let position = new Chess();
      let multiPv = 1;
      return {
        send(command) {
          commands.push(command);
          const reply = (line) => queueMicrotask(() => onLine(line));
          if (command === "uci") {
            reply("id name Stockfish 19 Fake");
            reply("uciok");
          } else if (command === "isready") {
            reply("readyok");
          } else if (command.startsWith("setoption name MultiPV value ")) {
            multiPv = Number(command.split(" ").at(-1));
          } else if (command.startsWith("position fen ")) {
            const [, fen, moves] = command.match(/^position fen (.+?)(?: moves (.+))?$/);
            position = new Chess(fen);
            for (const move of moves?.split(" ") ?? []) position.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
          } else if (command.startsWith("go ")) {
            goCount += 1;
            if (crashOnGo.has(goCount)) {
              queueMicrotask(() => onFailure(new Error("worker died")));
              return;
            }
            if (critical) {
              reply("info string CRITICAL ERROR: Command `position` failed: invalid FEN");
              return;
            }
            const restricted = command.match(/searchmoves (.+)$/)?.[1].split(" ");
            const legal = position.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ""}`).sort();
            const candidates = restricted ?? legal;
            let hash = 0;
            for (const char of position.fen()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
            if (failHigh) {
              reply(`info depth 12 multipv 1 score cp 10 wdl 50 900 50 nodes 900 pv ${candidates[0]}`);
              reply(`info depth 13 multipv 1 score cp 80 lowerbound nodes 1000 pv ${candidates[1]}`);
              reply(`bestmove ${candidates[1]}`);
              return;
            }
            reply("info depth 5 score cp 5000 lowerbound nodes 1 pv " + candidates[0]);
            for (let rank = 1; rank <= Math.min(multiPv, candidates.length); rank += 1) {
              const cp = (hash % 120) - 60 - rank * 15;
              reply(`info depth 12 multipv ${rank} score cp ${cp} wdl 100 800 100 nodes 1000 pv ${candidates[rank - 1]}`);
            }
            reply(`bestmove ${candidates[0]}`);
          }
        },
        terminate() {},
      };
    },
    { hashMb: 16, searchTimeoutMs: 5_000, buildLabel: "fake" },
  );
  return { engine, commands, starts: () => starts };
}

test("positions are validated before anything reaches the engine", async () => {
  assert.throws(() => validateSearchRequest({ rootFen: "not a fen", moves: [], nodes: 1, multiPv: 1 }), InvalidPositionError);
  assert.throws(() => validateSearchRequest({ rootFen: START, moves: ["e2e5"], nodes: 1, multiPv: 1 }), /Illegal move/);
  assert.throws(() => validateSearchRequest({ rootFen: START, moves: ["e2e4"], nodes: 1, multiPv: 1, searchMoves: ["e2e4"] }), /searchmoves/);
  assert.throws(
    () => validateSearchRequest({ rootFen: START, moves: ["f2f3", "e7e5", "g2g4", "d8h4"], nodes: 1, multiPv: 1 }),
    /No legal moves/,
  );
  const { engine, commands } = fakeEngine();
  await assert.rejects(engine.search({ rootFen: START, moves: ["e2e5"], nodes: 1000, multiPv: 1 }), InvalidPositionError);
  assert.equal(commands.length, 0, "an invalid request must not even start the engine");
});

test("the engine records its version, ignores bound lines and only resends MultiPV when it changes", async () => {
  const { engine, commands } = fakeEngine();
  const result = await engine.search({ rootFen: START, moves: ["e2e4"], nodes: 1000, multiPv: 1 });
  assert.equal(engine.engineVersion, "Stockfish 19 Fake [fake]");
  assert.equal(result.lines.length, 1);
  assert.notEqual(result.lines[0].cp, 5000, "lowerbound line must be ignored");
  assert.ok(commands.includes("setoption name UCI_ShowWDL value true"));
  assert.ok(commands.includes("setoption name Threads value 1"));
  await engine.search({ rootFen: START, moves: [], nodes: 1000, multiPv: 1 });
  await engine.search({ rootFen: START, moves: [], nodes: 1000, multiPv: 3 });
  assert.equal(commands.filter((command) => command.startsWith("setoption name MultiPV")).length, 2);
  assert.ok(commands.includes(`position fen ${START} moves e2e4`), "history is sent so repetitions are visible");
});

test("a move that fails high before the node limit keeps its own (bound) score and PV", async () => {
  const { engine } = fakeEngine({ failHigh: true });
  const result = await engine.search({ rootFen: START, moves: [], nodes: 1000, multiPv: 1 });
  assert.equal(result.lines[0].pv[0], result.bestMove);
  assert.equal(result.lines[0].bound, "lower");
  assert.equal(result.lines[0].cp, 80);
});

test("a Stockfish CRITICAL ERROR is surfaced as an engine crash", async () => {
  const { engine } = fakeEngine({ critical: true });
  await assert.rejects(engine.search({ rootFen: START, moves: [], nodes: 1000, multiPv: 1 }), EngineCrashedError);
});

test("a crashed engine is restarted and its chunk replayed with identical results", async () => {
  const game = parsePgn(SHORT_PGN);
  const options = { primaryNodes: 1000, candidateNodes: 1000, chunkPlies: 5 };
  const clean = await analyzeGame(game, [fakeEngine().engine], options);
  const flaky = fakeEngine({ crashOnGo: new Set([7]) });
  const recovered = await analyzeGame(game, [flaky.engine], options);
  assert.equal(flaky.starts(), 2, "the engine restarted once");
  assert.deepEqual(
    recovered.reviews.map((move) => [move.grade, move.expectedAfter]),
    clean.reviews.map((move) => [move.grade, move.expectedAfter]),
  );
});

test("results do not depend on how many engines run in parallel", async () => {
  const game = parsePgn(SHORT_PGN);
  const options = { primaryNodes: 1000, candidateNodes: 1000, chunkPlies: 4 };
  const one = await analyzeGame(game, [fakeEngine().engine], options);
  const three = await analyzeGame(game, [fakeEngine().engine, fakeEngine().engine, fakeEngine().engine], options);
  assert.deepEqual(
    three.reviews.map((move) => [move.grade, move.expectedBefore, move.expectedAfter]),
    one.reviews.map((move) => [move.grade, move.expectedBefore, move.expectedAfter]),
  );
});

test("real Stockfish 19: deterministic node-limited analysis across engine counts", { timeout: 240_000 }, async () => {
  const game = parsePgn(SHORT_PGN);
  const options = { primaryNodes: 30_000, candidateNodes: 30_000 };
  const single = createNodeEnginePool(1);
  const pair = createNodeEnginePool(2);
  try {
    const a = await analyzeGame(game, single, options);
    const b = await analyzeGame(game, pair, options);
    assert.match(a.meta.engineVersion, /^Stockfish 19/);
    assert.deepEqual(
      b.reviews.map((move) => [move.grade, move.expectedBefore, move.expectedAfter]),
      a.reviews.map((move) => [move.grade, move.expectedBefore, move.expectedAfter]),
    );
    // Black's final move delivers mate; White's 7.Be2 walked into it.
    assert.equal(a.reviews.at(-1).grade, "best");
    assert.equal(a.reviews.at(-2).grade, "blunder");
  } finally {
    [...single, ...pair].forEach((engine) => engine.dispose());
  }
});

test("real Stockfish 19: Morphy's Opera Game", { timeout: 240_000 }, async () => {
  const game = parsePgn(OPERA_PGN);
  const engines = createNodeEnginePool(1);
  try {
    const { reviews, meta } = await analyzeGame(game, engines, { primaryNodes: 150_000, candidateNodes: 150_000 });
    const bySan = (san) => reviews.find((move) => move.san === san);
    assert.equal(bySan("Qb8+").grade, "brilliant");
    assert.match(bySan("Qb8+").brilliantReason, /Sacrifices the queen/);
    assert.equal(bySan("Rd8#").grade, "best");
    assert.equal(bySan("e4").grade, "book");
    assert.ok(reviews.filter((move) => move.color === "w").every((move) => !["mistake", "blunder", "miss"].includes(move.grade)));
    assert.ok(meta.candidateSearches > 0 && meta.candidateSearches < reviews.length, "candidate pass is targeted");
  } finally {
    engines.forEach((engine) => engine.dispose());
  }
});
