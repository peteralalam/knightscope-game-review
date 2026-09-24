import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import {
  gamePhase,
  isFreeCapture,
  isObviousRecapture,
  legalMoveCount as countLegalMoves,
  lineMaterialGain,
  PIECE_NAME,
  pvSacrifice,
  staticSacrifices,
  tryChess,
  uciParts,
  type Sacrifice,
} from "./chess-analysis.ts";
import { matedIn, matingIn, type Evaluation } from "./evaluation.ts";
import { isBookPosition } from "./opening-book.ts";
import { classifyTimeControl, estimatePerformance, type EstimateOptions } from "./rating-model.ts";
import {
  ACCURACY,
  BOOK,
  BRILLIANT,
  GREAT,
  INFORMATIVENESS,
  LOSS_BANDS,
  MISS,
  OUTCOME_BANDS,
  VERIFICATION,
} from "./review-config.ts";

export type { Evaluation } from "./evaluation.ts";
export type { Sacrifice } from "./chess-analysis.ts";

export type Grade =
  | "brilliant"
  | "great"
  | "best"
  | "excellent"
  | "good"
  | "book"
  | "inaccuracy"
  | "mistake"
  | "miss"
  | "blunder";

export type Phase = "opening" | "middlegame" | "endgame";

export interface ParsedMove {
  index: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  from: Square;
  to: Square;
  piece: PieceSymbol;
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  before: string;
  after: string;
}

export interface ParsedGame {
  headers: Record<string, string>;
  moves: ParsedMove[];
  initialFen: string;
  result: string;
}

/** An engine line from the moving player's point of view. */
export type EngineLine = Evaluation;

/**
 * Engine facts about one move, all from the MOVER's point of view.
 *
 * `best` is the authoritative primary-pass (MultiPV 1) evaluation of the
 * position before the move. `played.pv` starts with the played move.
 * `candidates` come from the targeted MultiPV pass and are only used for
 * criticality (Great / Brilliant / Miss typing / alternatives).
 */
export interface EngineMoveResult {
  bestMove: string;
  best: EngineLine;
  played: EngineLine;
  playedRank: number | null;
  /** Best alternative to the top move (legacy MultiPV-2 input). */
  second?: EngineLine;
  candidates?: EngineLine[];
  /** Evaluation when the opponent is forced to accept a declined sacrifice. */
  acceptance?: EngineLine;
  /**
   * Deeper MultiPV search of the position before the move, run only for
   * Brilliant / Great candidates. When present it replaces `candidates` for
   * criticality and must agree with the primary pass.
   */
  verification?: EngineLine[];
  engineVersion?: string;
}

export type MissType = "mate" | "material" | "only-winning-move" | "drawing-resource" | "tactic";

export interface MissInfo {
  missedMove: string;
  missedMoveSan: string;
  missedExpectedScore: number;
  resultingExpectedScore: number;
  missedPV: string[];
  missedOpportunityType: MissType;
  missedMate?: number;
}

export interface Criticality {
  /** Expected score of the best move minus the best alternative (candidate pass). */
  gap?: number;
  bestAlternative?: string;
  bestAlternativeSan?: string;
  /** Candidate moves within the "good" band of the best move. */
  goodMoves?: number;
  onlyMove: boolean;
}

export interface ReviewContext {
  /** The opponent's move immediately before this one, already reviewed. */
  previous?: ReviewedMove;
  /** Mover's rating from the PGN, used only to tune how non-obvious a Brilliant must be. */
  playerRating?: number;
  /**
   * Set when hindsight shows the evaluation after this move was not stable
   * (the opponent's best reply swung it by more than VERIFICATION.maxDrift).
   * Brilliant / Great are then withheld.
   */
  unstable?: boolean;
  useBook?: boolean;
}

export interface ReviewedMove extends ParsedMove {
  grade: Grade;
  /** Grade before the Book override (always engine-based). */
  objectiveGrade: Grade;
  expectedPointsLost: number;
  /** Legacy: expected-score loss in percentage points. */
  rawLoss: number;
  /** Legacy: same as rawLoss (no fudge offset any more). */
  loss: number;
  cpLoss?: number;
  accuracy: number;
  /** Legacy: gap to the best alternative in percentage points (0 when unknown). */
  uniqueness: number;
  /** True when a deeper verification search confirmed a Brilliant / Great. */
  verified: boolean;
  playedMove: string;
  bestMove: string;
  bestMoveSan: string;
  bestLineSan: string[];
  playedLineSan: string[];
  bestPV: string[];
  bestEvaluation: Evaluation;
  resultingEvaluation: Evaluation;
  legalMoveCount: number;
  expectedBefore: number;
  expectedAfter: number;
  expectedWhiteBefore: number;
  expectedWhiteAfter: number;
  cpWhiteBefore?: number;
  cpWhiteAfter?: number;
  mateWhiteBefore?: number;
  mateWhiteAfter?: number;
  isTopMove: boolean;
  playedRank: number | null;
  isBook: boolean;
  phase: Phase;
  /** 0–1: how much this move says about playing strength. */
  informativeness: number;
  forcedReason?: string;
  criticality: Criticality;
  sacrifice?: Sacrifice;
  brilliantReason?: string;
  greatReason?: string;
  miss?: MissInfo;
  classificationReason: string;
  explanation: string;
  engineVersion?: string;
}

