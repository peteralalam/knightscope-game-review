"""Fit and validate the rating-conditioned outcome model E[result | cp, rating, tc].

    python3 scripts/corpus/outcome_model.py --positions .cache/corpus/outcome-positions.csv \
        --json data/rating-corpus-v2/outcome-model.json [--write-lib] [--final-test]

Target: the side to move's final game score (win 1, draw ½, loss 0), so every
model predicts an EXPECTED SCORE. Loss: cross-entropy with fractional targets
(a proper scoring rule for an expected score), plus Brier and calibration error.

Candidate models, all odd in cp (E(−cp) = 1 − E(cp), so cp = 0 ↦ ½ exactly),
strictly increasing in cp and tending to 0 / 1 (every slope is exp(·) > 0):

  baseline    Lichess's fixed curve, slope 0.00368208 (no fit)
  global      one refitted slope
  tc          slope per time class
  rating      log slope = quadratic in z = (R − 1500) / 400, per time class
  rating+sat  rating, plus a saturating log1p(|cp|/100) term with its own
              rating-dependent weight (lets the curve flatten for big advantages)
  +phase      rating+sat with an endgame multiplier on the slope
  +isotonic   isotonic regression layered on the best parametric model

A nuisance term d · (R_mover − R_opponent) / 400 is fitted in every model
except baseline (Lichess pairs players of similar strength, but not equal);
at inference it is 0 because only one player's estimated strength is known.

Selection uses the VALIDATION split (players disjoint from train). The test
split is only scored with --final-test, after every choice is frozen.
"""
import argparse
import json
import math

import numpy as np
from scipy.optimize import minimize
from sklearn.isotonic import IsotonicRegression

BASELINE_SLOPE = 0.00368208
BANDS = [(800, 1000), (1000, 1200), (1200, 1400), (1400, 1600), (1600, 1800),
         (1800, 2000), (2000, 2200), (2200, 2400), (2400, 3400)]
TCS = ["blitz", "rapid"]


def band_label(low, high):
    return f"{low}+" if high > 3000 else f"{low}–{high - 1}"


def load(path):
    cols = {k: [] for k in ["group", "split", "tc", "ply", "phase", "r", "ro", "cp", "y"]}
    with open(path) as handle:
        header = handle.readline().strip().split(",")
        idx = {name: i for i, name in enumerate(header)}
        for line in handle:
            f = line.rstrip("\n").split(",")
            if f[idx["tc"]] not in TCS:
                continue
            cols["group"].append(f[idx["group"]])
            cols["split"].append(f[idx["split"]])
            cols["tc"].append(f[idx["tc"]])
            cols["ply"].append(int(f[idx["ply"]]))
            cols["phase"].append(f[idx["phase"]])
            cols["r"].append(float(f[idx["mover_rating"]]))
            cols["ro"].append(float(f[idx["opponent_rating"]]))
            cols["cp"].append(float(f[idx["cp"]]))
            cols["y"].append(float(f[idx["score"]]))
    data = {k: np.array(v) for k, v in cols.items()}
    data["rapid"] = (data["tc"] == "rapid").astype(float)
    data["z"] = (data["r"] - 1500) / 400
    data["diff"] = (data["r"] - data["ro"]) / 400
    data["endgame"] = (data["phase"] == "endgame").astype(float)
    # Engine scores beyond ±20 pawns carry no extra outcome information.
    data["cp"] = np.clip(data["cp"], -2000, 2000)
    return data


def subset(data, mask):
    return {k: v[mask] for k, v in data.items()}


# --- parametric family -------------------------------------------------------

def slope_basis(d, spec):
    """Rows of the design for log-slope terms."""
    cols = [np.ones_like(d["z"])]
    if spec.get("tc"):
        cols.append(d["rapid"])
    if spec.get("rating"):
        cols += [d["z"], d["z"] ** 2]
        if spec.get("tc"):
            cols += [d["z"] * d["rapid"], d["z"] ** 2 * d["rapid"]]
    if spec.get("phase"):
        cols.append(d["endgame"])
    return np.stack(cols, axis=1)


def n_params(spec, d):
    k = slope_basis(subset(d, slice(0, 1)), spec).shape[1]
    total = k + (k if spec.get("sat") else 0) + 1  # + nuisance d
    return k, total


