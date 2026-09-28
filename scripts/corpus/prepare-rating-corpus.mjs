// Build the rated-game corpus used to calibrate and evaluate the rating model.
//
//   node scripts/corpus/prepare-rating-corpus.mjs --puzzle combined_puzzle_db_first_50k.ndjson \
//     --datasnaek chess.csv --out data/rating-corpus
//
// Sources (both public Lichess data):
//   * mcognetta/lichess-combined-puzzle-game-db, first-50k sample: Lichess API game
//     exports (2013–2022) with player ids, ratings, provisional flags and clocks.
//     https://github.com/mcognetta/lichess-combined-puzzle-game-db
//   * Kaggle "Chess Game Dataset (Lichess)" by Mitchell J. (datasnaek), 2016–2017,
//     as mirrored by TidyTuesday 2024-10-01. Covers the 800–1400 rapid bands the
//     puzzle sample lacks.
//     https://raw.githubusercontent.com/rfordatascience/tidytuesday/main/data/2024/2024-10-01/chess.csv
//
// Every filter below is counted and written to data/rating-corpus/FILTERS.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { classifyTimeControl } from "../../lib/rating-model.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export const BANDS = [
  [800, 1000], [1000, 1200], [1200, 1400], [1400, 1600], [1600, 1800],
  [1800, 2000], [2000, 2200], [2200, 2400], [2400, 3200],
];
export const bandLabel = (rating) => {
  const band = BANDS.find(([low, high]) => rating >= low && rating < high);
  return band ? (band[1] > 3000 ? `${band[0]}+` : `${band[0]}–${band[1]}`) : null;
};

const FILTERS = {
  notRated: "casual (unrated) game",
  variant: "non-standard variant or custom start position",
  missingPlayer: "anonymous player or missing rating",
  provisional: "provisional rating (fewer than ~20 rated games in that pool)",
  status: "cheat detection, abandonment ('timeout' = opponent left), aborted or unknown finish",
  timeClass: "time class other than blitz / rapid (bullet, classical, correspondence)",
  tooShort: "fewer than 12 plies (no meaningful sample of decisions)",
  tooLong: "more than 240 plies (the reviewer's limit)",
  illegal: "move list does not replay legally (checked on sampled games only)",
  duplicate: "same game id (or same players and moves) already seen",
  ratingRange: "a player outside 800–3200",
};

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function replays(san) {
  const chess = new Chess();
  try {
    for (const move of san) chess.move(move);
    return true;
  } catch {
    return false;
  }
}

function resultOf(winner, status) {
  if (winner === "white") return "1-0";
  if (winner === "black") return "0-1";
  return status === "draw" || status === "stalemate" ? "1/2-1/2" : "*";
}

