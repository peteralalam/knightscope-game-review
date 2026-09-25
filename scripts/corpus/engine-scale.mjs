// Are Lite and Full centipawns on the same scale?
//
//   node scripts/corpus/engine-scale.mjs --games data/rating-corpus/games.jsonl --positions 300 \
//     --nodes 150000 --json data/golden/engine-scale.json
//
// Both builds print Stockfish 19's normalized centipawns, but the normalization
// constants were fitted for the official network. If the Lite network's raw
// scale differs, the same position gets a larger or smaller cp from Lite, and a
// fixed cp → expected-score curve (such as Lichess's) means something different
// for each build. Positions are random plies of rated games (seeded).
import { readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { createNodeEngine } from "../node-engine.mjs";
import { priority } from "./sample-lichess-db.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const count = Number(argument("positions", "300"));
const nodes = Number(argument("nodes", "150000"));
const games = readFileSync(argument("games"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
games.sort((a, b) => priority(7, a.id) - priority(7, b.id));
const positions = [];
for (const game of games) {
  if (positions.length >= count) break;
  const sans = game.san.split(" ");
  const ply = 8 + Math.floor(priority(11, game.id) * Math.max(1, sans.length - 12));
  const chess = new Chess();
  const moves = [];
  for (const san of sans.slice(0, ply)) moves.push(chess.move(san));
  if (chess.isGameOver()) continue;
  positions.push({ id: `${game.id}#${ply}`, rootFen: new Chess().fen(), moves: moves.map((m) => `${m.from}${m.to}${m.promotion ?? ""}`) });
}

const lite = createNodeEngine({ flavour: "lite-single" });
const full = createNodeEngine({ flavour: "single" });
const rows = [];
for (const position of positions) {
  const request = { ...position, nodes, multiPv: 1 };
  await lite.newGame();
  await full.newGame();
  const a = (await lite.search(request)).lines[0];
  const b = (await full.search(request)).lines[0];
  rows.push({ id: position.id, lite: a.cp ?? null, full: b.cp ?? null, liteMate: a.mate ?? null, fullMate: b.mate ?? null });
}
lite.dispose();
full.dispose();

const both = rows.filter((row) => row.lite !== null && row.full !== null && Math.abs(row.lite) < 1500 && Math.abs(row.full) < 1500);
// Slope of Lite on Full through the origin, and the robust median ratio for |full| ≥ 100.
const slope = both.reduce((sum, row) => sum + row.lite * row.full, 0) / both.reduce((sum, row) => sum + row.full * row.full, 0);
const ratios = both.filter((row) => Math.abs(row.full) >= 100).map((row) => row.lite / row.full).sort((x, y) => x - y);
const median = ratios[Math.floor(ratios.length / 2)];
const meanAbs = (key) => both.reduce((sum, row) => sum + Math.abs(row[key]), 0) / both.length;
const summary = {
  positions: rows.length,
  compared: both.length,
  nodes,
  slopeLiteOnFull: Math.round(slope * 1000) / 1000,
  medianRatioLiteOverFull: Math.round(median * 1000) / 1000,
  meanAbsCp: { lite: Math.round(meanAbs("lite")), full: Math.round(meanAbs("full")) },
  signAgreement: Math.round((both.filter((row) => Math.sign(row.lite) === Math.sign(row.full)).length / both.length) * 1000) / 1000,
};
console.log(summary);
const json = argument("json");
if (json) writeFileSync(json, `${JSON.stringify({ summary, rows }, null, 1)}\n`);
process.exit(0);
