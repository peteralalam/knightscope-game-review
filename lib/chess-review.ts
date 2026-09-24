import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import {
  gamePhase,
  isFreeCapture,
  isObviousRecapture,
  legalMoveCount as countLegalMoves,
  lineMaterialGain,
  materialTrajectory,
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
  /**
   * Genuinely viable moves: candidates within the "good" band of the best move.
   * A lower bound when every searched candidate was viable (`viableMovesAtLeast`).
   */
  viableMoves?: number;
  viableMovesAtLeast?: boolean;
  onlyMove: boolean;
  /**
   * UNIQUENESS: how much better the played move is than the best alternative, in
   * human expected score (the candidate-pass gap, never negative).
   */
  moveUniqueness?: number;
  /**
   * IMPORTANCE: how much of that gap changes the likely RESULT. Both scores are
   * clamped to the undecided range [OUTCOME_BANDS.losing, OUTCOME_BANDS.winning]
   * before subtracting, so choosing between two already-winning (or two
   * already-lost) continuations has zero importance however large the raw gap.
   */
  outcomeImportance?: number;
  /** Outcome band after the played move vs after the best alternative, e.g. "balanced vs losing". */
  outcomeTransition?: string;
  /** Stockfish WDL result class (win/draw/loss) after the played move vs the best alternative. */
  objectiveTransition?: string;
}

/** Evidence for (or against) a Brilliant. Material is in pawn units from the mover's side. */
export interface BrilliantDiagnostics {
  materialBefore: number;
  materialAfterMove: number;
  /** After Stockfish's best reply (which may decline the offer). */
  materialAfterBestDefense: number;
  materialAfterPV: number;
  pvPliesInspected: number;
  sacrificedPiece: string;
  sacrificeSquare: string;
  sacrificeKind: string;
  sacrificeValue: number;
  /** "board": left en prise now (SEE); "line": only lost along Stockfish's main line. */
  detectedBy: "board" | "line";
  expectedScoreBefore: number;
  expectedScoreAfter: number;
  /** Mover's expected score when the opponent takes the material (forced-capture search when declined). */
  expectedScoreAfterAcceptance?: number;
  bestDefense?: string;
  acceptanceIsBestDefense: boolean;
  recoveredAfterPlies?: number;
  forcedMate?: number;
  bestMoveRank: number | null;
  bestAlternativeExpectedScore?: number;
  /** Expected score of the move in the deeper verification search, when one ran. */
  deepVerificationScore?: number;
  /** "brilliant", or the first rule that rejected the promotion. */
  decision: string;
}

/** Why a move was (or was not) promoted to Great. Produced for every Great candidate. */
export interface GreatDiagnostics {
  evaluationBefore: string;
  bestMove: string;
  playedMove: string;
  bestExpectedScore: number;
  playedExpectedScore: number;
  secondBestExpectedScore?: number;
  thirdBestExpectedScore?: number;
  gapBestToSecond?: number;
  numberOfAcceptableMoves?: number;
  acceptableMovesIsLowerBound?: boolean;
  legalMoveCount: number;
  positionStateBefore: string;
  positionStateAfter: string;
  /** State before the opponent's previous move (the baseline an error is measured from). */
  positionStateBeforeOpponentMove?: string;
  onlyMove: boolean;
  outcomeTransition?: string;
  objectiveTransition?: string;
  moveUniqueness?: number;
  outcomeImportance?: number;
  /** Expected score gained over the pre-opponent-move baseline (an opponent error created a chance). */
  tacticalOpportunity: number;
  forcedMove: boolean;
  obviousRecapture: boolean;
  freeCapture: boolean;
  /** The move was already in the line of the mover's previous Great / Brilliant move. */
  plannedFollowUp: boolean;
  /** The mover's previous move was already critical (Great, Brilliant, or part of the same run). */
  continuesCriticalSequence: boolean;
  /** The position before the move already occurred earlier in the game with the same side to move. */
  repeatedPosition: boolean;
  opponentPreviousMoveLoss: number;
  greatReason?: string;
  /** "great", or the first rule that rejected the promotion. */
  decision: string;
}

