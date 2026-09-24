// Turn analyzed rated games into one row per (game, player) with the rating
// model's features, and assign player-disjoint train / validation / test splits.
//
//   node scripts/corpus/rating-dataset.mjs --analyses ".cache/corpus/rating-quick.*.jsonl" \
//     --games data/rating-corpus/games.jsonl --out data/rating-corpus/samples.jsonl
//
// Leakage control: players are linked when they appear in the same game, and
// each connected component of that player graph goes to exactly one split. No
// player – and no game – is shared between train, validation and test.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { errorCategory, ratingFeatureVector } from "../../lib/rating-model.ts";
import { bandLabel } from "./prepare-rating-corpus.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function expand(pattern) {
  const directory = dirname(pattern);
  const regex = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return readdirSync(directory).filter((name) => regex.test(name)).sort().map((name) => join(directory, name));
}

export const SPLIT_FRACTIONS = { train: 0.6, validation: 0.2, test: 0.2 };

function unionFind() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  return { find, union: (a, b) => parent.set(find(a), find(b)) };
}

function splitOf(component) {
  const value = parseInt(createHash("sha256").update(`ks-rating-split:${component}`).digest("hex").slice(0, 8), 16) / 2 ** 32;
  if (value < SPLIT_FRACTIONS.train) return "train";
  if (value < SPLIT_FRACTIONS.train + SPLIT_FRACTIONS.validation) return "validation";
  return "test";
}

function main() {
  const games = new Map(
    readFileSync(argument("games", "data/rating-corpus/games.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line)).map((game) => [game.id, game]),
  );
  const byId = new Map();
  for (const file of expand(argument("analyses", ".cache/corpus/rating-quick.*.jsonl"))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const analysis = JSON.parse(line);
      if (!analysis.error && games.has(analysis.id)) byId.set(analysis.id, analysis);
    }
  }
  const analyses = [...byId.values()];
  const players = unionFind();
  for (const analysis of analyses) {
    const game = games.get(analysis.id);
    players.union(`${game.source}:${game.white.id}`, `${game.source}:${game.black.id}`);
  }
  // Players from the two sources are different people only if the ids differ;
  // Lichess ids are global, so link them across sources as well.
  for (const analysis of analyses) {
    const game = games.get(analysis.id);
    for (const side of [game.white, game.black]) players.union(`${game.source}:${side.id}`, `lichess:${side.id}`);
  }

  const rows = [];
  for (const analysis of analyses) {
    const game = games.get(analysis.id);
    for (const color of ["w", "b"]) {
      const side = analysis.sides[color];
      const player = color === "w" ? game.white : game.black;
      if (!side.features || !side.performance) continue; // too few decisions for any estimate
      const decisions = analysis.moves.filter((move) => move.c === color && move.inf > 0);
      const phaseShare = (phase) => decisions.filter((move) => move.ph === phase).length / Math.max(1, decisions.length);
      const score = game.result === "1/2-1/2" ? 0.5 : (game.result === "1-0") === (color === "w") ? 1 : 0;
      rows.push({
        gameId: game.id,
        color,
        player: player.id,
        component: players.find(`lichess:${player.id}`),
        rating: player.rating,
        band: bandLabel(player.rating),
        tc: game.tc,
        source: game.source,
        date: game.date,
        result: score === 1 ? "win" : score === 0 ? "loss" : "draw",
        ply: analysis.ply,
        endgameShare: phaseShare("endgame"),
        openingShare: phaseShare("opening"),
        preset: analysis.meta.preset,
        engine: analysis.meta.engineVersion,
        model: analysis.meta.modelVersion,
        meaningfulMoves: side.features.meaningfulMoves,
        x: ratingFeatureVector(side.features).map((value) => (value === null ? null : Math.round(value * 1e6) / 1e6)),
        // Per-decision inputs of the engine-error (ordered-logit) model.
        decisions: decisions.map((move) => ({
          category: errorCategory({ isTopMove: move.top, expectedPointsLost: move.loss }),
          weight: move.inf,
          expectedBefore: move.eb,
          legalMoves: move.lm,
        })),
        heuristic: (() => {
          const prior = side.priorPerformance ?? side.performance;
          return prior ? { estimate: prior.estimatedPerformanceRating, low: prior.confidenceLow, high: prior.confidenceHigh, id: prior.model } : null;
        })(),
      });
    }
  }
  for (const row of rows) {
    row.split = splitOf(row.component);
    // Anonymous group id for player-grouped cross-validation inside train + validation.
    row.group = createHash("sha256").update(row.component).digest("hex").slice(0, 12);
  }
  // The opponent's features, for the (not shipped) "opponent-aware" experiment.
  const bySide = new Map(rows.map((row) => [`${row.gameId}:${row.color}`, row]));
  for (const row of rows) row.opponentX = bySide.get(`${row.gameId}:${row.color === "w" ? "b" : "w"}`)?.x ?? null;
  // Per-decision inputs are large; they only feed the error-model baseline.
  const publicRow = (row) => {
    const copy = { ...row };
    delete copy.component;
    delete copy.decisions;
    return copy;
  };
  writeFileSync(argument("out", "data/rating-corpus/samples.jsonl"), rows.map((row) => JSON.stringify(publicRow(row))).join("\n") + "\n");
  writeFileSync(
    argument("decisions-out", ".cache/corpus/decisions.jsonl"),
    rows.map((row) => JSON.stringify({ key: `${row.gameId}:${row.color}`, decisions: row.decisions })).join("\n") + "\n",
  );

  // Verify the split really is player-disjoint.
  const splitsByPlayer = new Map();
  for (const row of rows) {
    splitsByPlayer.set(row.player, (splitsByPlayer.get(row.player) ?? new Set()).add(row.split));
  }
  const leaking = [...splitsByPlayer.values()].filter((splits) => splits.size > 1).length;
  const count = (predicate) => rows.filter(predicate).length;
  const bandOrder = ["800–1000", "1000–1200", "1200–1400", "1400–1600", "1600–1800", "1800–2000", "2000–2200", "2200–2400", "2400+"];
  const bands = bandOrder.filter((band) => rows.some((row) => row.band === band));
  const summary = {
    games: analyses.length,
    samples: rows.length,
    players: splitsByPlayer.size,
    leakingPlayers: leaking,
    splitMethod: "connected components of the player-game graph, hashed to 60/20/20 train/validation/test",
    splits: Object.fromEntries(["train", "validation", "test"].map((split) => [split, count((row) => row.split === split)])),
    byTimeControlAndBand: Object.fromEntries(["blitz", "rapid"].map((tc) => [tc, Object.fromEntries(bands.map((band) => [band, count((row) => row.tc === tc && row.band === band)]))])),
    bySource: Object.fromEntries([...new Set(rows.map((row) => row.source))].map((source) => [source, count((row) => row.source === source)])),
    preset: rows[0]?.preset,
    engine: rows[0]?.engine,
    model: rows[0]?.model,
  };
  if (argument("summary")) writeFileSync(argument("summary"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({
    games: analyses.length,
    samples: rows.length,
    players: splitsByPlayer.size,
    leakingPlayers: leaking,
    splits: Object.fromEntries(["train", "validation", "test"].map((split) => [split, count((row) => row.split === split)])),
    byTimeControl: Object.fromEntries(["blitz", "rapid"].map((tc) => [tc, count((row) => row.tc === tc)])),
  }, null, 2));
}

main();
