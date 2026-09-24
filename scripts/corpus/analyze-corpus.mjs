// Analyze a JSONL game corpus with the production pipeline.
//
//   node scripts/corpus/analyze-corpus.mjs --games data/rating-corpus/games.jsonl \
//     --preset quick --shard 0 --shards 4 --out .cache/corpus/rating-quick.0.jsonl
//
// Engine searches are memoized in .cache/corpus/searches/<preset>/ (see
// search-cache.mjs), so re-running after a classifier change only searches
// what is new. Run one process per core with --shard/--shards.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { analyzeGame } from "../../lib/analysis-pipeline.ts";
import { parsePgn, summarizeSide } from "../../lib/chess-review.ts";
import { ANALYSIS_PRESETS } from "../../lib/review-config.ts";
import { classifyTimeControl, DEFAULT_ENGINE_ERROR_MODEL, estimatePerformance } from "../../lib/rating-model.ts";
import { createNodeEngine } from "../node-engine.mjs";
import { CachedEngine, SearchCache } from "./search-cache.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function corpusPgn(record) {
  const headers = {
    Event: record.event ?? "Corpus game",
    Site: record.url ?? record.id,
    White: record.white?.id ?? "?",
    Black: record.black?.id ?? "?",
    Result: record.result ?? "*",
    ...(record.white?.rating ? { WhiteElo: String(record.white.rating) } : {}),
    ...(record.black?.rating ? { BlackElo: String(record.black.rating) } : {}),
    ...(record.timeControl ? { TimeControl: record.timeControl } : {}),
  };
  if (record.pgn) return record.pgn;
  const moves = record.san.split(" ").map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san)).join(" ");
  return `${Object.entries(headers).map(([key, value]) => `[${key} "${value}"]`).join("\n")}\n\n${moves} ${record.result ?? "*"}`;
}

const round = (value, digits = 4) => (value === undefined || value === null ? value : Math.round(value * 10 ** digits) / 10 ** digits);

/** Per-move facts kept for offline statistics (grades, losses, criticality, diagnostics). */
export function compactReview(review) {
  return {
    i: review.index,
    c: review.color,
    san: review.san,
    g: review.grade,
    og: review.objectiveGrade,
    loss: round(review.expectedPointsLost),
    eb: round(review.expectedBefore),
    ea: round(review.expectedAfter),
    top: review.isTopMove,
    rank: review.playedRank,
    inf: review.informativeness,
    fr: review.forcedReason,
    ph: review.phase,
    lm: review.legalMoveCount,
    book: review.isBook,
    gap: round(review.criticality.gap),
    only: review.criticality.onlyMove,
    viable: review.criticality.viableMoves,
    uniq: round(review.criticality.moveUniqueness),
    imp: round(review.criticality.outcomeImportance),
    miss: review.miss?.missedOpportunityType,
    great: review.greatDiagnostics,
    brill: review.brilliantDiagnostics,
    sac: review.sacrifice?.kind,
  };
}

async function main() {
  const gamesFile = argument("games");
  const presetKey = argument("preset", "balanced");
  const preset = ANALYSIS_PRESETS[presetKey];
  const shard = Number(argument("shard", "0"));
  const shards = Number(argument("shards", "1"));
  const out = argument("out", `.cache/corpus/out-${presetKey}.${shard}.jsonl`);
  const cacheDir = argument("cache", `.cache/corpus/searches/${presetKey}`);
  const limit = Number(argument("limit", "Infinity"));
  const useBook = argument("book", "true") !== "false";

  const records = readFileSync(gamesFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const mine = records.filter((_, index) => index % shards === shard).slice(0, limit);
  const cache = new SearchCache(cacheDir, { shard: `${presetKey}-${shard}` });
  const engine = new CachedEngine(cache, () => createNodeEngine());
  writeFileSync(out, "");
  const started = Date.now();
  let done = 0;
  for (const record of mine) {
    let game;
    try {
      game = parsePgn(corpusPgn(record));
    } catch (error) {
      appendFileSync(out, `${JSON.stringify({ id: record.id, error: String(error) })}\n`);
      continue;
    }
    const analysis = await analyzeGame(game, [engine], {
      primaryNodes: preset.primaryNodes,
      candidateNodes: preset.candidateNodes,
      ratings: { w: record.white?.rating, b: record.black?.rating },
      useBook,
    });
    const sides = {};
    for (const color of ["w", "b"]) {
      const summary = summarizeSide(analysis.reviews, color, game.headers);
      sides[color] = {
        rating: color === "w" ? record.white?.rating : record.black?.rating,
        player: color === "w" ? record.white?.id : record.black?.id,
        accuracy: summary.accuracy,
        counts: summary.counts,
        features: summary.features,
        performance: summary.performance,
        // The uncalibrated v2.0 prior, kept as the benchmark's "heuristic" baseline.
        priorPerformance: estimatePerformance(analysis.reviews.filter((move) => move.color === color), {
          timeControl: classifyTimeControl(game.headers.TimeControl),
          params: DEFAULT_ENGINE_ERROR_MODEL,
        }),
      };
    }
    appendFileSync(
      out,
      `${JSON.stringify({
        id: record.id,
        source: record.source,
        tags: record.tags,
        tc: record.tc,
        result: record.result,
        ply: game.moves.length,
        meta: { ...analysis.meta, preset: presetKey },
        sides,
        moves: analysis.reviews.map(compactReview),
      })}\n`,
    );
    done += 1;
    if (done % 10 === 0 || done === mine.length) {
      const rate = (Date.now() - started) / done / 1000;
      console.log(`[shard ${shard}] ${done}/${mine.length} games, ${rate.toFixed(1)} s/game, cache ${cache.hits} hits / ${cache.misses} misses`);
    }
  }
  engine.dispose();
  process.exit(0);
}

if (existsSync(argument("games", ""))) await main();