def linear_predictor(theta, d, spec, with_diff=True):
    basis = slope_basis(d, spec)
    k = basis.shape[1]
    w1 = np.exp(basis @ theta[:k])
    eta = w1 * d["cp"] / 100.0
    parts = [(basis, w1, d["cp"] / 100.0)]
    offset = k
    if spec.get("sat"):
        w2 = np.exp(basis @ theta[offset:offset + k])
        phi2 = np.sign(d["cp"]) * np.log1p(np.abs(d["cp"]) / 100.0)
        eta = eta + w2 * phi2
        parts.append((basis, w2, phi2))
        offset += k
    if with_diff:
        eta = eta + theta[offset] * d["diff"]
    return eta, parts, offset


def sigmoid(x):
    return 1 / (1 + np.exp(-np.clip(x, -40, 40)))


def objective(theta, d, spec, l2=1e-4):
    eta, parts, offset = linear_predictor(theta, d, spec)
    p = sigmoid(eta)
    eps = 1e-12
    y = d["y"]
    n = len(y)
    loss = -np.sum(y * np.log(p + eps) + (1 - y) * np.log(1 - p + eps)) / n + l2 * np.sum(theta ** 2)
    r = (p - y) / n
    grad = np.zeros_like(theta)
    start = 0
    for basis, w, phi in parts:
        k = basis.shape[1]
        grad[start:start + k] = basis.T @ (r * w * phi)
        start += k
    grad[offset] = np.sum(r * d["diff"])
    grad += 2 * l2 * theta
    return loss, grad


def fit(d, spec):
    k, total = n_params(spec, d)
    theta = np.zeros(total)
    theta[0] = math.log(BASELINE_SLOPE * 100)
    if spec.get("sat"):
        theta[k] = math.log(0.05)
    result = minimize(objective, theta, args=(d, spec), jac=True, method="L-BFGS-B", options={"maxiter": 2000})
    return result.x


def predict(theta, d, spec, with_diff=True):
    eta, _, _ = linear_predictor(theta, d, spec, with_diff)
    return sigmoid(eta)


# --- metrics -----------------------------------------------------------------

def metrics(y, p):
    eps = 1e-12
    logloss = float(-np.mean(y * np.log(p + eps) + (1 - y) * np.log(1 - p + eps)))
    brier = float(np.mean((p - y) ** 2))
    edges = np.quantile(p, np.linspace(0, 1, 21))
    ece = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p <= hi)
        if m.sum():
            ece += m.mean() * abs(p[m].mean() - y[m].mean())
    return {"logLoss": round(logloss, 5), "brier": round(brier, 5), "ece": round(float(ece), 4), "n": int(len(y))}


def by_group(d, p, key_fn, keys):
    out = {}
    for key in keys:
        m = key_fn(d, key)
        if m.sum() >= 200:
            out[key] = metrics(d["y"][m], p[m])
    return out


def band_mask(d, label):
    for lo, hi in BANDS:
        if band_label(lo, hi) == label:
            return (d["r"] >= lo) & (d["r"] < hi)
    raise KeyError(label)


def calibration_table(d, p, cp_edges=(-2000, -600, -300, -150, -50, 50, 150, 300, 600, 2000)):
    """Observed vs predicted mean score by cp bin, per rating band (the key diagnostic)."""
    table = {}
    for lo, hi in BANDS:
        label = band_label(lo, hi)
        mb = (d["r"] >= lo) & (d["r"] < hi)
        rows = []
        for a, b in zip(cp_edges[:-1], cp_edges[1:]):
            m = mb & (d["cp"] >= a) & (d["cp"] < b)
            if m.sum() >= 100:
                rows.append({"cp": f"[{a},{b})", "n": int(m.sum()), "observed": round(float(d["y"][m].mean()), 3),
                             "predicted": round(float(p[m].mean()), 3)})
        table[label] = rows
    return table


def grouped_bootstrap_ci(d, p_a, p_b, reps=200, seed=1):
    """95% CI of the log-loss difference (a − b), resampling player groups."""
    rng = np.random.default_rng(seed)
    groups, inverse = np.unique(d["group"], return_inverse=True)
    eps = 1e-12
    la = -(d["y"] * np.log(p_a + eps) + (1 - d["y"]) * np.log(1 - p_a + eps))
    lb = -(d["y"] * np.log(p_b + eps) + (1 - d["y"]) * np.log(1 - p_b + eps))
    sum_a = np.bincount(inverse, la)
    sum_b = np.bincount(inverse, lb)
    count = np.bincount(inverse)
    diffs = []
    for _ in range(reps):
        pick = rng.integers(0, len(groups), len(groups))
        diffs.append((sum_a[pick].sum() - sum_b[pick].sum()) / count[pick].sum())
    return [round(float(np.quantile(diffs, 0.025)), 5), round(float(np.quantile(diffs, 0.975)), 5)]


