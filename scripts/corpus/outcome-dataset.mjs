// One row per analyzed position for the outcome model
// E[result | cp, rating, time control] (scripts/corpus/outcome_model.py).
//
//   node scripts/corpus/outcome-dataset.mjs --analyses ".cache/corpus/rating-v2.*.jsonl" \
//     --games data/rating-corpus-v2/games.jsonl --samples data/rating-corpus-v2/samples.jsonl \
//     --out .cache/corpus/outcome-positions.csv
//
// Each position is the one BEFORE a move, seen from the side to move, with that
// side's final game score (1 / ½ / 0). The engine score is our own Stockfish 19
// Lite search of that position (the same number the reviewer grades with), so the
// fitted model is applied to exactly the scale it was fitted on. Mate scores and
// tablebase results are excluded (they are decisive by definition).
//
// Splits come from samples.jsonl (player-graph components), so a player's
// positions are in exactly one of train / validation / test – the same split as
// the rating model.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BASELINE_CURVE } from "../../lib/review-config.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function expand(pattern) {
  const directory = dirname(pattern);
  const regex = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return readdirSync(directory).filter((name) => regex.test(name)).sort().map((name) => join(directory, name));
}

/** Mover's-view centipawns of the position before the move, or null when decisive. */
export function moverCp(move) {
  if (move.mb !== undefined && move.mb !== null) return null;
  if (typeof move.cpb === "number") return Math.abs(move.cpb) >= 19_000 ? null : move.cpb;
  // Older analyses stored only the baseline expected score; invert the curve.
  const e = move.eb;
  if (!(e > 0 && e < 1)) return null;
  return Math.log(e / (1 - e)) / BASELINE_CURVE.slopePerCp;
}

function main() {
  const games = new Map(
    readFileSync(argument("games"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((game) => [game.id, game]),
  );
  const splitByGame = new Map();
  const groupByGame = new Map();
  for (const line of readFileSync(argument("samples"), "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    splitByGame.set(row.gameId, row.split);
    groupByGame.set(row.gameId, row.group);
  }
  const out = ["game,group,split,tc,ply,phase,mover_rating,opponent_rating,cp,score"];
  const seen = new Set();
  let skipped = 0;
  for (const file of expand(argument("analyses"))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const analysis = JSON.parse(line);
      const game = games.get(analysis.id);
      if (analysis.error || !game || seen.has(analysis.id) || !splitByGame.has(analysis.id)) continue;
      seen.add(analysis.id);
      const whiteScore = game.result === "1-0" ? 1 : game.result === "0-1" ? 0 : 0.5;
      for (const move of analysis.moves) {
        const cp = moverCp(move);
        if (cp === null) {
          skipped += 1;
          continue;
        }
        const white = move.c === "w";
        out.push([
          game.id,
          groupByGame.get(game.id),
          splitByGame.get(game.id),
          game.tc,
          move.i,
          move.ph,
          white ? game.white.rating : game.black.rating,
          white ? game.black.rating : game.white.rating,
          Math.round(cp),
          white ? whiteScore : 1 - whiteScore,
        ].join(","));
      }
    }
  }
  writeFileSync(argument("out", ".cache/corpus/outcome-positions.csv"), `${out.join("\n")}\n`);
  console.log(`${out.length - 1} positions from ${seen.size} games (${skipped} decisive positions skipped)`);
}

main();
