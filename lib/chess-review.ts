import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";

export type Grade =
  | "brilliant"
  | "great"
  | "best"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder";

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

export interface EngineLine {
  depth: number;
  nodes: number;
  cp?: number;
  mate?: number;
  expected: number;
  pv: string[];
}

export interface EngineMoveResult {
  bestMove: string;
  best: EngineLine;
  second?: EngineLine;
  played: EngineLine;
  playedRank: number | null;
}

export interface ReviewedMove extends ParsedMove {
  grade: Grade;
  rawLoss: number;
  loss: number;
  accuracy: number;
  uniqueness: number;
  bestMove: string;
  bestMoveSan: string;
  bestLineSan: string[];
  playedLineSan: string[];
  legalMoveCount: number;
  expectedBefore: number;
  expectedAfter: number;
  expectedWhiteBefore: number;
  expectedWhiteAfter: number;
  cpWhiteBefore?: number;
  cpWhiteAfter?: number;
  mateWhiteBefore?: number;
  mateWhiteAfter?: number;
  explanation: string;
}

export interface SideSummary {
  accuracy: number;
  counts: Record<Grade, number>;
  moveCount: number;
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
  "good",
  "inaccuracy",
  "mistake",
  "blunder",
];

export const GRADE_META: Record<
  Grade,
  { label: string; short: string; symbol: string }
> = {
  brilliant: { label: "Brilliant", short: "!!", symbol: "✦" },
  great: { label: "Great", short: "!", symbol: "★" },
  best: { label: "Best", short: "✓", symbol: "✓" },
  good: { label: "Good", short: "", symbol: "●" },
  inaccuracy: { label: "Inaccuracy", short: "?!", symbol: "?!" },
  mistake: { label: "Mistake", short: "?", symbol: "?" },
  blunder: { label: "Blunder", short: "??", symbol: "??" },
};

const MATERIAL: Record<PieceSymbol, number> = {
  p: 1,
  n: 3.2,
  b: 3.3,
  r: 5,
  q: 9,
  k: 0,
};

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
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

