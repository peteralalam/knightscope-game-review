// Select real positions for the Brilliant adversarial suite from the Lichess
// puzzle database (CC0; themes are assigned automatically by lichess-puzzler).
//
//   node scripts/corpus/build-brilliant-suite.mjs combined_puzzle_db_first_50k.ndjson
//
// Writes data/brilliant-suite/puzzles.json. Each case starts at the puzzle FEN,
// plays the opponent's move that set the puzzle up and the first solution
// moves, and the move under test is the first solution move (ply index 1).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { staticSacrifices, uciParts } from "../../lib/chess-analysis.ts";

const PER_CATEGORY = 4;

/** The move under test: the first solution move, or the first underpromotion. */
function testedMove(puzzle, themes) {
  const chess = new Chess(puzzle.FEN);
  const moves = puzzle.Moves.split(" ");
  let ply = 1;
  if (themes.has("underPromotion")) {
    ply = moves.findIndex((uci, index) => index % 2 === 1 && uci.length === 5 && uci[4] !== "q");
    if (ply < 0) throw new Error("no underpromotion");
  }
  for (const uci of moves.slice(0, ply)) chess.move(uciParts(uci));
  const before = chess.fen();
  const move = chess.move(uciParts(moves[ply]));
  return { before, move, ply };
}

const CATEGORIES = {
  "greek-gift": (puzzle, themes, { move }) =>
    themes.has("sacrifice") && move.piece === "b" && move.captured === "p" && ["h7", "h2"].includes(move.to) && move.san.includes("+"),
  deflection: (puzzle, themes) => themes.has("sacrifice") && themes.has("deflection"),
  clearance: (puzzle, themes) => themes.has("sacrifice") && themes.has("clearance"),
  "mating-sacrifice": (puzzle, themes, { before, move }) =>
    themes.has("sacrifice") && (themes.has("mateIn2") || themes.has("mateIn3")) && ["q", "r"].includes(move.piece) &&
    staticSacrifices(before, `${move.from}${move.to}${move.promotion ?? ""}`, 3).length > 0,
  "quiet-sacrifice": (puzzle, themes, { move }) => themes.has("sacrifice") && themes.has("quietMove") && !move.captured && !move.san.includes("+"),
  "exchange-sacrifice": (puzzle, themes, { before, move }) =>
    themes.has("sacrifice") && move.piece === "r" && ["n", "b"].includes(move.captured ?? "") &&
    staticSacrifices(before, `${move.from}${move.to}`, 1).length > 0,
  underpromotion: (puzzle, themes) => themes.has("underPromotion"),
  // Routine: taking a genuinely hanging piece. Must never be Brilliant.
  "hanging-piece-capture": (puzzle, themes, { move }) => themes.has("hangingPiece") && themes.has("oneMove") && Boolean(move.captured) && !move.san.includes("#"),
};

const file = process.argv[2];
const puzzles = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).puzzle);
puzzles.sort((a, b) => a.PuzzleId.localeCompare(b.PuzzleId));
const selected = Object.fromEntries(Object.keys(CATEGORIES).map((key) => [key, []]));
for (const puzzle of puzzles) {
  if (Number(puzzle.NbPlays) < 100) continue;
  const themes = new Set(puzzle.Themes.split(" "));
  let facts;
  try {
    facts = testedMove(puzzle, themes);
  } catch {
    continue;
  }
  for (const [category, test] of Object.entries(CATEGORIES)) {
    if (selected[category].length >= PER_CATEGORY) continue;
    if (!test(puzzle, themes, facts)) continue;
    const moves = puzzle.Moves.split(" ");
    selected[category].push({
      id: `${category}/${puzzle.PuzzleId}`,
      category,
      source: `https://lichess.org/training/${puzzle.PuzzleId}`,
      game: puzzle.GameUrl,
      themes: puzzle.Themes,
      puzzleRating: Number(puzzle.Rating),
      fen: puzzle.FEN,
      moves: moves.slice(0, facts.ply + 3),
      testedPly: facts.ply,
      testedSan: facts.move.san,
    });
    break;
  }
}
mkdirSync("data/brilliant-suite", { recursive: true });
writeFileSync("data/brilliant-suite/puzzles.json", JSON.stringify(Object.values(selected).flat(), null, 2) + "\n");
for (const [category, cases] of Object.entries(selected)) console.log(category, cases.map((item) => `${item.testedSan} (${item.source})`).join(", "));
