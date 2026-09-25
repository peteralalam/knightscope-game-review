/**
 * Engine evaluations as outcome probabilities.
 *
 * Every Evaluation is expressed from the point of view of ONE side (whoever
 * the producer says – the UCI side to move for raw engine output, the moving
 * player after `invert` for played-move evaluations). Callers never compare
 * raw centipawns across sides; they compare `baselineExpectedScore`.
 *
 * Every probability-like number here is an EXPECTED SCORE, E[result] with
 * win = 1, draw = ½, loss = 0 – never a win probability. Two scales are kept
 * apart on purpose (see BASELINE_CURVE in review-config.ts):
 *   engineWdl / engineExpectedScore – Stockfish's own WDL model, diagnostics only
 *   baselineExpectedScore           – a FIXED, rating-independent curve (Lichess's
 *                                     published "Win%" constant), used for grading
 * The rating-conditioned human model E[result | cp, rating, time control] lives
 * in outcome-model.ts and is applied on top of `cp`, not stored here.
 */

export interface Wdl {
  win: number;
  draw: number;
  loss: number;
}

export interface TablebaseScore {
  /** true = the side this evaluation belongs to wins. */
  win: boolean;
  /** Plies to the tablebase-backed conversion reported by Stockfish. */
  plies: number;
}

import { BASELINE_CURVE } from "./review-config.ts";

export interface Evaluation {
  /** Stockfish-normalized centipawns (100 = 50 % win chance in engine play). */
  cp?: number;
  /** Moves (not plies) to mate; positive = this side mates. 0 = this side is mated. */
  mate?: number;
  tablebase?: TablebaseScore;
  /** Stockfish's WDL (engine-play outcome probabilities), normalized to sum to 1. Diagnostics only. */
  engineWdl: Wdl;
  /** Engine WDL expected score: P(win) + ½·P(draw). Diagnostics only. */
  engineExpectedScore: number;
  /**
   * The value every classification uses: the fixed baseline curve
   * `baselineCurveExpectedScore(cp)`, or exactly 0 / 1 for mates and tablebase
   * results (and ½ for a drawn terminal position). An expected score (draws
   * count ½), not a win probability, and independent of the players' ratings.
   */
  baselineExpectedScore: number;
  depth: number;
  seldepth?: number;
  nodes: number;
  multipv?: number;
  pv: string[];
  engineVersion?: string;
  /**
   * Set when the score is an aspiration-window bound rather than exact. Only
   * used when Stockfish's final `bestmove` fails high after the last exact line.
   */
  bound?: "lower" | "upper";
}

/** Stockfish reports tablebase wins as cp ±(20000 − plies); see sf_19 src/uci.cpp. */
const TB_CP = 20_000;
const TB_CP_RANGE = 1_000;

const MATE_WDL: Wdl = { win: 1, draw: 0, loss: 0 };
const MATED_WDL: Wdl = { win: 0, draw: 0, loss: 1 };
const DRAW_WDL: Wdl = { win: 0, draw: 1, loss: 0 };

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function expectedFromWdl(wdl: Wdl) {
  return clamp01(wdl.win + wdl.draw / 2);
}

/**
 * Fixed, rating-independent expected score for Stockfish-normalized
 * centipawns: Lichess's published "Win%" curve divided by 100. Lichess calls it
 * a win percentage, but it was fitted to game results with draws counted as ½,
 * so it is an expected score.
 */
export function baselineCurveExpectedScore(cp: number) {
  return 1 / (1 + Math.exp(-BASELINE_CURVE.slopePerCp * cp));
}

function materialCount(fen: string) {
  const placement = fen.split(" ")[0] ?? "";
  let material = 0;
  for (const char of placement.toLowerCase()) {
    if (char === "p") material += 1;
    else if (char === "n" || char === "b") material += 3;
    else if (char === "r") material += 5;
    else if (char === "q") material += 9;
  }
  return material;
}

/**
 * Stockfish 19's own win-rate model (official-stockfish/Stockfish sf_19,
 * src/uci.cpp `win_rate_params`). Used only when an info line carries a score
 * but no `wdl` field, so every evaluation still gets probabilities that agree
 * with what the engine itself would have printed.
 */
export function stockfishWdl(cp: number, fen: string): Wdl {
  const m = Math.min(78, Math.max(17, materialCount(fen))) / 58;
  const a = ((-142.72052667 * m + 372.35176398) * m - 340.71073572) * m + 415.23490212;
  const b = ((5.93832785 * m + 15.61267078) * m - 30.57816876) * m + 69.63866711;
  const internal = (cp * a) / 100;
  const win = 1 / (1 + Math.exp((a - internal) / b));
  const loss = 1 / (1 + Math.exp((a + internal) / b));
  return { win, draw: Math.max(0, 1 - win - loss), loss };
}

function decodeTablebase(cp: number): TablebaseScore | undefined {
  const magnitude = Math.abs(cp);
  if (magnitude > TB_CP - TB_CP_RANGE && magnitude <= TB_CP) {
    return { win: cp > 0, plies: TB_CP - magnitude };
  }
  return undefined;
}