function uciParts(uci: string) {
  return {
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    promotion: (uci[4] || undefined) as PieceSymbol | undefined,
  };
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

function materialBalance(chess: Chess, mover: Color) {
  let score = 0;
  for (const rank of chess.board()) {
    for (const piece of rank) {
      if (!piece) continue;
      score += (piece.color === mover ? 1 : -1) * MATERIAL[piece.type];
    }
  }
  return score;
}

function isSoundSacrifice(move: ParsedMove, bestPv: string[]) {
  if (move.piece === "p" || move.piece === "k") return false;

  const mover = move.color;
  const line = new Chess(move.before);
  const beforeBalance = materialBalance(line, mover);
  const applied: Array<{ move: Move; balance: number }> = [];

  for (const uci of bestPv.slice(0, 8)) {
    try {
      const played = line.move(uciParts(uci));
      applied.push({ move: played, balance: materialBalance(line, mover) });
    } catch {
      break;
    }
  }

  for (let index = 0; index < applied.length; index += 1) {
    const current = applied[index];
    if (
      current.move.color === mover ||
      !current.move.captured ||
      current.move.captured === "p"
    ) {
      continue;
    }
    const dip = beforeBalance - current.balance;
    if (dip < 1.75) continue;

    const next = applied[index + 1];
    const immediateRecapture =
      next &&
      next.move.color === mover &&
      next.move.isCapture() &&
      next.move.to === current.move.to &&
      next.balance >= beforeBalance - 0.75;

    if (!immediateRecapture) return true;
  }

  try {
    const after = new Chess(move.after);
    const canBeTaken = after
      .moves({ verbose: true })
      .some((reply) => reply.to === move.to && reply.captured === move.piece);
    const offeredValue = MATERIAL[move.piece] - MATERIAL[move.captured ?? "k"];
    return canBeTaken && offeredValue >= 1.75;
  } catch {
    return false;
  }
}

function isCheckmate(fen: string) {
  try {
    return new Chess(fen).isCheckmate();
  } catch {
    return false;
  }
}

function buildExplanation(
  grade: Grade,
  loss: number,
  bestMoveSan: string,
  uniqueness: number,
) {
  const lossCopy =
    loss < 0.5
      ? "without giving away meaningful winning chances"
      : `at a cost of about ${loss.toFixed(1)}% in expected score`;

  switch (grade) {
    case "brilliant":
      return "A sound tactical sacrifice that holds up under the engine’s best defense.";
    case "great":
      return `A hard-to-find move. Other choices lose roughly ${uniqueness.toFixed(1)}% or more in expected score.`;
    case "best":
      return `This matches Stockfish’s first choice ${lossCopy}.`;
    case "good":
      return `A solid move ${lossCopy}. Stockfish slightly preferred ${bestMoveSan}.`;
    case "inaccuracy":
      return `A small slip ${lossCopy}. ${bestMoveSan} was more precise.`;
    case "mistake":
      return `This changes the character of the position ${lossCopy}. ${bestMoveSan} was the stronger continuation.`;
    case "blunder":
      return `A major turning point ${lossCopy}. The engine’s recommendation was ${bestMoveSan}.`;
  }
}

export function reviewMove(
  game: ParsedGame,
  moveIndex: number,
  engine: EngineMoveResult,
): ReviewedMove {
  const move = game.moves[moveIndex];
  const previous = game.moves[moveIndex - 1];
  const chess = new Chess(move.before);
  const legalMoveCount = chess.moves().length;
  const expectedBefore = clamp(engine.best.expected, 0, 1);
  const expectedAfter = clamp(engine.played.expected, 0, 1);
  const rawLoss = Math.max(0, (expectedBefore - expectedAfter) * 100);
  const loss = Math.max(0, rawLoss - 0.3);
  const uniqueness = Math.max(
    0,
    (engine.best.expected - (engine.second?.expected ?? engine.best.expected)) * 100,
  );
  const isTopMove = engine.playedRank === 1 || engine.bestMove === move.uci;
  const isRecapture = Boolean(move.captured && previous?.to === move.to);
  const openingMove = moveIndex < 8;
  const mateNow = isCheckmate(move.after);
  const nonTrivial = !openingMove && legalMoveCount >= 3 && !mateNow && !isRecapture;
  const sacrifice = isSoundSacrifice(move, engine.best.pv);

  let grade: Grade;
  if (
    isTopMove &&
    rawLoss <= 0.5 &&
    nonTrivial &&
    expectedAfter >= 0.35 &&
    sacrifice &&
    (uniqueness >= 3 || (engine.played.mate ?? 0) > 0)
  ) {
    grade = "brilliant";
  } else if (isTopMove && rawLoss <= 1 && nonTrivial && uniqueness >= 8) {
    grade = "great";
  } else if (mateNow || legalMoveCount === 1 || loss <= 0.6) {
    grade = "best";
  } else if (loss <= 2.5) {
    grade = "good";
  } else if (loss <= 8) {
    grade = "inaccuracy";
  } else if (loss <= 18) {
    grade = "mistake";
  } else {
    grade = "blunder";
  }

  const bestMate = engine.best.mate;
  const playedMate = engine.played.mate;
  if (playedMate !== undefined && playedMate < 0 && !(bestMate !== undefined && bestMate < 0)) {
    grade = "blunder";
  } else if (
    bestMate !== undefined &&
    bestMate < 0 &&
    playedMate !== undefined &&
    playedMate < 0
  ) {
    grade = isTopMove ? "best" : "good";
  } else if (bestMate !== undefined && bestMate > 0 && !(playedMate !== undefined && playedMate > 0)) {
    grade = bestMate <= 3 ? (loss > 8 ? grade : "mistake") : loss > 2.5 ? grade : "inaccuracy";
  }

  const statisticalLoss =
    grade === "blunder"
      ? Math.max(rawLoss, 20)
      : grade === "mistake"
        ? Math.max(rawLoss, 9)
        : grade === "inaccuracy"
          ? Math.max(rawLoss, 3)
          : rawLoss;
  const accuracy = clamp(100 * Math.exp(-4.5 * (statisticalLoss / 100)), 0, 100);
  const bestMoveSan = uciToSan(move.before, engine.bestMove);
  const rootToWhite = move.color === "w" ? 1 : -1;

  return {
    ...move,
    grade,
    rawLoss,
    loss,
    accuracy,
    uniqueness,
    bestMove: engine.bestMove,
    bestMoveSan,
    bestLineSan: pvToSan(move.before, engine.best.pv),
    playedLineSan: pvToSan(move.before, engine.played.pv),
    legalMoveCount,
    expectedBefore,
    expectedAfter,
    expectedWhiteBefore: move.color === "w" ? expectedBefore : 1 - expectedBefore,
    expectedWhiteAfter: move.color === "w" ? expectedAfter : 1 - expectedAfter,
    cpWhiteBefore:
      engine.best.cp === undefined ? undefined : engine.best.cp * rootToWhite,
    cpWhiteAfter:
      engine.played.cp === undefined ? undefined : engine.played.cp * rootToWhite,
    mateWhiteBefore:
      engine.best.mate === undefined ? undefined : engine.best.mate * rootToWhite,
    mateWhiteAfter:
      engine.played.mate === undefined ? undefined : engine.played.mate * rootToWhite,
    explanation: buildExplanation(grade, loss, bestMoveSan, uniqueness),
  };
}

function emptyCounts(): Record<Grade, number> {
  return {
    brilliant: 0,
    great: 0,
    best: 0,
    good: 0,
    inaccuracy: 0,
    mistake: 0,
    blunder: 0,
  };
}

export function summarizeSide(
  reviews: ReviewedMove[],
  color: Color,
  headers: Record<string, string>,
): SideSummary {
  const sideMoves = reviews.filter((move) => move.color === color);
  const counts = emptyCounts();
  for (const move of sideMoves) counts[move.grade] += 1;

  if (sideMoves.length === 0) {
    return { accuracy: 0, counts, moveCount: 0, estimatedRating: null };
  }

  let weightedAccuracy = 0;
  let harmonicDenominator = 0;
  let totalWeight = 0;
  for (const move of sideMoves) {
    const stakes = 4 * move.expectedBefore * (1 - move.expectedBefore);
    const criticality = clamp(move.uniqueness / 10, 0, 1);
    const weight = 0.5 + 0.25 * stakes + 0.25 * criticality;
    totalWeight += weight;
    weightedAccuracy += weight * move.accuracy;
    harmonicDenominator += weight / Math.max(move.accuracy, 1);
  }
  const arithmetic = weightedAccuracy / totalWeight;
  const harmonic = totalWeight / harmonicDenominator;
  const accuracy = Math.round(((arithmetic + harmonic) / 2) * 10) / 10;

  const decisions = sideMoves.filter(
    (move) => move.index >= 8 && move.legalMoveCount > 1,
  );
  let estimatedRating: SideSummary["estimatedRating"] = null;
  if (decisions.length >= 3) {
    let effectiveMoves = 0;
    let weightedLoss = 0;
    for (const move of decisions) {
      const stakes = 4 * move.expectedBefore * (1 - move.expectedBefore);
      const weight = 0.5 + 0.5 * stakes;
      effectiveMoves += weight;
      weightedLoss += weight * Math.min(move.rawLoss / 100, 0.4);
    }
    const meanLoss = weightedLoss / Math.max(effectiveMoves, 1);
    const adjustedLoss =
      (effectiveMoves * meanLoss + 4 * 0.02) / (effectiveMoves + 4);
    const center = Math.round(
      clamp(2100 - 585 * Math.log(Math.max(0.003, adjustedLoss) / 0.01), 400, 2800) /
        50,
    ) * 50;
    let halfWidth = clamp(180 + 850 / Math.sqrt(Math.max(1, effectiveMoves)), 275, 650);
    if (!headers.TimeControl) halfWidth += 75;
    const low = Math.floor(clamp(center - halfWidth, 400, 2800) / 100) * 100;
    const high = Math.ceil(clamp(center + halfWidth, 400, 2800) / 100) * 100;
    estimatedRating = {
      low,
      high,
      center,
      sample: effectiveMoves >= 18 ? "strong" : effectiveMoves >= 9 ? "fair" : "limited",
    };
  }

  return {
    accuracy,
    counts,
    moveCount: sideMoves.length,
    estimatedRating,
  };
}

export function formatEvaluation(cp?: number, mate?: number) {
  if (mate !== undefined) return mate > 0 ? `M${mate}` : `−M${Math.abs(mate)}`;
  if (cp === undefined) return "0.00";
  const pawns = cp / 100;
  if (Math.abs(pawns) < 0.005) return "0.00";
  return `${pawns > 0 ? "+" : "−"}${Math.abs(pawns).toFixed(2)}`;
}

export function positionFenAt(game: ParsedGame, cursor: number) {
  if (cursor <= 0) return game.initialFen;
  return game.moves[Math.min(cursor, game.moves.length) - 1]?.after ?? game.initialFen;
}
