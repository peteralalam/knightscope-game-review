/**
 * Two-stage game analysis.
 *
 * Stage 1 – primary pass: every position of the game is searched once with
 *   MultiPV 1 (the authoritative evaluation). The evaluation of the position
 *   after a move, flipped to the mover, is that move's played evaluation; the
 *   evaluation of the position before it is the best achievable.
 *
 * Stage 2 – candidate pass: only positions where criticality matters (possible
 *   Best/Excellent/Great/Brilliant, Miss candidates, boundary cases, suspected
 *   sacrifices) get a MultiPV search for alternatives; a declined sacrifice also
 *   gets a `searchmoves` search that forces the opponent to accept it.
 *
 * Work is cut into fixed chunks that each begin with `ucinewgame`, and each
 * chunk runs sequentially on one engine. Results therefore do not depend on
 * how many engines the device runs, only on the game and the node budgets.
 */
import { Chess } from "chess.js";
import {
  evaluationWasUnstable,
  reviewMove,
  type EngineMoveResult,
  type ParsedGame,
  type ReviewedMove,
} from "./chess-review.ts";
import { staticSacrifices, pvSacrifice } from "./chess-analysis.ts";
import {
  invertEvaluation,
  terminalEvaluation,
  type Evaluation,
} from "./evaluation.ts";
import { ANALYSIS, BRILLIANT, LOSS_BANDS, MISS, REVIEW_MODEL_VERSION } from "./review-config.ts";
import { EngineCrashedError, type SearchEngine, type SearchRequest, type SearchResult } from "./uci-engine.ts";

export interface AnalysisBudget {
  primaryNodes: number;
  candidateNodes: number;
  candidateMultiPv?: number;
  chunkPlies?: number;
}

export interface AnalysisProgress {
  phase: "primary" | "candidates" | "verification";
  done: number;
  total: number;
}

export interface AnalyzeOptions extends AnalysisBudget {
  onProgress?: (progress: AnalysisProgress) => void;
  /** Called with provisional reviews after the primary pass and final reviews at the end. */
  onReviews?: (reviews: ReviewedMove[], final: boolean) => void;
  signal?: AbortSignal;
  ratings?: { w?: number; b?: number };
  useBook?: boolean;
}

export interface GameAnalysis {
  reviews: ReviewedMove[];
  engineResults: EngineMoveResult[];
  meta: {
    modelVersion: string;
    engineVersion: string;
    primaryNodes: number;
    candidateNodes: number;
    candidateMultiPv: number;
    candidateSearches: number;
    acceptanceSearches: number;
    verificationSearches: number;
    elapsedMs: number;
  };
}

interface PositionInfo {
  fen: string;
  moves: string[];
  terminal: "checkmate" | "draw" | null;
}

function positionsOf(game: ParsedGame): PositionInfo[] {
  const chess = new Chess(game.initialFen);
  const played: string[] = [];
  const describe = (): PositionInfo => ({
    fen: chess.fen(),
    moves: [...played],
    terminal: chess.isCheckmate() ? "checkmate" : chess.isStalemate() || chess.isInsufficientMaterial() ? "draw" : null,
  });
  const positions = [describe()];
  for (const move of game.moves) {
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    played.push(move.uci);
    positions.push(describe());
  }
  return positions;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Analysis cancelled.");
}

type Job = (engine: SearchEngine) => Promise<void>;

