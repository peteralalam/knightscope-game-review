// Within-player game-to-game estimate variance (single-game noise).
//
//   node scripts/corpus/rating-consistency.mjs --samples data/rating-corpus-v2/samples.jsonl \
//     --json data/rating-corpus-v2/consistency.json
//
// For every player who appears in more than one sampled player-game (the
// sampler caps at --per-player, usually 2), computes this session's point
// estimate for EACH of their games independently (same shipped regression
// model, using only that one game's features) and compares the two
// estimates. This measures how much a single game's estimate varies for the
// SAME player, which the true-rating label cannot distinguish from model
// error: it is genuine single-game noise, not something to "fix".
//
// Only pairs within the SAME time control are combined into the headline
// distribution (different tc uses a different model / population, so a
// blitz-vs-rapid gap conflates two things). Cross-tc pairs are reported
// separately for reference.
import { readFileSync, writeFileSync } from "node:fs";
import { regressionModelFor, regressionFromVector } from "../../lib/rating-model.ts";
import { bandLabel } from "./sample-lichess-db.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round((sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)) * 10) / 10;
}

function estimateFor(row) {
  const { params } = regressionModelFor(row.tc);
  if (!params) return null;
  return regressionFromVector(row.x, row.meaningfulMoves, params).center;
}

function main() {
  const rows = readFileSync(argument("samples"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const byPlayer = new Map();
  for (const row of rows) {
    if (!row.x) continue;
    if (!byPlayer.has(row.player)) byPlayer.set(row.player, []);
    byPlayer.get(row.player).push(row);
  }
  const sameTcDiffs = [];
  const sameTcDiffsByBand = {};
  const crossTcDiffs = [];
  const pairs = [];
  let playersWithMultiple = 0;
  for (const [player, games] of byPlayer) {
    if (games.length < 2) continue;
    playersWithMultiple += 1;
    for (let i = 0; i < games.length; i += 1) {
      for (let j = i + 1; j < games.length; j += 1) {
        const a = games[i];
        const b = games[j];
        const estA = estimateFor(a);
        const estB = estimateFor(b);
        if (estA === null || estB === null) continue;
        const diff = Math.abs(estA - estB);
        const record = { player, gameA: a.gameId, gameB: b.gameId, tcA: a.tc, tcB: b.tc, estA: Math.round(estA), estB: Math.round(estB), diff: Math.round(diff), trueRating: Math.round((a.rating + b.rating) / 2) };
        pairs.push(record);
        if (a.tc === b.tc) {
          sameTcDiffs.push(diff);
          const band = bandLabel(record.trueRating) ?? "unknown";
          (sameTcDiffsByBand[band] ??= []).push(diff);
        } else {
          crossTcDiffs.push(diff);
        }
      }
    }
  }
  sameTcDiffs.sort((x, y) => x - y);
  crossTcDiffs.sort((x, y) => x - y);
  const byBand = Object.fromEntries(
    Object.entries(sameTcDiffsByBand).map(([band, diffs]) => {
      diffs.sort((x, y) => x - y);
      return [band, { n: diffs.length, median: quantile(diffs, 0.5), p75: quantile(diffs, 0.75), p90: quantile(diffs, 0.9) }];
    }),
  );
  const summary = {
    playersWithMultipleGames: playersWithMultiple,
    sameTimeControlPairs: sameTcDiffs.length,
    crossTimeControlPairs: crossTcDiffs.length,
    sameTimeControl: {
      medianAbsDiff: quantile(sameTcDiffs, 0.5),
      p75AbsDiff: quantile(sameTcDiffs, 0.75),
      p90AbsDiff: quantile(sameTcDiffs, 0.9),
      meanAbsDiff: sameTcDiffs.length ? Math.round((sameTcDiffs.reduce((a, b) => a + b, 0) / sameTcDiffs.length) * 10) / 10 : null,
    },
    crossTimeControl: {
      medianAbsDiff: quantile(crossTcDiffs, 0.5),
      p75AbsDiff: quantile(crossTcDiffs, 0.75),
      p90AbsDiff: quantile(crossTcDiffs, 0.9),
    },
    sameTimeControlByTrueRatingBand: byBand,
  };
  console.log(JSON.stringify(summary, null, 1));
  const json = argument("json");
  if (json) writeFileSync(json, `${JSON.stringify({ summary, pairs }, null, 1)}\n`);
}

main();
