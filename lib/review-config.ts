/**
 * Every tunable number in the KnightScope review model lives here.
 *
 * Units: "expected points" (EP) are the moving player's expected game score in
 * [0, 1] (win = 1, draw = ½). A loss of 0.10 EP means the move converted, on
 * average, a tenth of a game point into nothing.
 *
 * The EP-loss bands start from Chess.com's publicly documented Classification
 * V2 bands. They are a researched starting point, not a specification: tune them
 * with `scripts/calibrate-rating.mjs` output and the metadata stored on every
 * reviewed move (expectedPointsLost, cpLoss, classificationReason, …).
 */

export const REVIEW_MODEL_VERSION = "ks-review-2.0";

export const ENGINE_BUILD = {
  /** Directory under /public that holds the vendored stockfish.js build. */
  publicPath: "/stockfish/19.0.0/stockfish-19-lite-single.js",
  /** Human-readable build label; the engine's own `id name` is recorded too. */
  label: "Stockfish 19 Lite (WASM, single-threaded)",
  /**
   * Fixed so node-limited searches are reproducible across machines. A search
   * with the same position history, hash size and node budget returns the same
   * result on every device.
   */
  hashMb: 32,
} as const;

/**
 * Which expected-score model drives grading.
 *
 * "human" (default): Lichess's human-game win-percentage curve,
 *   E = 1 / (1 + exp(−0.00368208 · cp)), applied to Stockfish 19's centipawns.
 *   SF19 centipawns are already material-normalized (100 cp = 50 % win chance
 *   in engine play at that material), so the curve inherits that material
 *   awareness. This is the constant scalachess `WinPercent` / lila
 *   `AccuracyPercent` use.
 * "engine-wdl": Stockfish's own WDL, W + D/2. It describes engine-vs-engine
 *   conversion: +1.00 is already ~50 % wins, and +2.00 is ~95 %+ expected. That is
 *   objectively right for engines but grades human games far too harshly (an
 *   opening slip of ¾ pawn becomes a "blunder").
 *
 * The engine's WDL is stored on every Evaluation either way, and mate /
 * tablebase results are always decisive.
 */
export const EXPECTED_SCORE = {
  model: "human" as "human" | "engine-wdl",
  humanSlopePerCp: 0.00368208,
};

export const ANALYSIS_PRESETS = {
  quick: { label: "Quick", primaryNodes: 60_000, candidateNodes: 60_000 },
  balanced: { label: "Balanced", primaryNodes: 150_000, candidateNodes: 150_000 },
  deep: { label: "Deep", primaryNodes: 400_000, candidateNodes: 400_000 },
} as const;

export type AnalysisPresetKey = keyof typeof ANALYSIS_PRESETS;

export const ANALYSIS = {
  /** MultiPV for the targeted candidate pass (never used for the primary pass). */
  candidateMultiPv: 3,
  /**
   * Positions are searched in fixed-size chunks; each chunk starts with
   * `ucinewgame` so the transposition-table state – and therefore every result –
   * does not depend on how many workers the device happens to run.
   */
  chunkPlies: 12,
  /** Brilliant / Great candidates are re-searched with this many times the candidate budget. */
  verificationNodeFactor: 2,
  verificationMultiPv: 2,
  maxWorkers: 4,
  searchTimeoutMs: 90_000,
} as const;

/** Upper bound (inclusive) of expected-points lost for each severity band. */
export const LOSS_BANDS = {
  /** Non-top moves this close to the top move are treated as co-best (engine noise). */
  bestEquivalence: 0.004,
  excellent: 0.02,
  good: 0.05,
  inaccuracy: 0.1,
  mistake: 0.2,
  // anything above `mistake` is a blunder
} as const;

/** Outcome bands on the mover's expected score. Used by Great / Miss logic. */
export const OUTCOME_BANDS = {
  losing: 0.15,
  worse: 0.4,
  better: 0.6,
  winning: 0.85,
} as const;