export interface ReviewContext {
  /** The opponent's move immediately before this one, already reviewed. */
  previous?: ReviewedMove;
  /** The mover's own previous move, already reviewed. */
  previousOwn?: ReviewedMove;
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
  /** Present for every Brilliant candidate (near-best move that gives up material), promoted or not. */
  brilliantDiagnostics?: BrilliantDiagnostics;
  /** Present for every Great candidate (near-best and unique), promoted or not. */
  greatDiagnostics?: GreatDiagnostics;
  miss?: MissInfo;
  classificationReason: string;
  explanation: string;
  engineVersion?: string;
}

export interface PerformanceFeatures {
  meaningfulMoves: number;
  effectiveMoves: number;
  /** Plies in the whole game (both sides). */
  gameLength: number;
  meanLoss: number;
  medianLoss: number;
  p75Loss: number;
  p90Loss: number;
  /** Mean loss weighted by how much was at stake (balanced positions count most). */
  complexityWeightedLoss: number;
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
  openingAccuracy: number | null;
  middlegameAccuracy: number | null;
  endgameAccuracy: number | null;
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
  /** The game's time control has no model of its own; the nearest (blitz / rapid) was used. */
  extrapolated?: boolean;
  /** Mean absolute error of this model on held-out players (Elo points). */
  heldOutMae?: number;
  /** Share of held-out players whose rating fell inside the 80 % range. */
  heldOutCoverage?: number;
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
  const band = outcomeBand(played.humanExpectedScore);
  return `keeps the position ${OUTCOME_WORDS[band]} (${percent(played.humanExpectedScore)} expected score)`;
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

const round4 = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * 10_000) / 10_000);

/** Clamp an expected score to the undecided range: differences inside a decided zone do not change the result. */
function undecided(expected: number) {
  return clamp(expected, OUTCOME_BANDS.losing, OUTCOME_BANDS.winning);
}

const RESULT_RANK = { loss: 0, draw: 1, win: 2 } as const;

/** Stockfish's WDL verdict for one side: the outcome with probability ≥ ½, else a draw. */
function objectiveResult(evaluation: Evaluation): keyof typeof RESULT_RANK {
  if (evaluation.engineWdl.win >= 0.5) return "win";
  if (evaluation.engineWdl.loss >= 0.5) return "loss";
  return "draw";
}

function formatMoverEvaluation(evaluation: Evaluation, color: Color) {
  const sign = color === "w" ? 1 : -1;
  const mating = matingIn(evaluation);
  const mated = matedIn(evaluation);
  return formatEvaluation(
    evaluation.cp === undefined ? undefined : evaluation.cp * sign,
    mating !== undefined ? mating * sign : mated !== undefined ? -mated * sign : undefined,
  );
}

const CONTINUATION_DECISION = "rejected: continues the critical sequence credited to an earlier move";
const FOLLOW_UP_DECISION = "rejected: planned follow-up of the previous Great/Brilliant move";

/**
 * A run of consecutive critical moves by one side – a perpetual check, a king
 * shuffle holding a fortress, the forced follow-through of an attack – is one
 * decision, credited once, to the move that started it.
 */
function continuesCriticalSequence(context: ReviewContext) {
  const own = context.previousOwn;
  if (!own) return false;
  return (
    own.grade === "great" ||
    own.grade === "brilliant" ||
    own.greatDiagnostics?.decision === CONTINUATION_DECISION ||
    own.greatDiagnostics?.decision === FOLLOW_UP_DECISION
  );
}

/** Same placement, side to move, castling and en-passant rights as an earlier position in the game. */
function positionRepeated(game: ParsedGame, moveIndex: number) {
  const key = (fen: string) => fen.split(" ").slice(0, 4).join(" ");
  const current = key(game.moves[moveIndex].before);
  for (let index = moveIndex - 2; index >= 0; index -= 2) {
    if (key(game.moves[index].before) === current) return true;
  }
  return false;
}

/**
 * The move was already the planned continuation of the mover's previous Great /
 * Brilliant move: that line had the opponent's actual reply followed by this
 * move. The credit belongs to the earlier move.
 */
