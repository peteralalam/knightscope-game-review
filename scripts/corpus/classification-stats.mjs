// Classification distribution and pathology report for analyzed corpora.
//
//   node scripts/corpus/classification-stats.mjs ".cache/corpus/validation-balanced.jsonl" \
//     [--games data/validation-corpus/games.jsonl] [--json out.json]
//
// Rates are per 1000 moves (all plies, Book included, so rows sum to 1000).
// "Pathologies" are patterns that indicate a bug rather than a style choice:
// too many Great moves in one game, Great recaptures, Brilliants that are not
// real sacrifices, Book extending past bad moves, Miss on every tactical error.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { GRADE_ORDER } from "../../lib/chess-review.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function expand(pattern) {
  const directory = dirname(pattern);
  const regex = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return readdirSync(directory).filter((name) => regex.test(name)).sort().map((name) => join(directory, name));
}

const BANDS = [[0, 1200, "<1200"], [1200, 1600, "1200–1599"], [1600, 2000, "1600–1999"], [2000, 2400, "2000–2399"], [2400, 4000, "2400+"]];
const bandOf = (rating) => (rating ? BANDS.find(([low, high]) => rating >= low && rating < high)?.[2] : "unrated (master OTB)");

export function loadAnalyses(pattern, gamesFile) {
  const games = gamesFile
    ? new Map(readFileSync(gamesFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((game) => [game.id, game]))
    : new Map();
  // Keyed by game id: a re-run appends a newer record for the same game.
  const analyses = new Map();
  for (const file of expand(pattern)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const analysis = JSON.parse(line);
      if (analysis.error || (games.size && !games.has(analysis.id))) continue;
      analyses.set(analysis.id, { ...analysis, game: games.get(analysis.id) });
    }
  }
  return [...analyses.values()];
}

function rates(moves) {
  const counts = Object.fromEntries(GRADE_ORDER.map((grade) => [grade, 0]));
  for (const move of moves) counts[move.g] += 1;
  return {
    moves: moves.length,
    per1000: Object.fromEntries(GRADE_ORDER.map((grade) => [grade, moves.length ? Math.round((counts[grade] / moves.length) * 10000) / 10 : 0])),
    counts,
  };
}