SPECS = {
    "global": {},
    "tc": {"tc": True},
    "rating": {"tc": True, "rating": True},
    "rating+sat": {"tc": True, "rating": True, "sat": True},
    "rating+sat+phase": {"tc": True, "rating": True, "sat": True, "phase": True},
}


REPRESENTATIVE_CPS = [-500, -300, -150, -75, 0, 75, 150, 300, 500]


def curve_samples(theta, spec, cps=None):
    """Predicted expected score at fixed cp for each band midpoint and time class."""
    cps = np.array(cps if cps is not None else [50, 100, 200, 300, 500, 1000], dtype=float)
    out = {}
    for tc in TCS:
        for lo, hi in BANDS:
            r = (lo + min(hi, 2600)) / 2
            d = {"z": np.full(len(cps), (r - 1500) / 400), "rapid": np.full(len(cps), 1.0 if tc == "rapid" else 0.0),
                 "endgame": np.zeros(len(cps)), "cp": cps, "diff": np.zeros(len(cps))}
            p = predict(theta, d, spec, with_diff=False)
            out[f"{tc}|{band_label(lo, hi)}"] = {int(c): round(float(v), 3) for c, v in zip(cps, p)}
    base = 1 / (1 + np.exp(-BASELINE_SLOPE * cps))
    out["baseline"] = {int(c): round(float(v), 3) for c, v in zip(cps, base)}
    return out


def monotone_check(theta, spec):
    """cp = 0 ↦ ½; increasing in cp; → 0 / 1 at the extremes (every band and tc)."""
    cps = np.linspace(-3000, 3000, 601)
    ok = True
    worst_tail = 1.0
    for tc in TCS:
        for r in range(800, 2801, 50):
            d = {"z": np.full(len(cps), (r - 1500) / 400), "rapid": np.full(len(cps), 1.0 if tc == "rapid" else 0.0),
                 "endgame": np.zeros(len(cps)), "cp": cps, "diff": np.zeros(len(cps))}
            p = predict(theta, d, spec, with_diff=False)
            ok &= bool(np.all(np.diff(p) > 0)) and abs(p[300] - 0.5) < 1e-12
            worst_tail = min(worst_tail, float(p[-1]), float(1 - p[0]))
    return {"monotoneAndNeutral": bool(ok), "minTailAt3000cp": round(worst_tail, 4)}


