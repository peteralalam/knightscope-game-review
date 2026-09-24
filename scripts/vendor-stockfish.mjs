// Vendor the stockfish.js builds this app uses and their GPL source.
//
//   node scripts/vendor-stockfish.mjs [--source /path/to/stockfish.js checkout at v19.0.0]
//
// * public/stockfish/<version>/  – same-origin files served as static assets:
//     stockfish-19-lite-single.{js,wasm}  Lite engine (default, 1.8 MB)
//     stockfish-19-single.js              loader for the optional full engine
//     COPYING.txt, SOURCE.txt, source/    GPLv3 notice and Corresponding Source
// * .engine-assets/                     – the full engine's ~99 MB wasm, above the
//     25 MiB static-asset limit. Upload it to the R2 bucket bound as
//     ENGINE_ASSETS under the content-addressed key printed below.
//
// SHA-256 hashes are checked against ENGINE_BUILDS in lib/review-config.ts.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ENGINE_BUILDS } from "../lib/review-config.ts";

const pkg = JSON.parse(readFileSync(new URL("../node_modules/stockfish/package.json", import.meta.url), "utf8"));
const major = pkg.buildVersion;
const bin = (name) => new URL(`../node_modules/stockfish/bin/${name}`, import.meta.url);
const target = new URL(`../public/stockfish/${pkg.version}/`, import.meta.url);
const sha256 = (url) => createHash("sha256").update(readFileSync(url)).digest("hex");
mkdirSync(new URL("source/", target), { recursive: true });

for (const [key, build] of Object.entries(ENGINE_BUILDS)) {
  const flavour = build.loaderPath.match(/stockfish-\d+-(.+)\.js$/)[1];
  const wasm = bin(`stockfish-${major}-${flavour}.wasm`);
  if (sha256(wasm) !== build.wasmSha256) throw new Error(`${key}: wasm hash differs from ENGINE_BUILDS – update lib/review-config.ts deliberately`);
  copyFileSync(bin(`stockfish-${major}-${flavour}.js`), new URL(`stockfish-${major}-${flavour}.js`, target));
  if (build.wasmUrl.startsWith("/stockfish/")) {
    copyFileSync(wasm, new URL(`stockfish-${major}-${flavour}.wasm`, target));
  } else {
    const outDir = new URL("../.engine-assets/", import.meta.url);
    mkdirSync(outDir, { recursive: true });
    const name = build.wasmUrl.split("/").pop();
    copyFileSync(wasm, new URL(name, outDir));
    console.log(`${key}: upload .engine-assets/${name} to R2 key ${build.wasmUrl.slice(1)} (content-type application/wasm)`);
  }
}
copyFileSync(new URL("../node_modules/stockfish/Copying.txt", import.meta.url), new URL("COPYING.txt", target));

// Corresponding Source: the stockfish.js tree at the tag the npm package was
// published from, plus the Lite network embedded in the Lite binary.
const source = process.argv.includes("--source") ? process.argv[process.argv.indexOf("--source") + 1] : null;
if (source) {
  execFileSync("git", ["-C", source, "archive", "--format=tar.gz", `--prefix=stockfish.js-${pkg.version}/`, "-o",
    new URL(`source/stockfish.js-${pkg.version}-source.tar.gz`, target).pathname, "HEAD"]);
}
const liteNet = ENGINE_BUILDS.lite.network.split(" ")[0];
if (!existsSync(new URL(`source/${liteNet}`, target))) {
  execFileSync(process.execPath, [new URL("extract-embedded-net.mjs", import.meta.url).pathname,
    new URL(`stockfish-${major}-lite-single.wasm`, target).pathname, liteNet, new URL(`source/${liteNet}`, target).pathname]);
}

writeFileSync(
  new URL("SOURCE.txt", target),
  `Stockfish.js ${pkg.version} – WebAssembly builds of Stockfish ${major}
============================================================

Engine        Stockfish ${major} (official-stockfish/Stockfish, tag sf_${major}), GPLv3
Port          stockfish.js ${pkg.version} by Nathan Rugg / Chess.com, GPLv3
              npm: stockfish@${pkg.version}
              git: https://github.com/nmrugg/stockfish.js tag v${pkg.version}
                   = commit ${ENGINE_BUILDS.lite.portCommit}
Changes vs sf_${major}  Emscripten support only in search/uci/position/thread
              (cooperative yield, no filesystem, Syzygy compiled out); the Lite
              flavour additionally uses a reduced NNUE architecture (P_hm features).
Toolchain     emscripten 3.1.7, -msimd128, --closure 1, INITIAL_MEMORY 128 MB,
              MAXIMUM_MEMORY 2 GB, MODULARIZE, ENVIRONMENT=web,worker,node

Files
  stockfish-${major}-lite-single.{js,wasm}  ${ENGINE_BUILDS.lite.build}
      network ${ENGINE_BUILDS.lite.network}
      wasm sha256 ${ENGINE_BUILDS.lite.wasmSha256}
  stockfish-${major}-single.js             loader for the optional full engine
      network ${ENGINE_BUILDS.full.network}
      wasm sha256 ${ENGINE_BUILDS.full.wasmSha256}
      wasm served from ${ENGINE_BUILDS.full.wasmUrl} (R2), only on user request

Corresponding Source (GPLv3 section 6)
  source/stockfish.js-${pkg.version}-source.tar.gz   complete source + build scripts
      (build: ./build.js --single-threaded --lite --no-split, and ./build.js --single-threaded --no-split)
  source/${liteNet}                         network embedded in the Lite binary
  The official network ${ENGINE_BUILDS.full.network.split(" ")[0]} is embedded in the full binary
  and is published by the Stockfish project (https://tests.stockfishchess.org/nns).

License: GNU General Public License v3 – see COPYING.txt.
`,
);
console.log(`vendored stockfish ${pkg.version} → public/stockfish/${pkg.version}/`);
