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

Hyperparameters and the interval model are chosen by 5-fold player-grouped
cross-validation on TRAIN+VALIDATION; the final models are refit there. Every
number reported as held-out is on TEST, which nothing was tuned on. sklearn is used
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


def design(rows, stats=None, key="x"):
    raw = np.array([[math.nan if v is None else v for v in row[key]] for row in rows], float)
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


def grouped_folds(rows, k=5):
    """Deterministic player-grouped folds (a group = a connected set of players)."""
    groups = sorted({r["group"] for r in rows})
    fold_of = {g: int(g, 16) % k for g in groups}
    return [np.array([fold_of[r["group"]] == f for r in rows]) for f in range(k)]


def fit_model(kind, param, train_rows, y_train, key="x"):
    X, stats = design(train_rows, key=key)
    if kind == "ridge":
        model = Ridge(alpha=param).fit(X, y_train)
        clamp = (float(y_train.min()), float(y_train.max()))
        return lambda rows: np.clip(model.predict(design(rows, stats, key=key)[0]), *clamp), (model, stats, clamp)
    if kind == "gbm":
        lr, iters = param
        model = HistGradientBoostingRegressor(max_depth=3, learning_rate=lr, max_iter=iters, l2_regularization=1.0,
                                              min_samples_leaf=30, early_stopping=False, random_state=0).fit(X, y_train)
        return lambda rows: model.predict(design(rows, stats, key=key)[0]), (model, stats, None)
    if kind == "isotonic":
        col = FEATURES.index("logMeanLoss")
        model = IsotonicRegression(increasing=False, out_of_bounds="clip").fit(np.array([r["x"][col] for r in train_rows]), y_train)
        return lambda rows: model.predict(np.array([r["x"][col] for r in rows])), (model, None, None)
    raise ValueError(kind)


