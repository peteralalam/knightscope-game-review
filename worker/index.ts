/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

/** Minimal R2 surface used to serve large engine files (see serveEngineAsset). */
interface EngineAssetBucket {
  get(key: string): Promise<{ body: ReadableStream; size: number; httpEtag: string } | null>;
  head(key: string): Promise<{ size: number; httpEtag: string } | null>;
}

interface Env {
  ASSETS: Fetcher;
  /** Optional R2 bucket holding engine files above the 25 MiB static-asset limit. */
  ENGINE_ASSETS?: EngineAssetBucket;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

/**
 * Serve the optional full Stockfish build from R2, same origin (no CORS), as an
 * immutable, content-addressed file. Only static engine bytes go through here;
 * no game data is ever sent to the server.
 */
async function serveEngineAsset(request: Request, env: Env, pathname: string) {
  const key = pathname.slice(1);
  if (!/^engine-assets\/[\w.-]+\.wasm$/.test(key)) return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (!env.ENGINE_ASSETS) return new Response("The full engine is not hosted on this deployment.", { status: 404 });
  const headers = new Headers({
    "content-type": "application/wasm",
    "cache-control": "public, max-age=31536000, immutable",
    "cross-origin-resource-policy": "same-origin",
  });
  if (request.method === "HEAD") {
    const object = await env.ENGINE_ASSETS.head(key);
    if (!object) return new Response(null, { status: 404 });
    headers.set("content-length", String(object.size));
    headers.set("etag", object.httpEtag);
    return new Response(null, { headers });
  }
  const object = await env.ENGINE_ASSETS.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  headers.set("content-length", String(object.size));
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/engine-assets/")) {
      return serveEngineAsset(request, env, url.pathname);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
