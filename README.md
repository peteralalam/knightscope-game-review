# KnightScope

KnightScope is a private, browser-based chess game review. Paste or upload a PGN and it will:

- replay the game on an interactive board;
- analyze every decision with Stockfish 18 Lite;
- label moves as Brilliant, Great, Best, Good, Inaccuracy, Mistake, or Blunder;
- show the engine’s preferred move and principal variation;
- calculate per-side accuracy; and
- estimate a broad single-game playing-strength range.

All engine work runs locally in a browser Web Worker. PGNs are not uploaded or stored.

## Run locally

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validate

```powershell
npm test
npm run lint
```

The test suite covers PGN parsing, grade thresholds, score normalization, rating-range clamping, server rendering, static engine assets, and a real Stockfish UCI smoke search.

## Review model

KnightScope compares the played move with Stockfish’s top candidates using WDL expected score, not only raw centipawn loss. Base bands are:

| Grade | Expected-score loss |
| --- | ---: |
| Best | ≤ 0.6% |
| Good | ≤ 2.5% |
| Inaccuracy | ≤ 8% |
| Mistake | ≤ 18% |
| Blunder | > 18% |

Great moves must be unique engine-top choices. Brilliant moves must also pass a sound-sacrifice heuristic. Mate transitions receive explicit overrides. These are KnightScope’s own transparent heuristics; Chess.com’s exact Game Review model is proprietary.

The displayed rating range is a heuristic single-game performance estimate. It is intentionally broad and is not an account rating or a substitute for a multi-game rating system.

## Engine license

The app distributes the lite single-thread WebAssembly build from [Stockfish.js 18.0.8](https://github.com/nmrugg/stockfish.js/tree/v18.0.8), licensed under GPL v3. The bundled license is at `public/stockfish/18.0.8/COPYING.txt`. Chess.js is BSD-2-Clause.