def cross_validate(kind, params, rows, y, folds, key="x"):
    """Pick the hyperparameter by grouped-CV MAE with the one-standard-error rule:
    the simplest (most regularized, listed last for ridge) setting whose CV MAE
    is within one standard error of the best. Returns it with its out-of-fold
    predictions and CV MAE."""
    results = []
    for param in params:
        oof = np.zeros(len(rows))
        fold_maes = []
        for mask in folds:
            train = [r for r, m in zip(rows, mask) if not m]
            predict, _ = fit_model(kind, param, train, y[~mask], key=key)
            oof[mask] = predict([r for r, m in zip(rows, mask) if m])
            fold_maes.append(float(np.abs(oof[mask] - y[mask]).mean()))
        results.append((float(np.abs(oof - y).mean()), float(np.std(fold_maes) / math.sqrt(len(folds))), param, oof))
    best = min(results, key=lambda item: item[0])
    if kind == "ridge":
        eligible = [item for item in results if item[0] <= best[0] + best[1]]
        best = max(eligible, key=lambda item: item[2])
    return best[2], best[3], best[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("samples")
    parser.add_argument("--errmodel")
    parser.add_argument("--out", default="data/rating-corpus/benchmark.json")
    parser.add_argument("--write-lib", action="store_true")
    args = parser.parse_args()
    rows_all = [json.loads(line) for line in open(args.samples) if line.strip()]
    errmodel = json.load(open(args.errmodel)) if args.errmodel else {}
    report = {
        "samples": len(rows_all),
        "protocol": "Model choice, hyperparameters and the interval model use 5-fold player-grouped cross-validation on "
                    "train+validation; the final model is refit on train+validation; every held-out number is on test.",
        "timeControls": {},
    }
    lib_models = {}
    grids = {
        "ridge": [0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000],
        "gbm": [(0.03, 100), (0.03, 200), (0.03, 400), (0.06, 100), (0.06, 200)],
        "isotonic": [None],
    }

    for tc in ["blitz", "rapid"]:
        rows = [r for r in rows_all if r["tc"] == tc]
        dev = [r for r in rows if r["split"] in ("train", "validation")]
        test = [r for r in rows if r["split"] == "test"]
        y_dev = np.array([r["rating"] for r in dev], float)
        yt = np.array([r["rating"] for r in test], float)
        n_dev = np.array([max(1, r["meaningfulMoves"]) for r in dev], float)
        n_test = np.array([max(1, r["meaningfulMoves"]) for r in test], float)
        folds = grouped_folds(dev)
        test_preds, intervals, chosen, cv_mae = {}, {}, {}, {}

        test_preds["constant"] = np.full(len(test), y_dev.mean())
        test_preds["heuristic"] = np.array([r["heuristic"]["estimate"] if r["heuristic"] else y_dev.mean() for r in test], float)
        intervals["heuristic"] = (np.array([r["heuristic"]["low"] if r["heuristic"] else 0 for r in test], float),
                                  np.array([r["heuristic"]["high"] if r["heuristic"] else 4000 for r in test], float))
        if errmodel:
            test_preds["errmodel"] = np.array([errmodel[f'{r["gameId"]}:{r["color"]}']["estimate"] for r in test], float)
            intervals["errmodel"] = (np.array([errmodel[f'{r["gameId"]}:{r["color"]}']["low"] for r in test], float),
                                     np.array([errmodel[f'{r["gameId"]}:{r["color"]}']["high"] for r in test], float))
        fitted = {}
        for kind in ["isotonic", "ridge", "gbm"]:
            param, oof, mae = cross_validate(kind, grids[kind], dev, y_dev, folds)
            chosen[kind], cv_mae[kind] = param, round(mae, 1)
            predict, fitted[kind] = fit_model(kind, param, dev, y_dev)
            test_preds[kind] = predict(test)
            model = interval_model(y_dev - oof, n_dev)
            intervals[kind] = apply_interval(test_preds[kind], n_test, model) + (model,)

        # Experiment (not shipped): add the opponent's features. Lichess pairs
        # players of similar rating, so the opponent's play carries rating
        # information – but it would make one player's estimate depend on who
        # they happened to face.
        with_opponent = [r for r in dev if r.get("opponentX")]
        if with_opponent:
            for r in dev + test:
                r["xo"] = r["x"] + (r.get("opponentX") or [None] * len(r["x"]))
            param, oof, mae = cross_validate("ridge", grids["ridge"], dev, y_dev, folds, key="xo")
            predict, _ = fit_model("ridge", param, dev, y_dev, key="xo")
            test_preds["ridge+opponent (not shipped)"] = predict(test)

        tc_report = {
            "splits": {"train+validation": len(dev), "test": len(test)},
            "players": {"train+validation": len({r["player"] for r in dev}), "test": len({r["player"] for r in test})},
            "chosen": {k: v for k, v in chosen.items()},
            "cvMae": cv_mae,
            "test": {name: metrics(yt, p) for name, p in test_preds.items()},
            "maeByBand": breakdown(test, yt, test_preds, lambda r: r["band"], BANDS),
            "maeByDecisions": breakdown(test, yt, test_preds, decision_bin, [b[2] for b in DECISION_BINS]),
            "maeByResult": breakdown(test, yt, test_preds, lambda r: r["result"], ["win", "draw", "loss"]),
            "maeByPhaseComposition": breakdown(test, yt, test_preds, endgame_bin, [b[2] for b in ENDGAME_BINS]),
            "maeBySource": breakdown(test, yt, test_preds, lambda r: r["source"], sorted({r["source"] for r in test})),
            "intervals": {},
        }
        ridge, stats, clamp = fitted["ridge"]
        tc_report["ridgeCoefficients"] = dict(zip(FEATURES + [f"missing:{FEATURES[i]}" for i in stats["indicators"]],
                                                  [round(float(c), 1) for c in ridge.coef_]))
        for name, value in intervals.items():
            low, high = value[0], value[1]
            width = high - low
            by_n, by_band = {}, {}
            for lo, hi, label in DECISION_BINS:
                idx = [i for i, r in enumerate(test) if lo <= r["meaningfulMoves"] < hi]
                if idx:
                    by_n[label] = {"n": len(idx), "coverage": coverage(yt[idx], low[idx], high[idx]), "meanWidth": round(float(width[idx].mean()))}
            for band in BANDS:
                idx = [i for i, r in enumerate(test) if r["band"] == band]
                if idx:
                    by_band[band] = {"n": len(idx), "coverage": coverage(yt[idx], low[idx], high[idx]), "meanWidth": round(float(width[idx].mean()))}
            tc_report["intervals"][name] = {
                "coverage80": coverage(yt, low, high),
                "meanWidth": round(float(width.mean())),
                "byDecisions": by_n,
                "byBand": by_band,
                **({"model": {k: round(v, 3) for k, v in value[2].items()}} if len(value) > 2 else {}),
            }
        report["timeControls"][tc] = tc_report

        iv = intervals["ridge"][2]
        lib_models[tc] = {
            "id": f"lichess-{tc}-ridge-v1",
            "calibrated": True,
            "ratingSystem": f"Lichess {tc} (equivalent)",
            "trainedOn": f"{len(dev)} {tc} game-sides from {len({r['player'] for r in dev})} Lichess players",
            "imputation": [round(float(v), 6) for v in stats["imputation"]],
            "missingIndicators": [int(i) for i in stats["indicators"]],
            "mean": [round(float(v), 6) for v in stats["mean"]],
            "scale": [round(float(v), 6) for v in stats["scale"]],
            "coefficients": [round(float(v), 6) for v in ridge.coef_],
            "intercept": round(float(ridge.intercept_), 6),
            "interval": {k: round(float(v), 6) for k, v in iv.items()},
            "clamp": [round(clamp[0]), round(clamp[1])],
            "heldOut": {"mae": tc_report["test"]["ridge"]["mae"], "coverage80": tc_report["intervals"]["ridge"]["coverage80"], "samples": len(test)},
        }
        report["timeControls"][tc]["parityCheck"] = [
            {"gameId": r["gameId"], "color": r["color"], "prediction": round(float(p), 4)}
            for r, p in list(zip(test, test_preds["ridge"]))[:25]
        ]

    json.dump(report, open(args.out, "w"), indent=1, ensure_ascii=False)
    for tc, r in report["timeControls"].items():
        print(f"\n=== {tc}: {r['splits']} players {r['players']} chosen {r['chosen']} cv {r['cvMae']}")
        for name, m in r["test"].items():
            iv = r["intervals"].get(name, {})
            print(f"  {name:30s} MAE {m['mae']:6.1f}  medAE {m['medianAe']:6.1f}  RMSE {m['rmse']:6.1f}  R2 {m['r2']}  bias {m['bias']:6.1f}"
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
