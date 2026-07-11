import type { EngineLine, EngineMoveResult } from "./chess-review";

interface SearchResult {
  bestMove: string;
  lines: EngineLine[];
}

interface ActiveSearch {
  lines: Map<number, EngineLine>;
  resolve: (result: SearchResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function expectedFromScore(cp?: number, mate?: number, wdl?: number[]) {
  if (wdl && wdl.length === 3) {
    return (wdl[0] + wdl[1] / 2) / 1000;
  }
  if (mate !== undefined) return mate > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, cp ?? 0))));
}

function parseInfo(line: string): { rank: number; value: EngineLine } | null {
  if (!line.startsWith("info ") || !/\bscore (?:cp|mate) -?\d+/.test(line)) return null;
  const depth = Number(line.match(/\bdepth (\d+)/)?.[1] ?? 0);
  const nodes = Number(line.match(/\bnodes (\d+)/)?.[1] ?? 0);
  const rank = Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1);
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  const cp = score?.[1] === "cp" ? Number(score[2]) : undefined;
  const mate = score?.[1] === "mate" ? Number(score[2]) : undefined;
  const wdlMatch = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  const wdl = wdlMatch ? wdlMatch.slice(1).map(Number) : undefined;
  const pvMatch = line.match(/\bpv (.+)$/);
  const pv = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];
  return {
    rank,
    value: {
      depth,
      nodes,
      cp,
      mate,
      expected: expectedFromScore(cp, mate, wdl),
      pv,
    },
  };
}

export class StockfishClient {
  private worker: Worker;
  private waiters: Array<{
    token: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private activeSearch: ActiveSearch | null = null;
  private disposed = false;

  constructor() {
    this.worker = new Worker("/stockfish/18.0.8/stockfish.js");
    this.worker.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      for (const line of event.data.split(/\r?\n/)) this.onLine(line.trim());
    });
    this.worker.addEventListener("error", () => {
      this.fail(new Error("Stockfish could not start in this browser."));
    });
  }

  private post(command: string) {
    if (this.disposed) throw new Error("The engine was stopped.");
    this.worker.postMessage(command);
  }

  private onLine(line: string) {
    if (!line) return;
    for (const waiter of [...this.waiters]) {
      if (line.includes(waiter.token)) {
        clearTimeout(waiter.timeout);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve();
      }
    }

    if (!this.activeSearch) return;
    const info = parseInfo(line);
    if (info) {
      const previous = this.activeSearch.lines.get(info.rank);
      if (
        !previous ||
        info.value.depth > previous.depth ||
        (info.value.depth === previous.depth && info.value.nodes >= previous.nodes)
      ) {
        this.activeSearch.lines.set(info.rank, info.value);
      }
      return;
    }

    if (line.startsWith("bestmove ")) {
      const active = this.activeSearch;
      this.activeSearch = null;
      clearTimeout(active.timeout);
      const bestMove = line.split(/\s+/)[1] ?? "(none)";
      const lines = [...active.lines.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, value]) => value);
      if (lines.length === 0) {
        active.reject(new Error("The engine returned no evaluation for this position."));
      } else {
        active.resolve({ bestMove, lines });
      }
    }
  }

  private fail(error: Error) {
    if (this.activeSearch) {
      clearTimeout(this.activeSearch.timeout);
      this.activeSearch.reject(error);
      this.activeSearch = null;
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters = [];
  }

  private waitFor(token: string, timeoutMs = 30_000) {
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        token,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error(`The engine did not answer “${token}” in time.`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async initialize() {
    const uciReady = this.waitFor("uciok");
    this.post("uci");
    await uciReady;
    this.post("setoption name Hash value 32");
    this.post("setoption name UCI_ShowWDL value true");
    this.post("setoption name MultiPV value 2");
    const engineReady = this.waitFor("readyok");
    this.post("isready");
    await engineReady;
    this.post("ucinewgame");
  }

  private search(fen: string, nodes: number, searchMove?: string) {
    if (this.activeSearch) throw new Error("Engine searches must run one at a time.");
    return new Promise<SearchResult>((resolve, reject) => {
      this.activeSearch = {
        lines: new Map(),
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (!this.activeSearch) return;
          const active = this.activeSearch;
          this.activeSearch = null;
          active.reject(new Error("This position took too long to analyze."));
        }, 60_000),
      };
      this.post(`position fen ${fen}`);
      this.post(`go nodes ${nodes}${searchMove ? ` searchmoves ${searchMove}` : ""}`);
    });
  }

  async analyzeMove(fen: string, playedMove: string, nodes: number): Promise<EngineMoveResult> {
    const top = await this.search(fen, nodes);
    const best = top.lines[0];
    const second = top.lines[1];
    const rankedIndex = top.lines.findIndex((line) => line.pv[0] === playedMove);
    let played = rankedIndex >= 0 ? top.lines[rankedIndex] : undefined;
    if (!played) {
      const restricted = await this.search(fen, nodes, playedMove);
      played = restricted.lines[0];
    }
    return {
      bestMove: top.bestMove,
      best,
      second,
      played,
      playedRank: rankedIndex >= 0 ? rankedIndex + 1 : null,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.worker.postMessage("stop");
    } catch {
      // The worker may already have stopped.
    }
    this.worker.terminate();
    this.fail(new Error("Analysis cancelled."));
  }
}
