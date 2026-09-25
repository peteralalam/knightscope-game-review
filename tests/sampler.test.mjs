import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { parseMovetext, priority, toRecord } from "../scripts/corpus/sample-lichess-db.mjs";

function game(i, { white = 1500, black = 1500, tc = "180+0", event = "Rated Blitz game", diff = 6, termination = "Normal", evals = false, whiteName, blackName } = {}) {
  const moves = evals
    ? "1. e4 { [%eval 0.18] [%clk 0:03:00] } 1... e5 { [%eval 0.2] } 2. Nf3 { [%eval #3] } 2... Nc6 { [%eval -0.1] } 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 1-0"
    : "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 1-0";
  return `[Event "${event}"]
[Site "https://lichess.org/g${String(i).padStart(7, "0")}"]
[White "${whiteName ?? `w${i}`}"]
[Black "${blackName ?? `b${i}`}"]
[Result "1-0"]
[UTCDate "2026.08.01"]
[WhiteElo "${white}"]
[BlackElo "${black}"]
[WhiteRatingDiff "+${diff}"]
[BlackRatingDiff "-${diff}"]
[TimeControl "${tc}"]
[Termination "${termination}"]

${moves}

`;
}

test("movetext parsing keeps SAN and per-ply evals", () => {
  const { san, evals } = parseMovetext("1. e4 { [%eval 0.18] [%clk 0:03:00] } 1... e5 2. Qh5?! { [%eval #-2] } Nc6 1-0");
  assert.deepEqual(san, ["e4", "e5", "Qh5", "Nc6"]);
  assert.deepEqual(evals, [18, null, "#-2", null]);
});

test("filters: casual, bots, provisional, abandoned, bullet", () => {
  const parse = (text) => {
    const [head, moves] = text.split("\n\n");
    const headers = Object.fromEntries([...head.matchAll(/\[(\w+) "(.*)"\]/g)].map((m) => [m[1], m[2]]));
    return toRecord(headers, moves, "2026-08");
  };
  assert.equal(parse(game(1, { event: "Casual Blitz game" })), "notRated");
  assert.equal(parse(game(1, { diff: 120 })), "provisional");
  assert.equal(parse(game(1, { termination: "Abandoned" })), "termination");
  assert.equal(parse(game(1, { tc: "60+0" })), "timeClass");
  assert.equal(parse(game(1, { white: 700, black: 750 })), "ratingRange");
  const record = parse(game(1, { white: 2450, black: 2390, tc: "600+5" }));
  assert.equal(record.tc, "rapid");
  assert.equal(record.band, "2400+");
});

test("the seeded priority is deterministic and roughly uniform", () => {
  assert.equal(priority(7, "abc"), priority(7, "abc"));
  assert.notEqual(priority(7, "abc"), priority(8, "abc"));
  const values = Array.from({ length: 20000 }, (_, i) => priority(1, `game${i}`));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean}`);
  assert.ok(values.every((v) => v >= 0 && v < 1));
});

test("streams a .pgn.zst: stratified quotas, per-player cap, reproducible", () => {
  const dir = mkdtempSync(join(tmpdir(), "ks-sampler-"));
  const pgn = [];
  for (let i = 0; i < 600; i += 1) {
    // A common 1500 blitz population, a rare 2400+ rapid one, and one prolific player.
    if (i % 10 === 0) pgn.push(game(i, { white: 2500, black: 2450, tc: "600+0", evals: i % 20 === 0 }));
    else if (i % 7 === 0) pgn.push(game(i, { whiteName: "prolific" }));
    else pgn.push(game(i, { evals: i % 3 === 0 }));
  }
  writeFileSync(join(dir, "db.pgn.zst"), zstdCompressSync(Buffer.from(pgn.join(""))));
  const run = (out) => {
    execFileSync(process.execPath, [
      "scripts/corpus/sample-lichess-db.mjs", "--file", join(dir, "db.pgn.zst"), "--month", "2026-08",
      "--seed", "11", "--per-stratum", "40", "--per-player", "2", "--eval-per-stratum", "10", "--out", join(dir, out),
    ], { stdio: "pipe" });
    return {
      games: readFileSync(join(dir, out, "games.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
      manifest: JSON.parse(readFileSync(join(dir, out, "MANIFEST.json"), "utf8")),
    };
  };
  const first = run("a");
  const second = run("b");
  assert.deepEqual(first.games.map((g) => g.id), second.games.map((g) => g.id), "same seed → same sample");
  const byStratum = {};
  for (const g of first.games) byStratum[`${g.tc}|${g.band}`] = (byStratum[`${g.tc}|${g.band}`] ?? 0) + 1;
  assert.equal(byStratum["rapid|2400+"], 40);
  assert.equal(byStratum["blitz|1400–1599"], 40, "the common stratum is capped at its quota");
  assert.ok(first.games.filter((g) => g.white.id === "prolific").length <= 2, "per-player cap");
  assert.equal(first.manifest.month, "2026-08");
  assert.equal(first.manifest.seed, 11);
  assert.equal(first.manifest.gamesRead, 600);
});
