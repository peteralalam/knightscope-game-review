// Streaming, stratified, reproducible sampler for the official Lichess Standard
// Rated Games database (https://database.lichess.org/, CC0).
//
//   curl -sL https://database.lichess.org/standard/lichess_db_standard_rated_2026-08.pgn.zst \
//     | node scripts/corpus/sample-lichess-db.mjs --file - --month 2026-08 --seed 20260925 \
//         --per-stratum 3000 --scan 30000000 --out data/rating-corpus-v2
//
// Nothing is written to disk except the sample: the .pgn.zst is decompressed
// as a stream (node:zlib zstd) and parsed game by game. The scan stops once
// `--scan` games have been read, which closes the pipe and stops the download.
//
// Sampling design (all of it recorded in MANIFEST.json):
//   * strata = time class (blitz, rapid) × rating band of the players' mean
//     rating (800–999 … 2400+), so the common 1400–1900 population cannot
//     dominate training;
//   * inside a stratum, a uniform random sample of the scanned games by
//     bottom-k on a seeded hash of the game id – reproducible from
//     (month, seed, scan length) and independent of stream timing;
//   * at most `--per-player` games per player over the whole sample (greedy in
//     priority order), so no player's style is over-represented;
//   * separately, a bottom-k sample of games carrying Lichess server `%eval`
//     annotations (outcome-model sensitivity check, no engine work needed).
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { createInterface } from "node:readline";
import { classifyTimeControl } from "../../lib/rating-model.ts";

export const BANDS = [
  [800, 1000], [1000, 1200], [1200, 1400], [1400, 1600], [1600, 1800],
  [1800, 2000], [2000, 2200], [2200, 2400], [2400, 3400],
];
export const bandLabel = (rating) => {
  const band = BANDS.find(([low, high]) => rating >= low && rating < high);
  return band ? (band[1] > 3000 ? `${band[0]}+` : `${band[0]}–${band[1] - 1}`) : null;
};

export const FILTERS = {
  notRated: "casual game or not a standard rated game",
  variant: "variant or custom start position (FEN / SetUp tag)",
  bot: "a BOT account played",
  missingRating: "missing or '?' rating",
  provisional:
    "provisional rating: the database has no provisional flag, so a rating change of more than 35 points in the game (|RatingDiff| > 35; established players move ≈ 3–20) is used as the proxy",
  termination: "abandoned, rules infraction (cheat detection) or unterminated game",
  timeClass: "time class other than blitz / rapid",
  tooShort: "fewer than 12 plies",
  tooLong: "more than 240 plies (the reviewer's limit)",
  ratingRange: "mean rating outside 800–3400 or a player below 600",
};

/** 53-bit seeded hash of a string (two 32-bit murmur-style mixes). */
export function priority(seed, text) {
  const mix = (h) => {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  };
  let a = seed ^ 0x9e3779b9;
  let b = seed ^ 0x7f4a7c15;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995) + i;
  }
  return (mix(a) * 2 ** 21 + (mix(b) >>> 11)) / 2 ** 53;
}

/** Keeps the k smallest-priority items (a max-heap on priority). */
export class BottomK {
  constructor(k) {
    this.k = k;
    this.heap = [];
  }

  get threshold() {
    return this.heap.length < this.k ? Infinity : this.heap[0].p;
  }

  offer(item) {
    if (this.k <= 0 || item.p >= this.threshold) return;
    const heap = this.heap;
    if (heap.length < this.k) {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].p >= heap[i].p) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
      return;
    }
    heap[0] = item;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let largest = i;
      if (left < heap.length && heap[left].p > heap[largest].p) largest = left;
      if (right < heap.length && heap[right].p > heap[largest].p) largest = right;
      if (largest === i) break;
      [heap[largest], heap[i]] = [heap[i], heap[largest]];
      i = largest;
    }
  }

  sorted() {
    return [...this.heap].sort((x, y) => x.p - y.p);
  }
}

const RESULTS = new Set(["1-0", "0-1", "1/2-1/2"]);

