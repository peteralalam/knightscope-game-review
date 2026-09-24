"""Benchmark single-game rating estimators on player-disjoint held-out games.

    python3 scripts/corpus/rating_benchmark.py data/rating-corpus/samples.jsonl \
        --errmodel .cache/corpus/errmodel.json --out data/rating-corpus/benchmark.json [--write-lib]

Models (fitted separately for blitz and rapid, on the TRAIN split only):
  constant   – always predict the training-set mean rating (the floor to beat)
  heuristic  – the shipped v2.0 prior (uncalibrated ordered-logit error model)
  errmodel   – the same ordered-logit model with parameters fitted by maximum
               likelihood (scripts/corpus/rating-errormodel.mjs)
  isotonic   – monotone mapping from mean expected-points loss alone
               (what an "accuracy → rating table" does)
  ridge      – ridge regression on the 19 interpretable features
  gbm        – histogram gradient boosting (depth 3), for reference only

Hyperparameters and the interval model are chosen on VALIDATION; every number
reported as held-out is on TEST, which nothing was tuned on. sklearn is used
offline for the benchmark only; the shipped model is the ridge regression,
evaluated in TypeScript by lib/rating-model.ts from the exported parameters.
"""
import argparse
import json
import math

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import Ridge

FEATURES = [
    "logMeanLoss", "logMedianLoss", "logP75Loss", "logP90Loss", "logComplexityWeightedLoss",
    "blunderRate", "mistakeRate", "inaccuracyRate", "top1Agreement", "top3Agreement",
    "criticalAccuracy", "onlyMoveSuccess", "opportunityConversion", "defensiveAccuracy",
    "conversionAccuracy", "middlegameAccuracy", "endgameAccuracy", "logMeaningfulDecisions", "logGameLength",
]
BANDS = ["800–1000", "1000–1200", "1200–1400", "1400–1600", "1600–1800", "1800–2000", "2000–2200", "2200–2400", "2400+"]
DECISION_BINS = [(0, 15, "<15"), (15, 25, "15–24"), (25, 40, "25–39"), (40, 10_000, "40+")]
ENDGAME_BINS = [(0, 0.05, "no endgame"), (0.05, 0.4, "some endgame"), (0.4, 1.01, "endgame-heavy")]


def metrics(y, p):
    y, p = np.asarray(y, float), np.asarray(p, float)
    if len(y) == 0:
        return None
    err = p - y
    ss_tot = float(((y - y.mean()) ** 2).sum())
    return {
        "n": int(len(y)),
        "mae": round(float(np.abs(err).mean()), 1),
        "medianAe": round(float(np.median(np.abs(err))), 1),
        "rmse": round(float(math.sqrt((err ** 2).mean())), 1),
        "r2": round(1 - float((err ** 2).sum()) / ss_tot, 3) if ss_tot > 0 else None,
        "bias": round(float(err.mean()), 1),
    }


def design(rows, stats=None):
    raw = np.array([[math.nan if v is None else v for v in row["x"]] for row in rows], float)
    if stats is None:
        with np.errstate(all="ignore"):
            imputation = np.nanmean(raw, axis=0)
        imputation = np.where(np.isnan(imputation), 0.0, imputation)
        indicators = [i for i in range(raw.shape[1]) if np.isnan(raw[:, i]).any()]
        stats = {"imputation": imputation, "indicators": indicators}
    filled = np.where(np.isnan(raw), stats["imputation"], raw)
    extra = np.isnan(raw[:, stats["indicators"]]).astype(float)
    X = np.hstack([filled, extra])
    if "mean" not in stats:
        stats["mean"] = X.mean(axis=0)
        scale = X.std(axis=0)
        stats["scale"] = np.where(scale < 1e-9, 1.0, scale)
    return (X - stats["mean"]) / stats["scale"], stats


def interval_model(residuals, n):
    """s(n)^2 = a + b/n by least squares on squared residuals; empirical z-quantiles."""
    A = np.vstack([np.ones_like(n), 1.0 / n]).T
    coef, *_ = np.linalg.lstsq(A, residuals ** 2, rcond=None)
    a, b = max(float(coef[0]), 1.0), max(float(coef[1]), 0.0)
    s = np.sqrt(a + b / n)
    z = residuals / s
    return {"a": a, "b": b, "qLow": float(np.quantile(z, 0.1)), "qHigh": float(np.quantile(z, 0.9))}


def apply_interval(pred, n, model):
    s = np.sqrt(np.maximum(1.0, model["a"] + model["b"] / np.maximum(1, n)))
    return pred + model["qLow"] * s, pred + model["qHigh"] * s


def coverage(y, low, high):
    y = np.asarray(y)
    return round(float(((y >= low) & (y <= high)).mean()), 3) if len(y) else None


def breakdown(rows, y, preds, key_fn, keys):
    out = {}
    for key in keys:
        idx = [i for i, row in enumerate(rows) if key_fn(row) == key]
        if idx:
            out[key] = {name: metrics(y[idx], p[idx])["mae"] for name, p in preds.items()} | {"n": len(idx)}
    return out


