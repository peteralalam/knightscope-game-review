/**
 * Rating-conditioned human outcome model: E[result | cp, rating, time control].
 *
 * Fitted by scripts/corpus/outcome_model.py on positions from rated Lichess
 * games, analyzed with the same Stockfish 19 Lite search the reviewer uses, with
 * players split disjointly into train / validation / test. The fitted form is
 *
 *   logit E = w₁(R, tc) · cp/100 + w₂(R, tc) · sign(cp) · log(1 + |cp|/100)
 *   wᵢ = exp(βᵢ · [1, rapid, z, z², z·rapid, z²·rapid]),  z = (R − 1500) / 400
 *
 * (w₂ only in the saturating variant). It is odd in cp, so cp = 0 gives exactly
 * ½, strictly increasing in cp and tends to 0 / 1, for every rating and time
 * class, by construction (every weight is an exponential). The rating is
 * clamped to the fitted range. It is an EXPECTED SCORE (draw = ½), like the
 * baseline curve it may replace for DISPLAYED ordinary grades only.
 *
 * No circularity: the rating that selects the curve is estimated from
 * rating-independent features (baseline-curve losses, engine agreement,
 * criticality – see extractFeatures), and re-grading never feeds back into
 * that estimate. See regradeForRating().
 */
import { baselineCurveExpectedScore, type Evaluation } from "./evaluation.ts";
import { LOSS_BANDS } from "./review-config.ts";
import type { TimeControlClass } from "./chess-review.ts";

export interface OutcomeModelParams {
  id: string;
  form: string;
  spec: { tc?: boolean; rating?: boolean; sat?: boolean; phase?: boolean };
  /** β for the linear-in-cp weight, in slope_basis order. */
  slope: readonly number[];
  /** β for the saturating weight, or null. */
  saturation: readonly number[] | null;
  /** Nuisance coefficient on (R_mover − R_opponent)/400; 0 at inference. */
  ratingDifference: number;
  ratingRange: readonly [number, number];
}

function basis(spec: OutcomeModelParams["spec"], rating: number, rapid: number, endgame: number) {
  const z = (rating - 1500) / 400;
  const row = [1];
  if (spec.tc) row.push(rapid);
  if (spec.rating) {
    row.push(z, z * z);
    if (spec.tc) row.push(z * rapid, z * z * rapid);
  }
  if (spec.phase) row.push(endgame);
  return row;
}

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

/** Only blitz and rapid are modelled; other time controls use the nearer one. */
export function outcomeTimeClass(tc: TimeControlClass | undefined) {
  return tc === "rapid" || tc === "classical" || tc === "correspondence" || tc === "unknown" || tc === undefined ? 1 : 0;
}

/** Expected score of the side with `cp` (its own view) for a player of `rating`. */
export function ratedExpectedScore(
  cp: number,
  rating: number,
  tc: TimeControlClass | undefined,
  model: OutcomeModelParams,
  options: { endgame?: boolean } = {},
) {
  const r = Math.min(model.ratingRange[1], Math.max(model.ratingRange[0], rating));
  const clipped = Math.max(-2000, Math.min(2000, cp));
  const row = basis(model.spec, r, outcomeTimeClass(tc), options.endgame ? 1 : 0);
  let eta = Math.exp(dot(model.slope, row)) * (clipped / 100);
  if (model.saturation) {
    eta += Math.exp(dot(model.saturation, row)) * Math.sign(clipped) * Math.log1p(Math.abs(clipped) / 100);
  }
  return 1 / (1 + Math.exp(-eta));
}

/** Rated expected score for an Evaluation: decisive scores stay 0 / 1 (or ½). */
export function ratedEvaluationScore(
  evaluation: Pick<Evaluation, "cp" | "mate" | "tablebase" | "baselineExpectedScore">,
  rating: number,
  tc: TimeControlClass | undefined,
  model: OutcomeModelParams,
) {
  if (evaluation.cp === undefined || evaluation.mate !== undefined || evaluation.tablebase) return evaluation.baselineExpectedScore;
  return ratedExpectedScore(evaluation.cp, rating, tc, model);
}

/** Baseline counterpart, for symmetry in tests and reports. */
export const baselineScore = baselineCurveExpectedScore;

export type OrdinaryGrade = "best" | "excellent" | "good" | "inaccuracy" | "mistake" | "blunder";
const ORDINARY = new Set<string>(["best", "excellent", "good", "inaccuracy", "mistake", "blunder"]);

export function severityFromLoss(loss: number, isTop: boolean): OrdinaryGrade {
  if (isTop || loss <= LOSS_BANDS.bestEquivalence) return "best";
  if (loss <= LOSS_BANDS.excellent) return "excellent";
  if (loss <= LOSS_BANDS.good) return "good";
  if (loss <= LOSS_BANDS.inaccuracy) return "inaccuracy";
  if (loss <= LOSS_BANDS.mistake) return "mistake";
  return "blunder";
}

export interface RegradeInput {
  grade: string;
  isTopMove: boolean;
  bestEvaluation: Pick<Evaluation, "cp" | "mate" | "tablebase" | "baselineExpectedScore">;
  resultingEvaluation: Pick<Evaluation, "cp" | "mate" | "tablebase" | "baselineExpectedScore">;
}

/**
 * Step 3 of the pipeline (optional, display only): the ordinary grade a move
 * would get on the rating-conditioned curve for a player of `rating`. Book,
 * Great, Brilliant and Miss – and any move involving a mate or tablebase score –
 * keep their baseline grade. Pure function of (move, rating): it is applied once,
 * after the rating estimate, and its output is never read by extractFeatures,
 * so there is no rating ↔ classification feedback loop to converge.
 */
export function regradeForRating(move: RegradeInput, rating: number, tc: TimeControlClass | undefined, model: OutcomeModelParams) {
  if (!ORDINARY.has(move.grade)) return move.grade;
  const best = move.bestEvaluation;
  const played = move.resultingEvaluation;
  if (best.cp === undefined || played.cp === undefined || best.mate !== undefined || played.mate !== undefined || best.tablebase || played.tablebase) {
    return move.grade;
  }
  const loss = Math.max(0, ratedExpectedScore(best.cp, rating, tc, model) - ratedExpectedScore(played.cp, rating, tc, model));
  return severityFromLoss(loss, move.isTopMove);
}
