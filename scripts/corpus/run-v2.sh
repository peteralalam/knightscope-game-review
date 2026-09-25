#!/bin/sh
# End-to-end v2 statistical pass: sample → analyze → outcome model → rating
# model → classification impact → report. Every step writes under data/ or
# .cache/ and can be re-run on its own.
#
#   MONTH=2026-08 SEED=20260925 PER_STRATUM=2800 SCAN=40000000 sh scripts/corpus/run-v2.sh
#
# Needs network access to database.lichess.org (step 1 only).
set -eu
MONTH=${MONTH:-2026-08}
SEED=${SEED:-20260925}
PER_STRATUM=${PER_STRATUM:-2800}   # games per (time class × band) stratum; 18 strata
SCAN=${SCAN:-40000000}             # games read from the monthly file before stopping
SHARDS=${SHARDS:-$(nproc)}
OUT=data/rating-corpus-v2
export KS_NATIVE_ENGINE=${KS_NATIVE_ENGINE:-.cache/native/stockfish}

# 1. Streamed, stratified sample of the official monthly database (nothing but the sample is stored).
if [ ! -f "$OUT/games.jsonl" ]; then
  curl -sL "https://database.lichess.org/standard/lichess_db_standard_rated_${MONTH}.pgn.zst" \
    | node scripts/corpus/sample-lichess-db.mjs --file - --month "$MONTH" --seed "$SEED" \
        --per-stratum "$PER_STRATUM" --per-player 2 --eval-per-stratum 1500 --scan "$SCAN" --out "$OUT"
fi

# 2. Native build of the vendored engine (parity-checked against WASM).
[ -x "$KS_NATIVE_ENGINE" ] || sh scripts/corpus/build-native-engine.sh
node scripts/corpus/native-parity.mjs --games "$OUT/games.jsonl" --count 3 --preset quick

# 3. Quick-preset analysis with the production pipeline, one process per core.
i=0
while [ "$i" -lt "$SHARDS" ]; do
  node scripts/corpus/analyze-corpus.mjs --games "$OUT/games.jsonl" --preset quick --engine native \
    --shard "$i" --shards "$SHARDS" --out ".cache/corpus/rating-v2.$i.jsonl" > ".cache/corpus/rating-v2.$i.log" 2>&1 &
  i=$((i + 1))
done
wait

# 4. Player-disjoint samples (connected components → 60/20/20).
node scripts/corpus/rating-dataset.mjs --analyses ".cache/corpus/rating-v2.*.jsonl" --games "$OUT/games.jsonl" \
  --out "$OUT/samples.jsonl" --decisions-out .cache/corpus/decisions-v2.jsonl --summary "$OUT/dataset-summary.json"

# 5. Outcome model: choose on validation, then score test once.
node scripts/corpus/outcome-dataset.mjs --analyses ".cache/corpus/rating-v2.*.jsonl" --games "$OUT/games.jsonl" \
  --samples "$OUT/samples.jsonl" --out .cache/corpus/outcome-positions-v2.csv
python3 scripts/corpus/outcome_model.py --positions .cache/corpus/outcome-positions-v2.csv --json "$OUT/outcome-model.json" --final-test --write-lib

# 6. Rating model: every choice on grouped CV of train+validation, test scored once.
OMP_NUM_THREADS=1 python3 scripts/corpus/rating_benchmark.py "$OUT/samples.jsonl" --out "$OUT/benchmark.json" --final-test --write-lib

# 7. Does the rating-conditioned curve change the displayed grades?
node scripts/corpus/outcome-regrade.mjs --analyses ".cache/corpus/rating-v2.*.jsonl" --samples "$OUT/samples.jsonl" \
  --outcome "$OUT/outcome-model.json" --split test --out "$OUT/regrade.json"
node scripts/corpus/classification-stats.mjs ".cache/corpus/rating-v2.*.jsonl" --games "$OUT/games.jsonl" --json "$OUT/stats.json"

# 8. Report.
node scripts/corpus/write-report.mjs