function isPlannedFollowUp(move: ParsedMove, context: ReviewContext) {
  const own = context.previousOwn;
  const reply = context.previous;
  if (!own || !reply || (own.grade !== "great" && own.grade !== "brilliant")) return false;
  const line = own.resultingEvaluation.pv[0] === own.uci ? own.resultingEvaluation.pv : [own.uci, ...own.resultingEvaluation.pv];
  return line[1] === reply.uci && line[2] === move.uci;
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

  const bestE = bestEvaluation.humanExpectedScore;
  const playedE = resultingEvaluation.humanExpectedScore;
  let loss = isTop ? 0 : Math.max(0, bestE - playedE);
  if (!isTop && topCandidate && playedCandidate) {
    // Two independent comparisons of the same move; averaging damps search noise.
    loss = (loss + Math.max(0, topCandidate.humanExpectedScore - playedCandidate.humanExpectedScore)) / 2;
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
      Math.abs(engine.verification[0].humanExpectedScore - bestE) > VERIFICATION.maxDrift);

  // --- Criticality from the candidate pass --------------------------------
  const playedScoreForGap = playedCandidate?.humanExpectedScore ?? (isTop ? bestE : playedE);
  const gap = bestAlternative ? playedScoreForGap - bestAlternative.humanExpectedScore : undefined;
  const candidateList = engine.verification ?? engine.candidates ?? [];
  const goodMoves = candidateList.length
    ? candidateList.filter((line) => candidateList[0].humanExpectedScore - line.humanExpectedScore <= LOSS_BANDS.good).length
    : undefined;
  const viableMoves = goodMoves;
  const alternativeScore = bestAlternative?.humanExpectedScore;
  const moveUniqueness = gap === undefined ? undefined : Math.max(0, gap);
  const outcomeImportance =
    alternativeScore === undefined ? undefined : Math.max(0, undecided(playedScoreForGap) - undecided(alternativeScore));
  const playedResultClass = objectiveResult(playedCandidate ?? (isTop ? bestEvaluation : resultingEvaluation));
  const criticality: Criticality = {
    gap,
    bestAlternative: bestAlternative?.pv[0],
    bestAlternativeSan: bestAlternative ? uciToSan(move.before, bestAlternative.pv[0]) : undefined,
    goodMoves,
    viableMoves,
    viableMovesAtLeast: viableMoves !== undefined && viableMoves === candidateList.length,
    onlyMove: gap !== undefined && gap >= GREAT.minGap && (goodMoves ?? 2) <= 1,
    moveUniqueness,
    outcomeImportance,
    outcomeTransition:
      alternativeScore === undefined
        ? undefined
        : `${OUTCOME_WORDS[outcomeBand(playedScoreForGap)]} vs ${OUTCOME_WORDS[outcomeBand(alternativeScore)]}`,
    objectiveTransition: bestAlternative ? `${playedResultClass} vs ${objectiveResult(bestAlternative)}` : undefined,
  };

  // --- Book ------------------------------------------------------------------
  const isBook =
    context.useBook !== false &&
    moveIndex < BOOK.maxPly &&
    loss < BOOK.maxLoss &&
    playedMated === undefined &&
    isBookPosition(move.after);

  // --- Brilliant -------------------------------------------------------------
  // Brilliant = a real, sound, non-obvious sacrifice. Every sacrifice candidate
  // (near-best move that gives up material) gets structured evidence and the
  // first rule that rejected it. False positives are worse than misses, so each
  // rule errs toward rejecting.
  let sacrifice: Sacrifice | undefined;
  let brilliantReason: string | undefined;
  let brilliantDiagnostics: BrilliantDiagnostics | undefined;
  const nearBest = isTop || loss <= BRILLIANT.maxLoss;
  if (!isBook && nearBest && legalMoveCount >= 2 && !mateInOne) {
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
        // Declining is Stockfish's best defence. That is fine – the offer (and
        // the threat behind it) can be the point – as long as ACCEPTING is not a
        // refutation: the forced-capture search must leave the mover at least
        // as well off as the main line.
        candidate = { ...offered, accepted: false };
        if (engine.acceptance) {
          acceptanceOk =
            engine.acceptance.humanExpectedScore >= BRILLIANT.minExpectedAfter &&
            engine.acceptance.humanExpectedScore >= playedE - BRILLIANT.acceptanceTolerance;
        }
      }
    } else if (realized && realized.piece !== "p") {
      candidate = realized;
    }
    // Offered on the board (SEE) vs only arising along the engine line.
    const detectedBy = statics.length > 0 ? "board" : "line";

    if (candidate) {
      const alternativeScore = bestAlternative?.humanExpectedScore;
      // When a quiet alternative already wins overwhelmingly, the sacrifice is
      // a flourish – even a faster forced mate does not change the result.
      const unnecessary = alternativeScore !== undefined && alternativeScore >= BRILLIANT.alternativeAlreadyWinning;
      const edgeOk = gap === undefined || gap >= ratingEdge(context.playerRating);
      const candidateConfirms = !playedCandidate || !topCandidate ||
        topCandidate.humanExpectedScore - playedCandidate.humanExpectedScore <= BRILLIANT.maxLoss;
      // Material regained by force almost at once is a combination, not a sacrifice.
      const pseudo =
        candidate.accepted === true &&
        candidate.recoveredAfterPlies !== undefined &&
        candidate.recoveredAfterPlies <= BRILLIANT.pseudoRecoveryPlies;
      // Material that only goes missing along the engine line (nothing was
      // offered on the board) and comes back within that line is move-order
      // noise – an intermezzo or exchange sequence – not an investment.
      const lineOnlyRegained = detectedBy === "line" && candidate.recoveredAfterPlies !== undefined;
      // Giving up material because every other move is mated is not a choice.
      const forcedByMate =
        bestAlternative !== undefined && matedIn(bestAlternative) !== undefined && outcomeBand(playedE) <= 2;

      let decision = "brilliant";
      if (checkEvasion) decision = "rejected: check evasion";
      else if (isPlannedFollowUp(move, context)) decision = FOLLOW_UP_DECISION;
      else if (context.previousOwn?.grade === "brilliant") decision = "rejected: continues the combination credited to the previous Brilliant move";
      else if (unstable) decision = "rejected: evaluation unstable across searches";
      else if (!candidateList.length) decision = "rejected: no candidate search (cannot judge alternatives)";
      else if (playedCandidate === undefined && !isTop) decision = "rejected: move not confirmed by the candidate search";
      else if (!candidateConfirms) decision = "rejected: candidate search rates another move higher";
      else if (playedE < BRILLIANT.minExpectedAfter) decision = "rejected: position after the sacrifice is not good enough";
      else if (!acceptanceOk) decision = "rejected: accepting the sacrifice refutes it";
      else if (pseudo) decision = `rejected: material regained within ${candidate.recoveredAfterPlies} plies (pseudo-sacrifice)`;
      else if (lineOnlyRegained) decision = "rejected: nothing offered on the board, and the line regains the material";
      else if (forcedByMate) decision = "rejected: forced – every alternative is mated";
      else if (unnecessary) decision = "rejected: a simpler move was already winning";
      else if (!edgeOk) decision = "rejected: not clearly better than the alternatives for this rating";

      const trajectory = materialTrajectory(move.before, [move.uci, ...continuation.slice(0, BRILLIANT.pvPlies - 1)], move.color);
      const verificationLine = engine.verification?.find((line) => line.pv[0] === move.uci);
      const forcedMate = matingIn(resultingEvaluation);
      brilliantDiagnostics = {
        materialBefore: trajectory[0] ?? 0,
        materialAfterMove: trajectory[1] ?? trajectory[0] ?? 0,
        materialAfterBestDefense: trajectory[2] ?? trajectory[1] ?? 0,
        materialAfterPV: trajectory.at(-1) ?? 0,
        pvPliesInspected: Math.max(0, trajectory.length - 1),
        sacrificedPiece: PIECE_NAME[candidate.piece],
        sacrificeSquare: candidate.square,
        sacrificeKind: candidate.kind,
        sacrificeValue: candidate.material,
        detectedBy,
        expectedScoreBefore: round4(bestE)!,
        expectedScoreAfter: round4(playedE)!,
        expectedScoreAfterAcceptance: round4(
          candidate.accepted ? playedE : engine.acceptance?.humanExpectedScore,
        ),
        bestDefense: continuation[0] ? uciToSan(move.after, continuation[0]) : undefined,
        acceptanceIsBestDefense: candidate.accepted === true,
        recoveredAfterPlies: candidate.recoveredAfterPlies,
        forcedMate: forcedMate !== undefined && forcedMate > 0 ? forcedMate : undefined,
        bestMoveRank: isTop ? 1 : engine.playedRank,
        bestAlternativeExpectedScore: round4(alternativeScore),
        deepVerificationScore: round4(verificationLine?.humanExpectedScore),
        decision,
      };

      if (decision === "brilliant") {
        sacrifice = candidate;
        const acceptanceText = candidate.accepted
          ? candidate.recoveredAfterPlies !== undefined
            ? `Stockfish's best defence takes it, and the material comes back ${candidate.recoveredAfterPlies} plies later`
            : "Stockfish's best defence takes it"
          : engine.acceptance
            ? `Taking it leaves the opponent worse off (${percent(1 - engine.acceptance.humanExpectedScore)} for them after the capture)`
            : "Stockfish's best defence declines it";
        brilliantReason = `${isTop ? "Best move" : "Near-best move"}. ${describeSacrifice(candidate)}. ${acceptanceText}, and the move ${describeOutcome(resultingEvaluation)}.`;
        grade = "brilliant";
      }
    }
  }

  // --- Great -----------------------------------------------------------------
  // Great = the move is (near-)best AND unique AND the uniqueness matters for the
  // result. Uniqueness alone (a big gap between two winning moves) is not enough,
  // and neither is being Stockfish's #1. Every candidate gets diagnostics.
  let greatReason: string | undefined;
  let greatDiagnostics: GreatDiagnostics | undefined;
  const opponentLoss = context.previous?.expectedPointsLost ?? 0;
  const baseline = context.previous ? 1 - context.previous.expectedBefore : 0.5;
  const freeCapture = isFreeCapture(move.before, move.uci);
  const plannedFollowUp = isPlannedFollowUp(move, context);
  const continuesSequence = continuesCriticalSequence(context);
  const repeatedPosition = positionRepeated(game, moveIndex);
  const forcedMove = checkEvasion || legalMoveCount <= 2;
  if (
    grade !== "brilliant" &&
    !isBook &&
    legalMoveCount >= 2 &&
    (isTop || loss <= GREAT.maxLoss) &&
    gap !== undefined &&
    bestAlternative &&
    gap >= GREAT.minGap
  ) {
    const playedBand = outcomeBand(playedScoreForGap);
    const alternativeBand = outcomeBand(bestAlternative.humanExpectedScore);
    const baselineBand = outcomeBand(baseline);
    // The alternative must change the likely result: either Stockfish's own WDL
    // verdict (win / draw / loss) flips, or the human expected score falls by at
    // least two outcome bands (e.g. winning → balanced, balanced → losing).
    const objectiveChange = RESULT_RANK[playedResultClass] > RESULT_RANK[objectiveResult(bestAlternative)];
    const altSan = criticality.bestAlternativeSan ?? "the next-best move";
    const altText = `the best alternative, ${altSan}, scores ${percent(bestAlternative.humanExpectedScore)} against ${percent(playedScoreForGap)}`;
    let decision = "great";
    if (obviousRecapture) decision = "rejected: recapture";
    else if (freeCapture) decision = "rejected: takes a hanging piece";
    else if (mateInOne) decision = "rejected: mate in one";
    else if (forcedMove) decision = "rejected: forced (check evasion or ≤ 2 legal moves)";
    else if (unstable) decision = "rejected: evaluation unstable across searches";
    else if (plannedFollowUp) decision = FOLLOW_UP_DECISION;
    else if (continuesSequence) decision = CONTINUATION_DECISION;
    else if (repeatedPosition) decision = "rejected: the same position already occurred (decision already made)";
    else if (playedE < GREAT.minExpectedAfter) decision = "rejected: only postpones defeat";
    else if ((outcomeImportance ?? 0) < GREAT.minImportance) decision = "rejected: alternatives lead to the same outcome";
    else if (!objectiveChange && playedBand - alternativeBand < GREAT.minBandDrop) {
      decision = "rejected: the alternative keeps the same result class";
    }

    if (decision === "great") {
      if (opponentLoss >= GREAT.punishOpponentLoss && baselineBand <= 2 && playedBand >= 3) {
        greatReason = `Punishes the opponent's error: it turns a ${OUTCOME_WORDS[baselineBand]} position into a ${OUTCOME_WORDS[playedBand]} one, while ${altText} (${OUTCOME_WORDS[alternativeBand]}).`;
      } else if (playedBand >= 2 && alternativeBand <= 1) {
        greatReason = `Only move that holds: ${altText} (${OUTCOME_WORDS[alternativeBand]}).`;
      } else if (playedBand === 4) {
        greatReason = `Only move that keeps the win: ${altText} (${OUTCOME_WORDS[alternativeBand]}).`;
      } else {
        greatReason = `Critical move: it keeps the position ${OUTCOME_WORDS[playedBand]}, while ${altText} (${OUTCOME_WORDS[alternativeBand]}).`;
      }
      grade = "great";
    }

    greatDiagnostics = {
      evaluationBefore: formatMoverEvaluation(bestEvaluation, move.color),
      bestMove: bestMoveSan,
      playedMove: move.san,
      bestExpectedScore: round4(topCandidate?.humanExpectedScore ?? bestE)!,
      playedExpectedScore: round4(playedScoreForGap)!,
      secondBestExpectedScore: round4(candidateList[1]?.humanExpectedScore),
      thirdBestExpectedScore: round4(candidateList[2]?.humanExpectedScore),
      gapBestToSecond: candidateList[1] ? round4(candidateList[0].humanExpectedScore - candidateList[1].humanExpectedScore) : undefined,
      numberOfAcceptableMoves: viableMoves,
      acceptableMovesIsLowerBound: criticality.viableMovesAtLeast,
      legalMoveCount,
      positionStateBefore: OUTCOME_WORDS[outcomeBand(bestE)],
      positionStateAfter: OUTCOME_WORDS[outcomeBand(playedE)],
      positionStateBeforeOpponentMove: context.previous ? OUTCOME_WORDS[baselineBand] : undefined,
      onlyMove: criticality.onlyMove,
      outcomeTransition: criticality.outcomeTransition,
      objectiveTransition: criticality.objectiveTransition,
      moveUniqueness: round4(moveUniqueness),
      outcomeImportance: round4(outcomeImportance),
      tacticalOpportunity: round4(bestE - baseline)!,
      forcedMove,
      obviousRecapture,
      freeCapture,
      plannedFollowUp,
      continuesCriticalSequence: continuesSequence,
      repeatedPosition,
      opponentPreviousMoveLoss: round4(opponentLoss)!,
      greatReason,
      decision,
    };
  }

  // --- Miss ------------------------------------------------------------------
  let miss: MissInfo | undefined;
  if (grade !== "brilliant" && grade !== "great" && !isTop && legalMoveCount >= 2) {
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
      ? bestAlternative.humanExpectedScore >= INFORMATIVENESS.decidedThreshold
      : bestAlternative.humanExpectedScore <= 1 - INFORMATIVENESS.decidedThreshold);
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
    greatDiagnostics,
    brilliantDiagnostics,
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

  const stakesWeight = (move: ReviewedMove) =>
    move.informativeness * (0.25 + 4 * move.expectedBefore * (1 - move.expectedBefore));
  const stakesTotal = decisions.reduce((sum, move) => sum + stakesWeight(move), 0);
  const inPhase = (phase: Phase) => decisions.filter((move) => move.phase === phase);

  return {
    meaningfulMoves: decisions.filter((move) => move.informativeness >= 0.5).length,
    effectiveMoves,
    gameLength: Math.max(...sideMoves.map((move) => move.index)) + 2,
    meanLoss,
    medianLoss: quantile(losses, 0.5),
    p75Loss: quantile(losses, 0.75),
    p90Loss: quantile(losses, 0.9),
    complexityWeightedLoss: stakesTotal > 0
      ? decisions.reduce((sum, move) => sum + stakesWeight(move) * move.expectedPointsLost, 0) / stakesTotal
      : meanLoss,
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
    openingAccuracy: meanAccuracy(inPhase("opening")),
    middlegameAccuracy: meanAccuracy(inPhase("middlegame")),
    endgameAccuracy: meanAccuracy(inPhase("endgame")),
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

  const features = extractFeatures(sideMoves);
  const performance = estimatePerformance(sideMoves, {
    ...options,
    features,
    timeControl: classifyTimeControl(headers.TimeControl),
  });

  return {
    accuracy: aggregateAccuracy(reviews, color) ?? 100,
    counts,
    moveCount: sideMoves.length,
    phaseAccuracy,
    features,
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
