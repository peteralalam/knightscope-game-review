// Print every classification of a PGN with Great / Brilliant diagnostics.
//
//   node scripts/corpus/explain-game.mjs data/golden/opera-game-1858.pgn --preset balanced [--json out.json]
//
// Uses the corpus search cache, so repeated runs after a classifier change are instant.
import { readFileSync, writeFileSync } from "node:fs";
import { analyzeGame } from "../../lib/analysis-pipeline.ts";
import { GRADE_META, parsePgn } from "../../lib/chess-review.ts";
import { ANALYSIS_PRESETS } from "../../lib/review-config.ts";
import { createNodeEngine } from "../node-engine.mjs";
import { CachedEngine, SearchCache } from "./search-cache.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function splitPgn(text) {
  return text.replace(/\r\n/g, "\n").split(/\n\s*\n(?=\[Event )/).map((game) => game.trim()).filter(Boolean);
}

const file = process.argv[2];
const presetKey = argument("preset", "balanced");
const preset = ANALYSIS_PRESETS[presetKey];
const workers = Number(argument("workers", "3"));
// --build full uses the ~99 MB official-network build (npm flavour "single").
const build = argument("build", "lite");
const flavour = build === "full" ? "single" : "lite-single";
const cacheDir = argument("cache", `.cache/corpus/searches/${presetKey}${build === "full" ? "-full" : ""}`);
const cache = new SearchCache(cacheDir, { shard: `explain-${process.pid}` });
const engines = Array.from({ length: workers }, () => new CachedEngine(cache, () => createNodeEngine({ flavour })));
const report = [];
const quiet = process.argv.includes("--quiet");
for (const text of splitPgn(readFileSync(file, "utf8"))) {
  const game = parsePgn(text);
  const elo = (value) => (/^\d+$/.test(value ?? "") ? Number(value) : undefined);
  const analysis = await analyzeGame(game, engines, {
    primaryNodes: preset.primaryNodes,
    candidateNodes: preset.candidateNodes,
    ratings: { w: elo(game.headers.WhiteElo), b: elo(game.headers.BlackElo) },
  });
  const title = `${game.headers.White} – ${game.headers.Black} (${game.headers.Date ?? "?"})`;
  const counts = {};
  for (const review of analysis.reviews) counts[review.grade] = (counts[review.grade] ?? 0) + 1;
  if (!quiet) {
    console.log(`\n=== ${title} · ${presetKey} · ${analysis.meta.engineVersion}`);
    console.log(Object.entries(counts).map(([grade, count]) => `${GRADE_META[grade].label} ${count}`).join(", "));
    for (const review of analysis.reviews) {
      const label = `${review.moveNumber}${review.color === "w" ? "." : "..."}${review.san}`;
      const flag = review.greatDiagnostics ? ` [great-candidate: ${review.greatDiagnostics.decision}]` : "";
      if (review.grade === "brilliant" || review.grade === "great" || review.greatDiagnostics || process.argv.includes("--all")) {
        console.log(`${label.padEnd(14)} ${GRADE_META[review.grade].label.padEnd(10)} loss ${review.expectedPointsLost.toFixed(3)}${flag}`);
        if (review.greatDiagnostics) console.log(`   ${JSON.stringify(review.greatDiagnostics)}`);
        if (review.brilliantDiagnostics) console.log(`   brilliant: ${JSON.stringify(review.brilliantDiagnostics)}`);
      }
    }
  }
  report.push({
    title,
    preset: presetKey,
    meta: analysis.meta,
    counts,
    moves: analysis.reviews.map((review) => ({
      move: `${review.moveNumber}${review.color === "w" ? "." : "..."}${review.san}`,
      grade: review.grade,
      loss: Math.round(review.expectedPointsLost * 1e4) / 1e4,
      reason: review.classificationReason,
      great: review.greatDiagnostics,
      brilliant: review.brilliantDiagnostics,
    })),
  });
}
const json = argument("json");
if (json) writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
engines.forEach((engine) => engine.dispose());
console.error(`cache: ${cache.hits} hits, ${cache.misses} misses`);
process.exit(0);
