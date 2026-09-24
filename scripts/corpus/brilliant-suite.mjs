// Brilliant adversarial suite: real puzzle positions plus constructed traps.
//
//   node scripts/corpus/brilliant-suite.mjs [--preset balanced] [--json data/brilliant-suite/report.json]
//
// Categories in MUST_NOT_BE_BRILLIANT are hard failures when promoted; the others
// are sound-sacrifice categories where Brilliant is allowed (recall is reported,
// not required – a missed Brilliant is far cheaper than a false one).
import { readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { analyzeGame } from "../../lib/analysis-pipeline.ts";
import { uciParts } from "../../lib/chess-analysis.ts";
import { parsePgn } from "../../lib/chess-review.ts";
import { ANALYSIS_PRESETS } from "../../lib/review-config.ts";

export const MUST_NOT_BE_BRILLIANT = new Set([
  "sac-while-winning",
  "sac-while-losing",
  "hanging-queen",
  "unsound-sacrifice",
  "obvious-recapture",
  "temporary-sacrifice",
  "forced-queen-sacrifice",
  "underpromotion",
  "hanging-piece-capture",
]);

const root = new URL("../../data/brilliant-suite/", import.meta.url);

export function loadCases() {
  const puzzles = JSON.parse(readFileSync(new URL("puzzles.json", root), "utf8"));
  const synthetic = JSON.parse(readFileSync(new URL("synthetic.json", root), "utf8"));
  return [...synthetic, ...puzzles];
}

/** Build a PGN for a case: FEN + UCI moves, or SAN from the start position. */
function casePgn(item) {
  const chess = new Chess(item.fen);
  if (item.san) for (const san of item.san.split(" ")) chess.move(san);
  else for (const uci of item.moves) chess.move(uciParts(uci));
  const headers = item.fen ? `[FEN "${item.fen}"]\n[SetUp "1"]\n` : "";
  return `${headers}[WhiteElo "1500"]\n[BlackElo "1500"]\n\n${chess.pgn().replace(/^\[.*\]\n/gm, "").trim()}`;
}

export async function runSuite(engines, { preset = "balanced", cases = loadCases() } = {}) {
  const budget = ANALYSIS_PRESETS[preset];
  const results = [];
  for (const item of cases) {
    const game = parsePgn(casePgn(item));
    const analysis = await analyzeGame(game, engines, {
      primaryNodes: budget.primaryNodes,
      candidateNodes: budget.candidateNodes,
      ratings: { w: 1500, b: 1500 },
      useBook: false,
    });
    const review = analysis.reviews[item.testedPly];
    results.push({
      id: item.id,
      category: item.category,
      mustNotBeBrilliant: MUST_NOT_BE_BRILLIANT.has(item.category),
      move: review.san,
      grade: review.grade,
      reason: review.classificationReason,
      brilliantDiagnostics: review.brilliantDiagnostics ?? null,
      greatDecision: review.greatDiagnostics?.decision ?? null,
      source: item.source ?? item.note,
    });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createNodeEngine } = await import("../node-engine.mjs");
  const { CachedEngine, SearchCache } = await import("./search-cache.mjs");
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const preset = argument("preset", "balanced");
  const cache = new SearchCache(`.cache/corpus/searches/${preset}`, { shard: `suite-${process.pid}` });
  const engines = [0, 1, 2].map(() => new CachedEngine(cache, () => createNodeEngine()));
  const results = await runSuite(engines, { preset });
  for (const result of results) {
    const flag = result.mustNotBeBrilliant && result.grade === "brilliant" ? "  <-- FALSE POSITIVE" : "";
    console.log(`${result.category.padEnd(24)} ${result.move.padEnd(8)} ${result.grade.padEnd(10)} ${result.brilliantDiagnostics?.decision ?? "(no sacrifice detected)"}${flag}`);
  }
  const json = argument("json");
  if (json) writeFileSync(json, JSON.stringify({ preset, engine: engines[0].engineVersion, results }, null, 2) + "\n");
  engines.forEach((engine) => engine.dispose());
  process.exit(0);
}
