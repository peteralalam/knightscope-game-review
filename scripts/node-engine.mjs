// Node transport for the same UciEngine used in the browser (tests, calibration).
import { createRequire } from "node:module";
import initStockfish from "stockfish";
import { UciEngine } from "../lib/uci-engine.ts";
import { ANALYSIS, ENGINE_BUILD } from "../lib/review-config.ts";

const require = createRequire(import.meta.url);

// The stockfish.js module replaces its own `module.exports` on first use, so a
// cached copy cannot start a second engine. Drop it from the cache each time.
function forgetEngineModule() {
  for (const key of Object.keys(require.cache)) {
    if (/stockfish[\\/]bin[\\/]stockfish-.*\.js$/.test(key)) delete require.cache[key];
  }
}

export function createNodeEngine({ flavour = "lite-single", hashMb = ENGINE_BUILD.hashMb, log } = {}) {
  return new UciEngine(
    async ({ onLine }) => {
      forgetEngineModule();
      const engine = await initStockfish(flavour);
      engine.listener = (line) => onLine(line);
      return {
        send: (command) => engine.sendCommand(command),
        terminate: () => engine.terminate?.(),
      };
    },
    { hashMb, searchTimeoutMs: ANALYSIS.searchTimeoutMs, buildLabel: `stockfish.js npm ${flavour}`, log },
  );
}

export function createNodeEnginePool(count, options) {
  return Array.from({ length: count }, () => createNodeEngine(options));
}
