/**
 * Transport-agnostic UCI engine session with validation and crash recovery.
 *
 * The same class drives Stockfish in a browser Web Worker and in Node (tests,
 * calibration). Every position is validated with chess.js BEFORE it reaches the
 * engine: Stockfish 19 prints `info string CRITICAL ERROR …` and exits on an
 * invalid FEN or move, so a bad request would otherwise kill the worker.
 */
import { Chess } from "chess.js";
import { uciParts } from "./chess-analysis.ts";
import { parseInfoLine, type Evaluation } from "./evaluation.ts";

export interface UciTransport {
  send(command: string): void;
  terminate(): void;
}

export interface TransportHandlers {
  onLine(line: string): void;
  onFailure(error: Error): void;
}

export type TransportFactory = (handlers: TransportHandlers) => UciTransport | Promise<UciTransport>;

export interface SearchRequest {
  /** Game start position. */
  rootFen: string;
  /** Moves (UCI) from the root to the position to search; gives the engine repetition history. */
  moves: string[];
  nodes: number;
  multiPv: number;
  searchMoves?: string[];
}

export interface SearchResult {
  bestMove: string;
  /** MultiPV lines sorted by rank, from the side to move in the searched position. */
  lines: Evaluation[];
  fen: string;
  engineVersion: string;
}

export interface SearchEngine {
  readonly engineVersion: string;
  newGame(): Promise<void>;
  search(request: SearchRequest): Promise<SearchResult>;
  dispose(): void;
}

export class InvalidPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPositionError";
  }
}

export class EngineCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineCrashedError";
  }
}

