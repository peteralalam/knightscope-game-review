import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { engineCacheName } from "../lib/engine-assets.ts";
import { ENGINE_BUILDS } from "../lib/review-config.ts";

test("the full engine's expected hash is compiled into the app, never fetched", () => {
  assert.match(ENGINE_BUILDS.full.wasmSha256, /^[0-9a-f]{64}$/);
  // The content-addressed URL carries the same pinned hash.
  assert.ok(ENGINE_BUILDS.full.wasmUrl.includes(ENGINE_BUILDS.full.wasmSha256.slice(0, 12)));
  const source = readFileSync("lib/engine-assets.ts", "utf8");
  assert.doesNotMatch(source, /\.sha256|sha256sum|integrity\.json/i, "no hash file may be fetched next to the binary");
});

test("the engine cache is versioned by engine, port, network and binary hash", () => {
  const full = ENGINE_BUILDS.full;
  const name = engineCacheName(full);
  for (const part of ["stockfish-19", "stockfish.js-19.0.0", "nn-1a298aa575a0", full.wasmSha256.slice(0, 16)]) {
    assert.ok(name.includes(part), `${name} should include ${part}`);
  }
  assert.notEqual(engineCacheName({ ...full, wasmSha256: "0".repeat(64) }), name);
  assert.notEqual(engineCacheName({ ...full, network: "nn-000000000000.nnue" }), name);
  assert.notEqual(engineCacheName({ ...full, port: "stockfish.js 20.0.0" }), name);
});

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry) ? [path] : [];
  });
}

test("client code has no network API that could carry game data", () => {
  const allowedFetches = new Map([
    ["lib/engine-assets.ts", 2], // HEAD status (unused by the UI) + the opt-in full-engine GET
    ["lib/stockfish-client.ts", 1], // the static Lite engine binary
  ]);
  for (const file of [...sourceFiles("app"), ...sourceFiles("lib")]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /sendBeacon|XMLHttpRequest|new WebSocket|EventSource|navigator\.sendBeacon/, file);
    const fetches = source.match(/\bfetch\(/g)?.length ?? 0;
    assert.equal(fetches, allowedFetches.get(file) ?? 0, `${file} has an unexpected fetch()`);
  }
  // The allowed fetches only ever request fixed engine URLs from the config.
  assert.match(readFileSync("lib/engine-assets.ts", "utf8"), /fetch\(FULL\.wasmUrl, \{ method: "HEAD" \}\)/);
  assert.match(readFileSync("lib/engine-assets.ts", "utf8"), /fetch\(FULL\.wasmUrl, \{ signal, cache: "no-store" \}\)/);
  assert.match(readFileSync("lib/stockfish-client.ts", "utf8"), /fetch\(ENGINE_BUILDS\.lite\.wasmUrl\)/);
});
