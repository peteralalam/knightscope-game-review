import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the KnightScope PGN review shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>KnightScope — Chess Game Review<\/title>/i);
  assert.match(html, /KnightScope/);
  assert.match(html, /Review this game/);
  assert.match(html, /PGN notation/);
  assert.match(html, /Stockfish 19/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships GPL Corresponding Source and pins every engine binary by hash", async () => {
  const { createHash } = await import("node:crypto");
  const { ENGINE_BUILDS } = await import("../lib/review-config.ts");
  const engineRoot = new URL("../public/stockfish/19.0.0/", import.meta.url);
  const lite = await readFile(new URL("stockfish-19-lite-single.wasm", engineRoot));
  assert.equal(createHash("sha256").update(lite).digest("hex"), ENGINE_BUILDS.lite.wasmSha256);
  // The full engine's loader is same-origin; its 99 MB wasm is not a static asset.
  await access(new URL("stockfish-19-single.js", engineRoot));
  await assert.rejects(access(new URL("stockfish-19-single.wasm", engineRoot)));
  const net = await readFile(new URL("source/nn-61e7af4bb97d.nnue", engineRoot));
  assert.ok(createHash("sha256").update(net).digest("hex").startsWith("61e7af4bb97d"));
  const archive = await stat(new URL("source/stockfish.js-19.0.0-source.tar.gz", engineRoot));
  assert.ok(archive.size > 100_000);
  const notice = await readFile(new URL("SOURCE.txt", engineRoot), "utf8");
  assert.match(notice, new RegExp(ENGINE_BUILDS.lite.portCommit));
  assert.match(notice, /Corresponding Source/);
});

test("ships the same-origin Stockfish lite worker and license", async () => {
  const engineRoot = new URL("../public/stockfish/19.0.0/", import.meta.url);
  const [worker, wasm, license, packageJson] = await Promise.all([
    readFile(new URL("stockfish-19-lite-single.js", engineRoot), "utf8"),
    stat(new URL("stockfish-19-lite-single.wasm", engineRoot)),
    readFile(new URL("COPYING.txt", engineRoot), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /Stockfish\.js 19/);
  // Well under Cloudflare Workers' 25 MiB per-asset limit.
  assert.ok(wasm.size > 1_000_000 && wasm.size < 25 * 1024 * 1024);
  assert.match(license, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(packageJson, /"chess\.js"/);
  assert.match(packageJson, /"stockfish"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", templateRoot)));
});
