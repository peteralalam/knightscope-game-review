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

/**
 * Native build of the same vendored stockfish.js 19.0.0 source and Lite net
 * (see scripts/corpus/build-native-engine.sh). Node-limited single-thread
 * searches reproduce the WASM Lite engine exactly (checked by
 * scripts/corpus/native-parity.mjs) at several times the speed, so corpus
 * runs use it; the browser never does.
 */
export function createNativeEngine({ binary = process.env.KS_NATIVE_ENGINE, hashMb = ENGINE_BUILD.hashMb, log } = {}) {
  if (!binary) throw new Error("Set KS_NATIVE_ENGINE to the native Stockfish binary.");
  return new UciEngine(
    async ({ onLine, onFailure }) => {
      const { spawn } = await import("node:child_process");
      const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, newline).trimEnd());
          buffer = buffer.slice(newline + 1);
        }
      });
      child.on("exit", (code) => onFailure(new Error(`native engine exited (${code})`)));
      return {
        send: (command) => child.stdin.write(`${command}\n`),
        terminate: () => child.kill(),
      };
    },
    { hashMb, searchTimeoutMs: ANALYSIS.searchTimeoutMs, buildLabel: "native lite (corpus)", log },
  );
}
