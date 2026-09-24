"use client";

import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { analyzeGame as runAnalysis, type AnalysisProgress } from "../lib/analysis-pipeline";
import {
  formatEvaluation,
  formatReviewEvaluation,
  GRADE_META,
  GRADE_ORDER,
  parsePgn,
  positionFenAt,
  summarizeSide,
  type ParsedGame,
  type ReviewedMove,
  type SideSummary,
} from "../lib/chess-review";
import { deleteFullEngine, downloadFullEngine, isFullEngineCached } from "../lib/engine-assets";
import { ANALYSIS_PRESETS, ENGINE_BUILD, ENGINE_BUILDS, REVIEW_MODEL_VERSION, type EngineBuildKey } from "../lib/review-config";
import { createEnginePool } from "../lib/stockfish-client";
import type { UciEngine } from "../lib/uci-engine";

const SAMPLE_PGN = `[Event "A Night at the Opera"]
[Site "Paris, France"]
[Date "1858.??.??"]
[Round "?"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5
6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5
11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6
15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

const ENGINE_PRESETS = ANALYSIS_PRESETS;

type EnginePreset = keyof typeof ENGINE_PRESETS;
type EngineMode = "auto" | EngineBuildKey;
type FullEngineState =
  | { state: "unknown" | "missing" | "ready" }
  | { state: "downloading"; progress: number }
  | { state: "error"; message: string };

interface AnalysisSetup {
  preset: EnginePreset;
  build: EngineBuildKey;
  workers: number;
  engineVersion: string;
}

/** Auto: Lite for Quick / Balanced; the full network for Deep once it is downloaded. */
function resolveBuild(mode: EngineMode, preset: EnginePreset, fullReady: boolean): EngineBuildKey {
  if (mode === "lite") return "lite";
  if (mode === "full") return "full";
  return preset === "deep" && fullReady ? "full" : "lite";
}
type AnalysisState = "idle" | "loading" | "analyzing" | "complete" | "cancelled" | "error";

const PIECES: Record<Color, Record<PieceSymbol, string>> = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

const PIECE_NAMES: Record<PieceSymbol, string> = {
  k: "king",
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  p: "pawn",
};

function playerName(game: ParsedGame, color: Color) {
  return game.headers[color === "w" ? "White" : "Black"] || (color === "w" ? "White" : "Black");
}

function playerRating(game: ParsedGame, color: Color) {
  return game.headers[color === "w" ? "WhiteElo" : "BlackElo"] || "Unrated";
}

function playerInitial(name: string) {
  const parts = name.split(/[\s/]+/).filter(Boolean);
  return (parts[0]?.[0] || "?") + (parts.length > 1 ? parts.at(-1)?.[0] || "" : "");
}

function displayResult(result: string) {
  if (result === "1-0") return "White won";
  if (result === "0-1") return "Black won";
  if (result === "1/2-1/2") return "Draw";
  return "Game review";
}

function ratingRange(summary: SideSummary) {
  const rating = summary.performance;
  return rating ? `${rating.confidenceLow}–${rating.confidenceHigh}` : "More moves needed";
}

const PHASE_SPAN: Record<AnalysisProgress["phase"], [number, number]> = {
  primary: [0, 65],
  candidates: [65, 92],
  verification: [92, 100],
};

function progressPercent(progress: AnalysisProgress) {
  const [start, end] = PHASE_SPAN[progress.phase];
  return progress.total ? start + (progress.done / progress.total) * (end - start) : Math.max(2, start);
}

function ratingDetail(summary: SideSummary) {
  const rating = summary.performance;
  if (!rating) return "too few real decisions";
  const scale = rating.calibrated ? rating.ratingSystem : "uncalibrated prior";
  return `≈${rating.estimatedPerformanceRating} ${scale}${rating.extrapolated ? " (nearest model)" : ""} · ${rating.meaningfulMoves} decisions`;
}

function ImportPanel({
  pgn,
  onPgnChange,
  onFile,
  onReview,
  onSample,
  error,
  compact = false,
}: {
  pgn: string;
  onPgnChange: (value: string) => void;
  onFile: (file: File) => void;
  onReview: () => void;
  onSample: () => void;
  error: string;
  compact?: boolean;
}) {
  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    <section className={`import-card${compact ? " import-card--compact" : ""}`} aria-labelledby="import-title">
      <div className="import-copy">
        <span className="eyebrow">Private analysis · no account needed</span>
        <h1 id="import-title">See the story behind every move.</h1>
        <p>
          Drop in a PGN. KnightScope runs Stockfish in your browser, grades every decision,
          and turns the engine output into a review you can actually follow.
        </p>
      </div>

      <label
        className="drop-zone"
        htmlFor="pgn-file"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <span className="drop-icon">↥</span>
        <strong>Choose or drop a PGN</strong>
        <span>.pgn or plain text · processed on this device</span>
        <input
          id="pgn-file"
          type="file"
          accept=".pgn,text/plain,application/x-chess-pgn"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (file) onFile(file);
            event.target.value = "";
          }}
        />
      </label>

      <div className="or-divider"><span>or paste notation</span></div>

      <textarea
        className="pgn-input"
        value={pgn}
        onChange={(event) => onPgnChange(event.target.value)}
        placeholder={'[White "Player one"]\n[Black "Player two"]\n\n1. e4 e5 2. Nf3 ...'}
        aria-label="PGN notation"
        spellCheck={false}
      />

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="import-actions">
        <button className="button button--primary" onClick={onReview} disabled={!pgn.trim()}>
          <span>Review this game</span><span aria-hidden="true">→</span>
        </button>
        <button className="button button--ghost" onClick={onSample}>Try the Opera Game</button>
      </div>
    </section>
  );
}

function PlayerStrip({
  game,
  color,
  summary,
  complete,
}: {
  game: ParsedGame;
  color: Color;
  summary: SideSummary;
  complete: boolean;
}) {
  const name = playerName(game, color);
  return (
    <div className="player-strip">
      <div className={`player-avatar player-avatar--${color}`} aria-hidden="true">{playerInitial(name)}</div>
      <div className="player-identity">
        <strong>{name}</strong>
        <span>{playerRating(game, color)}</span>
      </div>
      <div className="player-metrics">
        <div><span>Accuracy</span><strong>{complete ? `${summary.accuracy.toFixed(1)}%` : "—"}</strong></div>
        <div><span title="Lichess-equivalent estimated game performance (80% range)">Est. performance</span><strong>{complete ? ratingRange(summary) : "—"}</strong></div>
      </div>
    </div>
  );
}

function ChessBoard({
  fen,
  orientation,
  lastMove,
  review,
}: {
  fen: string;
  orientation: Color;
  lastMove?: { from: Square; to: Square };
  review?: ReviewedMove;
}) {
  const chess = useMemo(() => new Chess(fen), [fen]);
  const files = orientation === "w" ? ["a", "b", "c", "d", "e", "f", "g", "h"] : ["h", "g", "f", "e", "d", "c", "b", "a"];
  const ranks = orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];

  return (
    <div className="board" role="grid" aria-label={`Chess position, ${orientation === "w" ? "white" : "black"} side below`}>
      {ranks.flatMap((rank, rowIndex) =>
        files.map((file, columnIndex) => {
          const square = `${file}${rank}` as Square;
          const piece = chess.get(square);
          const fileIndex = file.charCodeAt(0) - 97;
          const isLight = (fileIndex + rank) % 2 === 0;
          const isLastMove = lastMove?.from === square || lastMove?.to === square;
          const isDestination = lastMove?.to === square;
          return (
            <div
              key={square}
              className={`square square--${isLight ? "light" : "dark"}${isLastMove ? " square--last" : ""}`}
              role="gridcell"
              aria-label={`${square}${piece ? `, ${piece.color === "w" ? "white" : "black"} ${PIECE_NAMES[piece.type]}` : ", empty"}`}
            >
              {columnIndex === 0 && <span className="coord coord--rank">{rank}</span>}
              {rowIndex === 7 && <span className="coord coord--file">{file}</span>}
              {piece && (
                <span className={`piece piece--${piece.color}`} aria-hidden="true">
                  {PIECES[piece.color][piece.type]}
                </span>
              )}
              {isDestination && review && (
                <span className={`move-marker grade-${review.grade}`} aria-label={GRADE_META[review.grade].label}>
                  {GRADE_META[review.grade].symbol}
                </span>
              )}
            </div>
          );
        }),
      )}
    </div>
  );
}

function EvaluationBar({ expectedWhite, label }: { expectedWhite: number; label: string }) {
  const white = Math.max(4, Math.min(96, expectedWhite * 100));
  return (
    <div className="eval-bar" aria-label={`Position evaluation ${label}`}>
      <div className="eval-bar__black" style={{ height: `${100 - white}%` }} />
      <div className="eval-bar__white" style={{ height: `${white}%` }} />
      <span className={`eval-bar__label${expectedWhite < 0.5 ? " eval-bar__label--dark" : ""}`}>{label}</span>
    </div>
  );
}

function MoveButton({
  move,
  review,
  selected,
  onClick,
}: {
  move?: ParsedGame["moves"][number];
  review?: ReviewedMove;
  selected: boolean;
  onClick: () => void;
}) {
  if (!move) return <span className="move-slot move-slot--empty" />;
  const grade = review?.grade;
  return (
    <button
      className={`move-slot${selected ? " move-slot--selected" : ""}`}
      data-grade={grade}
      onClick={onClick}
      aria-label={`${move.moveNumber}${move.color === "b" ? " black" : " white"}, ${move.san}${grade ? `, ${GRADE_META[grade].label}` : ""}`}
    >
      <span>{move.san}</span>
      {grade && <span className={`move-grade grade-${grade}`} aria-hidden="true">{GRADE_META[grade].short || GRADE_META[grade].symbol}</span>}
    </button>
  );
}

function AccuracyRing({ value, color }: { value: number; color: Color }) {
  const rounded = Math.round(value);
  return (
    <div className={`accuracy-ring accuracy-ring--${color}`} style={{ "--accuracy": `${rounded * 3.6}deg` } as CSSProperties}>
      <div><strong>{value.toFixed(1)}</strong><span>accuracy</span></div>
    </div>
  );
}

const pct = (value?: number) => (value === undefined ? "—" : `${Math.round(value * 100)}%`);

/** The measured facts behind a Great / Brilliant decision (or its rejection). */
function GradeEvidence({ review }: { review: ReviewedMove }) {
  const great = review.greatDiagnostics;
  const brilliant = review.brilliantDiagnostics;
  if (!great && !brilliant) return null;
  return (
    <details className="grade-evidence">
      <summary>Why {review.grade === "brilliant" || review.grade === "great" ? "this grade" : "not Great / Brilliant"}</summary>
      {brilliant && (
        <dl>
          <div><dt>Sacrifice</dt><dd>{brilliant.sacrificedPiece} on {brilliant.sacrificeSquare} ({brilliant.sacrificeValue} pawns)</dd></div>
          <div><dt>Best defence</dt><dd>{brilliant.bestDefense ?? "—"}{brilliant.acceptanceIsBestDefense ? " (takes it)" : " (declines)"}</dd></div>
          <div><dt>If accepted</dt><dd>{pct(brilliant.expectedScoreAfterAcceptance)} for the mover</dd></div>
          <div><dt>Best alternative</dt><dd>{pct(brilliant.bestAlternativeExpectedScore)}</dd></div>
          <div><dt>Decision</dt><dd>{brilliant.decision}</dd></div>
        </dl>
      )}
      {great && (
        <dl>
          <div><dt>Played / next best</dt><dd>{pct(great.playedExpectedScore)} vs {pct(great.secondBestExpectedScore)}</dd></div>
          <div><dt>Viable moves</dt><dd>{great.numberOfAcceptableMoves ?? "—"}{great.acceptableMovesIsLowerBound ? "+" : ""} of {great.legalMoveCount}</dd></div>
          <div><dt>Uniqueness</dt><dd>{pct(great.moveUniqueness)}</dd></div>
          <div><dt>Importance</dt><dd>{pct(great.outcomeImportance)} ({great.outcomeTransition}; engine {great.objectiveTransition})</dd></div>
          <div><dt>Decision</dt><dd>{great.decision}</dd></div>
        </dl>
      )}
    </details>
  );
}

function SelectedMoveCard({ review, move }: { review?: ReviewedMove; move?: ParsedGame["moves"][number] }) {
  if (!move) {
    return (
      <div className="selected-card selected-card--intro">
        <span className="eyebrow">Game overview</span>
        <h2>Start at the beginning</h2>
        <p>Use the move list or board controls to walk through the engine’s review.</p>
      </div>
    );
  }
  if (!review) {
    return (
      <div className="selected-card selected-card--waiting">
        <span className="thinking-dot" /><span>Waiting for this move’s engine pass…</span>
      </div>
    );
  }
  const meta = GRADE_META[review.grade];
  return (
    <article className={`selected-card selected-card--${review.grade}`}>
      <div className="selected-card__heading">
        <span className={`grade-medallion grade-${review.grade}`}>{meta.symbol}</span>
        <div>
          <span className="eyebrow">Move {review.moveNumber}{review.color === "b" ? "…" : "."}</span>
          <h2>{review.san} <small>{meta.label}</small></h2>
        </div>
        <strong className="selected-eval">{formatReviewEvaluation(review)}</strong>
      </div>
      <p>{review.explanation}</p>
      {review.miss && review.grade !== "miss" && (
        <p className="miss-note">Missed opportunity: {review.miss.missedMoveSan}</p>
      )}
      <GradeEvidence review={review} />
      <div className="line-block">
        <span>{review.bestMove === review.uci ? "Engine continuation" : `Better was ${review.bestMoveSan}`}</span>
        <div className="pv-line">
          {review.bestLineSan.length ? review.bestLineSan.map((san, index) => <kbd key={`${san}-${index}`}>{san}</kbd>) : <em>No continuation</em>}
        </div>
      </div>
    </article>
  );
}

function SummaryPanel({
  game,
  reviews,
  white,
  black,
  complete,
}: {
  game: ParsedGame;
  reviews: ReviewedMove[];
  white: SideSummary;
  black: SideSummary;
  complete: boolean;
}) {
  return (
    <section className="summary-section" aria-label="Game summary">
      <div className="summary-title">
        <div><span className="eyebrow">Review summary</span><h3>{displayResult(game.result)}</h3></div>
        <span className="result-pill">{game.result}</span>
      </div>
      <div className="accuracy-pair">
        <div><span>{playerName(game, "w")}</span><AccuracyRing value={white.accuracy} color="w" /><strong>{complete ? ratingRange(white) : "Analyzing"}</strong><small>{complete ? ratingDetail(white) : "estimated game performance"}</small></div>
        <div><span>{playerName(game, "b")}</span><AccuracyRing value={black.accuracy} color="b" /><strong>{complete ? ratingRange(black) : "Analyzing"}</strong><small>{complete ? ratingDetail(black) : "estimated game performance"}</small></div>
      </div>
      <div className="grade-table" aria-label="Move classification counts">
        <div className="grade-table__header"><span>Move quality</span><span>White</span><span>Black</span></div>
        {GRADE_ORDER.map((grade) => (
          <div className="grade-table__row" key={grade}>
            <span><i className={`grade-dot grade-${grade}`} />{GRADE_META[grade].label}</span>
            <strong>{white.counts[grade]}</strong>
            <strong>{black.counts[grade]}</strong>
          </div>
        ))}
      </div>
      {complete && reviews.length > 0 && (
        <p className="estimate-note">
          {white.performance?.calibrated
            ? <>Lichess-equivalent estimated game performance: the Lichess {white.performance.timeControl === "blitz" || white.performance.timeControl === "bullet" ? "blitz" : "rapid"} rating
              whose typical games look like this one, with an 80% range that held for about 80% of held-out Lichess players.
              It is not a Chess.com or FIDE rating, and one game says little: on held-out players the estimate was off by
              {" "}{Math.round((white.performance.heldOutMae ?? 0) / 10) * 10} points on average.</>
            : <>Ranges are 80% intervals from an uncalibrated, prior-based model – not account ratings.</>}
          {" "}Accuracy measures engine precision and is not an Elo.
        </p>
      )}
    </section>
  );
}

export function ChessReviewApp() {
  const [pgn, setPgn] = useState("");
  const [game, setGame] = useState<ParsedGame | null>(null);
  const [reviews, setReviews] = useState<ReviewedMove[]>([]);
  const [cursor, setCursor] = useState(0);
  const [orientation, setOrientation] = useState<Color>("w");
  const [preset, setPreset] = useState<EnginePreset>("balanced");
  const [analysisPreset, setAnalysisPreset] = useState<EnginePreset>("balanced");
  const [analysisState, setAnalysisState] = useState<AnalysisState>("idle");
  const [progress, setProgress] = useState<AnalysisProgress>({ phase: "primary", done: 0, total: 0 });
  const [engineMode, setEngineMode] = useState<EngineMode>("auto");
  const [fullEngine, setFullEngine] = useState<FullEngineState>({ state: "unknown" });
  const [setup, setSetup] = useState<AnalysisSetup>({ preset: "balanced", build: "lite", workers: 0, engineVersion: ENGINE_BUILD.label });
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const engineRef = useRef<UciEngine[] | null>(null);
  const runRef = useRef(0);

  const isComplete = analysisState === "complete" && Boolean(game) && reviews.length === game?.moves.length;
  const headers = game?.headers;
  const whiteSummary = useMemo(() => summarizeSide(reviews, "w", headers ?? {}), [reviews, headers]);
  const blackSummary = useMemo(() => summarizeSide(reviews, "b", headers ?? {}), [reviews, headers]);
  const currentMove = game && cursor > 0 ? game.moves[cursor - 1] : undefined;
  const currentReview = cursor > 0 ? reviews[cursor - 1] : undefined;
  const currentFen = game ? positionFenAt(game, cursor) : "";

  const expectedWhite = useMemo(() => {
    if (!reviews.length) return 0.5;
    if (cursor <= 0) return reviews[0].expectedWhiteBefore;
    return reviews[Math.min(cursor, reviews.length) - 1]?.expectedWhiteAfter ?? 0.5;
  }, [cursor, reviews]);

  const evaluationLabel = useMemo(() => {
    if (!reviews.length) return "0.00";
    if (cursor <= 0) return formatEvaluation(reviews[0].cpWhiteBefore, reviews[0].mateWhiteBefore);
    const review = reviews[Math.min(cursor, reviews.length) - 1];
    return review ? formatReviewEvaluation(review) : "0.00";
  }, [cursor, reviews]);

  const cancelAnalysis = useCallback(() => {
    runRef.current += 1;
    engineRef.current?.forEach((engine) => engine.dispose());
    engineRef.current = null;
    setAnalysisState((state) => state === "analyzing" || state === "loading" ? "cancelled" : state);
  }, []);

  const analyzeGame = useCallback(async (parsed: ParsedGame) => {
    cancelAnalysis();
    const runId = runRef.current + 1;
    runRef.current = runId;
    setGame(parsed);
    setReviews([]);
    setCursor(0);
    setPlaying(false);
    setError("");
    setImportOpen(false);
    setProgress({ phase: "primary", done: 0, total: parsed.moves.length + 1 });
    setAnalysisState("loading");

    const selectedPreset = preset;
    setAnalysisPreset(selectedPreset);
    const build = resolveBuild(engineMode, selectedPreset, fullEngine.state === "ready");
    if (build === "full" && fullEngine.state !== "ready") {
      setError("Download the full engine first, or choose Lite.");
      setAnalysisState("error");
      return;
    }
    const engines = createEnginePool(undefined, build);
    engineRef.current = engines;
    const ratingOf = (value?: string) => (value && /^\d+$/.test(value) ? Number(value) : undefined);
    try {
      await Promise.all(engines.map((engine) => engine.start()));
      if (runRef.current !== runId) return;
      setSetup({ preset: selectedPreset, build, workers: engines.length, engineVersion: engines[0].engineVersion });
      console.info(`[KnightScope] ${REVIEW_MODEL_VERSION} · ${engines[0].engineVersion} · ${engines.length} engine(s)`);
      setAnalysisState("analyzing");
      const budget = ENGINE_PRESETS[selectedPreset];
      const analysis = await runAnalysis(parsed, engines, {
        primaryNodes: budget.primaryNodes,
        candidateNodes: budget.candidateNodes,
        ratings: { w: ratingOf(parsed.headers.WhiteElo), b: ratingOf(parsed.headers.BlackElo) },
        onProgress: (next) => {
          if (runRef.current === runId) setProgress(next);
        },
        onReviews: (next) => {
          if (runRef.current === runId) setReviews(next);
        },
      });
      if (runRef.current !== runId) return;
      console.info("[KnightScope] analysis", analysis.meta);
      const interesting = analysis.reviews.findIndex(
        (move) => !["best", "excellent", "good", "book"].includes(move.grade),
      );
      setCursor(interesting >= 0 ? interesting + 1 : Math.min(1, analysis.reviews.length));
      setAnalysisState("complete");
    } catch (caught) {
      if (runRef.current !== runId) return;
      const message = caught instanceof Error ? caught.message : "The review could not be completed.";
      if (message !== "Analysis cancelled.") {
        setError(message);
        setAnalysisState("error");
      }
    } finally {
      engines.forEach((engine) => engine.dispose());
      if (engineRef.current === engines) engineRef.current = null;
    }
  }, [cancelAnalysis, preset, engineMode, fullEngine.state]);

  useEffect(() => {
    // Local cache lookup only – nothing is downloaded until the user asks.
    void isFullEngineCached().then((cached) => setFullEngine({ state: cached ? "ready" : "missing" }));
  }, []);

  const startFullDownload = useCallback(async () => {
    setFullEngine({ state: "downloading", progress: 0 });
    try {
      await downloadFullEngine((progress) => setFullEngine({ state: "downloading", progress }));
      setFullEngine({ state: "ready" });
    } catch (caught) {
      setFullEngine({ state: "error", message: caught instanceof Error ? caught.message : "Download failed." });
    }
  }, []);

  const removeFullEngine = useCallback(async () => {
    await deleteFullEngine();
    setFullEngine({ state: "missing" });
  }, []);

  useEffect(() => () => {
    runRef.current += 1;
    engineRef.current?.forEach((engine) => engine.dispose());
  }, []);

  useEffect(() => {
    if (!playing || !game) return;
    const timer = window.setInterval(() => {
      setCursor((current) => {
        if (current >= game.moves.length) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 850);
    return () => window.clearInterval(timer);
  }, [playing, game]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || !game) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setPlaying(false);
        setCursor((value) => Math.max(0, value - 1));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        setCursor((value) => Math.min(game.moves.length, value + 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [game]);

  const submitPgn = () => {
    try {
      const parsed = parsePgn(pgn);
      void analyzeGame(parsed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The PGN could not be read.");
    }
  };

  const useSample = () => {
    setPgn(SAMPLE_PGN);
    setError("");
    void analyzeGame(parsePgn(SAMPLE_PGN));
  };

  const readFile = (file: File) => {
    if (file.size > 1_000_000) {
      setError("That file is over 1 MB. Please choose a single-game PGN.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPgn(String(reader.result ?? ""));
      setError("");
    };
    reader.onerror = () => setError("The file could not be read.");
    reader.readAsText(file);
  };

  const analysisActive = analysisState === "loading" || analysisState === "analyzing";

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="KnightScope home">
          <span className="brand-mark" aria-hidden="true">♞</span>
          <span><strong>KnightScope</strong><small>GAME REVIEW</small></span>
        </a>
        <div className="topbar-actions">
          <span className="local-badge"><i /> Stockfish 19 · on-device</span>
          <label className="engine-select">
            <span>Engine effort</span>
            <select value={preset} onChange={(event) => setPreset(event.target.value as EnginePreset)} disabled={analysisActive}>
              {Object.entries(ENGINE_PRESETS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
            </select>
          </label>
          <label className="engine-select">
            <span>Engine</span>
            <select value={engineMode} onChange={(event) => setEngineMode(event.target.value as EngineMode)} disabled={analysisActive}>
              <option value="auto">Auto</option>
              <option value="lite">Lite (1.8 MB)</option>
              <option value="full">Full (99 MB)</option>
            </select>
          </label>
          {game && <button className="button button--compact" onClick={() => setImportOpen(true)}>＋ New PGN</button>}
        </div>
      </header>

      {engineMode !== "lite" && fullEngine.state !== "ready" && fullEngine.state !== "unknown" && (
        <div className="engine-download" role="status">
          {fullEngine.state === "downloading" ? (
            <>
              <span>Downloading the full Stockfish 19 network… {Math.round(fullEngine.progress * 100)}%</span>
              <div className="progress-track"><span style={{ width: `${Math.round(fullEngine.progress * 100)}%` }} /></div>
            </>
          ) : (
            <>
              <span>
                {engineMode === "full" ? "The full engine" : "Auto uses the full engine for Deep reviews once it"} is a one-time ≈99 MB download,
                verified (SHA-256) and cached in this browser. Only the engine file is downloaded; your games never leave the device.
                {fullEngine.state === "error" && <b> {fullEngine.message}</b>}
              </span>
              <button className="button button--compact" onClick={() => void startFullDownload()}>Download full engine</button>
            </>
          )}
        </div>
      )}

      <main id="top">
        {!game ? (
          <div className="landing">
            <div className="landing-orbit landing-orbit--one" />
            <div className="landing-orbit landing-orbit--two" />
            <ImportPanel pgn={pgn} onPgnChange={setPgn} onFile={readFile} onReview={submitPgn} onSample={useSample} error={error} />
            <div className="trust-row" aria-label="Features">
              <span><b>01</b> Engine-backed grades</span>
              <span><b>02</b> Visual move replay</span>
              <span><b>03</b> Lichess-calibrated performance range</span>
            </div>
          </div>
        ) : (
          <div className="workspace">
            <section className="board-column" aria-label="Game board">
              <PlayerStrip game={game} color={orientation === "w" ? "b" : "w"} summary={orientation === "w" ? blackSummary : whiteSummary} complete={isComplete} />
              <div className="board-stage">
                <EvaluationBar expectedWhite={expectedWhite} label={evaluationLabel} />
                <ChessBoard fen={currentFen} orientation={orientation} lastMove={currentMove} review={currentReview} />
              </div>
              <PlayerStrip game={game} color={orientation} summary={orientation === "w" ? whiteSummary : blackSummary} complete={isComplete} />

              <div className="board-controls" aria-label="Board navigation">
                <button onClick={() => { setPlaying(false); setCursor(0); }} aria-label="First position" title="First position">|‹</button>
                <button onClick={() => { setPlaying(false); setCursor((value) => Math.max(0, value - 1)); }} aria-label="Previous move" title="Previous move">‹</button>
                <button className="play-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause replay" : "Play moves"} title={playing ? "Pause" : "Play"}>{playing ? "Ⅱ" : "▶"}</button>
                <button onClick={() => { setPlaying(false); setCursor((value) => Math.min(game.moves.length, value + 1)); }} aria-label="Next move" title="Next move">›</button>
                <button onClick={() => { setPlaying(false); setCursor(game.moves.length); }} aria-label="Last position" title="Last position">›|</button>
                <span className="control-divider" />
                <button onClick={() => setOrientation((value) => value === "w" ? "b" : "w")} aria-label="Flip board" title="Flip board">↻</button>
              </div>

              <p className="keyboard-hint">Tip: use <kbd>←</kbd> <kbd>→</kbd> to step through moves</p>
            </section>

            <aside className="review-column">
              {analysisActive && (
                <div className="analysis-progress" role="status" aria-live="polite">
                  <div><span className="engine-pulse" /><strong>{analysisState === "loading"
                    ? "Loading Stockfish 19…"
                    : progress.phase === "primary"
                      ? `Evaluating position ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
                      : progress.phase === "candidates"
                        ? `Checking critical moves ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
                        : `Verifying standout moves ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`}</strong><button onClick={cancelAnalysis}>Cancel</button></div>
                  <div className="progress-track"><span style={{ width: `${progressPercent(progress)}%` }} /></div>
                </div>
              )}
              {analysisState === "cancelled" && (
                <div className="analysis-message"><span>Review cancelled.</span><button onClick={() => void analyzeGame(game)}>Start again</button></div>
              )}
              {analysisState === "error" && (
                <div className="analysis-message analysis-message--error" role="alert"><span>{error}</span><button onClick={() => void analyzeGame(game)}>Retry</button></div>
              )}

              <SelectedMoveCard move={currentMove} review={currentReview} />

              <div className="panel-scroll">
                <div className="move-list-heading"><div><span className="eyebrow">Move by move</span><h3>Full notation</h3></div><span>{game.moves.length} plies</span></div>
                <div className="move-list" aria-label="Moves">
                  {Array.from({ length: Math.ceil(game.moves.length / 2) }, (_, row) => {
                    const whiteIndex = row * 2;
                    const blackIndex = whiteIndex + 1;
                    return (
                      <div className="move-row" key={row}>
                        <span className="move-number">{row + 1}.</span>
                        <MoveButton move={game.moves[whiteIndex]} review={reviews[whiteIndex]} selected={cursor === whiteIndex + 1} onClick={() => { setPlaying(false); setCursor(whiteIndex + 1); }} />
                        <MoveButton move={game.moves[blackIndex]} review={reviews[blackIndex]} selected={cursor === blackIndex + 1} onClick={() => { setPlaying(false); setCursor(blackIndex + 1); }} />
                      </div>
                    );
                  })}
                </div>
                <SummaryPanel game={game} reviews={reviews} white={whiteSummary} black={blackSummary} complete={isComplete} />
                <footer className="review-footer">
                  <dl className="engine-diagnostics" aria-label="Analysis setup">
                    <div><dt>Engine</dt><dd>{ENGINE_BUILDS[setup.build].engine}</dd></div>
                    <div><dt>Port</dt><dd>{ENGINE_BUILDS[setup.build].port}</dd></div>
                    <div><dt>Build</dt><dd>{ENGINE_BUILDS[setup.build].build}</dd></div>
                    <div><dt>Network</dt><dd>{ENGINE_BUILDS[setup.build].network}</dd></div>
                    <div><dt>Threads</dt><dd>1 per engine × {setup.workers || "—"} engines · Hash {ENGINE_BUILD.hashMb} MB</dd></div>
                    <div><dt>Nodes</dt><dd>{ENGINE_PRESETS[analysisPreset].primaryNodes / 1000}k primary · {ENGINE_PRESETS[analysisPreset].candidateNodes / 1000}k candidates</dd></div>
                    <div><dt>Model</dt><dd title={setup.engineVersion}>{REVIEW_MODEL_VERSION}</dd></div>
                  </dl>
                  <span>
                    <a href="/stockfish/19.0.0/SOURCE.txt" target="_blank" rel="noreferrer">Stockfish 19 · GPL v3 · source</a>
                    {fullEngine.state === "ready" && <> · <button className="link-button" onClick={() => void removeFullEngine()}>remove cached full engine</button></>}
                  </span>
                </footer>
              </div>
            </aside>
          </div>
        )}
      </main>

      {importOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setImportOpen(false); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Import another PGN">
            <button className="modal-close" onClick={() => setImportOpen(false)} aria-label="Close">×</button>
            <ImportPanel compact pgn={pgn} onPgnChange={setPgn} onFile={readFile} onReview={submitPgn} onSample={useSample} error={error} />
          </div>
        </div>
      )}
    </div>
  );
}
