// Check that the native corpus engine reproduces the WASM Lite engine exactly.
//
//   KS_NATIVE_ENGINE=.cache/native/stockfish node scripts/corpus/native-parity.mjs \
//     --games data/rating-corpus/games.jsonl --count 6 --preset quick
//
// Analyzes the same games with both transports (no search cache) and compares
// every per-move fact the corpus tooling stores. Exits non-zero on any difference.
import { readFileSync } from "node:fs";
import { analyzeGame } from "../../lib/analysis-pipeline.ts";
import { parsePgn } from "../../lib/chess-review.ts";
import { ANALYSIS_PRESETS } from "../../lib/review-config.ts";
import { createNativeEngine, createNodeEngine } from "../node-engine.mjs";
import { compactReview, corpusPgn } from "./analyze-corpus.mjs";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const preset = ANALYSIS_PRESETS[argument("preset", "quick")];
const count = Number(argument("count", "6"));
const records = readFileSync(argument("games"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const step = Math.max(1, Math.floor(records.length / count));
const sample = records.filter((_, index) => index % step === 0).slice(0, count);

async function run(engine, record) {
  const game = parsePgn(corpusPgn(record));
  const started = Date.now();
  const analysis = await analyzeGame(game, [engine], {
    primaryNodes: preset.primaryNodes,
    candidateNodes: preset.candidateNodes,
    ratings: { w: record.white?.rating, b: record.black?.rating },
  });
  return { moves: analysis.reviews.map(compactReview), seconds: (Date.now() - started) / 1000 };
}

const wasm = createNodeEngine();
const native = createNativeEngine();
let mismatches = 0;
let wasmSeconds = 0;
let nativeSeconds = 0;
for (const record of sample) {
  const a = await run(wasm, record);
  const b = await run(native, record);
  wasmSeconds += a.seconds;
  nativeSeconds += b.seconds;
  const same = JSON.stringify(a.moves) === JSON.stringify(b.moves);
  if (!same) {
    mismatches += 1;
    const first = a.moves.findIndex((move, index) => JSON.stringify(move) !== JSON.stringify(b.moves[index]));
    console.log(`${record.id}: DIFFERENT from ply ${first}`, JSON.stringify(a.moves[first]).slice(0, 300), JSON.stringify(b.moves[first]).slice(0, 300));
  } else {
    console.log(`${record.id}: identical (${a.moves.length} plies, wasm ${a.seconds.toFixed(1)} s, native ${b.seconds.toFixed(1)} s)`);
  }
}
console.log(`${sample.length - mismatches}/${sample.length} identical; wasm ${wasmSeconds.toFixed(0)} s, native ${nativeSeconds.toFixed(0)} s`);
wasm.dispose();
native.dispose();
process.exit(mismatches ? 1 : 0);