/** Run chunked jobs across engines; each chunk restarts once if its engine crashes. */
async function runChunks(engines: SearchEngine[], chunks: Job[][], signal?: AbortSignal) {
  let next = 0;
  const worker = async (engine: SearchEngine) => {
    while (next < chunks.length) {
      const chunk = chunks[next];
      next += 1;
      for (let attempt = 0; ; attempt += 1) {
        try {
          throwIfAborted(signal);
          await engine.newGame();
          for (const job of chunk) {
            throwIfAborted(signal);
            await job(engine);
          }
          break;
        } catch (error) {
          if (attempt >= 1 || !(error instanceof EngineCrashedError)) throw error;
          // The engine restarts itself on the next call; replay the whole chunk
          // from `ucinewgame` so the result stays deterministic.
        }
      }
    }
  };
  await Promise.all(engines.map(worker));
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function withPrefix(evaluation: Evaluation, move: string): Evaluation {
  return { ...evaluation, pv: [move, ...evaluation.pv] };
}

/** Assemble the per-move engine facts from both passes, all from the mover's view. */
function engineResultFor(
  game: ParsedGame,
  index: number,
  primary: Evaluation[],
  primaryBest: string[],
  candidates: Map<number, Evaluation[]>,
  acceptance: Map<number, Evaluation>,
  engineVersion: string,
  verification?: Map<number, Evaluation[]>,
): EngineMoveResult {
  const move = game.moves[index];
  const best = primary[index];
  // The best move is always the one whose evaluation we hold.
  const bestMove = best.pv[0] ?? primaryBest[index];
  let played: Evaluation;
  if (bestMove === move.uci) {
    played = best;
  } else {
    played = withPrefix(invertEvaluation(primary[index + 1]), move.uci);
  }
  const lines = candidates.get(index);
  const candidateRank = lines ? lines.findIndex((line) => line.pv[0] === move.uci) : -1;
  const accepted = acceptance.get(index);
  return {
    bestMove,
    best,
    played,
    playedRank: bestMove === move.uci ? 1 : candidateRank >= 0 ? candidateRank + 1 : null,
    candidates: lines,
    acceptance: accepted ? withPrefix(invertEvaluation(accepted), move.uci) : undefined,
    verification: verification?.get(index),
    engineVersion,
  };
}

function reviewAll(
  game: ParsedGame,
  results: EngineMoveResult[],
  options: Pick<AnalyzeOptions, "ratings" | "useBook">,
) {
  const reviews: ReviewedMove[] = [];
  const context = (index: number, unstable = false) => ({
    previous: reviews[index - 1],
    playerRating: options.ratings?.[game.moves[index].color],
    useBook: options.useBook,
    unstable,
  });
  results.forEach((result, index) => reviews.push(reviewMove(game, index, result, context(index))));
  // Withhold Brilliant / Great where the opponent's best reply exposed the
  // evaluation as a horizon artifact. The reply's own review is unaffected:
  // it depends only on this move's expected scores, which do not change.
  reviews.forEach((review, index) => {
    if ((review.grade === "brilliant" || review.grade === "great") && evaluationWasUnstable(review, reviews[index + 1])) {
      reviews[index] = reviewMove(game, index, results[index], context(index, true));
    }
  });
  return reviews;
}

/** Decide from the primary pass which moves need the candidate pass. */
function needsCandidates(game: ParsedGame, review: ReviewedMove, previous?: ReviewedMove) {
  if (review.legalMoveCount < 2) return false;
  if (review.isBook) return false;
  const loss = review.expectedPointsLost;
  const bestE = review.expectedBefore;
  const baseline = previous ? 1 - previous.expectedBefore : 0.5;
  const opportunity = bestE - baseline >= MISS.minOpportunity || review.bestEvaluation.mate !== undefined;
  const nearBoundary = [LOSS_BANDS.excellent, LOSS_BANDS.good, LOSS_BANDS.inaccuracy, LOSS_BANDS.mistake]
    .some((band) => Math.abs(loss - band) < 0.015);
  const sacrificeSuspected =
    staticSacrifices(review.before, review.uci, BRILLIANT.minSacrifice).length > 0 ||
    pvSacrifice(review.before, review.uci, review.resultingEvaluation.pv.slice(1), BRILLIANT.minSacrifice, BRILLIANT.pvPlies) !== null;
  const decided = bestE >= 0.97 || bestE <= 0.03;
  if (sacrificeSuspected && loss <= LOSS_BANDS.excellent) return true;
  if (opportunity && loss >= MISS.minLoss) return true;
  if (decided) return false;
  return loss <= LOSS_BANDS.excellent || nearBoundary;
}

export async function analyzeGame(
  game: ParsedGame,
  engines: SearchEngine[],
  options: AnalyzeOptions,
): Promise<GameAnalysis> {
  if (engines.length === 0) throw new Error("No engine available.");
  const started = Date.now();
  const chunkPlies = options.chunkPlies ?? ANALYSIS.chunkPlies;
  const candidateMultiPv = options.candidateMultiPv ?? ANALYSIS.candidateMultiPv;
  const positions = positionsOf(game);
  const primary: Evaluation[] = new Array(positions.length);
  const primaryBest: string[] = new Array(positions.length);
  let engineVersion = engines[0].engineVersion;

  const request = (position: PositionInfo, extra: Partial<SearchRequest> & Pick<SearchRequest, "nodes" | "multiPv">): SearchRequest => ({
    rootFen: game.initialFen,
    moves: position.moves,
    ...extra,
  });
  const record = (result: SearchResult) => {
    engineVersion = result.engineVersion;
    return result;
  };

  // --- Stage 1 -----------------------------------------------------------------
  let done = 0;
  const searchable = positions.map((position, index) => ({ position, index })).filter(({ position }) => !position.terminal);
  for (const { position, index } of positions.map((position, index) => ({ position, index }))) {
    if (position.terminal) primary[index] = terminalEvaluation(position.terminal, engineVersion);
  }
  options.onProgress?.({ phase: "primary", done, total: searchable.length });
  const primaryChunks = chunk(searchable, chunkPlies).map((items) =>
    items.map(({ position, index }): Job => async (engine) => {
      const result = record(await engine.search(request(position, { nodes: options.primaryNodes, multiPv: 1 })));
      primary[index] = result.lines[0];
      primaryBest[index] = result.bestMove;
      done += 1;
      options.onProgress?.({ phase: "primary", done, total: searchable.length });
    }),
  );
  await runChunks(engines, primaryChunks, options.signal);
  throwIfAborted(options.signal);

  const emptyCandidates = new Map<number, Evaluation[]>();
  const emptyAcceptance = new Map<number, Evaluation>();
  const provisionalResults = game.moves.map((_, index) =>
    engineResultFor(game, index, primary, primaryBest, emptyCandidates, emptyAcceptance, engineVersion),
  );
  const provisional = reviewAll(game, provisionalResults, options);
  options.onReviews?.(provisional, false);

  // --- Stage 2 -----------------------------------------------------------------
  const candidates = new Map<number, Evaluation[]>();
  const acceptance = new Map<number, Evaluation>();
  const jobs: Array<{ index: number; kind: "candidates" | "acceptance"; searchMoves?: string[] }> = [];
  provisional.forEach((review, index) => {
    if (!needsCandidates(game, review, provisional[index - 1])) return;
    jobs.push({ index, kind: "candidates" });
    const offered = staticSacrifices(review.before, review.uci, BRILLIANT.minSacrifice)[0];
    const reply = review.resultingEvaluation.pv[1];
    if (
      offered &&
      offered.acceptingMoves.length > 0 &&
      !offered.acceptingMoves.includes(reply) &&
      !positions[index + 1].terminal
    ) {
      jobs.push({ index, kind: "acceptance", searchMoves: offered.acceptingMoves });
    }
  });

  let candidateDone = 0;
  options.onProgress?.({ phase: "candidates", done: 0, total: jobs.length });
  const candidateChunks = chunk(jobs, chunkPlies).map((items) =>
    items.map((job): Job => async (engine) => {
      if (job.kind === "candidates") {
        const result = record(
          await engine.search(request(positions[job.index], { nodes: options.candidateNodes, multiPv: candidateMultiPv })),
        );
        candidates.set(job.index, result.lines);
      } else {
        const result = record(
          await engine.search(
            request(positions[job.index + 1], { nodes: options.candidateNodes, multiPv: 1, searchMoves: job.searchMoves }),
          ),
        );
        acceptance.set(job.index, result.lines[0]);
      }
      candidateDone += 1;
      options.onProgress?.({ phase: "candidates", done: candidateDone, total: jobs.length });
    }),
  );
  await runChunks(engines, candidateChunks, options.signal);
  throwIfAborted(options.signal);

  const candidateResults = game.moves.map((_, index) =>
    engineResultFor(game, index, primary, primaryBest, candidates, acceptance, engineVersion),
  );
  const candidateReviews = reviewAll(game, candidateResults, options);
  options.onReviews?.(candidateReviews, false);

  // --- Stage 3: verify Brilliant / Great candidates with a deeper search ----
  const verification = new Map<number, Evaluation[]>();
  const toVerify = candidateReviews
    .filter((review) => review.grade === "brilliant" || review.grade === "great")
    .map((review) => review.index);
  let verified = 0;
  options.onProgress?.({ phase: "verification", done: 0, total: toVerify.length });
  const verificationChunks = chunk(toVerify, chunkPlies).map((indices) =>
    indices.map((index): Job => async (engine) => {
      const result = record(
        await engine.search(
          request(positions[index], {
            nodes: options.candidateNodes * ANALYSIS.verificationNodeFactor,
            multiPv: ANALYSIS.verificationMultiPv,
          }),
        ),
      );
      verification.set(index, result.lines);
      verified += 1;
      options.onProgress?.({ phase: "verification", done: verified, total: toVerify.length });
    }),
  );
  await runChunks(engines, verificationChunks, options.signal);
  throwIfAborted(options.signal);

  const engineResults = game.moves.map((_, index) =>
    engineResultFor(game, index, primary, primaryBest, candidates, acceptance, engineVersion, verification),
  );
  const reviews = reviewAll(game, engineResults, options);
  options.onReviews?.(reviews, true);

  return {
    reviews,
    engineResults,
    meta: {
      modelVersion: REVIEW_MODEL_VERSION,
      engineVersion,
      primaryNodes: options.primaryNodes,
      candidateNodes: options.candidateNodes,
      candidateMultiPv,
      candidateSearches: jobs.filter((job) => job.kind === "candidates").length,
      acceptanceSearches: jobs.filter((job) => job.kind === "acceptance").length,
      verificationSearches: toVerify.length,
      elapsedMs: Date.now() - started,
    },
  };
}
