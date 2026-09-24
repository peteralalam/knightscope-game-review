/**
 * Every tunable number in the KnightScope review model lives here.
 *
 * Units: "expected points" (EP) are the moving player's expected game score in
 * [0, 1] (win = 1, draw = ½). A loss of 0.10 EP means the move converted, on
 * average, a tenth of a game point into nothing.
 *
 * The EP-loss bands start from Chess.com's publicly documented Classification
 * V2 bands. They are a researched starting point, not a specification: tune them
 * with the corpus tools in `scripts/corpus/` and the metadata stored on every
 * reviewed move (expectedPointsLost, cpLoss, classificationReason, …).
 */

export const REVIEW_MODEL_VERSION = "ks-review-2.1";

/**
 * Engine builds. Both come from the npm package `stockfish@19.0.0` (stockfish.js
 * by Nathan Rugg / Chess.com, GPLv3), git tag v19.0.0 =
 * nmrugg/stockfish.js@9cb3e5066d48f1a35d792afeda36eff37ae60570. Its src/ is
 * official-stockfish/Stockfish tag sf_19 with Emscripten patches only:
 * cooperative yielding in the single-threaded search, no filesystem, Syzygy
 * compiled out (__NO_SYZYGY__), non-aborting position checks. Compiled with
 * emscripten 3.1.7, `-msimd128`, `--closure 1`, 128 MB initial / 2 GB max memory.
 * The exact source and the embedded Lite network ship next to the binary in
 * public/stockfish/19.0.0/source/ (GPLv3 §6).
 */
export const ENGINE_BUILDS = {
  lite: {
    id: "lite",
    label: "Stockfish 19 Lite",
    engine: "Stockfish 19",
    port: "stockfish.js 19.0.0",
    portCommit: "9cb3e5066d48f1a35d792afeda36eff37ae60570",
    build: "lite-single (WASM SIMD, single-threaded)",
    /**
     * NOT the official network: a 1.1 MB net by Chris Bao (sscg13) on a reduced
     * architecture (mirrored piece-square features "P_hm", L1 = 1024) instead of
     * the official HalfKAv2_hm + FullThreats + PP_3Wide. Same search code.
     */
    network: "nn-61e7af4bb97d.nnue (Lite net by sscg13)",
    loaderPath: "/stockfish/19.0.0/stockfish-19-lite-single.js",
    wasmUrl: "/stockfish/19.0.0/stockfish-19-lite-single.wasm",
    wasmSha256: "57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387",
    wasmBytes: 1_787_571,
    maxWorkers: 4,
  },
  full: {
    id: "full",
    label: "Stockfish 19 (full network)",
    engine: "Stockfish 19",
    port: "stockfish.js 19.0.0",
    portCommit: "9cb3e5066d48f1a35d792afeda36eff37ae60570",
    build: "single (WASM SIMD, single-threaded)",
    network: "nn-1a298aa575a0.nnue (official Stockfish 19 network)",
    loaderPath: "/stockfish/19.0.0/stockfish-19-single.js",
    /**
     * ~99 MB – above the 25 MiB static-asset limit of Cloudflare Workers, so it is
     * served by worker/index.ts from an R2 bucket (binding ENGINE_ASSETS), same
     * origin, content-addressed and immutable. Only ever downloaded on request.
     */
    wasmUrl: "/engine-assets/stockfish-19-single-8725c2657627.wasm",
    wasmSha256: "8725c26572762617fd96b2ea83ff130e6640b85815890d682bf8c49db0820721",
    wasmBytes: 99_102_793,
    /** Each worker instantiates its own ~230 MB module; keep memory in check. */
    maxWorkers: 2,
  },
} as const;

export type EngineBuildKey = keyof typeof ENGINE_BUILDS;

export const ENGINE_BUILD = {
  ...ENGINE_BUILDS.lite,
  /** Legacy alias. */
  publicPath: ENGINE_BUILDS.lite.loaderPath,
  /**
   * Fixed so node-limited searches are reproducible across machines. A search
   * with the same position history, hash size and node budget returns the same
   * result on every device.
   */
  hashMb: 32,
} as const;

/**
 * Two expected-score scales live side by side on every Evaluation:
 *
 * ENGINE (diagnostics) – `engineWdl` / `engineExpectedScore`: Stockfish 19's own
 *   win/draw/loss model (`UCI_ShowWDL`), fitted by the Stockfish project on
 *   engine self-play at fixed material. It answers "what happens if two engines
 *   play this out?" and is objectively right for that question: +1.00 is already
 *   ~50 % wins and +2.00 is close to a certain win.
 *
 * HUMAN (every user-facing classification) – `humanWinProbability` /
 *   `humanExpectedScore`: Lichess's published "win percentage" curve,
 *     P = 1 / (1 + exp(−0.00368208 · cp)),
 *   the constant in lila `WinPercent` / `AccuracyPercent`, applied to Stockfish
 *   19's normalized centipawns. Lichess fitted it to the outcomes of real rated
 *   Lichess games between players rated around 2300, as a function of the
 *   (older, pre-normalization) Stockfish evaluation. It is therefore an
 *   empirical, *population-average* conversion for strong players – NOT an
 *   Elo-specific model (a 1000-rated player converts +3 far less reliably than
 *   the curve says, a 2700 more reliably), and applying it to Stockfish 19's
 *   normalized scale is an approximation.
 *   Despite the Lichess name it counts draws as half a point, so it is used as
 *   an expected score. Mates and tablebase results are decisive (0 / 1).
 *
 * Grading uses the human scale because the engine scale grades human games far
 * too harshly (a ¾-pawn opening slip becomes a "Blunder").
 */
export const HUMAN_CURVE = {
  slopePerCp: 0.00368208,
  source: "lichess-org/lila modules/analyse WinPercent (fitted on strong human games)",
} as const;

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

/**
 * Great = QUALITY (near-best) × UNIQUENESS (every alternative is clearly worse)
 * × IMPORTANCE (the difference changes the likely result). Both the uniqueness
 * and the importance thresholds are the Inaccuracy/Mistake boundary: a move is
 * Great when every alternative would have been at least a Mistake, counting only
 * the part of the loss that moves the game between outcome bands.
 */
export const GREAT = {
  /** Played move must lose at most this much. */
  maxLoss: 0.01,
  /** Uniqueness: gap between the move and the best alternative (candidate pass). */
  minGap: LOSS_BANDS.inaccuracy,
  /**
   * Importance: the same gap measured after clamping both scores to the undecided
   * range [OUTCOME_BANDS.losing, OUTCOME_BANDS.winning]. The outcome band must
   * also change (see chess-review.ts).
   */
  minImportance: LOSS_BANDS.inaccuracy,
  /**
   * Without a change in Stockfish's WDL verdict, the best alternative must fall at
   * least this many outcome bands (losing / worse / balanced / better / winning)
   * below the played move: "winning vs better" is the same result, "winning vs
   * balanced" is not.
   */
  minBandDrop: 2,
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
   * An accepted sacrifice whose material is back by this ply of the main line
   * (counted from the move; 4 = the mover's second move after it) is a
   * pseudo-sacrifice – a combination that regains material by force.
   */
  pseudoRecoveryPlies: 4,
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
