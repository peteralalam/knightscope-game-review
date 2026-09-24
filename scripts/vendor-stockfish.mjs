// Copy the chosen stockfish.js flavour from node_modules into public/ so it is
// served same-origin (Web Workers cannot load cross-origin scripts).
//
//   node scripts/vendor-stockfish.mjs            # lite-single (default)
//
// The full-strength single-threaded build (official Stockfish 19 NNUE,
// ~99 MB wasm) exceeds Cloudflare Workers' 25 MiB static-asset limit, so the
// lite build is the one this deployment ships.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const flavour = process.argv[2] ?? "lite-single";
const pkg = JSON.parse(readFileSync(new URL("../node_modules/stockfish/package.json", import.meta.url), "utf8"));
const major = pkg.buildVersion;
const target = new URL(`../public/stockfish/${pkg.version}/`, import.meta.url);
mkdirSync(target, { recursive: true });
for (const ext of ["js", "wasm"]) {
  copyFileSync(
    new URL(`../node_modules/stockfish/bin/stockfish-${major}-${flavour}.${ext}`, import.meta.url),
    new URL(`stockfish-${major}-${flavour}.${ext}`, target),
  );
}
copyFileSync(new URL("../node_modules/stockfish/Copying.txt", import.meta.url), new URL("COPYING.txt", target));
writeFileSync(
  new URL("SOURCE.txt", target),
  `Stockfish.js ${pkg.version} (${flavour} WASM build)\n\n` +
    `Built from official Stockfish ${major} (https://github.com/official-stockfish/Stockfish, tag sf_${major})\n` +
    `by the stockfish.js project: https://github.com/nmrugg/stockfish.js/tree/v${pkg.version}\n` +
    `npm package: stockfish@${pkg.version}\n\n` +
    `License: GNU General Public License v3. See COPYING.txt in this directory.\n`,
);
console.log(`vendored stockfish ${pkg.version} ${flavour} → public/stockfish/${pkg.version}/`);