/** Parse the movetext of a Lichess DB game into SAN moves and optional per-ply evals. */
export function parseMovetext(text) {
  const san = [];
  const evals = [];
  let evalCount = 0;
  // Comments carry [%eval …] / [%clk …]; everything else is move numbers, SAN and the result.
  const tokens = text.match(/\{[^}]*\}|[^\s{}]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("{")) {
      const match = token.match(/\[%eval (#?-?[\d.]+)\]/);
      if (match && san.length) {
        evals[san.length - 1] = match[1].startsWith("#") ? `#${match[1].slice(1)}` : Math.round(Number(match[1]) * 100);
        evalCount += 1;
      }
      continue;
    }
    if (/^\d+\.(\.\.)?$/.test(token) || /^\d+\.\.\.$/.test(token) || RESULTS.has(token) || token === "*") continue;
    const cleaned = token.replace(/^\d+\.+/, "").replace(/[?!]+$/, "");
    if (cleaned) san.push(cleaned);
  }
  return { san, evals: evalCount ? Array.from({ length: san.length }, (_, i) => evals[i] ?? null) : null };
}

/** Headers + movetext → corpus record, or the name of the filter that rejected it. */
export function toRecord(headers, movetext, month) {
  if (!/^Rated\b/.test(headers.Event ?? "")) return "notRated";
  if (headers.Variant && headers.Variant !== "Standard") return "variant";
  if (headers.FEN || headers.SetUp === "1") return "variant";
  if (headers.WhiteTitle === "BOT" || headers.BlackTitle === "BOT") return "bot";
  const white = Number(headers.WhiteElo);
  const black = Number(headers.BlackElo);
  if (!Number.isFinite(white) || !Number.isFinite(black) || !headers.White || !headers.Black) return "missingRating";
  const whiteDiff = Math.abs(Number(headers.WhiteRatingDiff ?? 0));
  const blackDiff = Math.abs(Number(headers.BlackRatingDiff ?? 0));
  if (whiteDiff > 35 || blackDiff > 35) return "provisional";
  if (!["Normal", "Time forfeit"].includes(headers.Termination ?? "")) return "termination";
  if (!RESULTS.has(headers.Result)) return "termination";
  const tc = classifyTimeControl(headers.TimeControl);
  if (tc !== "blitz" && tc !== "rapid") return "timeClass";
  const mean = (white + black) / 2;
  if (!bandLabel(mean) || Math.min(white, black) < 600) return "ratingRange";
  const { san, evals } = parseMovetext(movetext);
  if (san.length < 12) return "tooShort";
  if (san.length > 240) return "tooLong";
  const id = (headers.Site ?? "").split("/").pop();
  return {
    id,
    source: `lichess-db-${month}`,
    url: headers.Site,
    date: (headers.UTCDate ?? headers.Date ?? "").replaceAll(".", "-"),
    timeControl: headers.TimeControl,
    tc,
    termination: headers.Termination,
    white: { id: headers.White.toLowerCase(), rating: white },
    black: { id: headers.Black.toLowerCase(), rating: black },
    result: headers.Result,
    ply: san.length,
    san: san.join(" "),
    band: bandLabel(mean),
    ...(evals ? { evals } : {}),
  };
}

/** Async iterator over { headers, movetext } from a PGN line stream. */
export async function* pgnGames(lines) {
  let headers = {};
  let movetext = [];
  let inMoves = false;
  for await (const line of lines) {
    if (line.startsWith("[")) {
      if (inMoves) {
        yield { headers, movetext: movetext.join(" ") };
        headers = {};
        movetext = [];
        inMoves = false;
      }
      const match = line.match(/^\[(\w+) "(.*)"\]$/);
      if (match) headers[match[1]] = match[2];
    } else if (line.trim()) {
      inMoves = true;
      movetext.push(line);
    }
  }
  if (inMoves) yield { headers, movetext: movetext.join(" ") };
}

/**
 * Stratified bottom-k sample with a per-player cap.
 * Returns { games, evalGames, stats } – deterministic for (stream, seed, options).
 */
export async function sampleStream(lines, { month, seed, perStratum, perPlayer = 2, evalPerStratum = 0, scan = Infinity, log }) {
  const oversample = 3;
  const strata = new Map();
  const evalStrata = new Map();
  const dropped = Object.fromEntries(Object.keys(FILTERS).map((key) => [key, 0]));
  let read = 0;
  let eligible = 0;
  for await (const { headers, movetext } of pgnGames(lines)) {
    read += 1;
    if (read > scan) break;
    // Cheap pre-filters before parsing moves (most games are rejected here).
    const record = toRecord(headers, movetext, month);
    if (typeof record === "string") {
      dropped[record] += 1;
    } else {
      eligible += 1;
      const key = `${record.tc}|${record.band}`;
      const p = priority(seed, record.id);
      if (!strata.has(key)) strata.set(key, new BottomK(perStratum * oversample));
      const { evals, ...plain } = record;
      strata.get(key).offer({ p, record: plain });
      if (evals && evalPerStratum > 0) {
        if (!evalStrata.has(key)) evalStrata.set(key, new BottomK(evalPerStratum));
        evalStrata.get(key).offer({ p: priority(seed ^ 0x5eed, record.id), record });
      }
    }
    if (log && read % 1_000_000 === 0) log(`${read.toLocaleString()} games read, ${eligible.toLocaleString()} eligible`);
  }
  // Per-player cap, applied globally in priority order so it is reproducible.
  const perPlayerCount = new Map();
  const games = [];
  const strataStats = {};
  const candidates = [...strata.entries()].flatMap(([key, heap]) => heap.sorted().map((item) => ({ ...item, key })));
  candidates.sort((x, y) => x.p - y.p);
  const taken = new Map();
  let cappedOut = 0;
  for (const { record, key } of candidates) {
    if ((taken.get(key) ?? 0) >= perStratum) continue;
    const players = [record.white.id, record.black.id];
    if (players.some((player) => (perPlayerCount.get(player) ?? 0) >= perPlayer)) {
      cappedOut += 1;
      continue;
    }
    for (const player of players) perPlayerCount.set(player, (perPlayerCount.get(player) ?? 0) + 1);
    taken.set(key, (taken.get(key) ?? 0) + 1);
    games.push(record);
  }
  for (const [key, heap] of strata) {
    strataStats[key] = { eligibleSeen: heap.heap.length, selected: taken.get(key) ?? 0 };
  }
  // Eval games: kept separate, must not share players with the main sample (so
  // they can never leak test players into a model fitted on them).
  const evalGames = [...evalStrata.values()]
    .flatMap((heap) => heap.sorted().map((item) => item.record))
    .filter((record) => !perPlayerCount.has(record.white.id) && !perPlayerCount.has(record.black.id));
  games.sort((x, y) => (x.id < y.id ? -1 : 1));
  evalGames.sort((x, y) => (x.id < y.id ? -1 : 1));
  return { games, evalGames, stats: { read: Math.min(read, scan), eligible, dropped, cappedOut, strata: strataStats } };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const file = argument("file", "-");
  const month = argument("month");
  if (!month) throw new Error("--month YYYY-MM is required (it is recorded in the manifest).");
  const seed = Number(argument("seed", "20260925"));
  const perStratum = Number(argument("per-stratum", "3000"));
  const perPlayer = Number(argument("per-player", "2"));
  const evalPerStratum = Number(argument("eval-per-stratum", "0"));
  const scan = Number(argument("scan", "Infinity"));
  const out = argument("out", "data/rating-corpus-v2");
  const compressed = file === "-" ? process.stdin : createReadStream(file);
  const input = file.endsWith(".pgn") ? compressed : compressed.pipe(createZstdDecompress());
  const lines = createInterface({ input, crlfDelay: Infinity });
  const started = Date.now();
  const { games, evalGames, stats } = await sampleStream(lines, {
    month,
    seed,
    perStratum,
    perPlayer,
    evalPerStratum,
    scan,
    log: (message) => console.error(`[sample] ${message} (${((Date.now() - started) / 1000).toFixed(0)} s)`),
  });
  lines.close();
  input.destroy();
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/games.jsonl`, games.map((game) => JSON.stringify(game)).join("\n") + "\n");
  if (evalPerStratum > 0) writeFileSync(`${out}/eval-games.jsonl`, evalGames.map((game) => JSON.stringify(game)).join("\n") + "\n");
  const manifest = {
    source: `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`,
    license: "CC0 (Lichess open database)",
    month,
    seed,
    scanLimit: Number.isFinite(scan) ? scan : null,
    perStratum,
    perPlayerCap: perPlayer,
    evalPerStratum,
    strata: "time class (blitz | rapid) × band of the two players' mean rating",
    bands: BANDS.map(([low, high]) => bandLabel(low)).filter(Boolean),
    selection: "bottom-k on a seeded 53-bit hash of the game id inside each stratum (uniform over the scanned games), then a global per-player cap in hash order",
    filters: Object.fromEntries(Object.entries(FILTERS).map(([key, description]) => [key, { description, dropped: stats.dropped[key] }])),
    gamesRead: stats.read,
    eligible: stats.eligible,
    droppedByPlayerCap: stats.cappedOut,
    selected: games.length,
    playerGames: games.length * 2,
    evalGames: evalGames.length,
    strataCounts: stats.strata,
    createdWith: "scripts/corpus/sample-lichess-db.mjs",
  };
  writeFileSync(`${out}/MANIFEST.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`[sample] ${games.length} games (${games.length * 2} player-games), ${evalGames.length} eval games → ${out}`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
