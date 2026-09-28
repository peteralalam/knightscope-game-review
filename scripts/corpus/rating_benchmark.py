"""Single-game rating estimation: model comparison, calibration and intervals.

    python3 scripts/corpus/rating_benchmark.py data/rating-corpus-v2/samples.jsonl \
        --out data/rating-corpus-v2/benchmark.json [--final-test] [--write-lib]

Protocol (per time class, blitz and rapid):
  * DEV = train + validation splits, TEST = test split. Splits are connected
    components of the player graph (rating-dataset.mjs), so no player is in two.
  * Every choice – model family, hyperparameters, sample weighting, the
    calibration layer and the interval model – is made from 5-fold
    player-grouped cross-validation on DEV (out-of-fold predictions).
  * TEST is scored only with --final-test, after those choices are frozen.

Models compared (in the order the brief asks for):
  constant       training mean
  heuristic      the old uncalibrated engine-error prior (if present in samples)
  ridge          ridge on the 19 interpretable features (+ missing indicators)
  ridge-w        ridge with sample weights balancing true-rating bands
  ridge-nl       ridge-w plus squared features and feature × log(decisions)
                 interactions (still linear in parameters, exportable)
  gam            additive cubic splines per feature + ridge penalty (GAM-like)
  gbm            histogram gradient boosting (reference only, never shipped)
  ordinal        multinomial logistic over the nine rating bands; point =
                 median of the band distribution, interval = its 10–90% quantiles
                 (research comparison, not shipped unless clearly better)

Shipping rule: ridge-w/ridge unless a more complex model improves CV MAE by
more than 15 Elo AND more than two standard errors; an 8-Elo gain is not worth
a more opaque model.

Calibration (item 7): OOF prediction vs actual rating by predicted-rating bin.
An isotonic layer on the OOF predictions is evaluated with a second, nested
grouped CV and kept only if it lowers OOF MAE and calibration error.

Intervals (item 8): Mondrian split-conformal on OOF residuals y − ŷ, with
calibration groups = predicted-rating band × meaningful-decision band (both known
at inference time; never the true rating). Groups with fewer than MIN_GROUP
residuals are merged into neighbours. Bounds are the finite-sample conformal
quantiles ⌊(n+1)·0.1⌋ and ⌈(n+1)·0.9⌉ of the group's residuals, so they may be
asymmetric (they absorb the regression-to-the-mean bias at the extremes).
"""
import argparse
import json
import math

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.preprocessing import SplineTransformer

FEATURES = [
    "logMeanLoss", "logMedianLoss", "logP75Loss", "logP90Loss", "logComplexityWeightedLoss",
    "severeLossRate", "largeLossRate", "moderateLossRate", "top1Agreement", "top3Agreement",
    "criticalAccuracy", "onlyMoveSuccess", "punishRate", "defensiveAccuracy",
    "conversionAccuracy", "middlegameAccuracy", "endgameAccuracy", "logMeaningfulDecisions", "logGameLength",
]
DECISIONS_INDEX = FEATURES.index("logMeaningfulDecisions")
BAND_EDGES = [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 3400]
BAND_LABELS = ["800–999", "1000–1199", "1200–1399", "1400–1599", "1600–1799", "1800–1999", "2000–2199", "2200–2399", "2400+"]
DECISION_BINS = [(0, 20, "<20"), (20, 35, "20–34"), (35, 10_000, "35+")]
PLY_BINS = [(0, 50, "<50 plies"), (50, 80, "50–79"), (80, 120, "80–119"), (120, 10_000, "120+")]
LEVEL = 0.8
MIN_GROUP = 150


def band_index(rating):
    for i in range(len(BAND_EDGES) - 1):
        if rating < BAND_EDGES[i + 1]:
            return max(i, 0)
    return len(BAND_EDGES) - 2


def band_of(rating):
    return BAND_LABELS[band_index(rating)]


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


# --- design ------------------------------------------------------------------

