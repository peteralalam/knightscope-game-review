/**
 * Browser engine pool: Stockfish 19 (stockfish.js WASM build) in Web Workers.
 *
 * The vendored build is served same-origin from /public (see
 * scripts/vendor-stockfish.mjs). Each worker is an independent single-threaded
 * engine; the analysis pipeline spreads deterministic chunks across them.
 */
import { ANALYSIS, ENGINE_BUILD } from "./review-config.ts";
import { UciEngine, type TransportFactory } from "./uci-engine.ts";

let wasmUrl: Promise<string> | null = null;

/**
 * Fetch the engine's wasm once and expose it as a Blob URL typed
 * application/wasm. stockfish.js 19 compiles with instantiateStreaming, which
 * rejects any other Content-Type, so this keeps the engine working behind
 * servers that label .wasm as application/octet-stream. All pool workers
 * share the one download.
 */
function engineWasmUrl() {
  wasmUrl ??= fetch(ENGINE_BUILD.publicPath.replace(/\.js$/, ".wasm"))
    .then(async (response) => {
      if (!response.ok) throw new Error(`Stockfish could not be downloaded (HTTP ${response.status}).`);
      const bytes = await response.arrayBuffer();
      return URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
    })
    .catch((error) => {
      wasmUrl = null;
      throw error;
    });
  return wasmUrl;
}

const workerTransport: TransportFactory = async ({ onLine, onFailure }) => {
  // stockfish.js reads the wasm location from the worker URL's hash.
  const worker = new Worker(`${ENGINE_BUILD.publicPath}#${encodeURIComponent(await engineWasmUrl())}`);
  worker.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    for (const line of event.data.split(/\r?\n/)) onLine(line);
  });
  worker.addEventListener("error", (event) => {
    event.preventDefault?.();
    onFailure(new Error("Stockfish stopped unexpectedly in this browser."));
  });
  return {
    send: (command) => worker.postMessage(command),
    terminate: () => worker.terminate(),
  };
};

/** Number of parallel engines for this device. */
export function recommendedEngineCount() {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  const memory = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  const byMemory = memory !== undefined && memory <= 2 ? 1 : ANALYSIS.maxWorkers;
  return Math.max(1, Math.min(ANALYSIS.maxWorkers, cores - 1, byMemory));
}

export function createEnginePool(count = recommendedEngineCount()) {
  return Array.from(
    { length: count },
    () =>
      new UciEngine(workerTransport, {
        hashMb: ENGINE_BUILD.hashMb,
        searchTimeoutMs: ANALYSIS.searchTimeoutMs,
        buildLabel: "stockfish.js 19.0.0 lite-single",
        log: (message) => console.info(`[KnightScope engine] ${message}`),
      }),
  );
}
