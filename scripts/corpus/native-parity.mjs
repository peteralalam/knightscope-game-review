// Check that the native corpus engine reproduces the WASM Lite engine, at the
// level of what the models consume: per-move grade/loss facts AND the
// resulting continuous rating-model features (not required to be byte-for-byte
// identical PVs, though single-threaded deterministic search normally is).
//
//   KS_NATIVE_ENGINE=.cache/native/stockfish node scripts/corpus/native-parity.mjs \
//     --games data/rating-corpus/games.jsonl --count 30 --preset quick \
//     --json data/golden/native-parity-games.json
import { readFileSync, writeFileSync } from "node:fs";
import { analyzeGame } from "../../lib/analysis-pipeline.ts";
import { extractFeatures } from "../../lib/chess-review.ts";
import { parsePgn } from "../../lib/chess-review.ts";
import { ANALYSIS_PRESETS } from "../../lib/review-config.ts";
import { ratingFeatureVector, RATING_FEATURES } from "../../lib/rating-model.ts";
import { createNativeEngine, createNodeEngine } from "../node-engine.mjs";
import { compactReview, corpusPgn } from "./analyze-corpus.mjs";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const preset = ANALYSIS_PRESETS[argument("preset", "quick")];
const count = Number(argument("count", "30"));
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
  const features = {};
  for (const color of ["w", "b"]) {
    const sideMoves = analysis.reviews.filter((move) => move.color === color);
    const f = extractFeatures(sideMoves, analysis.reviews);
    features[color] = f ? ratingFeatureVector(f) : null;
  }
  return { moves: analysis.reviews.map(compactReview), features, seconds: (Date.now() - started) / 1000 };
}

const wasm = createNodeEngine();
const native = createNativeEngine();
let exactMatches = 0;
let wasmSeconds = 0;
let nativeSeconds = 0;
const gameRows = [];
let maxFeatureDiff = 0;
let maxFeatureDiffName = null;
let featureVectorsCompared = 0;
let cpMismatchMax = 0;

for (const record of sample) {
  const a = await run(wasm, record);
  const b = await run(native, record);
  wasmSeconds += a.seconds;
  nativeSeconds += b.seconds;
  const same = JSON.stringify(a.moves) === JSON.stringify(b.moves);
  if (same) exactMatches += 1;

  // Per-move cp diff even when not byte-identical (defensive; expected 0).
  let localCpMax = 0;
  for (let i = 0; i < a.moves.length; i += 1) {
    const cpA = a.moves[i]?.cpb;
    const cpB = b.moves[i]?.cpb;
    if (typeof cpA === "number" && typeof cpB === "number") localCpMax = Math.max(localCpMax, Math.abs(cpA - cpB));
  }
  cpMismatchMax = Math.max(cpMismatchMax, localCpMax);

  // Feature-vector diff per side.
  const featureDiffs = {};
  for (const color of ["w", "b"]) {
    const fa = a.features[color];
    const fb = b.features[color];
    if (!fa || !fb) continue;
    featureVectorsCompared += 1;
    fa.forEach((value, index) => {
      const other = fb[index];
      if (value === null || other === null) return;
      const diff = Math.abs(value - other);
      featureDiffs[RATING_FEATURES[index]] = Math.max(featureDiffs[RATING_FEATURES[index]] ?? 0, diff);
      if (diff > maxFeatureDiff) {
        maxFeatureDiff = diff;
        maxFeatureDiffName = RATING_FEATURES[index];
      }
    });
  }

  gameRows.push({ id: record.id, plies: a.moves.length, exact: same, cpMax: localCpMax, featureDiffs, wasmSeconds: a.seconds, nativeSeconds: b.seconds });
  if (!same) {
    const first = a.moves.findIndex((move, index) => JSON.stringify(move) !== JSON.stringify(b.moves[index]));
    console.log(`${record.id}: DIFFERENT from ply ${first}`, JSON.stringify(a.moves[first]).slice(0, 300), JSON.stringify(b.moves[first]).slice(0, 300));
  } else {
    console.log(`${record.id}: identical (${a.moves.length} plies, wasm ${a.seconds.toFixed(1)} s, native ${b.seconds.toFixed(1)} s)`);
  }
}

const summary = {
  gamesCompared: sample.length,
  exactMatches,
  exactMatchRate: Math.round((exactMatches / sample.length) * 1000) / 1000,
  featureVectorsCompared,
  maxFeatureDiff,
  maxFeatureDiffName,
  maxRootCpDiff: cpMismatchMax,
  wasmSecondsTotal: Math.round(wasmSeconds),
  nativeSecondsTotal: Math.round(nativeSeconds),
  speedup: Math.round((wasmSeconds / nativeSeconds) * 100) / 100,
  engineVersionWasm: wasm.engineVersion,
  engineVersionNative: native.engineVersion,
};
console.log(JSON.stringify(summary, null, 1));
console.log(`${exactMatches}/${sample.length} exact; wasm ${wasmSeconds.toFixed(0)} s, native ${nativeSeconds.toFixed(0)} s`);

const json = argument("json");
if (json) writeFileSync(json, `${JSON.stringify({ summary, games: gameRows }, null, 1)}\n`);
wasm.dispose();
native.dispose();
process.exit(exactMatches === sample.length ? 0 : 1);