def raw_matrix(rows):
    return np.array([[math.nan if v is None else v for v in row["x"]] for row in rows], float)


def design(rows, stats=None, expansion=None):
    raw = raw_matrix(rows)
    if stats is None:
        with np.errstate(all="ignore"):
            imputation = np.nanmean(raw, axis=0)
        imputation = np.where(np.isnan(imputation), 0.0, imputation)
        indicators = [i for i in range(raw.shape[1]) if np.isnan(raw[:, i]).any()]
        stats = {"imputation": imputation, "indicators": indicators, "expansion": expansion}
    filled = np.where(np.isnan(raw), stats["imputation"], raw)
    cols = [filled, np.isnan(raw[:, stats["indicators"]]).astype(float)]
    if stats["expansion"] == "nl":
        # Standardize the raw features first so squares / interactions are well scaled.
        if "rawMean" not in stats:
            stats["rawMean"] = filled.mean(axis=0)
            rs = filled.std(axis=0)
            stats["rawScale"] = np.where(rs < 1e-9, 1.0, rs)
        zr = (filled - stats["rawMean"]) / stats["rawScale"]
        cols.append(zr ** 2)
        cols.append(zr * zr[:, [DECISIONS_INDEX]])
    X = np.hstack(cols)
    if "mean" not in stats:
        stats["mean"] = X.mean(axis=0)
        scale = X.std(axis=0)
        stats["scale"] = np.where(scale < 1e-9, 1.0, scale)
    return (X - stats["mean"]) / stats["scale"], stats


def balanced_weights(y):
    idx = np.array([band_index(v) for v in y])
    counts = np.bincount(idx, minlength=len(BAND_LABELS)).astype(float)
    w = 1.0 / np.maximum(counts[idx], 1)
    return w * len(y) / w.sum()


def band_distribution_quantiles(prob, qs):
    """Quantiles of a piecewise-uniform distribution over the rating bands."""
    edges = np.array(BAND_EDGES, float)
    edges[-1] = 2800  # the open 2400+ band, spread over 2400–2800
    cdf = np.concatenate([np.zeros((prob.shape[0], 1)), np.cumsum(prob, axis=1)], axis=1)
    out = []
    for q in qs:
        values = np.empty(prob.shape[0])
        for i in range(prob.shape[0]):
            j = int(np.searchsorted(cdf[i], q, side="right")) - 1
            j = min(max(j, 0), prob.shape[1] - 1)
            inside = (q - cdf[i, j]) / max(prob[i, j], 1e-12)
            values[i] = edges[j] + np.clip(inside, 0, 1) * (edges[j + 1] - edges[j])
        out.append(values)
    return out


class Fitted:
    def __init__(self, kind, predict, extra=None):
        self.kind, self.predict, self.extra = kind, predict, extra or {}


def fit_model(kind, param, rows, y):
    clamp = (float(y.min()), float(y.max()))
    if kind in ("ridge", "ridge-w", "ridge-nl"):
        X, stats = design(rows, expansion="nl" if kind == "ridge-nl" else None)
        w = balanced_weights(y) if kind in ("ridge-w", "ridge-nl") else None
        model = Ridge(alpha=param).fit(X, y, sample_weight=w)
        return Fitted(kind, lambda r: np.clip(model.predict(design(r, stats)[0]), *clamp),
                      {"model": model, "stats": stats, "clamp": clamp})
    if kind == "gam":
        X, stats = design(rows)
        spline = SplineTransformer(n_knots=5, degree=3, extrapolation="linear").fit(X)
        model = Ridge(alpha=param).fit(spline.transform(X), y, sample_weight=balanced_weights(y))
        return Fitted(kind, lambda r: np.clip(model.predict(spline.transform(design(r, stats)[0])), *clamp))
    if kind == "gbm":
        lr, iters = param
        X, stats = design(rows)
        model = HistGradientBoostingRegressor(max_depth=3, learning_rate=lr, max_iter=iters, l2_regularization=1.0,
                                              min_samples_leaf=40, early_stopping=False, random_state=0)
        model.fit(X, y, sample_weight=balanced_weights(y))
        return Fitted(kind, lambda r: model.predict(design(r, stats)[0]))
    if kind == "ordinal":
        X, stats = design(rows)
        labels = np.array([band_index(v) for v in y])
        model = LogisticRegression(C=param, max_iter=2000).fit(X, labels)

        def probs(r):
            p = np.zeros((len(r), len(BAND_LABELS)))
            p[:, model.classes_] = model.predict_proba(design(r, stats)[0])
            return p

        def predict(r):
            return band_distribution_quantiles(probs(r), [0.5])[0]

        def interval(r):
            low, high = band_distribution_quantiles(probs(r), [(1 - LEVEL) / 2, 1 - (1 - LEVEL) / 2])
            return low, high

        return Fitted(kind, predict, {"interval": interval})
    raise ValueError(kind)


