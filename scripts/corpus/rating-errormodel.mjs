// Fit the ordered-logit engine-error model (lib/rating-model.ts) on the TRAIN
// split per time control, pick its likelihood temper on VALIDATION for 80 %
// coverage, and write posterior estimates for every sample. Consumed by
// rating_benchmark.py as the "fitted error model" baseline.
//
//   node scripts/corpus/rating-errormodel.mjs data/rating-corpus/samples.jsonl .cache/corpus/decisions.jsonl out.json
import { readFileSync, writeFileSync } from "node:fs";
import { fitErrorModel } from "../../lib/rating-calibration.ts";
import {
  DEFAULT_ENGINE_ERROR_MODEL,
  engineLogLikelihood,
  posteriorFrom,
  posteriorQuantile,
  ratingGrid,
} from "../../lib/rating-model.ts";

const [samplesPath, decisionsPath, outPath] = process.argv.slice(2);
const decisionsByKey = new Map(
  readFileSync(decisionsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((row) => [row.key, row.decisions]),
);
const rows = readFileSync(samplesPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  .map((row) => ({ ...row, decisions: decisionsByKey.get(`${row.gameId}:${row.color}`) ?? [] }));
const output = {};
for (const tc of ["blitz", "rapid"]) {
  const population = rows.filter((row) => row.tc === tc);
  const train = population.filter((row) => row.split === "train");
  const ratings = train.map((row) => row.rating);
  const mean = ratings.reduce((sum, value) => sum + value, 0) / ratings.length;
  const sd = Math.sqrt(ratings.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (ratings.length - 1));
  const base = {
    ...DEFAULT_ENGINE_ERROR_MODEL,
    timeControlOffset: { ...DEFAULT_ENGINE_ERROR_MODEL.timeControlOffset, [tc]: 0 },
    prior: { mean, sd },
  };
  const records = train.flatMap((row) => row.decisions.map((decision) => ({ ...decision, rating: row.rating })));
  const fitted = fitErrorModel(records, base, { iterations: 400 });
  const grid = ratingGrid(fitted);
  const predict = (row, temper) => {
    const posterior = posteriorFrom([engineLogLikelihood(row.decisions, tc, { ...fitted, temper }, grid)], { ...fitted, temper }, grid);
    return { estimate: posteriorQuantile(posterior, 0.5), low: posteriorQuantile(posterior, 0.1), high: posteriorQuantile(posterior, 0.9) };
  };
  const validation = population.filter((row) => row.split === "validation");
  let best = { temper: 1, gap: Infinity };
  for (const temper of [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1]) {
    const covered = validation.filter((row) => {
      const estimate = predict(row, temper);
      return row.rating >= estimate.low && row.rating <= estimate.high;
    }).length / Math.max(1, validation.length);
    if (Math.abs(covered - 0.8) < best.gap) best = { temper, gap: Math.abs(covered - 0.8) };
  }
  for (const row of population) output[`${row.gameId}:${row.color}`] = predict(row, best.temper);
  console.log(`${tc}: fitted on ${train.length} samples / ${records.length} decisions; temper ${best.temper}; beta ${fitted.beta.map((b) => b.toFixed(2)).join(" ")}`);
}
writeFileSync(outPath, JSON.stringify(output));