def decision_bin(row):
    n = row["meaningfulMoves"]
    return next(label for lo, hi, label in DECISION_BINS if lo <= n < hi)


def endgame_bin(row):
    share = row["endgameShare"]
    return next(label for lo, hi, label in ENDGAME_BINS if lo <= share < hi)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("samples")
    parser.add_argument("--errmodel")
    parser.add_argument("--out", default="data/rating-corpus/benchmark.json")
    parser.add_argument("--write-lib", action="store_true")
    args = parser.parse_args()
    rows_all = [json.loads(line) for line in open(args.samples) if line.strip()]
    errmodel = json.load(open(args.errmodel)) if args.errmodel else {}
    report = {"samples": len(rows_all), "timeControls": {}}
    lib_models = {}

    for tc in ["blitz", "rapid"]:
        rows = [r for r in rows_all if r["tc"] == tc]
        split = {s: [r for r in rows if r["split"] == s] for s in ["train", "validation", "test"]}
        y = {s: np.array([r["rating"] for r in split[s]], float) for s in split}
        Xtr, stats = design(split["train"])
        Xva, _ = design(split["validation"], stats)
        Xte, _ = design(split["test"], stats)
        n = {s: np.array([max(1, r["meaningfulMoves"]) for r in split[s]], float) for s in split}
        preds = {s: {} for s in ["validation", "test"]}
        intervals = {}

        # constant
        for s in preds:
            preds[s]["constant"] = np.full(len(split[s]), y["train"].mean())
        # heuristic (shipped v2.0 prior)
        for s in preds:
            preds[s]["heuristic"] = np.array([r["heuristic"]["estimate"] if r["heuristic"] else y["train"].mean() for r in split[s]], float)
        intervals["heuristic"] = {
            s: (np.array([r["heuristic"]["low"] if r["heuristic"] else 0 for r in split[s]], float),
                np.array([r["heuristic"]["high"] if r["heuristic"] else 4000 for r in split[s]], float)) for s in preds}
        # fitted error model
        if errmodel:
            for s in preds:
                preds[s]["errmodel"] = np.array([errmodel[f'{r["gameId"]}:{r["color"]}']["estimate"] for r in split[s]], float)
            intervals["errmodel"] = {s: (np.array([errmodel[f'{r["gameId"]}:{r["color"]}']["low"] for r in split[s]], float),
                                        np.array([errmodel[f'{r["gameId"]}:{r["color"]}']["high"] for r in split[s]], float)) for s in preds}
        # isotonic on mean loss only
        iso = IsotonicRegression(increasing=False, out_of_bounds="clip")
        col = FEATURES.index("logMeanLoss")
        iso.fit(np.array([r["x"][col] for r in split["train"]]), y["train"])
        for s in preds:
            preds[s]["isotonic"] = iso.predict(np.array([r["x"][col] for r in split[s]]))
        # ridge
        best = None
        for alpha in [0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000]:
            model = Ridge(alpha=alpha).fit(Xtr, y["train"])
            mae = float(np.abs(model.predict(Xva) - y["validation"]).mean())
            if best is None or mae < best[0]:
                best = (mae, alpha, model)
        ridge_alpha, ridge = best[1], best[2]
        clamp = (float(y["train"].min()), float(y["train"].max()))
        for s, X in [("validation", Xva), ("test", Xte)]:
            preds[s]["ridge"] = np.clip(ridge.predict(X), *clamp)
        # gbm
        best = None
        for lr in [0.03, 0.06]:
            for iters in [100, 200, 400]:
                model = HistGradientBoostingRegressor(max_depth=3, learning_rate=lr, max_iter=iters, l2_regularization=1.0,
                                                      min_samples_leaf=30, early_stopping=False, random_state=0).fit(Xtr, y["train"])
                mae = float(np.abs(model.predict(Xva) - y["validation"]).mean())
                if best is None or mae < best[0]:
                    best = (mae, (lr, iters), model)
        gbm_params, gbm = best[1], best[2]
        for s, X in [("validation", Xva), ("test", Xte)]:
            preds[s]["gbm"] = gbm.predict(X)

        # residual-derived intervals (validation) for the regression models
        for name in ["ridge", "gbm", "isotonic"]:
            model = interval_model(y["validation"] - preds["validation"][name], n["validation"])
            intervals[name] = {s: apply_interval(preds[s][name], n[s], model) for s in preds}
            intervals[name]["model"] = model

        test_rows, yt = split["test"], y["test"]
        test_preds = preds["test"]
        tc_report = {
            "splits": {s: len(split[s]) for s in split},
            "players": {s: len({r["player"] for r in split[s]}) for s in split},
            "ridgeAlpha": ridge_alpha,
            "gbm": {"learningRate": gbm_params[0], "iterations": gbm_params[1]},
            "test": {name: metrics(yt, p) for name, p in test_preds.items()},
            "validation": {name: metrics(y["validation"], p) for name, p in preds["validation"].items()},
            "maeByBand": breakdown(test_rows, yt, test_preds, lambda r: r["band"], BANDS),
            "maeByDecisions": breakdown(test_rows, yt, test_preds, decision_bin, [b[2] for b in DECISION_BINS]),
            "maeByResult": breakdown(test_rows, yt, test_preds, lambda r: r["result"], ["win", "draw", "loss"]),
            "maeByPhaseComposition": breakdown(test_rows, yt, test_preds, endgame_bin, [b[2] for b in ENDGAME_BINS]),
            "maeBySource": breakdown(test_rows, yt, test_preds, lambda r: r["source"], sorted({r["source"] for r in test_rows})),
            "intervals": {},
            "ridgeCoefficients": dict(zip(FEATURES + [f"missing:{FEATURES[i]}" for i in stats["indicators"]],
                                          [round(float(c), 1) for c in ridge.coef_])),
        }
        for name, iv in intervals.items():
            low, high = iv["test"]
            width = high - low
            by_n = {}
            for lo, hi, label in DECISION_BINS:
                idx = [i for i, r in enumerate(test_rows) if lo <= r["meaningfulMoves"] < hi]
                if idx:
                    by_n[label] = {"n": len(idx), "coverage": coverage(yt[idx], low[idx], high[idx]), "meanWidth": round(float(width[idx].mean()))}
            by_band = {}
            for band in BANDS:
                idx = [i for i, r in enumerate(test_rows) if r["band"] == band]
                if idx:
                    by_band[band] = {"n": len(idx), "coverage": coverage(yt[idx], low[idx], high[idx]), "meanWidth": round(float(width[idx].mean()))}
            tc_report["intervals"][name] = {
                "coverage80": coverage(yt, low, high),
                "validationCoverage80": coverage(y["validation"], *iv["validation"]),
                "meanWidth": round(float(width.mean())),
                "byDecisions": by_n,
                "byBand": by_band,
                **({"model": {k: round(v, 3) for k, v in iv["model"].items()}} if "model" in iv else {}),
            }
        report["timeControls"][tc] = tc_report

        iv = intervals["ridge"]["model"]
        lib_models[tc] = {
            "id": f"lichess-{tc}-ridge-v1",
            "calibrated": True,
            "ratingSystem": f"Lichess {tc} (equivalent)",
            "trainedOn": f"{len(split['train'])} {tc} game-sides from {len({r['player'] for r in split['train']})} Lichess players",
            "imputation": [round(float(v), 6) for v in stats["imputation"]],
            "missingIndicators": [int(i) for i in stats["indicators"]],
            "mean": [round(float(v), 6) for v in stats["mean"]],
            "scale": [round(float(v), 6) for v in stats["scale"]],
            "coefficients": [round(float(v), 6) for v in ridge.coef_],
            "intercept": round(float(ridge.intercept_), 6),
            "interval": {k: round(float(v), 6) for k, v in iv.items()},
            "clamp": [round(clamp[0]), round(clamp[1])],
            "heldOut": {"mae": tc_report["test"]["ridge"]["mae"], "coverage80": tc_report["intervals"]["ridge"]["coverage80"], "samples": len(split["test"])},
        }
        report["timeControls"][tc]["parityCheck"] = [
            {"gameId": r["gameId"], "color": r["color"], "prediction": round(float(p), 4)}
            for r, p in list(zip(test_rows, np.clip(ridge.predict(Xte), *clamp)))[:25]
        ]

    json.dump(report, open(args.out, "w"), indent=1, ensure_ascii=False)
    for tc, r in report["timeControls"].items():
        print(f"\n=== {tc}: splits {r['splits']} players {r['players']} ridge alpha {r['ridgeAlpha']}")
        for name, m in r["test"].items():
            iv = r["intervals"].get(name, {})
            print(f"  {name:10s} MAE {m['mae']:6.1f}  medAE {m['medianAe']:6.1f}  RMSE {m['rmse']:6.1f}  R2 {m['r2']}  bias {m['bias']:6.1f}"
                  + (f"  cov80 {iv['coverage80']} width {iv['meanWidth']}" if iv else ""))
    if args.write_lib:
        header = '''/**
 * Calibrated rating models per time control.
 *
 * REGRESSION_MODELS is generated by scripts/corpus/rating_benchmark.py --write-lib
 * from public rated Lichess games (see data/rating-corpus/). Do not edit by hand.
 * CALIBRATED_MODELS (engine-error model) stays empty: the fitted error model is
 * benchmarked but the ridge regression generalizes better (benchmark.json).
 */
import type { TimeControlClass } from "./chess-review.ts";
import type { EngineErrorModelParams, RegressionModelParams } from "./rating-model.ts";

export const CALIBRATED_MODELS: Partial<Record<TimeControlClass, EngineErrorModelParams>> = {};

export const REGRESSION_MODELS: Partial<Record<"blitz" | "rapid", RegressionModelParams>> = '''
        with open("lib/rating-params.ts", "w") as handle:
            handle.write(header + json.dumps(lib_models, indent=2, ensure_ascii=False) + ";\n")
        print("wrote lib/rating-params.ts")


if __name__ == "__main__":
    main()