def grouped_folds(rows, k=5):
    groups = sorted({r["group"] for r in rows})
    fold_of = {g: int(g, 16) % k for g in groups}
    return [np.array([fold_of[r["group"]] == f for r in rows]) for f in range(k)]


def select(kind, grid, rows, y, folds):
    """Grouped-CV MAE for each hyperparameter; one-SE rule toward regularization."""
    results = []
    for param in grid:
        oof = np.zeros(len(rows))
        fold_maes = []
        for mask in folds:
            fitted = fit_model(kind, param, [r for r, m in zip(rows, mask) if not m], y[~mask])
            oof[mask] = fitted.predict([r for r, m in zip(rows, mask) if m])
            fold_maes.append(float(np.abs(oof[mask] - y[mask]).mean()))
        results.append({"param": param, "mae": float(np.abs(oof - y).mean()),
                        "se": float(np.std(fold_maes) / math.sqrt(len(folds))), "oof": oof})
    best = min(results, key=lambda r: r["mae"])
    if kind in ("ridge", "ridge-w", "ridge-nl", "gam"):
        eligible = [r for r in results if r["mae"] <= best["mae"] + best["se"]]
        best = max(eligible, key=lambda r: r["param"])
    elif kind == "ordinal":
        eligible = [r for r in results if r["mae"] <= best["mae"] + best["se"]]
        best = min(eligible, key=lambda r: r["param"])
    return best


# --- calibration -------------------------------------------------------------

PRED_BINS = [(-1e9, 1000), (1000, 1200), (1200, 1400), (1400, 1600), (1600, 1800), (1800, 2000), (2000, 2200), (2200, 1e9)]


def pred_bin_label(lo, hi):
    if lo < 0:
        return f"<{hi}"
    if hi > 1e8:
        return f"{lo}+"
    return f"{lo}–{hi - 1}"


def calibration_table(y, p):
    rows = []
    for lo, hi in PRED_BINS:
        m = (p >= lo) & (p < hi)
        if m.sum() >= 20:
            rows.append({"predicted": pred_bin_label(lo, hi), "n": int(m.sum()), "meanPredicted": round(float(p[m].mean())),
                         "meanActual": round(float(y[m].mean())), "gap": round(float(y[m].mean() - p[m].mean()))})
    # Weighted mean |gap| across bins: the calibration error in Elo.
    total = sum(r["n"] for r in rows)
    ece = sum(r["n"] * abs(r["gap"]) for r in rows) / max(total, 1)
    slope = float(np.polyfit(p, y, 1)[0]) if len(y) > 2 else None
    return {"bins": rows, "calibrationError": round(ece, 1), "slopeActualOnPredicted": round(slope, 3) if slope else None}


def nested_isotonic(rows, y, oof, folds):
    """Isotonic layer y ~ f(oof), evaluated by grouped CV over the OOF predictions."""
    out = np.zeros(len(y))
    for mask in folds:
        iso = IsotonicRegression(out_of_bounds="clip").fit(oof[~mask], y[~mask])
        out[mask] = iso.predict(oof[mask])
    return out


