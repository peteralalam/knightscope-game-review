/**
 * Chess-aware board analysis used by the classifier: material, static exchange
 * evaluation (SEE), sacrifice detection and "obvious move" detection.
 *
 * Everything here is deterministic board logic – no engine calls – so every
 * statement the review makes from it (e.g. "sacrifices a rook") is a fact about
 * the position, not an inference from an evaluation number.
 */
import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";

export const PIECE_VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const PIECE_NAME: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export function uciParts(uci: string) {
  return {
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    promotion: (uci[4] || undefined) as PieceSymbol | undefined,
  };
}

export function tryChess(fen: string) {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/** Material balance in pawn units from `side`'s point of view. */
export function materialBalance(chess: Chess, side: Color) {
  let score = 0;
  for (const rank of chess.board()) {
    for (const piece of rank) {
      if (piece) score += (piece.color === side ? 1 : -1) * PIECE_VALUE[piece.type];
    }
  }
  return score;
}

/**
 * Material balance (pawn units, `side`'s view) at the start and after each ply of
 * `line`. Stops at the first illegal move.
 */
export function materialTrajectory(fen: string, line: string[], side: Color) {
  const board = tryChess(fen);
  if (!board) return [];
  const balances = [materialBalance(board, side)];
  for (const uci of line) {
    try {
      board.move(uciParts(uci));
    } catch {
      break;
    }
    balances.push(materialBalance(board, side));
  }
  return balances;
}

/**
 * Static exchange evaluation: the material the side to move wins by starting a
 * capture sequence on `square`, both sides always recapturing with their least
 * valuable legal capturer and stopping when continuing would lose material.
 * Uses legal move generation, so pins, x-rays and checks are respected.
 */
export function staticExchange(chess: Chess, square: Square): number {
  const captures = chess
    .moves({ verbose: true })
    .filter((move) => move.to === square && move.captured);
  if (captures.length === 0) return 0;
  captures.sort(
    (left, right) =>
      (left.piece === "k" ? 100 : PIECE_VALUE[left.piece]) -
      (right.piece === "k" ? 100 : PIECE_VALUE[right.piece]),
  );
  const capture = captures[0];
  const gained =
    PIECE_VALUE[capture.captured!] +
    (capture.promotion ? PIECE_VALUE[capture.promotion] - PIECE_VALUE.p : 0);
  chess.move(capture);
  const reply = staticExchange(chess, square);
  chess.undo();
  return Math.max(0, gained - reply);
}

/** The same position with the other side to move (a "null move"), or null if illegal. */
function withSideToMove(fen: string, side: Color) {
  const parts = fen.split(" ");
  if (parts[1] === side) return tryChess(fen);
  parts[1] = side;
  parts[3] = "-";
  const flipped = tryChess(parts.join(" "));
  // Passing the move is illegal if the side that would pass is in check.
  if (!flipped) return null;
  const passer = side === "w" ? "b" : "w";
  const king = flipped.findPiece({ type: "k", color: passer })[0];
  if (king && flipped.isAttacked(king, side)) return null;
  return flipped;
}

export type SacrificeKind = "queen" | "exchange" | "piece" | "en-prise" | "pv";

export interface Sacrifice {
  kind: SacrificeKind;
  piece: PieceSymbol;
  square: Square;
  /** Net material (pawn units) the opponent can win / wins. */
  material: number;
  /** Opponent captures that accept the sacrifice, in UCI. */
  acceptingMoves: string[];
  /** Whether the engine's best defence takes the material. null = not established. */
  accepted: boolean | null;
  /** Plies after the move at which the mover's material recovers, if within the inspected line. */
  recoveredAfterPlies?: number;
  /** Plies from the move to the deepest material deficit in the engine line. */
  deficitPly?: number;
}

function acceptingCaptures(chess: Chess, square: Square) {
  return chess
    .moves({ verbose: true })
    .filter((move) => move.to === square && move.captured)
    .map((move) => `${move.from}${move.to}${move.promotion ?? ""}`);
}

function sacrificeKind(piece: PieceSymbol, material: number, movedPiece: boolean): SacrificeKind {
  if (piece === "q") return "queen";
  // The exchange: a rook for a minor piece (net 2), possibly with a pawn thrown in.
  if (piece === "r" && material <= 2) return "exchange";
  return movedPiece ? "piece" : "en-prise";
}

/**
 * Pieces the move puts (or leaves) en prise, measured by SEE with the opponent
 * to move. Pieces that were already capturable before the move are ignored –
 * the move did not offer them. Pawns are never counted as a sacrificed piece.
 */
export function staticSacrifices(beforeFen: string, moveUci: string, minMaterial: number): Sacrifice[] {
  const board = tryChess(beforeFen);
  if (!board) return [];
  const mover = board.turn();
  const opponent: Color = mover === "w" ? "b" : "w";
  let played: Move;
  try {
    played = board.move(uciParts(moveUci));
  } catch {
    return [];
  }
  const capturedValue = played.captured ? PIECE_VALUE[played.captured] : 0;
  const before = withSideToMove(beforeFen, opponent);
  const results: Sacrifice[] = [];

  for (const rank of board.board()) {
    for (const piece of rank) {
      if (!piece || piece.color !== mover || piece.type === "p" || piece.type === "k") continue;
      const square = piece.square;
      const lossAfter = staticExchange(board, square);
      if (lossAfter <= 0) continue;
      const isMovedPiece = square === played.to;
      let lossBefore = 0;
      if (!isMovedPiece && before) lossBefore = staticExchange(before, square);
      // Material we took with this very move offsets what we now offer.
      const offered = lossAfter - lossBefore - capturedValue;
      if (offered < minMaterial) continue;
      results.push({
        kind: sacrificeKind(piece.type, offered, isMovedPiece),
        piece: piece.type,
        square,
        material: offered,
        acceptingMoves: acceptingCaptures(board, square),
        accepted: null,
      });
    }
  }
  return results.sort((left, right) => right.material - left.material);
}

/**
 * Follow the engine line after the move and measure the mover's material
 * against the position before the move. A deficit of at least `minMaterial`
 * that is not repaid by an immediate recapture is a realized sacrifice.
 */
export function pvSacrifice(
  beforeFen: string,
  moveUci: string,
  continuation: string[],
  minMaterial: number,
  maxPlies: number,
  maxAcceptancePly = 3,
): Sacrifice | null {
  const board = tryChess(beforeFen);
  if (!board) return null;
  const mover = board.turn();
  const start = materialBalance(board, mover);
  const trajectory: Array<{ move: Move; deficit: number }> = [];
  for (const uci of [moveUci, ...continuation].slice(0, maxPlies)) {
    try {
      const move = board.move(uciParts(uci));
      trajectory.push({ move, deficit: start - materialBalance(board, mover) });
    } catch {
      break;
    }
  }

  let worst: { index: number; deficit: number; move: Move } | null = null;
  // Only captures soon after the move count: material lost deep in a principal
  // variation is not what this move offered, and PV tails are unreliable.
  for (let index = 0; index <= Math.min(maxAcceptancePly, trajectory.length - 1); index += 1) {
    const step = trajectory[index];
    if (step.move.color === mover || !step.move.captured) continue;
    if (step.deficit < minMaterial) continue;
    const next = trajectory[index + 1];
    // Without the mover's next move we cannot tell a sacrifice from a trade.
    if (!next) continue;
    // An immediate recapture that restores the balance is just a trade. Winning
    // back a pawn after giving a piece (piece for two pawns) is still a sacrifice.
    if (next.move.color === mover && next.deficit <= 0.5) continue;
    if (!worst || step.deficit > worst.deficit) worst = { index, deficit: step.deficit, move: step.move };
  }
  if (!worst) return null;

  let recoveredAfterPlies: number | undefined;
  for (let index = worst.index + 1; index < trajectory.length; index += 1) {
    if (trajectory[index].deficit <= 0.5) {
      recoveredAfterPlies = index;
      break;
    }
  }
  const lostPiece = worst.move.captured!;
  return {
    kind: lostPiece === "p" ? "pv" : sacrificeKind(lostPiece, worst.deficit, worst.move.to === uciParts(moveUci).to),
    piece: lostPiece,
    square: worst.move.to,
    material: worst.deficit,
    acceptingMoves: [],
    accepted: true,
    recoveredAfterPlies,
    deficitPly: worst.index,
  };
}

/** Best net material the side to move gains over the first plies of a line. */
export function lineMaterialGain(fen: string, line: string[], maxPlies: number) {
  const board = tryChess(fen);
  if (!board) return 0;
  const side = board.turn();
  const start = materialBalance(board, side);
  let settled = 0;
  for (const [index, uci] of line.slice(0, maxPlies).entries()) {
    try {
      board.move(uciParts(uci));
    } catch {
      break;
    }
    // Only count balances after the opponent has had the chance to recapture.
    if (index % 2 === 1) settled = Math.max(settled, materialBalance(board, side) - start);
  }
  return settled;
}

/**
 * A recapture on the square where the opponent just captured, which restores
 * the material balance of the exchange. These are rarely real decisions.
 */
export function isObviousRecapture(
  beforeFen: string,
  moveUci: string,
  previous?: { to: Square; captured?: PieceSymbol },
) {
  if (!previous?.captured) return false;
  const { to } = uciParts(moveUci);
  if (to !== previous.to) return false;
  const board = tryChess(beforeFen);
  if (!board) return false;
  try {
    const move = board.move(uciParts(moveUci));
    return Boolean(move.captured) && PIECE_VALUE[move.captured!] >= PIECE_VALUE[previous.captured] - 1;
  } catch {
    return false;
  }
}

/**
 * Capturing a piece or pawn that SEE says is simply free (no tactic needed):
 * the exchange on that square wins at least the target's value less a pawn,
 * and never less than a pawn.
 */
export function isFreeCapture(beforeFen: string, moveUci: string) {
  const board = tryChess(beforeFen);
  if (!board) return false;
  const { to } = uciParts(moveUci);
  const target = board.get(to);
  if (!target || target.color === board.turn()) return false;
  const gain = staticExchange(board, to);
  return gain >= Math.max(1, PIECE_VALUE[target.type] - 1);
}

export function givesMateInOne(beforeFen: string, moveUci: string) {
  const board = tryChess(beforeFen);
  if (!board) return false;
  try {
    board.move(uciParts(moveUci));
    return board.isCheckmate();
  } catch {
    return false;
  }
}

export function legalMoveCount(fen: string) {
  return tryChess(fen)?.moves().length ?? 0;
}

/** Game phase by non-pawn material (both sides, pawn units) and move number. */
export function gamePhase(fen: string, ply: number): "opening" | "middlegame" | "endgame" {
  const board = tryChess(fen);
  if (!board) return "middlegame";
  let nonPawn = 0;
  let queens = 0;
  for (const rank of board.board()) {
    for (const piece of rank) {
      if (!piece || piece.type === "p" || piece.type === "k") continue;
      nonPawn += PIECE_VALUE[piece.type];
      if (piece.type === "q") queens += 1;
    }
  }
  if (nonPawn <= 26 || (queens === 0 && nonPawn <= 32)) return "endgame";
  if (ply < 20 && nonPawn >= 56) return "opening";
  return "middlegame";
}