export interface PerformanceFeatures {
  meaningfulMoves: number;
  effectiveMoves: number;
  meanLoss: number;
  medianLoss: number;
  p90Loss: number;
  blunderRate: number;
  mistakeRate: number;
  inaccuracyRate: number;
  top1Agreement: number;
  topNAgreement: number | null;
  criticalAccuracy: number | null;
  onlyMoveSuccess: number | null;
  conversionAccuracy: number | null;
  defensiveAccuracy: number | null;
  opportunityConversion: number | null;
}

export interface PerformanceEstimate {
  estimatedPerformanceRating: number;
  confidenceLow: number;
  confidenceHigh: number;
  confidence: "low" | "medium" | "high";
  meaningfulMoves: number;
  timeControl: TimeControlClass;
  ratingSystem: string;
  model: string;
  calibrated: boolean;
}

export type TimeControlClass =
  | "ultrabullet"
  | "bullet"
  | "blitz"
  | "rapid"
  | "classical"
  | "correspondence"
  | "unknown";

export interface SideSummary {
  accuracy: number;
  counts: Record<Grade, number>;
  moveCount: number;
  phaseAccuracy: Partial<Record<Phase, number>>;
  features: PerformanceFeatures | null;
  performance: PerformanceEstimate | null;
  /** Legacy shape used by the UI. */
  estimatedRating: {
    low: number;
    high: number;
    center: number;
    sample: "limited" | "fair" | "strong";
  } | null;
}

export const GRADE_ORDER: Grade[] = [
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "book",
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
];