# --- conformal intervals -----------------------------------------------------

def decision_bin(n):
    return next(i for i, (lo, hi, _) in enumerate(DECISION_BINS) if lo <= n < hi)


def conformal_quantiles(residuals):
    r = np.sort(residuals)
    n = len(r)
    lo_k = max(int(math.floor((n + 1) * (1 - LEVEL) / 2)), 1)
    hi_k = min(int(math.ceil((n + 1) * (1 - (1 - LEVEL) / 2))), n)
    return float(r[lo_k - 1]), float(r[hi_k - 1])


def mondrian_groups(pred, n_dec, residuals):
    """Predicted band × decision band; merge sparse cells, then sparse bands."""
    groups = []
    band_members = []
    for bi, (lo, hi) in enumerate(PRED_BINS):
        band_members.append(((pred >= lo) & (pred < hi), [lo, hi]))
    # Merge sparse predicted bands into their neighbour toward the centre.
    merged = []
    for mask, (lo, hi) in band_members:
        if merged and (merged[-1][0].sum() < MIN_GROUP or mask.sum() < MIN_GROUP) and not (
                merged[-1][0].sum() >= MIN_GROUP and mask.sum() >= MIN_GROUP):
            prev_mask, (plo, phi) = merged.pop()
            merged.append((prev_mask | mask, [plo, hi]))
        else:
            merged.append((mask, [lo, hi]))
    if len(merged) > 1 and merged[-1][0].sum() < MIN_GROUP:
        last_mask, (llo, lhi) = merged.pop()
        prev_mask, (plo, phi) = merged.pop()
        merged.append((prev_mask | last_mask, [plo, lhi]))
    for mask, (lo, hi) in merged:
        dec_bins = [[b] for b in range(len(DECISION_BINS))]
        # Merge sparse decision cells with the neighbouring cell.
        changed = True
        while changed and len(dec_bins) > 1:
            changed = False
            for i, bins in enumerate(dec_bins):
                cell = mask & np.isin(n_dec, bins)
                if cell.sum() < MIN_GROUP:
                    j = i - 1 if i > 0 else i + 1
                    dec_bins[j] = sorted(dec_bins[j] + bins)
                    dec_bins.pop(i)
                    changed = True
                    break
        for bins in dec_bins:
            cell = mask & np.isin(n_dec, bins)
            if cell.sum() == 0:
                continue
            q_lo, q_hi = conformal_quantiles(residuals[cell])
            groups.append({
                "predLow": None if lo < 0 else lo, "predHigh": None if hi > 1e8 else hi,
                "decisionsLow": DECISION_BINS[bins[0]][0], "decisionsHigh": None if DECISION_BINS[bins[-1]][1] > 1000 else DECISION_BINS[bins[-1]][1],
                "qLow": round(q_lo, 1), "qHigh": round(q_hi, 1), "n": int(cell.sum()),
            })
    return groups


def apply_groups(pred, meaningful, groups):
    low = np.empty(len(pred))
    high = np.empty(len(pred))
    for i, (p, n) in enumerate(zip(pred, meaningful)):
        g = next(g for g in groups
                 if (g["predLow"] is None or p >= g["predLow"]) and (g["predHigh"] is None or p < g["predHigh"])
                 and n >= g["decisionsLow"] and (g["decisionsHigh"] is None or n < g["decisionsHigh"]))
        low[i], high[i] = p + g["qLow"], p + g["qHigh"]
    return low, high


def cross_fitted_mondrian(point_oof, n_dec, meaningful, residuals, folds):
    """Honest dev coverage: groups built on four folds, applied to the fifth."""
    low = np.zeros(len(point_oof))
    high = np.zeros(len(point_oof))
    for mask in folds:
        groups = mondrian_groups(point_oof[~mask], n_dec[~mask], residuals[~mask])
        low[mask], high[mask] = apply_groups(point_oof[mask], [m for m, k in zip(meaningful, mask) if k], groups)
    return low, high


