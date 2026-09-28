/**
 * Browser engine pool: Stockfish 19 (stockfish.js WASM builds) in Web Workers.
 *
 * Lite (default): the 1.8 MB lite-single build served same-origin from /public.
 * Full (opt-in): the ~99 MB single-threaded build with the official network,
 *   loaded from the verified local cache (see engine-assets.ts).
 *
 * Each worker is an independent single-threaded engine; the analysis pipeline
 * spreads deterministic chunks across them. Multi-threaded builds are not used:
 * they need cross-origin isolation (COOP/COEP → SharedArrayBuffer) and their
 * parallel search is non-deterministic, while game review already
 * parallelizes across positions.
 */
import { fullEngineBlobUrl } from "./engine-assets.ts";
import { ANALYSIS, ENGINE_BUILD, ENGINE_BUILDS, type EngineBuildKey } from "./review-config.ts";
import { UciEngine, type TransportFactory } from "./uci-engine.ts";

const wasmUrls: Partial<Record<EngineBuildKey, Promise<string>>> = {};

/**
 * The engine's wasm as a Blob URL typed application/wasm. stockfish.js 19
 * compiles with instantiateStreaming, which rejects any other Content-Type, so
 * this keeps the engine working behind servers that label .wasm as
 * application/octet-stream. All pool workers share the one download.
 */
function engineWasmUrl(build: EngineBuildKey) {
  wasmUrls[build] ??= (async () => {
    if (build === "full") {
      const url = await fullEngineBlobUrl();
      if (!url) throw new Error("The full engine is not downloaded yet.");
      return url;
    }
    const response = await fetch(ENGINE_BUILDS.lite.wasmUrl);
    if (!response.ok) throw new Error(`Stockfish could not be downloaded (HTTP ${response.status}).`);
    const bytes = await response.arrayBuffer();
    return URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
  })().catch((error) => {
    delete wasmUrls[build];
    throw error;
  });
  return wasmUrls[build]!;
}

function workerTransport(build: EngineBuildKey): TransportFactory {
  return async ({ onLine, onFailure }) => {
    // stockfish.js reads the wasm location from the worker URL's hash.
    const worker = new Worker(`${ENGINE_BUILDS[build].loaderPath}#${encodeURIComponent(await engineWasmUrl(build))}`);
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
}

/** Number of parallel engines for this device and build. */
export function recommendedEngineCount(build: EngineBuildKey = "lite") {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  const memory = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  const byMemory = memory !== undefined && memory <= 2 ? 1 : ENGINE_BUILDS[build].maxWorkers;
  return Math.max(1, Math.min(ANALYSIS.maxWorkers, ENGINE_BUILDS[build].maxWorkers, cores - 1, byMemory));
}

export function createEnginePool(count?: number, build: EngineBuildKey = "lite") {
  return Array.from(
    { length: count ?? recommendedEngineCount(build) },
    () =>
      new UciEngine(workerTransport(build), {
        hashMb: ENGINE_BUILD.hashMb,
        searchTimeoutMs: ANALYSIS.searchTimeoutMs,
        buildLabel: `${ENGINE_BUILDS[build].port} ${ENGINE_BUILDS[build].build.split(" ")[0]}`,
        log: (message) => console.info(`[KnightScope engine] ${message}`),
      }),
  );
}
