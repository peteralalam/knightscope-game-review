"""How much does the analysis preset move the rating estimate?

The model is trained on Quick-preset features; the app defaults to Balanced.
This re-analyzes a random sample of TEST games at Balanced and compares the
shipped model's estimates for the same game-sides at both presets.

    python3 scripts/corpus/preset_check.py data/rating-corpus/samples.jsonl \
        ".cache/corpus/preset-balanced.*.jsonl" data/rating-corpus/preset-check.json
"""
import glob
import json
import sys

samples_path, pattern, out = sys.argv[1:4]
quick = {}
for line in open(samples_path):
    row = json.loads(line)
    quick[f'{row["gameId"]}:{row["color"]}'] = row
pairs = []
for path in sorted(glob.glob(pattern)):
    for line in open(path):
        analysis = json.loads(line)
        for color in "wb":
            key = f'{analysis["id"]}:{color}'
            side = analysis["sides"][color]
            if key not in quick or not side["performance"]:
                continue
            pairs.append((quick[key], side["performance"]))

# Quick-preset estimates for the same rows: the shipped model (lib/rating-params.ts)
# applied to the stored Quick features.


def quick_estimate(row):
    import math
    model = LIB[row["tc"]]
    raw = row["x"]
    values = [model["imputation"][i] if v is None else v for i, v in enumerate(raw)]
    values += [1 if raw[i] is None else 0 for i in model["missingIndicators"]]
    prediction = model["intercept"] + sum(c * (v - m) / s for c, v, m, s in zip(model["coefficients"], values, model["mean"], model["scale"]))
    center = min(model["clamp"][1], max(model["clamp"][0], prediction))
    spread = math.sqrt(max(1, model["interval"]["a"] + model["interval"]["b"] / max(1, row["meaningfulMoves"])))
    low, high = center + model["interval"]["qLow"] * spread, center + model["interval"]["qHigh"] * spread
    # Same rounding as the app's estimate (to 50, bounds outward).
    return round(center / 50) * 50, math.floor(low / 50) * 50, math.ceil(high / 50) * 50


text = open("lib/rating-params.ts").read()
start = text.index("= {", text.index("export const REGRESSION_MODELS"))
LIB = json.loads(text[start + 2:text.rindex(";")])

report = {"pairs": len(pairs), "byTimeControl": {}}
for tc in ["blitz", "rapid"]:
    subset = [(row, perf) for row, perf in pairs if row["tc"] == tc]
    if not subset:
        continue
    q = [quick_estimate(row) for row, _ in subset]
    truth = [row["rating"] for row, _ in subset]
    bal = [(perf["estimatedPerformanceRating"], perf["confidenceLow"], perf["confidenceHigh"]) for _, perf in subset]
    mae = lambda est: round(sum(abs(e[0] - t) for e, t in zip(est, truth)) / len(truth), 1)
    cov = lambda est: round(sum(e[1] <= t <= e[2] for e, t in zip(est, truth)) / len(truth), 3)
    shift = [b[0] - qq[0] for b, qq in zip(bal, q)]
    report["byTimeControl"][tc] = {
        "n": len(subset),
        "quick": {"mae": mae(q), "coverage80": cov(q)},
        "balanced": {"mae": mae(bal), "coverage80": cov(bal)},
        "meanShiftBalancedMinusQuick": round(sum(shift) / len(shift), 1),
        "meanAbsShift": round(sum(abs(s) for s in shift) / len(shift), 1),
    }
json.dump(report, open(out, "w"), indent=1)
print(json.dumps(report, indent=1))
