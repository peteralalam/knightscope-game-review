# KnightScope

KnightScope is a private, browser-based chess game review. Paste or upload a PGN and it will:

- replay the game on an interactive board;
- analyze every position with **Stockfish 19** (on-device WebAssembly, several engines in parallel);
- label moves as Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss, or Blunder, with a factual reason;
- show the engine's preferred move and principal variation;
- calculate per-side accuracy (overall and by game phase); and
- estimate a **Lichess-equivalent game performance** with an 80% range calibrated on held-out rated games.

**Privacy: chess analysis runs locally in your browser; game data is not uploaded.** Precisely: no PGN, move, FEN,
engine line, classification, accuracy, rating estimate or anything else derived from a game leaves the device. The page
does make network requests. It loads its own static files, including the Lite engine, and it makes the one-time opt-in
download of the Full engine. All of these are plain `GET` requests for fixed, same-origin files, and none carries game
data. There is no telemetry, analytics or error reporting. `tests/engine-assets.test.mjs` audits the source for every
network API, and the browser end-to-end check in `docs/validation-report.md` recorded zero non-GET or cross-origin
requests during a review.

## Run locally

```sh
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validate

```sh
npm test       # build + unit, rating-model, engine/pipeline and Brilliant suite (real Stockfish 19), render and smoke tests
npm run lint
```

Evidence that the classifications and the rating estimate are reliable is in
[`docs/validation-report.md`](docs/validation-report.md), generated from the committed JSON under `data/`. It covers
corpus statistics, the Brilliant adversarial suite, held-out rating accuracy and interval coverage. In brief:

- **Classification distribution**: 140 curated games (Balanced) and 2,140 rated Lichess games (Quick), reported per 1000 moves overall and by rating band. Great fell from 36 to 20 per 1000 moves after the uniqueness/importance split, with at most 5 per player per game (was 9).
- **Brilliant adversarial suite**: 42 positions, of which 17 are traps and 25 sound sacrifices. It produces **0 false positives**, and 15 of the sound sacrifices are recognised.
- **Rating**: 4,271 game-sides from 3,963 Lichess players, with a player-disjoint split. Held-out MAE is 243 (blitz) and 249 (rapid), against 301 / 341 for always guessing the average and 476 / 408 for the previous heuristic. The 80% range covered 84% / 86%.

Corpus tooling (`scripts/corpus/`):

```sh
npm run corpus:suite     # Brilliant adversarial suite → data/brilliant-suite/report.json
npm run corpus:report    # docs/validation-report.md from data/
```

Rebuilding the corpora is documented at the top of each script. The engine searches are cached in `.cache/corpus/`, so re-grading after a classifier change takes minutes instead of hours.

## Engine

| | Lite (default) | Full (optional) |
| --- | --- | --- |
| Engine | Stockfish 19 search (official tag `sf_19`) | Stockfish 19 (official tag `sf_19`) |
| Port | [stockfish.js 19.0.0](https://github.com/nmrugg/stockfish.js/tree/v19.0.0) = commit `9cb3e5066d48`, npm `stockfish@19.0.0` (pinned) | same |
| Build | `lite-single`: WASM + SIMD, single-threaded | `single`: WASM + SIMD, single-threaded |
| Network | `nn-61e7af4bb97d.nnue`, a 1.1 MB **third-party** Lite net (Chris Bao / sscg13) on a reduced architecture (mirrored piece-square features `P_hm`, L1 = 1024) | `nn-1a298aa575a0.nnue`, the official Stockfish 19 network |
| wasm | 1.8 MB, SHA-256 `57ac2d72…`, static asset | 99.1 MB, SHA-256 `8725c265…`, downloaded only on request |
| Tablebases | none (`__NO_SYZYGY__`) | none |

**Provenance.** stockfish.js's `src/` is official `sf_19` with Emscripten-only changes: cooperative yielding in the
single-threaded search, no filesystem, Syzygy compiled out, and non-aborting position checks. Search, move generation
and evaluation code are unchanged. The Lite flavour also swaps the NNUE feature set and network, so "Stockfish 19 Lite"
is Stockfish 19's search with a smaller, unofficial evaluation. Toolchain: emscripten 3.1.7, `-msimd128`,
`--closure 1`, 128 MB initial / 2 GB max memory. `lib/review-config.ts` (`ENGINE_BUILDS`) pins every binary by
SHA-256, and tests and `scripts/vendor-stockfish.mjs` refuse a mismatch. Every review records:
- in its metadata: the engine's `id name`, build, network, threads × engines, hash and node budgets;
- in the UI footer: Engine / Port / Build / Network / Threads / Nodes / Model.

**GPL.** Serving the wasm is distributing object code. `public/stockfish/19.0.0/` therefore ships, next to it:
- the GPLv3 text;
- `SOURCE.txt`, recording the exact tag, commit, flags and hashes;
- `source/stockfish.js-19.0.0-source.tar.gz`, the complete source and build scripts;
- `source/nn-61e7af4bb97d.nnue`, the network embedded in the Lite binary. It was recovered from the wasm by `scripts/extract-embedded-net.mjs` and verified against the SHA-256 prefix in its name.

Before this, the deployment shipped only a license file and a link to a third-party repository, and no network file.

**Optional Full engine.** Cloudflare's 25 MiB static-asset limit rules out shipping the 99 MB build as a normal asset.
It is served instead by `worker/index.ts` at `/engine-assets/<name>-<sha12>.wasm` from an R2 bucket bound as `ENGINE_ASSETS`:
- same origin, so no CORS;
- `immutable` caching, because the name is content-addressed;
- only static bytes pass through, never game data.

In the app, **Engine: Auto / Lite / Full**:
- Nothing is downloaded until the user clicks *Download full engine*.
- The download shows progress, is SHA-256-verified before it is stored in Cache Storage, and is re-verified on every load. A corrupted file is discarded.
- Auto uses Lite for Quick and Balanced, and Full for Deep once it is downloaded.
- Full runs at most 2 parallel engines, because each instantiates a ~230 MB module.
- Multi-threaded builds are deliberately not used:
  - they need cross-origin isolation (COOP/COEP) for SharedArrayBuffer;
  - their parallel search is non-deterministic;
  - review already parallelizes across positions.
- If this deployment doesn't host the file, the download reports that and Lite keeps working.

To host it:
1. Bind an R2 bucket as `ENGINE_ASSETS`. For this template, set `"r2": "ENGINE_ASSETS"` in `.openai/hosting.json`, or add the binding to your Wrangler config.
2. Run `npm run vendor:stockfish`.
3. Upload the file: `npx wrangler r2 object put <bucket>/engine-assets/stockfish-19-single-8725c2657276.wasm --file .engine-assets/stockfish-19-single-8725c2657276.wasm --content-type application/wasm --remote`.

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

**Tablebases.** Both browser builds compile Syzygy out (`__NO_SYZYGY__`). Tablebase scores (`cp ±(20000 − plies)` in SF19) are still decoded explicitly as TB wins or losses for native engines, never treated as giant centipawns. Checkmate, stalemate and insufficient material are resolved without the engine.

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

## Review model (`ks-review-2.1`)

Every threshold lives in `lib/review-config.ts`. Every reviewed move stores the metadata needed to retune them: `expectedPointsLost`, `cpLoss`, `bestMove`, `playedMove`, `bestEvaluation`, `resultingEvaluation`, `bestPV`, `classificationReason`, `criticality`, `informativeness`, `sacrifice`, `brilliantReason` and `miss`.

### Evaluation and expected score

Every probability-like number in the model is an **expected score**, E[result] with win = 1, draw = ½, loss = 0. None of them is a win probability, and no field is called one. Each `Evaluation` (`lib/evaluation.ts`) is always from one side's point of view and keeps two scales apart:

| Field | Scale | Used for |
| --- | --- | --- |
| `engineWdl`, `engineExpectedScore` | Stockfish 19's own WDL (`UCI_ShowWDL`). Fitted by the Stockfish project on engine self-play at fixed material, where +1.00 ≈ 50% wins. | Diagnostics, and the "objective" result class (win / draw / loss) in the Great rule |
| `baselineExpectedScore` | A **fixed, rating-independent** curve: Lichess's published `1 / (1 + e^(−0.00368208·cp))` (lila `WinPercent` ÷ 100), on Stockfish 19's normalized centipawns | **Every user-facing classification** |

`baselineExpectedScore` is the curve value, or exactly 1 / 0 for mates and tablebase results. Played moves are always graded
from the mover's side, including Black.

**What the baseline curve is, and isn't.** Lichess fitted it to real rated Lichess games between players rated around 2300,
as a function of an older, pre-normalization Stockfish's evaluation. Lichess calls it "Win%", but it was fitted with draws
counted as half, so it is an expected score. It is a population-average conversion for *strong* players, **not** a
rating-conditioned model. Applying it to Stockfish 19's normalized scale is an approximation. It is still used for grading
because the engine scale grades human games far too harshly: under Stockfish WDL a ¾-pawn opening slip is a "Blunder".

**This is our own hybrid, not Chess.com's model.** The expected-points-loss bands below (Excellent < 0.02, Good < 0.05,
Inaccuracy < 0.10, Mistake < 0.20, Blunder ≥ 0.20) are Chess.com's published Classification V2 thresholds. Chess.com
applies them to its own Expected Points model, which conditions on the player's rating and is not public. We apply them
to the fixed Lichess curve instead, so a move gets the same grade whoever plays it. Our own rating-conditioned model,
E[result | cp, rating, time control], and whether it should replace the baseline curve, is covered under
[Outcome model](#rating-conditioned-outcome-model).

Grading uses **expected points lost** (`bestBaselineExpectedScore − playedBaselineExpectedScore`), not centipawn loss.

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

**Great** separates **uniqueness** from **importance**. Both are measured on the candidate (MultiPV 3) or verification lines:
- `moveUniqueness`: how much better the move is than the best alternative, in baseline expected score (EP).
- `outcomeImportance`: the same gap after clamping both scores to the undecided range [0.15, 0.85]. Choosing between two winning continuations therefore has zero importance, however large the centipawn gap. Example: +8.6 vs +6.5 has importance 0; 0.00 vs −3.00 has importance 0.25.

A move is Great when all of these hold:
1. **Quality**: best or within 0.01 EP.
2. **Uniqueness**: every alternative is ≥ 0.10 EP worse, so exactly one viable move exists.
3. **Importance**: `outcomeImportance` ≥ 0.10, and the alternative changes the *result class*. That means either Stockfish's WDL verdict flips (win/draw/loss), or the human expected score falls by ≥ 2 outcome bands, e.g. winning → balanced. "Winning vs better" is the same result.

The 0.10 thresholds are the Inaccuracy/Mistake boundary: a move is Great when every alternative would have been at
least a Mistake, counting only the part of the loss that moves the game between outcome classes.

Never Great:
- recaptures;
- taking a hanging piece or pawn (by SEE);
- mate in one;
- forced moves (check evasions with ≤ 5 replies, or ≤ 2 legal moves);
- moves that only postpone defeat (< 25%);
- unstable evaluations;
- the **planned follow-up** of the mover's previous Great/Brilliant move (its line predicted the reply and this move), because the credit belongs to the earlier decision;
- any move in a **run of consecutive critical moves** after the first, such as a perpetual check or a fortress king shuffle. One decision is credited once;
- a move from a position that **already occurred** in the game.

Reasons are typed:
- *only move that holds*;
- *only move that keeps the win*;
- *punishes the opponent's error*: a balanced-or-worse position turned into a better or winning one after an opponent error of ≥ 0.10;
- *critical move*.

Every Great **candidate** (near-best and unique) stores `greatDiagnostics`, whether promoted or not:
- `evaluationBefore`, `bestMove`, `playedMove`;
- best / played / 2nd / 3rd expected scores and `gapBestToSecond`;
- `numberOfAcceptableMoves`, `legalMoveCount`;
- position state before and after, and before the opponent's move;
- `onlyMove`, `outcomeTransition`, `objectiveTransition`;
- `tacticalOpportunity`, `forcedMove`, `obviousRecapture`, `opponentPreviousMoveLoss`;
- `greatReason`, and the `decision`, meaning the first rule that rejected it.

The UI shows them under *Why this grade*.

**Brilliant** requires all of:
1. The best or near-best move (≤ 0.01), confirmed by the candidate and verification passes.
2. A genuine material sacrifice (net ≥ 1 pawn unit; the sacrificed unit is never a pawn), detected two ways:
   - **Statically**: SEE on legal moves, so pins, x-rays and checks count. This catches a moved piece left en prise, another piece newly left en prise (for example by removing its defender), exchange and queen sacrifices.
   - **Along the engine line**: a capture within the opponent's first two replies that isn't repaid by an immediate recapture. "Piece for two pawns" still counts; a material deficit that is later recovered is reported as a temporary sacrifice.
3. Accepting doesn't refute it. Either the engine's best defence takes the material and the position holds, or a targeted `searchmoves` search forces the acceptance and the mover keeps ≥ 45% and within 0.05 of the main line.
4. The position after the move is still acceptable (≥ 45%).
5. It is not unnecessary: rejected if the best alternative also keeps ≥ 95%. That includes a faster forced mate when a quiet move already wins.
   Also rejected:
   - **pseudo-sacrifices**: the material comes back by force within 4 plies;
   - **forced sacrifices**: every alternative is mated;
   - the **planned follow-up** of a previous Great/Brilliant move, and a second Brilliant directly after one (a combination is credited once);
   - a sacrifice that appears only along the engine line (nothing left en prise on the board) and is regained within that line.
6. For rated players, a modest non-obviousness edge over the alternative (0 / 0.01 / 0.03 EP below 1200 / below 2000 / above). Soundness never depends on rating.
7. Stability. The deeper verification search must agree, and after the opponent's best reply the mover must still stand within 0.15 EP of the promised evaluation. This hindsight check catches horizon artifacts.

Declining is allowed. When Stockfish's best defence declines the offer, the forced-acceptance search only has to show
that taking is not a refutation, so a sacrifice whose point is the threat can still be Brilliant.

Every Brilliant **candidate** stores `brilliantDiagnostics`:
- material before the move, after it, after the best defence, and at the end of the PV;
- the sacrificed piece and its value;
- expected score before, after, and after forced acceptance;
- the best defence, and `acceptanceIsBestDefense`;
- `forcedMate`, `bestMoveRank`;
- the best alternative's score, and the deeper verification score;
- the `decision`.

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

### Lichess-equivalent game performance

The estimate answers: *which Lichess rating's typical games look like this one?* It is calibrated on real rated
Lichess games, so it is a **Lichess blitz / rapid** number. It is not Chess.com, FIDE, or anyone's account rating.
It does not map accuracy to Elo.

**Model.** A ridge regression, one per time control (blitz, rapid), from 19 interpretable per-game features
(`lib/rating-model.ts`, `RATING_FEATURES`):
- mean / median / p75 / p90 expected-points loss, and a stakes-weighted loss (all log-scaled);
- blunder, mistake and inaccuracy rates;
- top-1 and top-3 agreement;
- critical-position accuracy and only-move success;
- opportunity conversion;
- defensive and conversion accuracy;
- middlegame and endgame accuracy;
- meaningful decisions and game length.

Features a game cannot measure (no endgame, no critical positions) are imputed with the training mean plus a missing flag.
Neither player's rating is ever a feature, and neither is the opponent's. Bullet uses the blitz model, and classical or
unknown time controls use the rapid model; both are flagged as extrapolated.

**Interval.** The 80% range comes from held-out residuals, not a formula. Residual spread is modelled as
`s(n) = sqrt(a + b/n)` in the number of meaningful decisions `n`, fitted on the validation split. The 10th and 90th
percentiles of the standardized validation residuals set the bounds. A 12-move miniature gets a wider range than a
60-move game because such games measurably are harder to place.

**Data and protocol** (`scripts/corpus/`):
1. `prepare-rating-corpus.mjs`: public rated Lichess games from two sources, the Lichess puzzle/game database sample (2013–2022) and the Kaggle "datasnaek" set (2016–17). Every filter is documented and counted in `data/rating-corpus/FILTERS.json`. Games are stratified by time control × rating band, with at most 3 games per player.
2. `analyze-corpus.mjs`: runs the app's own pipeline (Quick preset) on every game. Searches are cached.
3. `rating-dataset.mjs`: one row per game-side. Players are linked when they meet, and each connected component of that graph goes to exactly one of train / validation / test (60/20/20). No player, and no game, appears in two splits.
4. `rating-errormodel.mjs`: fits the previous ordered-logit error model on the same split, as a baseline.
5. `rating_benchmark.py`: benchmarks six models and writes `lib/rating-params.ts` (`--write-lib`). The models are constant, the old prior, the fitted error model, isotonic on mean loss, ridge, and gradient boosting (sklearn, offline only).

A test checks that the TypeScript model reproduces the Python predictions.

Results are in [`docs/validation-report.md`](docs/validation-report.md) §4–7:
- MAE, median AE, RMSE and R² on test players;
- MAE by rating band, time control, decision count, result, phase composition and source;
- 80% coverage and width, by decisions and by band.

#### Human move models (Maia)

`HumanMovePredictor` and `humanModelLogLikelihood` add Σ log P(played move | position, R) over the same rating grid. The log-probability is floored at 1e-3 and the sum is tempered. This is the Maia-style estimator: evaluate the grid, combine it with the engine curve, and read the interval off the posterior.

- **Maia-3** ([CSSLab/maia3](https://github.com/CSSLab/maia3), ICLR 2026 "Chessformer") is **AGPL-3.0**.
  - Its only interface is Python/PyTorch, a UCI engine conditioned on `SelfElo`/`OppoElo` (Lichess ratings).
  - It has no ONNX or JS export, and its weights live on Hugging Face.
  - Running it would mean server-side inference, which would send game positions to a server and break KnightScope's "game data is not uploaded" design, and AGPL's network-use clause would then apply to that service.
- **Maia-2** ([CSSLab/maia2](https://github.com/CSSLab/maia2)) is **MIT** and has separate Rapid/Blitz models conditioned on self/opponent Elo. It is also PyTorch-only.
- **What shipped**: neither model, because neither can run in the browser today without a separate ONNX export and runtime port. The adapter interface is in place. The most direct path is exporting Maia-2 to ONNX and serving P(move | fen, R) through an optional, explicitly opt-in adapter.

## Limitations

- **Lite is not the official evaluation.** The default engine uses Stockfish 19's search with a small third-party network. It is far stronger than any human, but it misses very deep ideas. For example, it doesn't find Kasparov's 24.Rxd4 at Balanced, while the Full engine rates it Brilliant (see the report, §8). The Full engine needs an R2 bucket to host its 99 MB file.
- **One game says little about rating.** On held-out Lichess players the estimate is off by about 240–250 points on average (blitz / rapid). That is 20–30% better than always guessing the average, but it is not a rating.
- **The 80% range is calibrated overall, not per band.** It covers 82–86% overall, but players far from the average are covered less often, because single-game estimates regress toward the mean.
- **Rating-corpus coverage.**
  - Blitz has no games below 1400.
  - Rapid below 1400 comes only from 2016–17 games.
  - Every puzzle-database game contains at least one tactical error, because that is how Lichess selects puzzle games.
  - The model was trained on Quick-preset analysis. Re-analyzing 120 test games at Balanced moved estimates by 35–70 points on average, with no systematic shift (−11 / +16) and an equal or better MAE (`data/rating-corpus/preset-check.json`).
- **Great and Brilliant are rule-based.** They are checked on corpora and an adversarial suite, not against human annotations. `docs/validation-report.md` lists every rule's hit counts.
- **No Syzygy tablebases** in either browser build.

## Licenses

- Stockfish and stockfish.js are GPL-3.0; see `public/stockfish/19.0.0/COPYING.txt` and `SOURCE.txt`.
- chess.js is BSD-2-Clause.
- The opening book data is derived from lichess-org/chess-openings (CC0 1.0); regenerate it with `npm run build:opening-book -- <checkout>`.