def export_params(theta, spec):
    k = slope_basis({"z": np.zeros(1), "rapid": np.zeros(1), "endgame": np.zeros(1)}, spec).shape[1]
    return {
        "slope": [round(float(v), 6) for v in theta[:k]],
        "saturation": [round(float(v), 6) for v in theta[k:2 * k]] if spec.get("sat") else None,
        "ratingDifference": round(float(theta[-1]), 6),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--positions", required=True)
    parser.add_argument("--json", required=True)
    parser.add_argument("--final-test", action="store_true")
    parser.add_argument("--write-lib", action="store_true")
    parser.add_argument("--choose", default=None, help="freeze this model instead of the validation winner")
    args = parser.parse_args()

    data = load(args.positions)
    train = subset(data, data["split"] == "train")
    val = subset(data, data["split"] == "validation")
    report = {
        "positions": {s: int((data["split"] == s).sum()) for s in ["train", "validation", "test"]},
        "games": {s: int(len(np.unique(data["group"][data["split"] == s]))) for s in ["train", "validation", "test"]},
        "models": {},
    }
    baseline_val = sigmoid(BASELINE_SLOPE * val["cp"])
    report["models"]["baseline"] = {"validation": metrics(val["y"], baseline_val)}
    fitted = {}
    for name, spec in SPECS.items():
        theta = fit(train, spec)
        p_val = predict(theta, val, spec)
        fitted[name] = (theta, spec)
        report["models"][name] = {
            "validation": metrics(val["y"], p_val),
            "validationNoDiff": metrics(val["y"], predict(theta, val, spec, with_diff=False)),
            "params": export_params(theta, spec),
            "spec": spec,
            "constraints": monotone_check(theta, spec),
        }
        print(name, report["models"][name]["validation"])

    # Isotonic layer on the best parametric model (fit on train predictions).
    best_param = min(SPECS, key=lambda n: report["models"][n]["validation"]["logLoss"])
    theta, spec = fitted[best_param]
    iso = IsotonicRegression(y_min=1e-4, y_max=1 - 1e-4, out_of_bounds="clip")
    iso.fit(predict(theta, train, spec), train["y"])
    p_iso = iso.predict(predict(theta, val, spec))
    report["models"][f"{best_param}+isotonic"] = {"validation": metrics(val["y"], p_iso)}

    # Parsimony: prefer the simplest model within the bootstrap noise of the best.
    order = ["global", "tc", "rating", "rating+sat", "rating+sat+phase"]
    best = min(order, key=lambda n: report["models"][n]["validation"]["logLoss"])
    chosen = best
    for name in order:
        if name == best:
            break
        t, s = fitted[name]
        tb, sb = fitted[best]
        ci = grouped_bootstrap_ci(val, predict(t, val, s), predict(tb, val, sb))
        report["models"][name]["deltaVsBestCI"] = ci
        if ci[0] <= 0:  # not significantly worse than the best
            chosen = name
            break
    if args.choose:
        chosen = args.choose
    report["chosen"] = chosen
    theta, spec = fitted[chosen]
    p_val = predict(theta, val, spec)
    report["chosenVsBaselineCI"] = grouped_bootstrap_ci(val, baseline_val, p_val)
    band_keys = [band_label(lo, hi) for lo, hi in BANDS]
    report["validationByBand"] = {
        "chosen": by_group(val, p_val, band_mask, band_keys),
        "baseline": by_group(val, baseline_val, band_mask, band_keys),
    }
    report["validationByTc"] = {
        "chosen": by_group(val, p_val, lambda d, k: d["tc"] == k, TCS),
        "baseline": by_group(val, baseline_val, lambda d, k: d["tc"] == k, TCS),
    }
    report["calibrationValidation"] = {"chosen": calibration_table(val, p_val), "baseline": calibration_table(val, baseline_val)}
    report["curves"] = curve_samples(theta, spec)
    # Representative evaluation table requested for the report: -500..+500 cp.
    report["representativeCurves"] = curve_samples(theta, spec, REPRESENTATIVE_CPS)

    if args.final_test:
        test = subset(data, data["split"] == "test")
        p_test = predict(theta, test, spec)
        base_test = sigmoid(BASELINE_SLOPE * test["cp"])
        report["test"] = {
            "chosen": metrics(test["y"], p_test),
            "chosenNoDiff": metrics(test["y"], predict(theta, test, spec, with_diff=False)),
            "baseline": metrics(test["y"], base_test),
            "baselineMinusChosenCI": grouped_bootstrap_ci(test, base_test, p_test),
            "byBand": {"chosen": by_group(test, p_test, band_mask, band_keys), "baseline": by_group(test, base_test, band_mask, band_keys)},
            "byTc": {"chosen": by_group(test, p_test, lambda d, k: d["tc"] == k, TCS),
                     "baseline": by_group(test, base_test, lambda d, k: d["tc"] == k, TCS)},
        }
        print("TEST", report["test"]["chosen"], "baseline", report["test"]["baseline"])

    with open(args.json, "w") as handle:
        json.dump(report, handle, indent=1)
    print("chosen", chosen, "vs baseline CI", report["chosenVsBaselineCI"])

    if args.write_lib:
        params = export_params(theta, spec)
        lib = f"""// Generated by scripts/corpus/outcome_model.py – do not edit by hand.
// Rating-conditioned human outcome model E[result | cp, rating, time control],
// fitted on player-disjoint train games; see docs/validation-report.md.
export const OUTCOME_MODEL = {json.dumps({
    "id": f"ks-outcome-{chosen}-v1",
    "form": chosen,
    "spec": spec,
    **params,
    "ratingRange": [800, 2700],
    "validation": report["models"][chosen]["validation"],
    "test": report.get("test", {}).get("chosen"),
}, indent=2)} as const;
"""
        with open("lib/outcome-params.ts", "w") as handle:
            handle.write(lib)
        print("wrote lib/outcome-params.ts")


if __name__ == "__main__":
    main()
