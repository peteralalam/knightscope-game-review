// A SearchEngine wrapper that memoizes engine searches on disk.
//
// Corpus runs (validation, rating calibration) take hours of engine time. The
// classifier on top of the searches is cheap, so searches are cached by
// (position history, nodes, MultiPV, searchmoves) and the reviews can be
// recomputed after any classifier change. A request the cache has not seen
// (e.g. a verification search for a new Great candidate) falls through to a
// real engine that is only started when first needed.
//
// Entries store the raw UCI score fields and are turned back into Evaluations
// with makeEvaluation, so the cache survives changes to the Evaluation shape.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { makeEvaluation } from "../../lib/evaluation.ts";
import { validateSearchRequest } from "../../lib/uci-engine.ts";

const PV_KEEP = 16;

export function searchKey(request) {
  const position = createHash("sha1").update(`${request.rootFen}|${request.moves.join(" ")}`).digest("hex");
  return `${position}|${request.nodes}|${request.multiPv}|${(request.searchMoves ?? []).join(",")}`;
}

function packLine(evaluation) {
  const cp = evaluation.tablebase
    ? (evaluation.tablebase.win ? 1 : -1) * (20_000 - evaluation.tablebase.plies)
    : evaluation.cp;
  return {
    cp,
    mate: evaluation.mate,
    wdl: [evaluation.engineWdl.win, evaluation.engineWdl.draw, evaluation.engineWdl.loss].map((value) => Math.round(value * 1000)),
    d: evaluation.depth,
    sd: evaluation.seldepth,
    n: evaluation.nodes,
    mpv: evaluation.multipv,
    pv: evaluation.pv.slice(0, PV_KEEP),
    b: evaluation.bound,
  };
}

function unpackLine(line, fen, engineVersion) {
  const evaluation = makeEvaluation({
    cp: line.cp,
    mate: line.mate,
    wdl: { win: line.wdl[0], draw: line.wdl[1], loss: line.wdl[2] },
    fen,
    depth: line.d,
    seldepth: line.sd,
    nodes: line.n,
    multipv: line.mpv,
    pv: line.pv,
    engineVersion,
  });
  return line.b ? { ...evaluation, bound: line.b } : evaluation;
}

export class SearchCache {
  constructor(directory, { shard = "main", readOnly = false } = {}) {
    this.directory = directory;
    this.file = `${directory}/shard-${shard}.jsonl`;
    this.readOnly = readOnly;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    if (existsSync(directory)) {
      for (const name of readdirSync(directory).filter((file) => file.endsWith(".jsonl"))) {
        for (const text of readFileSync(`${directory}/${name}`, "utf8").split("\n")) {
          if (!text) continue;
          try {
            const { k, r } = JSON.parse(text);
            this.entries.set(k, r);
          } catch {
            // A torn final line from an interrupted run.
          }
        }
      }
    } else if (!readOnly) {
      mkdirSync(directory, { recursive: true });
    }
  }

  get(request, fen) {
    const stored = this.entries.get(searchKey(request));
    if (!stored) return undefined;
    return {
      bestMove: stored.bm,
      lines: stored.l.map((line) => unpackLine(line, fen, stored.v)),
      fen,
      engineVersion: stored.v,
    };
  }

  put(request, result) {
    const key = searchKey(request);
    const packed = { bm: result.bestMove, v: result.engineVersion, l: result.lines.map(packLine) };
    this.entries.set(key, packed);
    if (!this.readOnly) appendFileSync(this.file, `${JSON.stringify({ k: key, r: packed })}\n`);
  }
}

/** SearchEngine backed by a SearchCache, starting `createEngine()` only on a miss. */
export class CachedEngine {
  constructor(cache, createEngine) {
    this.cache = cache;
    this.createEngine = createEngine;
    this.engine = null;
    this.pendingNewGame = false;
    this.engineVersion = "cached";
  }

  async newGame() {
    // Deferred: only a real search needs a fresh engine state.
    this.pendingNewGame = true;
  }

  async search(request) {
    const fen = validateSearchRequest(request);
    const hit = this.cache.get(request, fen);
    if (hit) {
      this.cache.hits += 1;
      this.engineVersion = hit.engineVersion;
      return hit;
    }
    this.cache.misses += 1;
    this.engine ??= this.createEngine();
    if (this.pendingNewGame) {
      await this.engine.newGame();
      this.pendingNewGame = false;
    }
    const result = await this.engine.search(request);
    this.engineVersion = result.engineVersion;
    this.cache.put(request, result);
    return result;
  }

  dispose() {
    this.engine?.dispose();
  }
}
