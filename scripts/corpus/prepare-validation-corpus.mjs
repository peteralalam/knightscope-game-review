// Build the classification validation corpus: ~120 games chosen to cover the
// situations where classification pathologies show up.
//
//   node scripts/corpus/prepare-validation-corpus.mjs --puzzle combined_puzzle_db_first_50k.ndjson \
//     --datasnaek chess.csv --out data/validation-corpus
//
// Lichess games are tagged from the Lichess puzzle themes attached to them and
// from Lichess's own per-player error counts (only used for selection, never
// for grading). Master games come from data/golden/*.pgn.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { classifyTimeControl } from "../../lib/rating-model.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const PER_TAG = Number(argument("per-tag", "10"));
const excluded = new Set(
  readFileSync("data/rating-corpus/games.jsonl", "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).id),
);

const TAGS = {
  "low-rated": (game) => game.avg < 1200,
  "club-1200-1800": (game) => game.avg >= 1200 && game.avg < 1800,
  "strong-1800-2400": (game) => game.avg >= 1800 && game.avg < 2400,
  "strong-online-2400+": (game) => game.avg >= 2400,
  short: (game) => game.ply <= 30 && game.result !== "1/2-1/2",
  long: (game) => game.ply >= 150,
  "drawn-ending": (game) => game.result === "1/2-1/2" && game.ply >= 60,
  "blunder-heavy": (game) => game.blunders !== undefined && game.blunders >= 6,
  "quiet-positional": (game) => game.blunders !== undefined && game.blunders <= 1 && game.mistakes <= 2 && game.ply >= 60,
  "real-sacrifice": (game) => game.themes?.has("sacrifice"),
  "defensive-save": (game) => game.themes?.has("defensiveMove") || game.themes?.has("equality"),
  "winning-conversion": (game) => game.themes?.has("endgame") && game.result !== "1/2-1/2" && game.ply >= 100,
  "classical-time-control": (game) => game.tc === "classical",
};

function main() {
  const pool = [];
  const games = new Map();
  for (const line of readFileSync(argument("puzzle"), "utf8").split("\n")) {
    if (!line) continue;
    const { puzzle, game } = JSON.parse(line);
    if (!games.has(game.id)) games.set(game.id, { game, themes: new Set() });
    for (const theme of puzzle.Themes.split(" ")) games.get(game.id).themes.add(theme);
  }
  for (const { game, themes } of games.values()) {
    if (excluded.has(game.id) || !game.rated || game.variant !== "standard") continue;
    const white = game.players.white;
    const black = game.players.black;
    if (!white?.user || !black?.user || !white.rating || !black.rating) continue;
    const san = game.moves.trim().split(/\s+/);
    if (san.length < 10 || san.length > 240) continue;
    const timeControl = `${game.clock.initial}+${game.clock.increment}`;
    pool.push({
      id: game.id,
      source: "lichess-puzzle-db",
      url: `https://lichess.org/${game.id}`,
      timeControl,
      tc: classifyTimeControl(timeControl),
      white: { id: white.user.id, rating: white.rating },
      black: { id: black.user.id, rating: black.rating },
      result: game.winner === "white" ? "1-0" : game.winner === "black" ? "0-1" : "1/2-1/2",
      status: game.status,
      ply: san.length,
      avg: (white.rating + black.rating) / 2,
      blunders: (white.analysis?.blunder ?? 0) + (black.analysis?.blunder ?? 0),
      mistakes: (white.analysis?.mistake ?? 0) + (black.analysis?.mistake ?? 0),
      themes,
      san: san.join(" "),
    });
  }
  const [header, ...rows] = readFileSync(argument("datasnaek"), "utf8").trim().split("\n");
  const columns = header.split(",");
  for (const row of rows) {
    const values = row.split(",");
    const field = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    if (excluded.has(field.game_id) || field.rated !== "TRUE") continue;
    const [base, increment] = field.time_increment.split("+").map(Number);
    const timeControl = `${base * 60}+${increment}`;
    const san = field.moves.trim().split(/\s+/);
    if (san.length < 10 || san.length > 240) continue;
    const white = Number(field.white_rating);
    const black = Number(field.black_rating);
    pool.push({
      id: field.game_id,
      source: "lichess-datasnaek",
      url: `https://lichess.org/${field.game_id}`,
      timeControl,
      tc: classifyTimeControl(timeControl),
      white: { id: field.white_id.toLowerCase(), rating: white },
      black: { id: field.black_id.toLowerCase(), rating: black },
      result: field.winner === "white" ? "1-0" : field.winner === "black" ? "0-1" : "1/2-1/2",
      status: field.victory_status,
      ply: san.length,
      avg: (white + black) / 2,
      san: san.join(" "),
    });
  }

  const random = seededRandom(Number(argument("seed", "7")));
  const shuffled = pool.map((game) => ({ game, key: random() })).sort((a, b) => a.key - b.key).map(({ game }) => game);
  const chosen = new Map();
  for (const [tag, test] of Object.entries(TAGS)) {
    let count = 0;
    for (const game of shuffled) {
      if (count >= PER_TAG) break;
      if (chosen.has(game.id) || !test(game)) continue;
      const chess = new Chess();
      try {
        for (const move of game.san.split(" ")) chess.move(move);
      } catch {
        continue;
      }
      chosen.set(game.id, { ...game, tags: [tag] });
      count += 1;
    }
  }
  // Every other tag a chosen game also satisfies.
  for (const game of chosen.values()) {
    for (const [tag, test] of Object.entries(TAGS)) if (!game.tags.includes(tag) && test(game)) game.tags.push(tag);
  }

  // Selection-only fields are not part of the corpus record.
  const records = [...chosen.values()].map((game) => {
    const record = { ...game };
    for (const key of ["themes", "avg", "blunders", "mistakes"]) delete record[key];
    return record;
  });
  for (const file of readdirSync("data/golden").filter((name) => name.endsWith(".pgn")).sort()) {
    const text = readFileSync(`data/golden/${file}`, "utf8").replace(/\r\n/g, "\n");
    text.split(/\n\s*\n(?=\[Event )/).forEach((pgn, index) => {
      const chess = new Chess();
      try {
        chess.loadPgn(pgn);
      } catch {
        return; // e.g. the null move in anastasian-lewis.pgn
      }
      if (chess.history().length < 10) return;
      const headers = chess.getHeaders();
      records.push({
        id: `${file.replace(/\.pgn$/, "")}#${index + 1}`,
        source: "master-otb",
        event: headers.Event,
        tags: ["master-otb"],
        tc: "classical",
        result: headers.Result,
        ply: chess.history().length,
        pgn,
      });
    });
  }
  mkdirSync(argument("out", "data/validation-corpus"), { recursive: true });
  writeFileSync(`${argument("out", "data/validation-corpus")}/games.jsonl`, records.map((game) => JSON.stringify(game)).join("\n") + "\n");
  const tagCounts = {};
  for (const game of records) for (const tag of game.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  console.log(records.length, "games", tagCounts);
}

main();
