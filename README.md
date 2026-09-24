# KnightScope

KnightScope is a private, browser-based chess game review. Paste or upload a PGN and it will:

- replay the game on an interactive board;
- analyze every position with **Stockfish 19** (on-device WebAssembly, several engines in parallel);
- label moves as Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss, or Blunder, with a factual reason;
- show the engine's preferred move and principal variation;
- calculate per-side accuracy (overall and by game phase); and
- estimate a **single-game performance rating** with an honest confidence interval.

All engine work runs locally in Web Workers. PGNs are not uploaded or stored.

## Run locally

```sh
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validate

```sh
npm test       # build + unit, rating-model, engine/pipeline (real Stockfish 19), render and smoke tests
npm run lint
```

## Engine

| | |
| --- | --- |
| Engine | Stockfish 19 (official release `sf_19`, Sept 2026), built to WebAssembly by [stockfish.js 19.0.0](https://github.com/nmrugg/stockfish.js/tree/v19.0.0) (the Chess.com-maintained port; includes Lichess stockfish-web patches) |
| Build shipped | `lite-single`: single-threaded, 1.8 MB wasm with a 1 MB lite NNUE net |
| Where | `public/stockfish/19.0.0/`, vendored from the pinned npm package by `npm run vendor:stockfish` |
| Recorded version | The engine's own `id name` plus build flavour is recorded on every evaluation and in the analysis metadata, logged to the console, and shown in the footer tooltip |

**Why this build.** Official Stockfish publishes native binaries only. Its Makefile has a `wasm32` target, but there is no official browser artifact. stockfish.js builds the official source with Emscripten. Its full-strength single-threaded build (official `nn-1a298aa575a0.nnue`) is a 99 MB wasm, above Cloudflare Workers' 25 MiB per-asset limit, so the lite build is the strongest one this deployment can serve. To switch builds, run `node scripts/vendor-stockfish.mjs single` and change `ENGINE_BUILD.publicPath` in `lib/review-config.ts`.

**UCI configuration** (`lib/uci-engine.ts`):
- `Threads 1`, one engine per Web Worker. Parallelism comes from a pool of up to 4 workers (cores − 1, and 1 on low-memory devices).
- `Hash 32` MB, fixed so results are reproducible across devices.
- `UCI_ShowWDL true`.
- `MultiPV 1` for the authoritative pass. MultiPV is raised only for targeted searches and re-sent only when it changes.
- Every position is sent as `position fen <start> moves …`, so Stockfish sees repetitions and the 50-move rule.
- `ucinewgame` + `isready` starts every work chunk.
- All searches are node-limited (`go nodes N`). Wall-clock limits are timeouts only.

**Robustness.**
- Stockfish 19 prints `info string CRITICAL ERROR` and exits on an invalid position or command. So every FEN, move history and `searchmoves` list is validated with chess.js before it reaches the engine.
- A crashed or hung worker is restarted, and its whole chunk is replayed from `ucinewgame`, so the result is identical.
- `lowerbound`/`upperbound` aspiration lines are ignored. The one exception is a move that fails high right before the node limit: it keeps its own bound score and principal variation instead of borrowing another move's.
- stockfish.js 19 compiles with `instantiateStreaming`, which rejects wasm not served as `application/wasm`. The client fetches the wasm once and hands workers a correctly typed Blob URL.

**Determinism.** Positions are cut into fixed 12-ply chunks. Each chunk starts with `ucinewgame` and runs sequentially on one engine. A review is therefore a function of (game, node budget, engine build) only, not of how many workers the device runs. This is covered by tests with 1 and 2 real engines.

**Tablebases.** The official `wasm32` target builds with `syzygy=no`, so the browser engine has no Syzygy support. Tablebase scores (`cp ±(20000 − plies)` in SF19) are still decoded explicitly as TB wins or losses for native engines, never treated as giant centipawns. Checkmate, stalemate and insufficient material are resolved without the engine.

### Analysis strategy and budgets

1. **Primary pass**: one MultiPV-1 search per position. This is the authoritative evaluation. The position after a move, flipped to the mover's side, gives the played move's evaluation.
2. **Candidate pass**: MultiPV 3, only where criticality matters. That means possible Best/Excellent/Great/Brilliant moves, Miss candidates, losses within 0.015 of a band boundary, and suspected sacrifices. Decided positions (≥ 97% / ≤ 3%) are skipped unless something is at stake. A sacrifice the engine declines gets a `searchmoves` search forcing the opponent to accept it.
3. **Verification pass**: Brilliant/Great candidates get a MultiPV-2 search at 2× nodes. The move must survive, and the evaluation must not drift by more than 0.15 expected points.

Measured on this project's 4-core CI container:

| | Lite (`lite-single`) | Full (`single`) |
| --- | --- | --- |
| Search speed (Node, 1 thread) | ~570k nodes/s | ~290k nodes/s |
| Engine load | 0.15 s | 1.4 s |
| wasm size | 1.8 MB | 99 MB |

| Preset | Nodes per position | 87-ply Kasparov–Topalov, browser, 3 workers | 33-ply Opera Game |
| --- | --- | --- | --- |
| Quick | 60k | 17 s | ~5 s |
| Balanced (default) | 150k | 34 s | 11 s |
| Deep | 400k | 87 s | ~30 s |

In practice, the candidate pass runs on roughly 60% of moves. Verification runs on the few Brilliant/Great candidates.

## Review model (`ks-review-2.0`)

Every threshold lives in `lib/review-config.ts`. Every reviewed move stores the metadata needed to retune them: `expectedPointsLost`, `cpLoss`, `bestMove`, `playedMove`, `bestEvaluation`, `resultingEvaluation`, `bestPV`, `classificationReason`, `criticality`, `informativeness`, `sacrifice`, `brilliantReason` and `miss`.

### Evaluation and expected score

Each `Evaluation` (`lib/evaluation.ts`) is always from one side's point of view. It contains:
- `cp`, `mate`, `tablebase`;
- Stockfish's WDL (`winProbability`, `drawProbability`, `lossProbability`, `engineExpectedScore`);
- `expectedScore`, which is used for grading;
- `depth`, `nodes`, `pv`, `engineVersion`.

Played moves are always graded from the mover's side, including Black. Mates and tablebase results are decisive (1 / 0), never large numbers.

Grading uses **expected points lost**, not centipawn loss: `bestExpectedScore − playedExpectedScore`. The default expected-score model is **human-calibrated**. It is Lichess's win-percentage curve `1 / (1 + e^(−0.00368208·cp))`, the constant scalachess/lila use for accuracy, applied to Stockfish 19's material-normalized centipawns.

Why not raw Stockfish WDL? Stockfish's WDL describes **engine-vs-engine** conversion: +1.00 already means ~50% wins, and +2.00 means ~95%+ expected. With Chess.com's bands, that turns a ¾-pawn opening slip into a "blunder". I tried fitting Stockfish's own two-sigmoid WDL form to the human curve, and it degenerates to a plain logistic, because humans have no wide engine-style draw band. Engine WDL is still stored on every evaluation, and `EXPECTED_SCORE.model = "engine-wdl"` switches grading to it.

The difference in practice: the same 150 cp loss is a **Mistake** from +0.2 → −1.3, but only **Good** from +9.0 → +7.5.

### Classifications

| Grade | Rule |
| --- | --- |
| Best | Engine's top move (primary or candidate pass), or within 0.004 EP of it (co-best, so engine noise doesn't flip grades). Also used for the only legal move and delivering mate. |
| Excellent | ≤ 0.02 EP lost |
| Good | ≤ 0.05 |
| Inaccuracy | ≤ 0.10 |
| Mistake | ≤ 0.20 |
| Blunder | > 0.20; also any move that walks into a short forced mate |
| Book | The position after the move occurs in the [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) dataset (CC0, 3,815 lines, 7,863 positions). Requires ply < 30 and a loss < 0.05, so a bad move never hides as Book. The objective grade is kept in `objectiveGrade`. |
| Great | See below |
| Brilliant | See below |
| Miss | See below |

The EP bands start from Chess.com's public Classification V2 bands, as a baseline rather than a spec. Mate transitions are explicit:
- Keeping a forced mate: Best, or Excellent/Good by mate length.
- Defending an already-mated position: Best/Excellent/Good by how long the defence lasts.
- Allowing a forced mate: Blunder (Mistake only when already lost and the mate is long).

**Great** is a best or near-best move (≤ 0.01) that is also critical, measured on the candidate or verification lines:
- an **only move** (every alternative loses ≥ 0.20); or
- alternatives lose ≥ 0.10 **and** drop the position to a worse outcome band (losing / worse / balanced / better / winning); or
- it is the clear punishment of an opponent error (≥ 0.10).

Never awarded for:
- obvious recaptures;
- grabbing a piece that is simply hanging (by static exchange evaluation);
- mate-in-one;
- answering a check with ≤ 5 legal replies;
- a move that merely postpones defeat (expected score < 0.25);
- positions where the evaluation proved unstable.

**Brilliant** requires all of:
1. The best or near-best move (≤ 0.01), confirmed by the candidate and verification passes.
2. A genuine material sacrifice (net ≥ 1 pawn unit; the sacrificed unit is never a pawn), detected two ways:
   - **Statically**: SEE on legal moves, so pins, x-rays and checks count. This catches a moved piece left en prise, another piece newly left en prise (for example by removing its defender), exchange and queen sacrifices.
   - **Along the engine line**: a capture within the opponent's first two replies that isn't repaid by an immediate recapture. "Piece for two pawns" still counts; a material deficit that is later recovered is reported as a temporary sacrifice.
3. Accepting doesn't refute it. Either the engine's best defence takes the material and the position holds, or a targeted `searchmoves` search forces the acceptance and the mover keeps ≥ 45% and within 0.05 of the main line.
4. The position after the move is still acceptable (≥ 45%).
5. It is not unnecessary. It is rejected if the best non-sacrificing alternative also keeps ≥ 95%, unless only the sacrifice forces mate.
6. For rated players, a modest non-obviousness edge over the alternative (0 / 0.01 / 0.03 EP below 1200 / below 2000 / above). Soundness never depends on rating.
7. Stability. The deeper verification search must agree, and after the opponent's best reply the mover must still stand within 0.15 EP of the promised evaluation. This hindsight check catches horizon artifacts.

`brilliantReason` states only established facts, e.g. *"Best move. Sacrifices the queen. Stockfish's best defence takes it, and the move leads to a forced mate in 2."* or *"Best move. Sacrifices the knight on b5. Taking it leaves the opponent worse off (13% for them after the capture), and the move keeps the position better (83% expected score)."*

**Miss** means a real opportunity existed before the move and the move gave it up (≥ 0.08) without losing ground below the player's pre-opportunity baseline. The baseline is where the mover stood before the opponent's last move. The opportunity must be one of:
- a forced mate in ≤ 2, or in ≤ 5 when the played move isn't crushing;
- or a best move worth ≥ 0.10 over that baseline, or an outcome-band upgrade.

If the move also dropped below the baseline, it stays a Mistake/Blunder, and the reason adds "It also missed …". Miss metadata records `missedMove`, `missedExpectedScore`, `resultingExpectedScore`, `missedPV` and `missedOpportunityType`, which is one of `mate`, `material`, `only-winning-move`, `drawing-resource` or `tactic`.

**Informativeness.** Each move gets a 0–1 weight for rating purposes:
- 0: book moves and the only legal move;
- 0.25: obvious recaptures;
- 0.3: mate in one;
- 0.5: check evasions with ≤ 5 legal replies, or exactly 2 legal moves;
- 0.15: decided positions where every alternative is also decided;
- 1: everything else.

### Accuracy

- **Per move**: Lichess's published curve (lila `AccuracyPercent`) on expected-score loss: `103.1668·e^(−0.04354·Δ) − 3.1669 + 1`, where Δ is in percentage points.
- **Per game**: the mean of a volatility-weighted mean and a harmonic mean, following lila. Volatility is the standard deviation of White's win% in a sliding window, clamped to [0.5, 12], so long trivial conversions weigh little.
- **KnightScope changes**: moves with a single legal option are excluded, and per-move accuracy is floored at 10 inside the harmonic mean. One catastrophic move then dominates without zeroing the game.
- **By phase**: accuracy is also reported for opening, middlegame and endgame.

Accuracy measures engine precision. It is not presented as, or converted to, Elo.

### Single-game performance rating

This does **not** map accuracy to Elo. A 95%-accuracy game can happen at almost any rating, depending on how hard the positions were.

`lib/rating-model.ts` treats each meaningful decision as evidence. An ordered-logit **engine error model** gives P(error category | rating R, position difficulty, time control). The categories are top move, excellent, good, inaccuracy, mistake and blunder. Difficulty covers stakes 4·E·(1−E) and the number of legal moves. Time control follows Lichess's base + 40 × increment classes.

Over a 400–3000 grid:
- the log-likelihoods, weighted by informativeness and tempered for within-game correlation, are summed;
- the sum is multiplied by a population prior;
- the posterior median is reported, rounded to 50, with its 10th–90th percentile as the interval.

A 20-move game with 8 real decisions therefore gets a much wider interval than an 80-move game with 40. The output includes `estimatedPerformanceRating`, `confidenceLow`/`High`, `confidence`, `meaningfulMoves`, `timeControl`, `ratingSystem`, `model` and `calibrated`.

Reported features also include:
- median / p90 loss;
- blunder, mistake and inaccuracy rates;
- top-1 and top-N agreement;
- critical-position accuracy and only-move success;
- conversion and defensive accuracy;
- opportunity conversion.

**Current status: uncalibrated priors.** The shipped parameters encode rough public error rates and are labelled `calibrated: false` in the UI. The pipeline to replace them with fitted, per-time-control parameters is included and tested (see below). Until then, treat the number as a structured, honest-uncertainty estimate, not a calibrated one.

#### Calibration

```sh
# Lichess monthly dumps are CC0: https://database.lichess.org/ (decompress the .zst first)
npm run calibrate -- extract lichess_db_standard_rated_2026-08.pgn --out features.jsonl --limit 5000 --nodes 60000 --workers 4
npm run calibrate -- fit features.jsonl --out rating-params.json --write-lib
```

`extract` runs the app's own review pipeline on rated games and writes one feature record per decision. `fit` does the following for each time control with ≥ 100 game-sides:
- maximum-likelihood fitting of the 12 model parameters;
- setting the prior from the population;
- choosing the likelihood temper so the holdout 80% interval covers about 80% of true ratings;
- reporting holdout MAE, correlation, coverage and interval width.

With `--write-lib`, the parameters go to `lib/rating-params.ts`, and the estimator picks them up automatically. Parameter recovery and interval coverage are tested on synthetic rated games. Rating pools are never mixed: parameters fit on Lichess blitz describe Lichess blitz ratings, not Chess.com or FIDE.

#### Human move models (Maia)

`HumanMovePredictor` and `humanModelLogLikelihood` add Σ log P(played move | position, R) over the same rating grid. The log-probability is floored at 1e-3 and the sum is tempered. This is the Maia-style estimator: evaluate the grid, combine it with the engine curve, and read the interval off the posterior.

- **Maia-3** ([CSSLab/maia3](https://github.com/CSSLab/maia3), ICLR 2026 "Chessformer") is **AGPL-3.0**.
  - Its only interface is Python/PyTorch, a UCI engine conditioned on `SelfElo`/`OppoElo` (Lichess ratings).
  - It has no ONNX or JS export, and its weights live on Hugging Face.
  - Running it would mean server-side inference, which breaks KnightScope's "nothing leaves your device" design, and AGPL's network-use clause would then apply to that service.
- **Maia-2** ([CSSLab/maia2](https://github.com/CSSLab/maia2)) is **MIT** and has separate Rapid/Blitz models conditioned on self/opponent Elo. It is also PyTorch-only.
- **What shipped**: neither model, because neither can run in the browser today without a separate ONNX export and runtime port. The adapter interface is in place. The most direct path is exporting Maia-2 to ONNX and serving P(move | fen, R) through an optional, explicitly opt-in adapter.

## Limitations

- The browser engine is Stockfish 19 **Lite** (1 MB net). It is far stronger than any human, but it can misjudge very deep sacrificial ideas. For example, it doesn't find Kasparov's 24.Rxd4 at Balanced; at Deep it rates it co-best. The verification and hindsight checks keep such misjudgements from producing false Brilliants, but they cannot create insight the engine lacks. Use Deep for critical games.
- Rating estimates use uncalibrated priors until the calibration step is run on real rated games.
- No Syzygy tablebases in the browser build.

## Licenses

- Stockfish and stockfish.js are GPL-3.0; see `public/stockfish/19.0.0/COPYING.txt` and `SOURCE.txt`.
- chess.js is BSD-2-Clause.
- The opening book data is derived from lichess-org/chess-openings (CC0 1.0); regenerate it with `npm run build:opening-book -- <checkout>`.