/** Replay and validate a request; returns the FEN of the searched position. */
export function validateSearchRequest(request: SearchRequest) {
  let chess: Chess;
  try {
    chess = new Chess(request.rootFen);
  } catch (error) {
    throw new InvalidPositionError(`Invalid root FEN: ${error instanceof Error ? error.message : request.rootFen}`);
  }
  for (const move of request.moves) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new InvalidPositionError(`Malformed UCI move ${move}`);
    try {
      chess.move(uciParts(move));
    } catch {
      throw new InvalidPositionError(`Illegal move ${move} in ${chess.fen()}`);
    }
  }
  if (chess.isCheckmate() || chess.isStalemate()) {
    throw new InvalidPositionError(`No legal moves to search in ${chess.fen()}`);
  }
  const legal = new Set(chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ""}`));
  for (const move of request.searchMoves ?? []) {
    if (!legal.has(move)) throw new InvalidPositionError(`searchmoves entry ${move} is not legal in ${chess.fen()}`);
  }
  if (!Number.isInteger(request.nodes) || request.nodes <= 0) throw new InvalidPositionError("nodes must be a positive integer");
  if (!Number.isInteger(request.multiPv) || request.multiPv < 1 || request.multiPv > 10) {
    throw new InvalidPositionError("MultiPV must be between 1 and 10");
  }
  return chess.fen();
}

interface Waiter {
  token: RegExp;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ActiveSearch {
  fen: string;
  lines: Map<number, Evaluation>;
  /** Latest aspiration-bound line for rank 1 (see onLine). */
  boundLine?: Evaluation;
  resolve: (result: SearchResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface UciEngineOptions {
  hashMb: number;
  searchTimeoutMs: number;
  /** Extra label recorded next to the engine's `id name` (e.g. build flavour). */
  buildLabel?: string;
  log?: (message: string) => void;
}

export class UciEngine implements SearchEngine {
  engineVersion = "unknown";
  private transport: UciTransport | null = null;
  private waiters: Waiter[] = [];
  private active: ActiveSearch | null = null;
  private multiPv = 1;
  private disposed = false;
  private starting: Promise<void> | null = null;
  private readonly factory: TransportFactory;
  private readonly options: UciEngineOptions;

  constructor(factory: TransportFactory, options: UciEngineOptions) {
    this.factory = factory;
    this.options = options;
  }

  private onLine(line: string) {
    if (!line) return;
    if (line.includes("CRITICAL ERROR")) {
      this.fail(new EngineCrashedError(line));
      return;
    }
    if (line.startsWith("id name ")) this.engineVersion = line.slice("id name ".length).trim();

    for (const waiter of [...this.waiters]) {
      if (waiter.token.test(line)) {
        clearTimeout(waiter.timeout);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(line);
      }
    }

    const active = this.active;
    if (!active) return;
    const info = parseInfoLine(line, active.fen, this.engineVersion, true);
    if (info) {
      if (info.bound) {
        if (info.multipv === 1) active.boundLine = info.evaluation;
      } else {
        active.lines.set(info.multipv, info.evaluation);
      }
      return;
    }
    if (line.startsWith("bestmove ")) {
      this.active = null;
      clearTimeout(active.timeout);
      const lines = [...active.lines.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, evaluation]) => evaluation);
      const bestMove = line.split(/\s+/)[1] ?? lines[0]?.pv[0];
      // A move that failed high after the last exact iteration becomes
      // `bestmove` with only a bound score. Report that move with its (conservative)
      // bound rather than pairing it with another move's exact score and PV.
      if (lines[0] && lines[0].pv[0] !== bestMove && active.boundLine?.pv[0] === bestMove) {
        lines[0] = active.boundLine;
      }
      if (lines.length === 0) {
        active.reject(new EngineCrashedError("The engine returned no evaluation for this position."));
      } else {
        active.resolve({ bestMove, lines, fen: active.fen, engineVersion: this.engineVersion });
      }
    }
  }

  private fail(error: Error) {
    const transport = this.transport;
    this.transport = null;
    this.starting = null;
    try {
      transport?.terminate();
    } catch {
      // Already gone.
    }
    if (this.active) {
      clearTimeout(this.active.timeout);
      this.active.reject(error);
      this.active = null;
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters = [];
    if (!this.disposed) this.options.log?.(`engine failure: ${error.message}`);
  }

  private post(command: string) {
    if (!this.transport) throw new EngineCrashedError("The engine is not running.");
    this.transport.send(command);
  }

  private waitFor(token: RegExp, timeoutMs = 30_000) {
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        token,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          this.fail(new EngineCrashedError(`The engine did not answer ${token} in time.`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Start (or restart) the engine process. Idempotent while running. */
  start() {
    if (this.disposed) return Promise.reject(new Error("Analysis cancelled."));
    if (this.transport && !this.starting) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.transport = await this.factory({
        onLine: (line) => this.onLine(line.trim()),
        // Any transport-level failure (e.g. the Worker died) is a crash the
        // pipeline may recover from by restarting and replaying the chunk.
        onFailure: (error) => this.fail(error instanceof EngineCrashedError ? error : new EngineCrashedError(error.message)),
      });
      const uciOk = this.waitFor(/^uciok/);
      this.post("uci");
      await uciOk;
      if (this.options.buildLabel) this.engineVersion = `${this.engineVersion} [${this.options.buildLabel}]`;
      this.post("setoption name Threads value 1");
      this.post(`setoption name Hash value ${this.options.hashMb}`);
      this.post("setoption name UCI_ShowWDL value true");
      this.post("setoption name MultiPV value 1");
      this.multiPv = 1;
      const ready = this.waitFor(/^readyok/);
      this.post("isready");
      await ready;
      this.options.log?.(`engine ready: ${this.engineVersion}`);
      this.starting = null;
    })();
    return this.starting;
  }

  async newGame() {
    await this.start();
    this.post("ucinewgame");
    const ready = this.waitFor(/^readyok/);
    this.post("isready");
    await ready;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const fen = validateSearchRequest(request);
    await this.start();
    if (this.active) throw new Error("Engine searches must run one at a time.");
    if (this.multiPv !== request.multiPv) {
      this.post(`setoption name MultiPV value ${request.multiPv}`);
      this.multiPv = request.multiPv;
    }
    return new Promise<SearchResult>((resolve, reject) => {
      this.active = {
        fen,
        lines: new Map(),
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.fail(new EngineCrashedError("This position took too long to analyze."));
        }, this.options.searchTimeoutMs),
      };
      try {
        this.post(
          request.moves.length
            ? `position fen ${request.rootFen} moves ${request.moves.join(" ")}`
            : `position fen ${request.rootFen}`,
        );
        this.post(
          `go nodes ${request.nodes}${request.searchMoves?.length ? ` searchmoves ${request.searchMoves.join(" ")}` : ""}`,
        );
      } catch (error) {
        this.fail(error instanceof Error ? error : new EngineCrashedError(String(error)));
      }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.transport?.send("stop");
      this.transport?.send("quit");
    } catch {
      // The engine may already be gone.
    }
    this.fail(new Error("Analysis cancelled."));
  }
}