export function makeEvaluation(input: {
  cp?: number;
  mate?: number;
  wdl?: Wdl;
  fen?: string;
  depth?: number;
  seldepth?: number;
  nodes?: number;
  multipv?: number;
  pv?: string[];
  engineVersion?: string;
}): Evaluation {
  let wdl: Wdl;
  let tablebase: TablebaseScore | undefined;
  let decisive = true;
  if (input.mate !== undefined) {
    // Mate scores are decisive regardless of what a WDL head would say.
    wdl = input.mate > 0 ? MATE_WDL : MATED_WDL;
  } else if (input.cp !== undefined && (tablebase = decodeTablebase(input.cp))) {
    wdl = tablebase.win ? MATE_WDL : MATED_WDL;
  } else if (input.wdl) {
    decisive = false;
    const total = input.wdl.win + input.wdl.draw + input.wdl.loss;
    wdl = total > 0
      ? { win: input.wdl.win / total, draw: input.wdl.draw / total, loss: input.wdl.loss / total }
      : DRAW_WDL;
  } else if (input.cp !== undefined) {
    decisive = false;
    wdl = stockfishWdl(input.cp, input.fen ?? "");
  } else {
    wdl = DRAW_WDL;
  }
  const engineExpectedScore = expectedFromWdl(wdl);
  const baseline = !decisive && input.cp !== undefined ? baselineCurveExpectedScore(input.cp) : undefined;
  return {
    cp: tablebase ? undefined : input.cp,
    mate: input.mate,
    tablebase,
    engineWdl: wdl,
    engineExpectedScore,
    baselineExpectedScore: baseline ?? engineExpectedScore,
    depth: input.depth ?? 0,
    seldepth: input.seldepth,
    nodes: input.nodes ?? 0,
    multipv: input.multipv,
    pv: input.pv ?? [],
    engineVersion: input.engineVersion,
  };
}

/** Evaluation of a terminal position, from the side to move. */
export function terminalEvaluation(kind: "checkmate" | "draw", engineVersion?: string): Evaluation {
  return makeEvaluation(
    kind === "checkmate"
      ? { mate: 0, engineVersion }
      : { wdl: { win: 0, draw: 1000, loss: 0 }, cp: 0, engineVersion },
  );
}

/**
 * Flip an evaluation to the other side. `mate 0` (side to move is mated)
 * becomes a win for the side that delivered it; we keep `mate: 0` out of the
 * flipped result and mark it as mate 1-equivalent via probabilities only.
 */
export function invertEvaluation(evaluation: Evaluation): Evaluation {
  const mate = evaluation.mate === undefined
    ? undefined
    : evaluation.mate === 0
      ? 0
      : -evaluation.mate;
  return {
    ...evaluation,
    cp: evaluation.cp === undefined ? undefined : -evaluation.cp,
    mate,
    tablebase: evaluation.tablebase
      ? { win: !evaluation.tablebase.win, plies: evaluation.tablebase.plies }
      : undefined,
    engineWdl: { win: evaluation.engineWdl.loss, draw: evaluation.engineWdl.draw, loss: evaluation.engineWdl.win },
    engineExpectedScore: 1 - evaluation.engineExpectedScore,
    baselineExpectedScore: 1 - evaluation.baselineExpectedScore,
  };
}

/** Positive mate distance for the side this evaluation belongs to, if it mates. */
export function matingIn(evaluation: Evaluation | undefined) {
  if (!evaluation || evaluation.mate === undefined) return undefined;
  if (evaluation.mate > 0) return evaluation.mate;
  // A flipped `mate 0` means this side has just delivered mate.
  if (evaluation.mate === 0 && evaluation.baselineExpectedScore === 1) return 0;
  return undefined;
}

/** Positive mate distance against the side this evaluation belongs to. */
export function matedIn(evaluation: Evaluation | undefined) {
  if (!evaluation || evaluation.mate === undefined) return undefined;
  if (evaluation.mate < 0) return -evaluation.mate;
  if (evaluation.mate === 0 && evaluation.baselineExpectedScore === 0) return 0;
  return undefined;
}

export interface ParsedInfo {
  multipv: number;
  evaluation: Evaluation;
  bound?: "lower" | "upper";
}

/**
 * Parse a UCI `info` line into an Evaluation from the side to move.
 * Returns null for lines without a score or PV, and – unless `includeBounds` –
 * for aspiration-window `lowerbound` / `upperbound` lines, whose scores are not final.
 */
export function parseInfoLine(
  line: string,
  fen: string,
  engineVersion?: string,
  includeBounds = false,
): ParsedInfo | null {
  if (!line.startsWith("info ")) return null;
  const score = line.match(/\bscore (cp|mate) (-?\d+)(?: (lowerbound|upperbound))?/);
  if (!score || (score[3] && !includeBounds)) return null;
  const bound = score[3] === "lowerbound" ? "lower" : score[3] === "upperbound" ? "upper" : undefined;
  const pvMatch = line.match(/\bpv (.+)$/);
  if (!pvMatch) return null;
  const wdlMatch = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  const evaluation = makeEvaluation({
    cp: score[1] === "cp" ? Number(score[2]) : undefined,
    mate: score[1] === "mate" ? Number(score[2]) : undefined,
    wdl: wdlMatch
      ? { win: Number(wdlMatch[1]), draw: Number(wdlMatch[2]), loss: Number(wdlMatch[3]) }
      : undefined,
    fen,
    depth: Number(line.match(/\bdepth (\d+)/)?.[1] ?? 0),
    seldepth: Number(line.match(/\bseldepth (\d+)/)?.[1] ?? 0) || undefined,
    nodes: Number(line.match(/\bnodes (\d+)/)?.[1] ?? 0),
    pv: pvMatch[1].trim().split(/\s+/),
    engineVersion,
  });
  return {
    multipv: Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1),
    evaluation: bound ? { ...evaluation, bound } : evaluation,
    bound,
  };
}