function main() {
  const out = argument("out", "data/rating-corpus");
  const perStratum = Number(argument("per-stratum", "170"));
  const perPlayer = Number(argument("per-player", "3"));
  const seed = Number(argument("seed", "20260924"));
  const dropped = Object.fromEntries(Object.keys(FILTERS).map((key) => [key, 0]));
  const seen = new Set();
  const pool = [];
  let read = 0;

  const accept = (record, san) => {
    if (record.ply < 12) return (dropped.tooShort += 1), undefined;
    if (record.ply > 240) return (dropped.tooLong += 1), undefined;
    const signature = `${record.white.id}|${record.black.id}|${san.join(" ")}`;
    if (seen.has(record.id) || seen.has(signature)) return (dropped.duplicate += 1), undefined;
    if ([record.white.rating, record.black.rating].some((rating) => rating < 800 || rating >= 3200)) {
      return (dropped.ratingRange += 1), undefined;
    }
    seen.add(record.id);
    seen.add(signature);
    pool.push({ ...record, san: san.join(" ") });
  };

  const puzzleFile = argument("puzzle");
  if (puzzleFile) {
    const games = new Map();
    for (const line of readFileSync(puzzleFile, "utf8").split("\n")) {
      if (!line) continue;
      const { game } = JSON.parse(line);
      games.set(game.id, game);
    }
    for (const game of games.values()) {
      read += 1;
      if (!game.rated) { dropped.notRated += 1; continue; }
      if (game.variant !== "standard" || game.initialFen) { dropped.variant += 1; continue; }
      const white = game.players?.white;
      const black = game.players?.black;
      if (!white?.user?.id || !black?.user?.id || !white.rating || !black.rating) { dropped.missingPlayer += 1; continue; }
      if (white.provisional || black.provisional) { dropped.provisional += 1; continue; }
      if (!["mate", "resign", "outoftime", "draw", "stalemate"].includes(game.status)) { dropped.status += 1; continue; }
      const timeControl = `${game.clock.initial}+${game.clock.increment}`;
      const tc = classifyTimeControl(timeControl);
      if (tc !== "blitz" && tc !== "rapid") { dropped.timeClass += 1; continue; }
      const san = game.moves.trim().split(/\s+/);
      accept({
        id: game.id,
        source: "lichess-puzzle-db",
        url: `https://lichess.org/${game.id}`,
        date: new Date(game.createdAt).toISOString().slice(0, 10),
        timeControl,
        tc,
        white: { id: game.players.white.user.id, rating: white.rating },
        black: { id: game.players.black.user.id, rating: black.rating },
        result: resultOf(game.winner, game.status),
        status: game.status,
        ply: san.length,
      }, san);
    }
  }

  const csvFile = argument("datasnaek");
  if (csvFile) {
    const [header, ...rows] = readFileSync(csvFile, "utf8").trim().split("\n");
    const columns = header.split(",");
    for (const row of rows) {
      read += 1;
      const values = row.split(",");
      const field = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      if (field.rated !== "TRUE") { dropped.notRated += 1; continue; }
      if (!field.white_id || !field.black_id) { dropped.missingPlayer += 1; continue; }
      // The dataset stores the base time in minutes.
      const [base, increment] = field.time_increment.split("+").map(Number);
      const timeControl = `${base * 60}+${increment}`;
      const tc = classifyTimeControl(timeControl);
      if (tc !== "blitz" && tc !== "rapid") { dropped.timeClass += 1; continue; }
      const san = field.moves.trim().split(/\s+/);
      accept({
        id: field.game_id,
        source: "lichess-datasnaek",
        url: `https://lichess.org/${field.game_id}`,
        date: new Date(Number(field.start_time)).toISOString().slice(0, 10),
        timeControl,
        tc,
        white: { id: field.white_id.toLowerCase(), rating: Number(field.white_rating) },
        black: { id: field.black_id.toLowerCase(), rating: Number(field.black_rating) },
        result: resultOf(field.winner, field.victory_status),
        status: field.victory_status,
        ply: san.length,
      }, san);
    }
  }

  // Stratified sample: per (time class, band of the players' mean rating), capped
  // per player so no individual dominates a band.
  const random = seededRandom(seed);
  const shuffled = pool.map((game) => ({ game, key: random() })).sort((a, b) => a.key - b.key).map(({ game }) => game);
  const perPlayerCount = new Map();
  const strata = new Map();
  const selected = [];
  for (const game of shuffled) {
    const band = bandLabel((game.white.rating + game.black.rating) / 2);
    if (!band) continue;
    const stratum = `${game.tc}|${band}`;
    if ((strata.get(stratum) ?? 0) >= perStratum) continue;
    if ([game.white.id, game.black.id].some((id) => (perPlayerCount.get(id) ?? 0) >= perPlayer)) continue;
    // Legality is checked only for games that would be selected (replaying all is slow).
    if (!replays(game.san.split(" "))) {
      dropped.illegal += 1;
      continue;
    }
    strata.set(stratum, (strata.get(stratum) ?? 0) + 1);
    for (const id of [game.white.id, game.black.id]) perPlayerCount.set(id, (perPlayerCount.get(id) ?? 0) + 1);
    selected.push({ ...game, band });
  }
  selected.sort((a, b) => a.id.localeCompare(b.id));

  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/games.jsonl`, selected.map((game) => JSON.stringify(game)).join("\n") + "\n");
  const summary = {
    seed,
    perStratum,
    perPlayerCap: perPlayer,
    gamesRead: read,
    eligible: pool.length,
    selected: selected.length,
    filters: Object.fromEntries(Object.entries(FILTERS).map(([key, description]) => [key, { description, dropped: dropped[key] }])),
    strata: Object.fromEntries([...strata.entries()].sort()),
    bySource: selected.reduce((acc, game) => ({ ...acc, [game.source]: (acc[game.source] ?? 0) + 1 }), {}),
  };
  writeFileSync(`${out}/FILTERS.json`, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