/** A deeper verification search must agree with the earlier passes. */
export const VERIFICATION = {
  /** Max change in the best line's expected score between the primary and verification searches. */
  maxDrift: 0.15,
} as const;

export const GREAT = {
  /** Played move must lose at most this much. */
  maxLoss: 0.01,
  /** Gap between the best and the best alternative from the candidate pass. */
  minGap: 0.1,
  /** Gap that makes a move an "only move" even without an outcome-band change. */
  onlyMoveGap: 0.2,
  /** A move that merely postpones defeat is not Great. */
  minExpectedAfter: 0.25,
  /** Opponent's previous error needed for "punishes the mistake". */
  punishOpponentLoss: 0.1,
} as const;

export const BRILLIANT = {
  maxLoss: 0.01,
  /**
   * Net material (pawn units) given up. 1 admits a piece for two pawns or the
   * exchange for a pawn; the sacrificed unit itself must never be a pawn.
   */
  minSacrifice: 1,
  /** The position after the sacrifice must still be at least this good for the mover. */
  minExpectedAfter: 0.45,
  /**
   * When accepting the sacrifice is explicitly checked, the mover must keep this
   * much of the best line's expected score.
   */
  acceptanceTolerance: 0.05,
  /** If the best non-sacrificing alternative keeps at least this, the sac was unnecessary. */
  alternativeAlreadyWinning: 0.95,
  /** Plies of the engine continuation inspected for realized sacrifices. */
  pvPlies: 10,
  /** The sacrifice must be taken within this many plies of the move (1 = immediate reply). */
  maxAcceptancePly: 3,
  /**
   * Minimum advantage of the sacrifice over the best non-sacrificing alternative,
   * by player rating. Soundness never depends on rating – only how non-obvious
   * the idea must be before we call it Brilliant.
   */
  uniquenessByRating: [
    { below: 1200, minEdge: 0 },
    { below: 2000, minEdge: 0.01 },
    { below: Infinity, minEdge: 0.03 },
  ],
} as const;

export const MISS = {
  /** The opportunity must be worth this much over the mover's baseline. */
  minOpportunity: 0.1,
  /** The played move must forfeit at least this much of it. */
  minLoss: 0.08,
  /**
   * A move that also drops more than this below the pre-opportunity baseline is
   * graded Mistake/Blunder (with miss metadata) rather than Miss.
   */
  baselineSlack: 0.05,
  /** Mates this short are always reported when missed. */
  alwaysReportMateWithin: 2,
  /** Longer mates up to this length are reported when the played move is not crushing. */
  reportMateWithin: 5,
  crushing: 0.97,
  /** Net material gain in the best line that counts as a "material win". */
  materialWin: 2,
} as const;

export const ACCURACY = {
  /**
   * Per-move accuracy floor inside the harmonic mean. Lichess's aggregate lets a
   * single near-0 % move collapse the harmonic term; the floor bounds any one
   * catastrophe's influence while still punishing it heavily.
   */
  harmonicFloor: 10,
} as const;

export const BOOK = {
  /** Theory lookup stops after this many plies. */
  maxPly: 30,
  /** A theoretical move that loses at least this much keeps its objective grade. */
  maxLoss: LOSS_BANDS.good,
} as const;

/**
 * How much a move tells us about playing strength, in [0, 1]. Used as a weight in
 * the rating model and (softly) in accuracy aggregation.
 */
export const INFORMATIVENESS = {
  book: 0,
  onlyLegal: 0,
  twoLegal: 0.5,
  obviousRecapture: 0.25,
  /** Answering a check with only a handful of legal replies. */
  checkEvasion: 0.5,
  checkEvasionMaxLegal: 5,
  mateInOne: 0.3,
  decided: 0.15,
  /** Expected score beyond which a position counts as decided. */
  decidedThreshold: 0.97,
} as const;
