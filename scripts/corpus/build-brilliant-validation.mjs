// Build the expanded Brilliant validation set (precision / recall / FPR).
//
//   node scripts/corpus/build-brilliant-validation.mjs .cache/sources/combined_puzzle_db_first_50k.ndjson \
//     --out data/brilliant-suite/validation.json
//
// Sharded (parallel across cores; scans, then merges with the SAME seeded
// pick() so the result is identical to the single-process run, just faster):
//   for i in 0 1 2 3; do node scripts/corpus/build-brilliant-validation.mjs \
//     .cache/sources/combined_puzzle_db_first_50k.ndjson --shard $i --shards 4 & done; wait
//   node scripts/corpus/build-brilliant-validation.mjs --merge --out data/brilliant-suite/validation.json
//
// Source: mcognetta/lichess-combined-puzzle-game-db, 50k sample (CC0): Lichess
// puzzles joined with their full games, INCLUDING Lichess's own server analysis
// (per-ply eval and Inaccuracy / Mistake / Blunder judgments from fishnet).
// Every label is decided by the rules below – by Lichess's puzzle generator or
// Lichess's engine and the actual game – never by KnightScope's Brilliant
// algorithm, so the measured precision / recall are not circular.
//
// POSITIVE ("legitimate sacrifice candidate"):
//   the first solution move of a puzzle tagged `sacrifice` that statically gives
//   up ≥ 1 point of material with a non-pawn piece. lichess-puzzler only emits a
//   puzzle when that move is the unique winning move, so it is sound and needed.
//
// NEGATIVE (must never be Brilliant), from real games unless noted:
//   unsound-sacrifice-real   a static sacrifice Lichess judged Mistake / Blunder
//   desperation-sacrifice    a static sacrifice by a side that stays lost
//                            (Lichess eval ≤ −4 before and ≤ −3 after)
//   sac-while-crushing       a static sacrifice with Lichess eval ≥ +10 before and
//                            after (the game was already decided; nothing needed)
//   temporary-sacrifice-real a static sacrifice whose material the mover had
//                            back within the next four plies of the game
//   routine-recapture-real   recapturing on the square the opponent just captured on
//   hanging-piece-capture    puzzle tagged hangingPiece + oneMove: taking free material
// Selection inside each category is by a seeded hash of the id (reproducible).
import { readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { staticSacrifices } from "../../lib/chess-analysis.ts";
import { priority } from "./sample-lichess-db.mjs";

const SEED = 20260925;
const TARGETS = {
  positive: 130,
  "unsound-sacrifice-real": 40,
  "desperation-sacrifice": 20,
  "sac-while-crushing": 20,
  "temporary-sacrifice-real": 25,
  "routine-recapture-real": 20,
  "hanging-piece-capture": 20,
};
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const uciOf = (move) => `${move.from}${move.to}${move.promotion ?? ""}`;

function material(chess, color) {
  let total = 0;
  for (const row of chess.board()) for (const square of row) if (square && square.color === color) total += VALUES[square.type];
  return total;
}

/** Lichess eval after ply i from the side that played ply i, in cp (mate = ±10000). */
function moverEval(analysis, i, moverIsWhite) {
  const entry = analysis?.[i];
  if (!entry) return null;
  const white = entry.mate !== undefined ? Math.sign(entry.mate) * 10_000 : entry.eval;
  if (white === undefined) return null;
  return moverIsWhite ? white : -white;
}

function positives(puzzles) {
  const out = [];
  for (const { puzzle, game } of puzzles) {
    const themes = new Set(puzzle.Themes.split(" "));
    if (!themes.has("sacrifice")) continue;
    const chess = new Chess(puzzle.FEN);
    const moves = puzzle.Moves.split(" ");
    try {
      chess.move({ from: moves[0].slice(0, 2), to: moves[0].slice(2, 4), promotion: moves[0][4] });
    } catch {
      continue;
    }
    const before = chess.fen();
    const sacs = staticSacrifices(before, moves[1], 1);
    if (!sacs.length) continue;
    const piece = chess.get(moves[1].slice(0, 2))?.type;
    if (!piece || piece === "p") continue;
    out.push({
      id: `positive/${puzzle.PuzzleId}`,
      category: "positive",
      label: "positive",
      source: `https://lichess.org/training/${puzzle.PuzzleId}`,
      game: puzzle.GameUrl,
      themes: puzzle.Themes,
      puzzleRating: Number(puzzle.Rating),
      playerRating: game?.players?.white?.rating && game?.players?.black?.rating
        ? Math.round((game.players.white.rating + game.players.black.rating) / 2) : null,
      fen: puzzle.FEN,
      moves: moves.slice(0, 4),
      testedPly: 1,
    });
  }
  return out;
}

function hangingCaptures(puzzles) {
  const out = [];
  for (const { puzzle } of puzzles) {
    const themes = new Set(puzzle.Themes.split(" "));
    if (!themes.has("hangingPiece") || !themes.has("oneMove") || themes.has("mate")) continue;
    const moves = puzzle.Moves.split(" ");
    out.push({
      id: `hanging-piece-capture/${puzzle.PuzzleId}`,
      category: "hanging-piece-capture",
      label: "negative",
      source: `https://lichess.org/training/${puzzle.PuzzleId}`,
      fen: puzzle.FEN,
      moves: moves.slice(0, 2),
      testedPly: 1,
    });
  }
  return out;
}

/** Walk the given games once and collect real-game negatives. Logs progress. */
function realGameNegatives(puzzles, label = "") {
  const out = Object.fromEntries(Object.keys(TARGETS).filter((key) => key.endsWith("-real") || key.startsWith("desperation") || key.startsWith("sac-while")).map((key) => [key, []]));
  const started = Date.now();
  let done = 0;
  for (const { game } of puzzles) {
    done += 1;
    if (done % 2000 === 0) {
      const rate = (Date.now() - started) / done / 1000;
      console.error(`[${label}] ${done}/${puzzles.length} games scanned, ${rate.toFixed(3)} s/game, found so far: ${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])))}`);
    }
    if (!game?.analysis?.length || game.variant !== "standard" || !game.moves) continue;
    const sans = game.moves.split(" ");
    const chess = new Chess();
    const history = [];
    for (let i = 0; i < sans.length && i < game.analysis.length; i += 1) {
      const before = chess.fen();
      let move;
      try {
        move = chess.move(sans[i]);
      } catch {
        break;
      }
      history.push({ before, move });
    }
    // Replay once more to measure material a few plies later.
    const materialAt = [];
    const replay = new Chess();
    for (const { move } of history) {
      materialAt.push({ w: material(replay, "w"), b: material(replay, "b") });
      replay.move(move.san);
    }
    materialAt.push({ w: material(replay, "w"), b: material(replay, "b") });
    for (let i = 1; i < history.length - 1; i += 1) {
      const { before, move } = history[i];
      const white = move.color === "w";
      const base = { gameUrl: `https://lichess.org/${game.id}#${i + 1}`, fen: before, moves: history.slice(i, i + 3).map((h) => uciOf(h.move)), testedPly: 0, label: "negative" };
      const previous = history[i - 1].move;
      if (move.captured && previous.captured && previous.to === move.to && !move.san.includes("#")) {
        out["routine-recapture-real"].push({ ...base, id: `routine-recapture-real/${game.id}-${i}`, category: "routine-recapture-real" });
        continue;
      }
      if (move.piece === "p" || move.san.includes("#")) continue;
      const sacs = staticSacrifices(before, uciOf(move), 1);
      if (!sacs.length) continue;
      const judgment = game.analysis[i]?.judgment?.name;
      const evalBefore = moverEval(game.analysis, i - 1, white);
      const evalAfter = moverEval(game.analysis, i, white);
      const diff = (m) => (white ? m.w - m.b : m.b - m.w);
      const regained = i + 5 <= materialAt.length - 1 && diff(materialAt[i + 5]) >= diff(materialAt[i]);
      if (judgment === "Mistake" || judgment === "Blunder") {
        out["unsound-sacrifice-real"].push({ ...base, id: `unsound-sacrifice-real/${game.id}-${i}`, category: "unsound-sacrifice-real", lichessJudgment: judgment });
      } else if (evalBefore !== null && evalAfter !== null && evalBefore <= -400 && evalAfter <= -300) {
        out["desperation-sacrifice"].push({ ...base, id: `desperation-sacrifice/${game.id}-${i}`, category: "desperation-sacrifice", lichessEval: [evalBefore, evalAfter] });
      } else if (evalBefore !== null && evalAfter !== null && evalBefore >= 1000 && evalAfter >= 1000 && Math.abs(evalAfter) < 10_000) {
        out["sac-while-crushing"].push({ ...base, id: `sac-while-crushing/${game.id}-${i}`, category: "sac-while-crushing", lichessEval: [evalBefore, evalAfter] });
      } else if (regained && !judgment) {
        out["temporary-sacrifice-real"].push({ ...base, id: `temporary-sacrifice-real/${game.id}-${i}`, category: "temporary-sacrifice-real" });
      }
    }
  }
  return out;
}

function pick(items, count, stratify) {
  const ranked = [...items].sort((a, b) => priority(SEED, a.id) - priority(SEED, b.id));
  if (!stratify) return ranked.slice(0, count);
  // Round-robin over strata so no one kind of puzzle dominates.
  const strata = new Map();
  for (const item of ranked) {
    const key = stratify(item);
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(item);
  }
  const out = [];
  const queues = [...strata.values()];
  while (out.length < count && queues.some((queue) => queue.length)) {
    for (const queue of queues) if (queue.length && out.length < count) out.push(queue.shift());
  }
  return out;
}

const file = process.argv[2];
const shard = argument("shard") !== undefined ? Number(argument("shard")) : null;
const shards = Number(argument("shards", "1"));
const merge = process.argv.includes("--merge");

function positiveStratum(item) {
  const themes = new Set(item.themes.split(" "));
  const kind = themes.has("mate") ? "mate" : themes.has("crushing") ? "crushing" : "advantage";
  const rating = item.puzzleRating < 1400 ? "low" : item.puzzleRating < 2000 ? "mid" : "high";
  return `${kind}|${rating}`;
}

if (shard !== null) {
  // Shard mode: scan this shard's slice of games, write RAW (unpicked) candidates.
  const puzzles = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const mine = puzzles.filter((_, index) => index % shards === shard);
  const shardOut = {
    positive: positives(mine),
    "hanging-piece-capture": hangingCaptures(mine),
    ...realGameNegatives(mine, `shard ${shard}`),
  };
  const path = argument("shard-out", `.cache/corpus/brilliant-val-scan.${shard}.json`);
  writeFileSync(path, JSON.stringify(shardOut));
  console.log(`[shard ${shard}] wrote ${path}: ${Object.fromEntries(Object.entries(shardOut).map(([k, v]) => [k, v.length]))}`);
  process.exit(0);
}

if (merge) {
  // Merge mode: combine every shard's raw candidates, then apply the same
  // seeded pick() as the single-process path (identical result, just parallel).
  const pattern = argument("shard-glob", ".cache/corpus/brilliant-val-scan.*.json");
  const { readdirSync } = await import("node:fs");
  const { dirname, basename, join } = await import("node:path");
  const directory = dirname(pattern);
  const regex = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const files = readdirSync(directory).filter((name) => regex.test(name)).sort().map((name) => join(directory, name));
  if (!files.length) throw new Error(`no shard files matched ${pattern}`);
  const merged = {};
  for (const path of files) {
    const shardOut = JSON.parse(readFileSync(path, "utf8"));
    for (const [key, items] of Object.entries(shardOut)) (merged[key] ??= []).push(...items);
  }
  const cases = [
    ...pick(merged.positive, TARGETS.positive, positiveStratum),
    ...pick(merged["hanging-piece-capture"], TARGETS["hanging-piece-capture"]),
  ];
  for (const category of Object.keys(TARGETS)) {
    if (category === "positive" || category === "hanging-piece-capture") continue;
    cases.push(...pick(merged[category] ?? [], TARGETS[category]));
  }
  const counts = {};
  for (const item of cases) counts[item.category] = (counts[item.category] ?? 0) + 1;
  writeFileSync(argument("out", "data/brilliant-suite/validation.json"), `${JSON.stringify({ seed: SEED, source: "mcognetta/lichess-combined-puzzle-game-db first-50k sample (CC0)", counts, cases }, null, 1)}\n`);
  console.log(counts);
  process.exit(0);
}

// Single-process fallback (small inputs, or explicit non-sharded run).
const puzzles = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const cases = [
  ...pick(positives(puzzles), TARGETS.positive, positiveStratum),
  ...pick(hangingCaptures(puzzles), TARGETS["hanging-piece-capture"]),
];
for (const [category, items] of Object.entries(realGameNegatives(puzzles, "single"))) cases.push(...pick(items, TARGETS[category]));
const counts = {};
for (const item of cases) counts[item.category] = (counts[item.category] ?? 0) + 1;
writeFileSync(argument("out", "data/brilliant-suite/validation.json"), `${JSON.stringify({ seed: SEED, source: "mcognetta/lichess-combined-puzzle-game-db first-50k sample (CC0)", counts, cases }, null, 1)}\n`);
console.log(counts);
