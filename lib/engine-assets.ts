/**
 * Optional full-network engine: one-time, opt-in download, cached locally.
 *
 * - Nothing is fetched unless the user asks (or has already downloaded it).
 * - The download is a plain GET of a static, content-addressed file; no game
 *   data is ever sent anywhere. Analysis stays in this browser's Web Workers.
 * - The bytes are verified against the SHA-256 pinned in ENGINE_BUILDS – i.e.
 *   compiled into this application's own JavaScript – before they are cached,
 *   and again every time they are loaded from the cache. No hash is ever
 *   fetched from the asset host: a hash stored next to the binary could be
 *   replaced together with it, and would then only detect accidental corruption.
 *   The trust root is the deployed application itself.
 * - Cache Storage (not a service worker) keeps the file across visits; it is
 *   readable from the page, needs no extra headers and survives reloads.
 */
import { ENGINE_BUILDS } from "./review-config.ts";

const FULL = ENGINE_BUILDS.full;
const CACHE_PREFIX = "knightscope-engine";

/**
 * Versioned by engine, port, network and binary hash, so an engine upgrade can
 * never be served an older cached binary (and the old one is pruned).
 */
export function engineCacheName(build: { engine: string; port: string; network: string; wasmSha256: string } = FULL) {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
  return [CACHE_PREFIX, slug(build.engine), slug(build.port), slug(build.network.split(" ")[0]), build.wasmSha256.slice(0, 16)].join(":");
}

const CACHE_NAME = engineCacheName();

/** Drop engine caches written by any other build. */
async function pruneStaleCaches() {
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
  } catch {
    // Pruning is best-effort.
  }
}

export type FullEngineStatus =
  | { state: "ready" }
  | { state: "downloadable"; bytes: number }
  | { state: "unavailable"; reason: string };

function cacheAvailable() {
  return typeof caches !== "undefined" && typeof crypto !== "undefined" && Boolean(crypto.subtle);
}

async function sha256Hex(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cachedBytes() {
  if (!cacheAvailable()) return null;
  const cache = await caches.open(CACHE_NAME);
  const response = await cache.match(FULL.wasmUrl);
  if (!response) return null;
  const buffer = await response.arrayBuffer();
  if ((await sha256Hex(buffer)) !== FULL.wasmSha256) {
    await cache.delete(FULL.wasmUrl);
    return null;
  }
  return buffer;
}

/** Local-only check (no network request): is a verified copy already cached? */
export async function isFullEngineCached() {
  if (!cacheAvailable()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return Boolean(await cache.match(FULL.wasmUrl));
  } catch {
    return false;
  }
}

/** Is the full engine cached, downloadable from this deployment, or unavailable? */
export async function fullEngineStatus(): Promise<FullEngineStatus> {
  if (!cacheAvailable()) return { state: "unavailable", reason: "This browser does not offer Cache Storage / Web Crypto." };
  if (typeof WebAssembly === "undefined") return { state: "unavailable", reason: "WebAssembly is not supported." };
  const cache = await caches.open(CACHE_NAME);
  if (await cache.match(FULL.wasmUrl)) return { state: "ready" };
  try {
    const response = await fetch(FULL.wasmUrl, { method: "HEAD" });
    if (!response.ok) return { state: "unavailable", reason: "This deployment does not host the full engine." };
    return { state: "downloadable", bytes: Number(response.headers.get("content-length")) || FULL.wasmBytes };
  } catch {
    return { state: "unavailable", reason: "The full engine could not be reached." };
  }
}

/** Download, verify and cache the full engine. Reports progress in [0, 1]. */
export async function downloadFullEngine(onProgress?: (fraction: number) => void, signal?: AbortSignal) {
  if (!cacheAvailable()) throw new Error("This browser cannot cache the full engine.");
  const response = await fetch(FULL.wasmUrl, { signal, cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`Full engine download failed (HTTP ${response.status}).`);
  const total = Number(response.headers.get("content-length")) || FULL.wasmBytes;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    onProgress?.(Math.min(1, received / total));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const hash = await sha256Hex(bytes.buffer);
  if (hash !== FULL.wasmSha256) {
    throw new Error("The downloaded engine failed its integrity check and was discarded.");
  }
  await pruneStaleCaches();
  const cache = await caches.open(CACHE_NAME);
  await cache.put(
    FULL.wasmUrl,
    new Response(new Blob([bytes], { type: "application/wasm" }), {
      headers: { "content-type": "application/wasm", "x-knightscope-sha256": hash },
    }),
  );
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is best-effort.
  }
}

/** Blob URL for the verified cached full engine, or null when it is not cached. */
export async function fullEngineBlobUrl() {
  const buffer = await cachedBytes();
  return buffer ? URL.createObjectURL(new Blob([buffer], { type: "application/wasm" })) : null;
}

export async function deleteFullEngine() {
  if (!cacheAvailable()) return;
  await pruneStaleCaches();
  await caches.delete(CACHE_NAME);
}