export function classificationReport(analyses) {
  const allMoves = analyses.flatMap((analysis) => analysis.moves.map((move) => ({ ...move, analysis })));
  const ratingOf = (move) => {
    const side = move.analysis.sides?.[move.c];
    return side?.rating ?? (move.c === "w" ? move.analysis.game?.white?.rating : move.analysis.game?.black?.rating);
  };
  const byBand = {};
  for (const [, , label] of [...BANDS, [0, 0, "unrated (master OTB)"]]) {
    const moves = allMoves.filter((move) => bandOf(ratingOf(move)) === label);
    if (moves.length) byBand[label] = rates(moves);
  }
  const byTag = {};
  for (const analysis of analyses) {
    for (const tag of analysis.game?.tags ?? analysis.tags ?? []) (byTag[tag] ??= []).push(...analysis.moves);
  }

  const perSideGreat = analyses.flatMap((analysis) => ["w", "b"].map((color) => ({
    id: analysis.id,
    color,
    great: analysis.moves.filter((move) => move.c === color && move.g === "great").length,
    brilliant: analysis.moves.filter((move) => move.c === color && move.g === "brilliant").length,
    moves: analysis.moves.filter((move) => move.c === color).length,
  })));
  const tacticalErrors = allMoves.filter((move) => ["mistake", "miss", "blunder"].includes(move.g));
  const book = allMoves.filter((move) => move.book);
  const greatCandidates = allMoves.filter((move) => move.great);
  const decisionCounts = {};
  for (const move of greatCandidates) decisionCounts[move.great.decision] = (decisionCounts[move.great.decision] ?? 0) + 1;
  const brilliantCandidates = allMoves.filter((move) => move.brill);
  const brilliantDecisions = {};
  for (const move of brilliantCandidates) brilliantDecisions[move.brill.decision] = (brilliantDecisions[move.brill.decision] ?? 0) + 1;

  return {
    games: analyses.length,
    overall: rates(allMoves),
    byBand,
    byTag: Object.fromEntries(Object.entries(byTag).map(([tag, moves]) => [tag, rates(moves)])),
    greatPerSideGame: {
      mean: Math.round((perSideGreat.reduce((sum, side) => sum + side.great, 0) / Math.max(1, perSideGreat.length)) * 100) / 100,
      max: Math.max(0, ...perSideGreat.map((side) => side.great)),
      distribution: perSideGreat.reduce((acc, side) => ({ ...acc, [side.great]: (acc[side.great] ?? 0) + 1 }), {}),
    },
    greatDecisions: decisionCounts,
    brilliantDecisions,
    pathologies: {
      sidesWithMoreThan3Great: perSideGreat.filter((side) => side.great > 3).map((side) => `${side.id}:${side.color} (${side.great} in ${side.moves})`),
      greatRecaptures: allMoves.filter((move) => move.g === "great" && move.fr === "recapture").map((move) => `${move.analysis.id}#${move.i} ${move.san}`),
      greatWhileDecided: allMoves.filter((move) => move.g === "great" && move.great && move.great.positionStateBefore === "winning" && move.great.objectiveTransition === "win vs win").map((move) => `${move.analysis.id}#${move.i} ${move.san}`),
      brilliantsWithoutSacrifice: allMoves.filter((move) => move.g === "brilliant" && !move.sac).map((move) => `${move.analysis.id}#${move.i} ${move.san}`),
      brilliantsWhereAlternativeAlreadyWon: allMoves.filter((move) => move.g === "brilliant" && (move.brill?.bestAlternativeExpectedScore ?? 0) >= 0.95).map((move) => `${move.analysis.id}#${move.i} ${move.san}`),
      brilliantsFromLosingPositions: allMoves.filter((move) => move.g === "brilliant" && move.eb < 0.4).map((move) => `${move.analysis.id}#${move.i} ${move.san} (E ${move.eb})`),
      consecutiveBrilliantsSameSide: allMoves.filter((move) => move.g === "brilliant" && move.analysis.moves[move.i - 2]?.g === "brilliant").map((move) => `${move.analysis.id}#${move.i} ${move.san}`),
      missShareOfTacticalErrors: Math.round((tacticalErrors.filter((move) => move.g === "miss").length / Math.max(1, tacticalErrors.length)) * 1000) / 1000,
      bookMovesLosingOver5Points: book.filter((move) => move.loss > 0.05).length,
      maxBookPly: Math.max(0, ...book.map((move) => move.i + 1)),
      bookAfterNonBookMove: analyses.filter((analysis) => {
        let left = false;
        for (const move of analysis.moves) {
          if (!move.book) left = true;
          else if (left) return true;
        }
        return false;
      }).length,
    },
    brilliants: allMoves.filter((move) => move.g === "brilliant").map((move) => ({ game: move.analysis.id, ply: move.i, san: move.san, rating: ratingOf(move), evidence: move.brill })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const analyses = loadAnalyses(process.argv[2], argument("games"));
  const report = classificationReport(analyses);
  const json = argument("json");
  if (json) writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.games} games, ${report.overall.moves} moves`);
  console.log("per 1000 moves:", JSON.stringify(report.overall.per1000));
  for (const [band, value] of Object.entries(report.byBand)) console.log(`  ${band.padEnd(22)} (${value.moves} moves)`, JSON.stringify(value.per1000));
  console.log("Great per side-game:", JSON.stringify(report.greatPerSideGame));
  console.log("Great candidate decisions:", JSON.stringify(report.greatDecisions));
  console.log("Brilliant candidate decisions:", JSON.stringify(report.brilliantDecisions));
  console.log("pathologies:", JSON.stringify(report.pathologies, null, 1));
}