export const GRADE_META: Record<Grade, { label: string; short: string; symbol: string }> = {
  brilliant: { label: "Brilliant", short: "!!", symbol: "✦" },
  great: { label: "Great", short: "!", symbol: "★" },
  best: { label: "Best", short: "✓", symbol: "✓" },
  excellent: { label: "Excellent", short: "", symbol: "◆" },
  good: { label: "Good", short: "", symbol: "●" },
  book: { label: "Book", short: "", symbol: "▤" },
  inaccuracy: { label: "Inaccuracy", short: "?!", symbol: "?!" },
  mistake: { label: "Mistake", short: "?", symbol: "?" },
  miss: { label: "Miss", short: "✕", symbol: "✕" },
  blunder: { label: "Blunder", short: "??", symbol: "??" },
};

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function parsePgn(pgn: string): ParsedGame {
  const source = pgn.trim();
  if (!source) {
    throw new Error("Paste a PGN or choose a .pgn file first.");
  }

  const chess = new Chess();
  try {
    chess.loadPgn(source, { strict: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The notation could not be read.";
    throw new Error(`This PGN is not valid. ${detail}`);
  }

  const history = chess.history({ verbose: true });
  if (history.length === 0) {
    throw new Error("The PGN does not contain any moves.");
  }
  if (history.length > 240) {
    throw new Error("This first version reviews games up to 120 moves.");
  }

  const moves = history.map((move, index) => ({
    index,
    moveNumber: Math.floor(index / 2) + 1,
    color: move.color,
    san: move.san,
    uci: `${move.from}${move.to}${move.promotion ?? ""}`,
    from: move.from,
    to: move.to,
    piece: move.piece,
    captured: move.captured,
    promotion: move.promotion,
    before: move.before,
    after: move.after,
  }));

  const headers = chess.getHeaders();
  return {
    headers,
    moves,
    initialFen: moves[0]?.before ?? headers.FEN ?? STARTING_FEN,
    result: headers.Result ?? "*",
  };
}

/**
 * Hindsight check: after the opponent's reply, the mover should stand roughly
 * where the engine said this move left them. A large drop when the opponent
 * simply played the engine's top move means the first evaluation was beyond
 * the search horizon.
 */
export function evaluationWasUnstable(review: ReviewedMove, reply?: ReviewedMove) {
  if (!reply || !(reply.isTopMove || reply.expectedPointsLost <= LOSS_BANDS.excellent)) return false;
  const moverAfterReply = 1 - reply.expectedAfter;
  return review.expectedAfter - moverAfterReply > VERIFICATION.maxDrift;
}

export function uciToSan(fen: string, uci: string) {
  if (!uci || uci === "(none)") return "—";
  try {
    const chess = new Chess(fen);
    return chess.move(uciParts(uci)).san;
  } catch {
    return uci;
  }
}

export function pvToSan(fen: string, pv: string[], limit = 8) {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of pv.slice(0, limit)) {
    try {
      sans.push(chess.move(uciParts(uci)).san);
    } catch {
      break;
    }
  }
  return sans;
}

function isCheckmate(fen: string) {
  try {
    return new Chess(fen).isCheckmate();
  } catch {
    return false;
  }
}

type OutcomeBand = 0 | 1 | 2 | 3 | 4;

/** 0 = losing, 1 = worse, 2 = balanced, 3 = better, 4 = winning. */
export function outcomeBand(expected: number): OutcomeBand {
  if (expected < OUTCOME_BANDS.losing) return 0;
  if (expected < OUTCOME_BANDS.worse) return 1;
  if (expected <= OUTCOME_BANDS.better) return 2;
  if (expected <= OUTCOME_BANDS.winning) return 3;
  return 4;
}

const OUTCOME_WORDS = ["losing", "worse", "balanced", "better", "winning"] as const;

function severityGrade(loss: number, isTop: boolean): Grade {
  if (isTop || loss <= LOSS_BANDS.bestEquivalence) return "best";
  if (loss <= LOSS_BANDS.excellent) return "excellent";
  if (loss <= LOSS_BANDS.good) return "good";
  if (loss <= LOSS_BANDS.inaccuracy) return "inaccuracy";
  if (loss <= LOSS_BANDS.mistake) return "mistake";
  return "blunder";
}

/** Lichess's published move-accuracy curve (lila AccuracyPercent), on expected-score loss. */
export function moveAccuracy(loss: number) {
  if (loss <= 0) return 100;
  const winDiff = loss * 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411;
  return clamp(raw + 1, 0, 100);
}

function ratingEdge(rating?: number) {
  const bucket = BRILLIANT.uniquenessByRating.find((entry) => (rating ?? 1500) < entry.below);
  return bucket?.minEdge ?? 0;
}

function describeSacrifice(sacrifice: Sacrifice) {
  const name = PIECE_NAME[sacrifice.piece];
  switch (sacrifice.kind) {
    case "queen":
      return "Sacrifices the queen";
    case "exchange":
      return "Gives up the exchange";
    case "piece":
      return `Sacrifices the ${name} on ${sacrifice.square}`;
    case "en-prise":
      return `Leaves the ${name} on ${sacrifice.square} en prise`;
    case "pv":
      return `Gives up material (${sacrifice.material} pawn units) in the main line`;
  }
}

function describeOutcome(played: Evaluation) {
  const mate = matingIn(played);
  if (mate !== undefined && mate > 0) return `leads to a forced mate in ${mate}`;
  const band = outcomeBand(played.expectedScore);
  return `keeps the position ${OUTCOME_WORDS[band]} (${percent(played.expectedScore)} expected score)`;
}

interface Alternatives {
  /** Candidate evaluations with the played move's own line removed. */
  bestAlternative?: EngineLine;
  playedCandidate?: EngineLine;
  topCandidate?: EngineLine;
}

function splitCandidates(engine: EngineMoveResult, uci: string): Alternatives {
  const candidates = engine.verification?.length
    ? engine.verification
    : engine.candidates?.length
    ? engine.candidates
    : engine.second
      ? [engine.best, engine.second]
      : [];
  if (candidates.length === 0) return {};
  return {
    topCandidate: candidates[0],
    playedCandidate: candidates.find((line) => line.pv[0] === uci),
    bestAlternative: candidates.find((line) => line.pv[0] !== uci),
  };
}

export function reviewMove(
  game: ParsedGame,
  moveIndex: number,
  engine: EngineMoveResult,
  context: ReviewContext = {},
): ReviewedMove {
  const move = game.moves[moveIndex];
  const previousMove = game.moves[moveIndex - 1];
  const legalMoveCount = countLegalMoves(move.before);
  const bestEvaluation = engine.best;
  const { topCandidate, playedCandidate, bestAlternative } = splitCandidates(engine, move.uci);

  const isTop =
    engine.bestMove === move.uci ||
    engine.playedRank === 1 ||
    topCandidate?.pv[0] === move.uci;
  const resultingEvaluation = isTop && engine.bestMove === move.uci ? bestEvaluation : engine.played;

  const bestE = bestEvaluation.expectedScore;
  const playedE = resultingEvaluation.expectedScore;
  let loss = isTop ? 0 : Math.max(0, bestE - playedE);
  if (!isTop && topCandidate && playedCandidate) {
    // Two independent comparisons of the same move; averaging damps search noise.
    loss = (loss + Math.max(0, topCandidate.expectedScore - playedCandidate.expectedScore)) / 2;
  }

  const bestMate = matingIn(bestEvaluation);
  const playedMate = matingIn(resultingEvaluation);
  const bestMated = matedIn(bestEvaluation);
  const playedMated = matedIn(resultingEvaluation);
  const mateNow = isCheckmate(move.after);
  const bestMoveSan = uciToSan(move.before, engine.bestMove);

  let grade = severityGrade(loss, isTop);
  let reason: string;
  let forcedReason: string | undefined;

  if (legalMoveCount === 1) {
    grade = "best";
    loss = 0;
    forcedReason = "only legal move";
    reason = "The only legal move.";
  } else if (mateNow) {
    grade = "best";
    loss = 0;
    reason = "Delivers checkmate.";
  } else if (bestMate !== undefined && playedMate !== undefined) {
    loss = 0;
    grade = isTop ? "best" : playedMate <= bestMate + 2 ? "excellent" : "good";
    reason = isTop
      ? `Keeps the forced mate (mate in ${playedMate}).`
      : `Still mates by force (mate in ${playedMate}); ${bestMoveSan} mates in ${bestMate}.`;
  } else if (bestMated !== undefined && playedMated !== undefined) {
    loss = 0;
    grade = isTop ? "best" : playedMated >= bestMated - 1 ? "excellent" : "good";
    reason = `The position was already lost to a forced mate; this ${isTop ? "is the most stubborn defence" : `allows mate in ${playedMated}`}.`;
  } else if (playedMated !== undefined && bestMated === undefined) {
    // Walking into a forced mate is never a small slip, even from a bad position.
    grade = playedMated <= 3 || bestE > 0.1 ? "blunder" : grade === "blunder" ? "blunder" : "mistake";
    reason = `Allows a forced mate in ${playedMated}. ${bestMoveSan} avoided it.`;
  } else if (grade === "best") {
    reason = isTop
      ? "Stockfish's top choice."
      : `Practically equal to Stockfish's top choice ${bestMoveSan}.`;
  } else {
    reason = `${bestMoveSan} was stronger: this move gives up ${(loss * 100).toFixed(1)} percentage points of expected score (${percent(bestE)} → ${percent(playedE)}).`;
  }

  const informativenessBase = legalMoveCount === 1 ? INFORMATIVENESS.onlyLegal : 1;
  const obviousRecapture = isObviousRecapture(move.before, move.uci, previousMove);
  const mateInOne = mateNow;
  const checkEvasion =
    legalMoveCount <= INFORMATIVENESS.checkEvasionMaxLegal && Boolean(tryChess(move.before)?.inCheck());
  // A verification search that disagrees with the primary pass means the
  // position is beyond the search horizon: do not award Brilliant / Great.
  const unstable =
    context.unstable === true ||
    (engine.verification?.[0] !== undefined &&
      Math.abs(engine.verification[0].expectedScore - bestE) > VERIFICATION.maxDrift);

  // --- Criticality from the candidate pass --------------------------------
  const playedScoreForGap = playedCandidate?.expectedScore ?? (isTop ? bestE : playedE);
  const gap = bestAlternative ? playedScoreForGap - bestAlternative.expectedScore : undefined;
  const candidateList = engine.verification ?? engine.candidates ?? [];
  const goodMoves = candidateList.length
    ? candidateList.filter((line) => candidateList[0].expectedScore - line.expectedScore <= LOSS_BANDS.good).length
    : undefined;
  const criticality: Criticality = {
    gap,
    bestAlternative: bestAlternative?.pv[0],
    bestAlternativeSan: bestAlternative ? uciToSan(move.before, bestAlternative.pv[0]) : undefined,
    goodMoves,
    onlyMove: gap !== undefined && gap >= GREAT.minGap && (goodMoves ?? 2) <= 1,
  };

  // --- Book ------------------------------------------------------------------
  const isBook =
    context.useBook !== false &&
    moveIndex < BOOK.maxPly &&
    loss < BOOK.maxLoss &&
    playedMated === undefined &&
    isBookPosition(move.after);

  // --- Brilliant -------------------------------------------------------------
  let sacrifice: Sacrifice | undefined;
  let brilliantReason: string | undefined;
  const nearBest = isTop || loss <= BRILLIANT.maxLoss;
  if (!isBook && nearBest && legalMoveCount >= 2 && !mateInOne && !checkEvasion && !unstable && candidateList.length) {
    const statics = staticSacrifices(move.before, move.uci, BRILLIANT.minSacrifice);
    const continuation = resultingEvaluation.pv[0] === move.uci
      ? resultingEvaluation.pv.slice(1)
      : resultingEvaluation.pv;
    const realized = pvSacrifice(
      move.before,
      move.uci,
      continuation,
      BRILLIANT.minSacrifice,
      BRILLIANT.pvPlies,
      BRILLIANT.maxAcceptancePly,
    );
    let candidate: Sacrifice | undefined;
    let acceptanceOk = true;
    if (statics.length > 0) {
      const offered = statics[0];
      const reply = continuation[0];
      if (reply && offered.acceptingMoves.includes(reply)) {
        // Accepted in the main line: the deficit must actually persist there.
        candidate = realized && realized.piece !== "p"
          ? { ...offered, accepted: true, recoveredAfterPlies: realized.recoveredAfterPlies, deficitPly: realized.deficitPly }
          : undefined;
      } else {
        candidate = { ...offered, accepted: false };
        if (engine.acceptance) {
          acceptanceOk =
            engine.acceptance.expectedScore >= BRILLIANT.minExpectedAfter &&
            engine.acceptance.expectedScore >= playedE - BRILLIANT.acceptanceTolerance;
        }
      }
    } else if (realized && realized.piece !== "p") {
      candidate = realized;
    }

    const alternativeScore = bestAlternative?.expectedScore;
    const alternativeMate = matingIn(bestAlternative);
    // A sacrifice that forces mate where the alternatives merely win is still meaningful.
    const forcesMateAlone =
      playedMate !== undefined && (alternativeMate === undefined || alternativeMate > playedMate + 1);
    const unnecessary =
      alternativeScore !== undefined && alternativeScore >= BRILLIANT.alternativeAlreadyWinning && !forcesMateAlone;
    const edgeOk = gap === undefined || gap >= ratingEdge(context.playerRating);
    const candidateConfirms = !playedCandidate || !topCandidate ||
      topCandidate.expectedScore - playedCandidate.expectedScore <= BRILLIANT.maxLoss;

    if (
      candidate &&
      acceptanceOk &&
      playedE >= BRILLIANT.minExpectedAfter &&
      !unnecessary &&
      edgeOk &&
      candidateConfirms &&
      (playedCandidate !== undefined || isTop)
    ) {
      sacrifice = candidate;
      const acceptanceText = candidate.accepted
        ? candidate.recoveredAfterPlies !== undefined
          ? `Stockfish's best defence takes it, and the material comes back ${candidate.recoveredAfterPlies} plies later`
          : "Stockfish's best defence takes it"
        : engine.acceptance
          ? `Taking it leaves the opponent worse off (${percent(1 - engine.acceptance.expectedScore)} for them after the capture)`
          : "Stockfish's best defence declines it";
      brilliantReason = `${isTop ? "Best move" : "Near-best move"}. ${describeSacrifice(candidate)}. ${acceptanceText}, and the move ${describeOutcome(resultingEvaluation)}.`;
      grade = "brilliant";
    }
  }

  // --- Great -----------------------------------------------------------------
  let greatReason: string | undefined;
  const opponentLoss = context.previous?.expectedPointsLost ?? 0;
  if (
    grade !== "brilliant" &&
    !isBook &&
    (isTop || loss <= GREAT.maxLoss) &&
    legalMoveCount >= 2 &&
    !obviousRecapture &&
    !mateInOne &&
    !checkEvasion &&
    !unstable &&
    // Taking a piece that is simply hanging is never a hard-to-find move.
    !isFreeCapture(move.before, move.uci) &&
    gap !== undefined &&
    bestAlternative &&
    playedE >= GREAT.minExpectedAfter
  ) {
    const playedBand = outcomeBand(playedScoreForGap);
    const alternativeBand = outcomeBand(bestAlternative.expectedScore);
    const altSan = criticality.bestAlternativeSan ?? "the next-best move";
    const altText = `the best alternative, ${altSan}, scores ${percent(bestAlternative.expectedScore)} against ${percent(playedScoreForGap)}`;
    if (gap >= GREAT.onlyMoveGap) {
      greatReason = `Only move: ${altText}.`;
    } else if (gap >= GREAT.minGap && playedBand > alternativeBand) {
      greatReason = `Critical move: it keeps the position ${OUTCOME_WORDS[playedBand]}, while ${altText} (${OUTCOME_WORDS[alternativeBand]}).`;
    } else if (gap >= GREAT.minGap && opponentLoss >= GREAT.punishOpponentLoss) {
      greatReason = `Punishes the opponent's error: ${altText}.`;
    }
    if (greatReason) grade = "great";
  }

  // --- Miss ------------------------------------------------------------------
  let miss: MissInfo | undefined;
  if (grade !== "brilliant" && grade !== "great" && !isTop && legalMoveCount >= 2) {
    const baseline = context.previous ? 1 - context.previous.expectedBefore : 0.5;
    const opportunity = bestE - baseline;
    const missedMateRelevant =
      bestMate !== undefined &&
      playedMate === undefined &&
      (bestMate <= MISS.alwaysReportMateWithin ||
        (bestMate <= MISS.reportMateWithin && playedE < MISS.crushing));
    const bandDrop = outcomeBand(bestE) > outcomeBand(playedE);
    const realOpportunity =
      missedMateRelevant ||
      (loss >= MISS.minLoss &&
        bandDrop &&
        (opportunity >= MISS.minOpportunity || outcomeBand(bestE) > outcomeBand(baseline)));

    if (realOpportunity) {
      const bestGain = lineMaterialGain(move.before, bestEvaluation.pv, 6);
      const playedGain = lineMaterialGain(move.before, resultingEvaluation.pv, 6);
      let type: MissType;
      if (missedMateRelevant) type = "mate";
      else if (bestE >= OUTCOME_BANDS.worse && playedE < OUTCOME_BANDS.losing && baseline < OUTCOME_BANDS.worse) type = "drawing-resource";
      else if (bestGain >= MISS.materialWin && playedGain < bestGain - 1) type = "material";
      else if (criticality.onlyMove && bestE > OUTCOME_BANDS.winning) type = "only-winning-move";
      else type = "tactic";
      miss = {
        missedMove: engine.bestMove,
        missedMoveSan: bestMoveSan,
        missedExpectedScore: bestE,
        resultingExpectedScore: playedE,
        missedPV: bestEvaluation.pv,
        missedOpportunityType: type,
        missedMate: missedMateRelevant ? bestMate : undefined,
      };
      const what =
        type === "mate"
          ? `a forced mate in ${bestMate} with ${bestMoveSan}`
          : type === "material"
            ? `${bestMoveSan}, which wins material (about ${bestGain} pawn units in the main line)`
            : type === "drawing-resource"
              ? `the drawing resource ${bestMoveSan}`
              : type === "only-winning-move"
                ? `the only winning move, ${bestMoveSan}`
                : `${bestMoveSan} (${percent(bestE)} expected score)`;
      // A Miss is failing to cash in. If the move also dropped below where the
      // player stood before the chance appeared, it is a real Mistake/Blunder.
      if (playedE >= baseline - MISS.baselineSlack) {
        grade = "miss";
        reason = `Missed ${what}. After this move the position is ${OUTCOME_WORDS[outcomeBand(playedE)]} (${percent(playedE)}).`;
      } else {
        if (missedMateRelevant && grade !== "blunder") grade = loss > LOSS_BANDS.mistake ? "blunder" : "mistake";
        reason = `${reason} It also missed ${what}.`;
      }
    }
  }

  // --- Informativeness ---------------------------------------------------------
  let informativeness = informativenessBase;
  const decided =
    (bestE >= INFORMATIVENESS.decidedThreshold && playedE >= INFORMATIVENESS.decidedThreshold) ||
    bestE <= 1 - INFORMATIVENESS.decidedThreshold;
  const alternativesAlsoDecided =
    !bestAlternative ||
    (bestE >= 0.5
      ? bestAlternative.expectedScore >= INFORMATIVENESS.decidedThreshold
      : bestAlternative.expectedScore <= 1 - INFORMATIVENESS.decidedThreshold);
  if (isBook) {
    informativeness = INFORMATIVENESS.book;
    forcedReason ??= "opening theory";
  } else if (legalMoveCount === 1) {
    informativeness = INFORMATIVENESS.onlyLegal;
  } else if (obviousRecapture) {
    informativeness = INFORMATIVENESS.obviousRecapture;
    forcedReason = "recapture";
  } else if (mateInOne) {
    informativeness = INFORMATIVENESS.mateInOne;
    forcedReason = "mate in one";
  } else if (checkEvasion) {
    informativeness = INFORMATIVENESS.checkEvasion;
    forcedReason = "check evasion";
  } else if (decided && alternativesAlsoDecided && !miss) {
    informativeness = INFORMATIVENESS.decided;
    forcedReason = "result already decided";
  } else if (legalMoveCount === 2) {
    informativeness = INFORMATIVENESS.twoLegal;
    forcedReason = "two legal moves";
  }

  if (isBook) {
    reason = "A known opening-theory move.";
  } else if (grade === "brilliant" && brilliantReason) {
    reason = brilliantReason;
  } else if (grade === "great" && greatReason) {
    reason = greatReason;
  } else if (grade === "best" && isTop && criticality.gap !== undefined && reason === "Stockfish's top choice.") {
    reason = criticality.gap < LOSS_BANDS.excellent
      ? "Stockfish's top choice; several moves were about as good."
      : "Stockfish's top choice.";
  } else if (grade === "excellent") {
    reason = `Nearly as good as Stockfish's ${bestMoveSan} (${(loss * 100).toFixed(1)} points of expected score).`;
  }

  const finalLoss = loss;
  const shownGrade: Grade = isBook ? "book" : grade;
  const accuracy = legalMoveCount === 1 ? 100 : moveAccuracy(finalLoss);
  const rootToWhite = move.color === "w" ? 1 : -1;
  const cpLoss =
    bestEvaluation.cp !== undefined && resultingEvaluation.cp !== undefined
      ? Math.max(0, bestEvaluation.cp - resultingEvaluation.cp)
      : undefined;
  const playedPv = resultingEvaluation.pv[0] === move.uci ? resultingEvaluation.pv : [move.uci, ...resultingEvaluation.pv];

  return {
    ...move,
    grade: shownGrade,
    objectiveGrade: grade,
    expectedPointsLost: finalLoss,
    rawLoss: finalLoss * 100,
    loss: finalLoss * 100,
    cpLoss,
    accuracy,
    uniqueness: Math.max(0, (gap ?? 0) * 100),
    verified: Boolean(engine.verification?.length) && (grade === "brilliant" || grade === "great"),
    playedMove: move.uci,
    bestMove: engine.bestMove,
    bestMoveSan,
    bestLineSan: pvToSan(move.before, bestEvaluation.pv),
    playedLineSan: pvToSan(move.before, playedPv),
    bestPV: bestEvaluation.pv,
    bestEvaluation,
    resultingEvaluation,
    legalMoveCount,
    expectedBefore: bestE,
    expectedAfter: playedE,
    expectedWhiteBefore: move.color === "w" ? bestE : 1 - bestE,
    expectedWhiteAfter: move.color === "w" ? playedE : 1 - playedE,
    cpWhiteBefore: bestEvaluation.cp === undefined ? undefined : bestEvaluation.cp * rootToWhite,
    cpWhiteAfter: resultingEvaluation.cp === undefined ? undefined : resultingEvaluation.cp * rootToWhite,
    mateWhiteBefore: signedMate(bestEvaluation, rootToWhite),
    mateWhiteAfter: signedMate(resultingEvaluation, rootToWhite),
    isTopMove: isTop,
    playedRank: isTop ? 1 : engine.playedRank,
    isBook,
    phase: gamePhase(move.before, moveIndex),
    informativeness,
    forcedReason,
    criticality,
    sacrifice,
    brilliantReason: grade === "brilliant" ? brilliantReason : undefined,
    greatReason: grade === "great" ? greatReason : undefined,
    miss,
    classificationReason: reason,
    explanation: reason,
    engineVersion: engine.engineVersion ?? bestEvaluation.engineVersion,
  };
}

/** Mate distance from White's side; 0 means the game has ended in mate. */
function signedMate(evaluation: Evaluation, rootToWhite: number) {
  const mating = matingIn(evaluation);
  if (mating !== undefined) return mating === 0 ? 0 : mating * rootToWhite;
  const mated = matedIn(evaluation);
  if (mated !== undefined) return mated === 0 ? 0 : -mated * rootToWhite;
  return undefined;
}

function emptyCounts(): Record<Grade, number> {
  return {
    brilliant: 0,
    great: 0,
    best: 0,
    excellent: 0,
    good: 0,
    book: 0,
    inaccuracy: 0,
    mistake: 0,
    miss: 0,
    blunder: 0,
  };
}

function populationStd(values: number[]) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

/**
 * Game accuracy following lila's `AccuracyPercent.gameAccuracy`: the mean of a
 * volatility-weighted mean and a harmonic mean of per-move accuracies, with
 * volatility measured as the standard deviation of White's win percentage in a
 * sliding window. Moves with a single legal option are left out – there was
 * no decision to be precise about.
 */
export function aggregateAccuracy(reviews: ReviewedMove[], color: Color, filter?: (move: ReviewedMove) => boolean) {
  if (reviews.length === 0) return null;
  const winPercents = [reviews[0].expectedWhiteBefore * 100, ...reviews.map((move) => move.expectedWhiteAfter * 100)];
  const windowSize = clamp(Math.floor(reviews.length / 10), 2, 8);
  const windows: number[][] = [];
  for (let index = 0; index < Math.min(windowSize, winPercents.length) - 2; index += 1) {
    windows.push(winPercents.slice(0, windowSize));
  }
  for (let index = 0; index + windowSize <= winPercents.length; index += 1) {
    windows.push(winPercents.slice(index, index + windowSize));
  }

  let weightedSum = 0;
  let weightTotal = 0;
  let harmonicDenominator = 0;
  let count = 0;
  reviews.forEach((move, index) => {
    if (move.color !== color || move.legalMoveCount <= 1) return;
    if (filter && !filter(move)) return;
    const weight = clamp(populationStd(windows[index] ?? windows.at(-1) ?? []), 0.5, 12);
    weightedSum += weight * move.accuracy;
    weightTotal += weight;
    harmonicDenominator += 1 / Math.max(move.accuracy, ACCURACY.harmonicFloor);
    count += 1;
  });
  if (count === 0) return null;
  const weighted = weightedSum / weightTotal;
  const harmonic = count / harmonicDenominator;
  return Math.round(((weighted + harmonic) / 2) * 10) / 10;
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function rate(moves: ReviewedMove[], predicate: (move: ReviewedMove) => boolean) {
  const relevant = moves.filter((move) => move.informativeness > 0);
  if (relevant.length === 0) return null;
  const weight = relevant.reduce((sum, move) => sum + move.informativeness, 0);
  return relevant.reduce((sum, move) => sum + (predicate(move) ? move.informativeness : 0), 0) / weight;
}

export function extractFeatures(sideMoves: ReviewedMove[]): PerformanceFeatures | null {
  const decisions = sideMoves.filter((move) => move.informativeness > 0);
  if (decisions.length === 0) return null;
  const effectiveMoves = decisions.reduce((sum, move) => sum + move.informativeness, 0);
  const losses = decisions.map((move) => move.expectedPointsLost).sort((left, right) => left - right);
  const meanLoss = decisions.reduce((sum, move) => sum + move.informativeness * move.expectedPointsLost, 0) / effectiveMoves;
  const withCandidates = decisions.filter((move) => move.criticality.gap !== undefined);
  const critical = decisions.filter((move) => (move.criticality.gap ?? 0) >= GREAT.minGap);
  const onlyMoves = decisions.filter((move) => move.criticality.onlyMove);
  const conversion = decisions.filter((move) => move.expectedBefore >= OUTCOME_BANDS.winning);
  const defence = decisions.filter((move) => move.expectedBefore <= OUTCOME_BANDS.worse);
  const opportunities = decisions.filter((move) => move.miss || move.grade === "great" || move.grade === "brilliant");
  const meanAccuracy = (moves: ReviewedMove[]) =>
    moves.length ? moves.reduce((sum, move) => sum + move.accuracy, 0) / moves.length : null;
  const severe = (grades: Grade[]) => (move: ReviewedMove) => grades.includes(move.objectiveGrade);

  return {
    meaningfulMoves: decisions.filter((move) => move.informativeness >= 0.5).length,
    effectiveMoves,
    meanLoss,
    medianLoss: quantile(losses, 0.5),
    p90Loss: quantile(losses, 0.9),
    blunderRate: rate(decisions, severe(["blunder"])) ?? 0,
    mistakeRate: rate(decisions, severe(["mistake", "miss"])) ?? 0,
    inaccuracyRate: rate(decisions, severe(["inaccuracy"])) ?? 0,
    top1Agreement: rate(decisions, (move) => move.isTopMove) ?? 0,
    topNAgreement: withCandidates.length ? rate(withCandidates, (move) => move.playedRank !== null) : null,
    criticalAccuracy: meanAccuracy(critical),
    onlyMoveSuccess: onlyMoves.length
      ? onlyMoves.filter((move) => move.isTopMove || move.expectedPointsLost <= GREAT.maxLoss).length / onlyMoves.length
      : null,
    conversionAccuracy: meanAccuracy(conversion),
    defensiveAccuracy: meanAccuracy(defence),
    opportunityConversion: opportunities.length
      ? opportunities.filter((move) => !move.miss).length / opportunities.length
      : null,
  };
}

export function summarizeSide(
  reviews: ReviewedMove[],
  color: Color,
  headers: Record<string, string>,
  options: Omit<EstimateOptions, "timeControl"> = {},
): SideSummary {
  const sideMoves = reviews.filter((move) => move.color === color);
  const counts = emptyCounts();
  for (const move of sideMoves) counts[move.grade] += 1;

  if (sideMoves.length === 0) {
    return {
      accuracy: 0,
      counts,
      moveCount: 0,
      phaseAccuracy: {},
      features: null,
      performance: null,
      estimatedRating: null,
    };
  }

  const phaseAccuracy: Partial<Record<Phase, number>> = {};
  for (const phase of ["opening", "middlegame", "endgame"] as const) {
    const value = aggregateAccuracy(reviews, color, (move) => move.phase === phase);
    if (value !== null) phaseAccuracy[phase] = value;
  }

  const performance = estimatePerformance(sideMoves, {
    ...options,
    timeControl: classifyTimeControl(headers.TimeControl),
  });

  return {
    accuracy: aggregateAccuracy(reviews, color) ?? 100,
    counts,
    moveCount: sideMoves.length,
    phaseAccuracy,
    features: extractFeatures(sideMoves),
    performance,
    estimatedRating: performance
      ? {
          low: performance.confidenceLow,
          high: performance.confidenceHigh,
          center: performance.estimatedPerformanceRating,
          sample: performance.confidence === "high" ? "strong" : performance.confidence === "medium" ? "fair" : "limited",
        }
      : null,
  };
}

export function formatEvaluation(cp?: number, mate?: number) {
  if (mate === 0) return "#";
  if (mate !== undefined) return mate > 0 ? `M${mate}` : `−M${Math.abs(mate)}`;
  if (cp === undefined) return "0.00";
  const pawns = cp / 100;
  if (Math.abs(pawns) < 0.005) return "0.00";
  return `${pawns > 0 ? "+" : "−"}${Math.abs(pawns).toFixed(2)}`;
}

/** Evaluation label for a review, handling tablebase results explicitly. */
export function formatReviewEvaluation(review: ReviewedMove, side: "before" | "after" = "after") {
  const evaluation = side === "after" ? review.resultingEvaluation : review.bestEvaluation;
  const whiteMoverSign = review.color === "w" ? 1 : -1;
  if (evaluation.tablebase) {
    const whiteWins = evaluation.tablebase.win === (whiteMoverSign === 1);
    return whiteWins ? "TB 1-0" : "TB 0-1";
  }
  return side === "after"
    ? formatEvaluation(review.cpWhiteAfter, review.mateWhiteAfter)
    : formatEvaluation(review.cpWhiteBefore, review.mateWhiteBefore);
}

export function positionFenAt(game: ParsedGame, cursor: number) {
  if (cursor <= 0) return game.initialFen;
  return game.moves[Math.min(cursor, game.moves.length) - 1]?.after ?? game.initialFen;
}

export { emptyCounts };
