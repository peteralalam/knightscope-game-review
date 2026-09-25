// Does grading on the rating-conditioned outcome curve materially change the
// displayed classifications, by rating band?
//
//   node scripts/corpus/outcome-regrade.mjs --analyses ".cache/corpus/rating-v2.*.jsonl" \
//     --samples data/rating-corpus-v2/samples.jsonl --outcome data/rating-corpus-v2/outcome-model.json \
//     --split test --out data/rating-corpus-v2/regrade.json
//
// For every ordinary move (Best … Blunder, centipawn scores on both sides) the
// expected-points loss is recomputed from the stored engine scores on
//   baseline  the fixed Lichess curve (what ships today),
//   true      the rating-conditioned curve at the player's TRUE rating (oracle),
//   estimated the rating-conditioned curve at the single-game ESTIMATE (what the
//             app could actually do: step 2 → step 3, no feedback),
// and graded with the same EP bands. Book / Great / Brilliant / Miss and moves
// with mate or tablebase scores are left alone, as in regradeForRating().
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BASELINE_CURVE } from "../../lib/review-config.ts";
import { ratedExpectedScore, severityFromLoss } from "../../lib/outcome-model.ts";
import { REGRESSION_MODELS } from "../../lib/rating-params.ts";
import { regressionFromVector } from "../../lib/rating-model.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function expand(pattern) {
  const directory = dirname(pattern);
  const regex = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return readdirSync(directory).filter((name) => regex.test(name)).sort().map((name) => join(directory, name));
}

const ORDINARY = ["best", "excellent", "good", "inaccuracy", "mistake", "blunder"];
const BANDS = ["800–999", "1000–1199", "1200–1399", "1400–1599", "1600–1799", "1800–1999", "2000–2199", "2200–2399", "2400+"];
const bandOf = (rating) => BANDS[Math.max(0, Math.min(8, Math.floor((rating - 800) / 200)))];
const cpFromExpected = (e) => (e > 0 && e < 1 ? Math.log(e / (1 - e)) / BASELINE_CURVE.slopePerCp : null);
const baseline = (cp) => 1 / (1 + Math.exp(-BASELINE_CURVE.slopePerCp * cp));

function main() {
  const report = JSON.parse(readFileSync(argument("outcome"), "utf8"));
  const name = argument("model", report.chosen);
  const fitted = report.models[name];
  const model = { ...fitted.params, spec: fitted.spec ?? report.specs?.[name], ratingRange: [800, 2700] };
  if (!model.spec) throw new Error("outcome report lacks the model spec");
  const split = argument("split", "test");
  const samples = new Map();
  for (const line of readFileSync(argument("samples"), "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.split === split) samples.set(`${row.gameId}:${row.color}`, row);
  }
  const tally = {};
  const changed = {};
  const seen = new Set();
  for (const file of expand(argument("analyses"))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const analysis = JSON.parse(line);
      if (analysis.error || seen.has(analysis.id)) continue;
      seen.add(analysis.id);
      for (const color of ["w", "b"]) {
        const row = samples.get(`${analysis.id}:${color}`);
        if (!row) continue;
        const params = REGRESSION_MODELS[row.tc];
        const estimate = params ? regressionFromVector(row.x, row.meaningfulMoves, params).center : row.rating;
        const band = bandOf(row.rating);
        tally[band] ??= { moves: 0, baseline: {}, true: {}, estimated: {} };
        changed[band] ??= { true: 0, estimated: 0, eligible: 0 };
        for (const move of analysis.moves) {
          if (move.c !== color || move.book) continue;
          if (!ORDINARY.includes(move.g)) continue;
          const before = typeof move.cpb === "number" ? move.cpb : cpFromExpected(move.eb);
          const after = cpFromExpected(move.ea);
          if (before === null || after === null || move.mb != null) continue;
          const t = tally[band];
          t.moves += 1;
          changed[band].eligible += 1;
          const grades = {
            baseline: severityFromLoss(Math.max(0, baseline(before) - baseline(after)), move.top),
            true: severityFromLoss(Math.max(0, ratedExpectedScore(before, row.rating, row.tc, model) - ratedExpectedScore(after, row.rating, row.tc, model)), move.top),
            estimated: severityFromLoss(Math.max(0, ratedExpectedScore(before, estimate, row.tc, model) - ratedExpectedScore(after, estimate, row.tc, model)), move.top),
          };
          for (const [key, grade] of Object.entries(grades)) t[key][grade] = (t[key][grade] ?? 0) + 1;
          if (grades.true !== grades.baseline) changed[band].true += 1;
          if (grades.estimated !== grades.baseline) changed[band].estimated += 1;
        }
      }
    }
  }
  const per1000 = (counts, total) => Object.fromEntries(ORDINARY.map((grade) => [grade, Math.round(((counts[grade] ?? 0) / Math.max(1, total)) * 10000) / 10]));
  const out = { model: name, split, bands: {} };
  for (const band of BANDS) {
    const t = tally[band];
    if (!t) continue;
    out.bands[band] = {
      moves: t.moves,
      baseline: per1000(t.baseline, t.moves),
      ratedAtTrueRating: per1000(t.true, t.moves),
      ratedAtEstimate: per1000(t.estimated, t.moves),
      changedShare: {
        trueRating: Math.round((changed[band].true / Math.max(1, changed[band].eligible)) * 1000) / 1000,
        estimate: Math.round((changed[band].estimated / Math.max(1, changed[band].eligible)) * 1000) / 1000,
      },
    };
  }
  writeFileSync(argument("out"), `${JSON.stringify(out, null, 1)}\n`);
  for (const [band, value] of Object.entries(out.bands)) {
    console.log(band, value.moves, "blunder", value.baseline.blunder, "→", value.ratedAtTrueRating.blunder, "/", value.ratedAtEstimate.blunder,
      "mistake", value.baseline.mistake, "→", value.ratedAtTrueRating.mistake, "changed", value.changedShare);
  }
}

main();