def neyman_belt(y, pred, n_dec):
    """Research comparison: invert quantile lines of the estimate given the TRUE
    rating (fitted on dev only). The confidence set {R : q10(ŷ|R) ≤ ŷ ≤ q90(ŷ|R)}
    covers every true rating at ~80 % by construction, at the price of width
    (and it need not contain the point estimate)."""
    from sklearn.linear_model import QuantileRegressor
    belts = {}
    for b in sorted(set(n_dec)):
        m = n_dec == b
        if m.sum() < MIN_GROUP:
            m = np.ones(len(y), bool)
        lines = {}
        for q in (0.1, 0.9):
            qr = QuantileRegressor(quantile=q, alpha=0.0, solver="highs").fit(y[m].reshape(-1, 1), pred[m])
            lines[q] = (float(qr.coef_[0]), float(qr.intercept_))
        belts[int(b)] = lines
    return belts


def apply_belt(pred, n_dec, belts, lo_clip=600, hi_clip=3000):
    low = np.empty(len(pred))
    high = np.empty(len(pred))
    for i, (p, b) in enumerate(zip(pred, n_dec)):
        (a10, c10), (a90, c90) = belts[int(b)][0.1], belts[int(b)][0.9]
        r_low = (p - c90) / a90 if a90 > 1e-6 else lo_clip
        r_high = (p - c10) / a10 if a10 > 1e-6 else hi_clip
        low[i], high[i] = np.clip(r_low, lo_clip, hi_clip), np.clip(r_high, lo_clip, hi_clip)
    return low, high


def scale_interval(residuals, n):
    """The previous interval: s(n)² = a + b/n and pooled standardized quantiles."""
    A = np.vstack([np.ones_like(n), 1.0 / n]).T
    coef, *_ = np.linalg.lstsq(A, residuals ** 2, rcond=None)
    a, b = max(float(coef[0]), 1.0), max(float(coef[1]), 0.0)
    z = residuals / np.sqrt(a + b / n)
    return {"a": a, "b": b, "qLow": float(np.quantile(z, 0.1)), "qHigh": float(np.quantile(z, 0.9))}


def apply_scale(pred, n, m):
    s = np.sqrt(np.maximum(1.0, m["a"] + m["b"] / np.maximum(1, n)))
    return pred + m["qLow"] * s, pred + m["qHigh"] * s


def coverage_report(y, low, high, rows, pred):
    inside = (y >= low) & (y <= high)
    width = high - low

    def by(key_fn, keys):
        out = {}
        for key in keys:
            m = np.array([key_fn(r, p) == key for r, p in zip(rows, pred)])
            if m.sum() >= 10:
                out[key] = {"n": int(m.sum()), "coverage": round(float(inside[m].mean()), 3), "meanWidth": round(float(width[m].mean()))}
        return out

    return {
        "coverage": round(float(inside.mean()), 3),
        "meanWidth": round(float(width.mean())),
        "byPredictedBand": by(lambda r, p: next(pred_bin_label(lo, hi) for lo, hi in PRED_BINS if lo <= p < hi),
                              [pred_bin_label(lo, hi) for lo, hi in PRED_BINS]),
        "byTrueBand": by(lambda r, p: band_of(r["rating"]), BAND_LABELS),
        "byDecisions": by(lambda r, p: DECISION_BINS[decision_bin(r["meaningfulMoves"])][2], [b[2] for b in DECISION_BINS]),
        "byGameLength": by(lambda r, p: next(label for lo, hi, label in PLY_BINS if lo <= r["ply"] < hi), [b[2] for b in PLY_BINS]),
    }


def bias_by_true_band(rows, y, pred):
    out = {}
    for label in BAND_LABELS:
        m = np.array([band_of(r["rating"]) == label for r in rows])
        if m.sum() >= 10:
            out[label] = {"n": int(m.sum()), "mae": round(float(np.abs(pred[m] - y[m]).mean()), 1),
                          "bias": round(float((pred[m] - y[m]).mean()), 1)}
    return out


