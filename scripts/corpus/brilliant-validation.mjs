// Score the Brilliant rule on the expanded validation set.
//
//   KS_NATIVE_ENGINE=.cache/native/stockfish node scripts/corpus/brilliant-validation.mjs \
//     --preset balanced --engine native --shard 0 --shards 4 --out .cache/corpus/brilliant-val.0.jsonl
//   node scripts/corpus/brilliant-validation.mjs --summarize ".cache/corpus/brilliant-val.*.jsonl" \
//     --json data/brilliant-suite/validation-report.json
//
// Labels come from data/brilliant-suite/validation.json (built by
// build-brilliant-validation.mjs from Lichess's puzzle generator and Lichess's own
// game analysis), plus the hand-built adversarial cases (puzzles.json,
// synthetic.json) whose category is in MUST_NOT_BE_BRILLIANT (negatives) or a
// sound-sacrifice category (positives). The Brilliant algorithm is NOT changed
// by this script; it only measures it.
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AMBIGUOUS_CATEGORIES, loadCases, MUST_NOT_BE_BRILLIANT, runSuite } from "./brilliant-suite.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function expand(pattern) {
  const directory = dirname(pattern);
  const regex = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return readdirSync(directory).filter((name) => regex.test(name)).sort().map((name) => join(directory, name));
}

function labelFor(category) {
  if (AMBIGUOUS_CATEGORIES.has(category)) return "ambiguous";
  return MUST_NOT_BE_BRILLIANT.has(category) ? "negative" : "positive";
}

export function allCases() {
  const expanded = JSON.parse(readFileSync(new URL("../../data/brilliant-suite/validation.json", import.meta.url), "utf8")).cases;
  const handBuilt = loadCases().map((item) => ({ ...item, label: labelFor(item.category), handBuilt: true }));
  return [...handBuilt, ...expanded];
}

/** Wilson score interval for a proportion. */
export function wilson(successes, total, z = 1.96) {
  if (total === 0) return [null, null];
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.round((centre - half) * 1000) / 1000, Math.round((centre + half) * 1000) / 1000];
}

export function summarize(results) {
  const positives = results.filter((r) => r.label === "positive");
  const negatives = results.filter((r) => r.label === "negative");
  const ambiguous = results.filter((r) => r.label === "ambiguous");
  const tp = positives.filter((r) => r.grade === "brilliant").length;
  const fp = negatives.filter((r) => r.grade === "brilliant").length;
  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] ??= { label: r.label, n: 0, brilliant: 0, grades: {} };
    const c = byCategory[r.category];
    c.n += 1;
    if (r.grade === "brilliant") c.brilliant += 1;
    c.grades[r.grade] = (c.grades[r.grade] ?? 0) + 1;
  }
  const rejections = {};
  for (const r of positives) {
    if (r.grade === "brilliant") continue;
    const reason = r.brilliantDiagnostics?.decision ?? "no sacrifice detected";
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  }
  return {
    positives: positives.length,
    negatives: negatives.length,
    truePositives: tp,
    falsePositives: fp,
    precision: tp + fp ? Math.round((tp / (tp + fp)) * 1000) / 1000 : null,
    precisionCI95: wilson(tp, tp + fp),
    recall: Math.round((tp / Math.max(1, positives.length)) * 1000) / 1000,
    recallCI95: wilson(tp, positives.length),
    falsePositiveRate: Math.round((fp / Math.max(1, negatives.length)) * 1000) / 1000,
    falsePositiveRateCI95: wilson(fp, negatives.length),
    byCategory,
    positiveRejections: rejections,
    // bestAlternativeExpectedScore lets a reader audit whether the label or the
    // algorithm is likely wrong: if it is well below the "unnecessary" bar
    // (BRILLIANT.alternativeAlreadyWinning, 0.95), the algorithm's own analysis
    // disagrees with the label's premise that no sacrifice was needed.
    falsePositiveCases: negatives.filter((r) => r.grade === "brilliant").map((r) => ({
      id: r.id,
      move: r.move,
      source: r.source,
      bestAlternativeExpectedScore: r.brilliantDiagnostics?.bestAlternativeExpectedScore ?? null,
    })),
    ambiguousCases: ambiguous.map((r) => ({ id: r.id, move: r.move, grade: r.grade, reason: r.reason, note: r.source })),
  };
}

async function run() {
  const preset = argument("preset", "balanced");
  const shard = Number(argument("shard", "0"));
  const shards = Number(argument("shards", "1"));
  const out = argument("out", `.cache/corpus/brilliant-val.${shard}.jsonl`);
  const { createNativeEngine, createNodeEngine } = await import("../node-engine.mjs");
  const { CachedEngine, SearchCache } = await import("./search-cache.mjs");
  const cache = new SearchCache(`.cache/corpus/searches/${preset}`, { shard: `brilliant-val-${shard}` });
  const native = argument("engine", "wasm") === "native";
  const engine = new CachedEngine(cache, () => (native ? createNativeEngine() : createNodeEngine()));
  const mine = allCases().filter((_, index) => index % shards === shard);
  writeFileSync(out, "");
  for (const item of mine) {
    const [result] = await runSuite([engine], { preset, cases: [item] });
    appendFileSync(out, `${JSON.stringify({ ...result, label: item.label, handBuilt: Boolean(item.handBuilt) })}\n`);
  }
  engine.dispose();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pattern = argument("summarize");
  if (pattern) {
    const results = expand(pattern).flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    const report = {
      all: summarize(results),
      automaticOnly: summarize(results.filter((r) => !r.handBuilt)),
      goldSubset: summarize(results.filter((r) => r.handBuilt)),
    };
    const json = argument("json");
    if (json) writeFileSync(json, `${JSON.stringify(report, null, 1)}\n`);
    const { byCategory, ...headline } = report.all;
    console.log("ALL:", JSON.stringify(headline, null, 1));
    const { byCategory: goldByCategory, ...goldHeadline } = report.goldSubset;
    console.log("GOLD SUBSET (hand-audited):", JSON.stringify(goldHeadline, null, 1));
    for (const [category, value] of Object.entries(byCategory)) console.log(category.padEnd(28), value.label, `${value.brilliant}/${value.n}`, JSON.stringify(value.grades));
  } else {
    await run();
  }
}