def bias_by_decisions(rows, y, pred):
    """MAE and signed bias by meaningful-decision count, for the point estimate."""
    out = {}
    for lo, hi, label in DECISION_BINS:
        m = np.array([lo <= r["meaningfulMoves"] < hi for r in rows])
        if m.sum() >= 10:
            out[label] = {"n": int(m.sum()), "mae": round(float(np.abs(pred[m] - y[m]).mean()), 1), "bias": round(float((pred[m] - y[m]).mean()), 1)}
    return out


def bias_by_band_and_decisions(rows, y, pred):
    """Does the extreme-band bias shrink when a game has more decisions (more information)?"""
    out = {}
    for label in BAND_LABELS:
        for lo, hi, dl in DECISION_BINS:
            m = np.array([band_of(r["rating"]) == label and lo <= r["meaningfulMoves"] < hi for r in rows])
            if m.sum() >= 15:
                out[f"{label} | {dl}"] = {"n": int(m.sum()), "bias": round(float((pred[m] - y[m]).mean()), 1)}
    return out


GRIDS = {
    "ridge": [1, 3, 10, 30, 100, 300, 1000],
    "ridge-w": [1, 3, 10, 30, 100, 300, 1000],
    "ridge-nl": [10, 30, 100, 300, 1000, 3000],
    "gam": [10, 30, 100, 300, 1000, 3000],
    "gbm": [(0.05, 150), (0.05, 300), (0.1, 150)],
    "ordinal": [0.01, 0.03, 0.1, 0.3, 1.0],
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("samples")
    parser.add_argument("--out", required=True)
    parser.add_argument("--final-test", action="store_true")
    parser.add_argument("--write-lib", action="store_true")
    parser.add_argument("--models", default="ridge,ridge-w,ridge-nl,gam,gbm,ordinal")
    args = parser.parse_args()
    rows_all = [json.loads(line) for line in open(args.samples) if line.strip()]
    kinds = args.models.split(",")
    report = {"samples": len(rows_all), "level": LEVEL, "minGroup": MIN_GROUP, "timeControls": {}}
    lib_models = {}

    for tc in ["blitz", "rapid"]:
        rows = [r for r in rows_all if r["tc"] == tc]
        dev = [r for r in rows if r["split"] in ("train", "validation")]
        test = [r for r in rows if r["split"] == "test"]
        y = np.array([r["rating"] for r in dev], float)
        yt = np.array([r["rating"] for r in test], float)
        folds = grouped_folds(dev)
        tr = {"dev": {"playerGames": len(dev), "players": len({r["player"] for r in dev}), "groups": len({r["group"] for r in dev})},
              "test": {"playerGames": len(test), "players": len({r["player"] for r in test}), "groups": len({r["group"] for r in test})},
              "ratingDistributionDev": {b: sum(band_of(r["rating"]) == b for r in dev) for b in BAND_LABELS},
              "cv": {}, "oofBiasByTrueBand": {}, "oofCalibration": {}}
        selected = {}
        for kind in kinds:
            best = select(kind, GRIDS[kind], dev, y, folds)
            selected[kind] = best
            tr["cv"][kind] = {"param": best["param"], "mae": round(best["mae"], 1), "se": round(best["se"], 1),
                              **{k: v for k, v in metrics(y, best["oof"]).items() if k != "n"}}
            tr["oofBiasByTrueBand"][kind] = bias_by_true_band(dev, y, best["oof"])
            tr["oofCalibration"][kind] = calibration_table(y, best["oof"])
            print(tc, kind, tr["cv"][kind])
        const_oof = np.zeros(len(dev))
        for mask in folds:
            const_oof[mask] = y[~mask].mean()
        tr["cv"]["constant"] = {"mae": round(float(np.abs(const_oof - y).mean()), 1)}

        # Shipping rule: the simplest ridge family member unless something beats it clearly.
        base_kind = min([k for k in ("ridge", "ridge-w") if k in selected], key=lambda k: selected[k]["mae"])
        chosen = base_kind
        for kind in ("ridge-nl", "gam"):
            if kind in selected:
                gain = selected[chosen]["mae"] - selected[kind]["mae"]
                if gain > 15 and gain > 2 * selected[chosen]["se"]:
                    chosen = kind
        tr["chosen"] = chosen
        tr["extremeBiasDiagnosis"] = {
            "oofBiasByBandAndDecisions": bias_by_band_and_decisions(dev, y, selected[chosen]["oof"]),
            "attenuationSlopePredictedOnActual": round(float(np.polyfit(y, selected[chosen]["oof"], 1)[0]), 3),
        }

        # Calibration layer: nested grouped CV over the chosen model's OOF predictions.
        oof = selected[chosen]["oof"]
        iso_oof = nested_isotonic(dev, y, oof, folds)
        tr["calibrationLayer"] = {
            "without": {"mae": round(float(np.abs(oof - y).mean()), 1), **calibration_table(y, oof)},
            "withIsotonic": {"mae": round(float(np.abs(iso_oof - y).mean()), 1), **calibration_table(y, iso_oof)},
        }
        use_iso = (tr["calibrationLayer"]["withIsotonic"]["mae"] < tr["calibrationLayer"]["without"]["mae"] - 2
                   and tr["calibrationLayer"]["withIsotonic"]["calibrationError"] < tr["calibrationLayer"]["without"]["calibrationError"])
        tr["calibrationLayer"]["used"] = bool(use_iso)
        point_oof = iso_oof if use_iso else oof

        # Intervals from OOF residuals (never the test set).
        n_dec = np.array([decision_bin(r["meaningfulMoves"]) for r in dev])
        residuals = y - point_oof
        groups = mondrian_groups(point_oof, n_dec, residuals)
        scale = scale_interval(residuals, np.array([max(1, r["meaningfulMoves"]) for r in dev], float))
        # Dev coverage: cross-fitted (groups from four folds applied to the fifth).
        lo_m, hi_m = cross_fitted_mondrian(point_oof, n_dec, [r["meaningfulMoves"] for r in dev], residuals, folds)
        lo_s, hi_s = apply_scale(point_oof, np.array([r["meaningfulMoves"] for r in dev], float), scale)
        tr["intervalsDev"] = {"mondrian": coverage_report(y, lo_m, hi_m, dev, point_oof),
                              "scale(previous)": coverage_report(y, lo_s, hi_s, dev, point_oof)}
        if "ordinal" in selected:
            # Ordinal OOF intervals.
            lo_o = np.zeros(len(dev))
            hi_o = np.zeros(len(dev))
            for mask in folds:
                fitted = fit_model("ordinal", selected["ordinal"]["param"], [r for r, m in zip(dev, mask) if not m], y[~mask])
                lo_o[mask], hi_o[mask] = fitted.extra["interval"]([r for r, m in zip(dev, mask) if m])
            tr["intervalsDev"]["ordinal"] = coverage_report(y, lo_o, hi_o, dev, selected["ordinal"]["oof"])
        tr["conformalGroups"] = groups
        belts = neyman_belt(y, point_oof, n_dec)
        tr["neymanBelt"] = {str(k): {str(q): [round(a, 4), round(c, 1)] for q, (a, c) in v.items()} for k, v in belts.items()}

        # Final refit on DEV.
        final = {kind: fit_model(kind, selected[kind]["param"], dev, y) for kind in kinds}
        iso = IsotonicRegression(out_of_bounds="clip").fit(oof, y) if use_iso else None

        def shipped_point(r):
            p = final[chosen].predict(r)
            return iso.predict(p) if iso is not None else p

        if args.final_test:
            preds = {"constant": np.full(len(test), y.mean())}
            if all(r.get("heuristic") for r in test):
                preds["heuristic"] = np.array([r["heuristic"]["estimate"] for r in test], float)
            for kind in kinds:
                preds[kind] = final[kind].predict(test)
            preds["shipped"] = shipped_point(test)
            pt = preds["shipped"]
            lo_t, hi_t = apply_groups(pt, [r["meaningfulMoves"] for r in test], groups)
            lo_st, hi_st = apply_scale(pt, np.array([r["meaningfulMoves"] for r in test], float), scale)
            tr["test"] = {name: metrics(yt, p) for name, p in preds.items()}
            tr["testByTrueBand"] = {name: bias_by_true_band(test, yt, p) for name, p in preds.items()}
            tr["testByDecisions"] = {name: bias_by_decisions(test, yt, p) for name, p in preds.items()}
            tr["testCalibration"] = calibration_table(yt, pt)
            tr["testIntervals"] = {"mondrian": coverage_report(yt, lo_t, hi_t, test, pt),
                                   "scale(previous)": coverage_report(yt, lo_st, hi_st, test, pt)}
            n_dec_t = np.array([decision_bin(r["meaningfulMoves"]) for r in test])
            lo_n, hi_n = apply_belt(pt, n_dec_t, belts)
            tr["testIntervals"]["neymanBelt(research)"] = coverage_report(yt, lo_n, hi_n, test, pt)
            if "ordinal" in final:
                lo_o, hi_o = final["ordinal"].extra["interval"](test)
                tr["testIntervals"]["ordinal"] = coverage_report(yt, lo_o, hi_o, test, preds["ordinal"])
            tr["parityCheck"] = [{"gameId": r["gameId"], "color": r["color"], "prediction": round(float(p), 4)}
                                 for r, p in list(zip(test, pt))[:25]]
            print(tc, "TEST shipped", tr["test"]["shipped"], "coverage", tr["testIntervals"]["mondrian"]["coverage"])

        report["timeControls"][tc] = tr

        if chosen in ("ridge", "ridge-w", "ridge-nl"):
            extra = final[chosen].extra
            stats, model, clamp = extra["stats"], extra["model"], extra["clamp"]
            lib_models[tc] = {
                "id": f"lichess-{tc}-{chosen}-v2",
                "calibrated": True,
                "ratingSystem": f"Lichess {tc} (equivalent)",
                "trainedOn": f"{len(dev)} {tc} player-games from {tr['dev']['players']} Lichess players",
                "imputation": [round(float(v), 6) for v in stats["imputation"]],
                "missingIndicators": [int(i) for i in stats["indicators"]],
                "expansion": ({"rawMean": [round(float(v), 6) for v in stats["rawMean"]],
                               "rawScale": [round(float(v), 6) for v in stats["rawScale"]],
                               "interactWith": DECISIONS_INDEX} if stats["expansion"] == "nl" else None),
                "mean": [round(float(v), 6) for v in stats["mean"]],
                "scale": [round(float(v), 6) for v in stats["scale"]],
                "coefficients": [round(float(v), 6) for v in model.coef_],
                "intercept": round(float(model.intercept_), 6),
                "calibration": ({"x": [round(float(v), 2) for v in iso.X_thresholds_], "y": [round(float(v), 2) for v in iso.y_thresholds_]}
                                if iso is not None else None),
                "clamp": [round(clamp[0]), round(clamp[1])],
                "conformal": {"level": LEVEL, "groups": groups},
                "heldOut": ({"mae": tr["test"]["shipped"]["mae"], "coverage80": tr["testIntervals"]["mondrian"]["coverage"], "samples": len(test)}
                            if args.final_test else None),
            }

    json.dump(report, open(args.out, "w"), indent=1, ensure_ascii=False)
    if args.write_lib:
        if not args.final_test:
            raise SystemExit("--write-lib needs --final-test (held-out numbers are shipped with the model)")
        header = '''/**
 * Calibrated rating models per time control.
 *
 * Generated by scripts/corpus/rating_benchmark.py --final-test --write-lib from
 * rated Lichess games (see data/rating-corpus-v2/). Do not edit by hand.
 * CALIBRATED_MODELS (engine-error model) stays empty; it is only the fallback prior.
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
