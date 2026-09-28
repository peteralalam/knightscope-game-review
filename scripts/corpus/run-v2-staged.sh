#!/bin/sh
# Staged v2 pass, per the "do not spend the full compute budget at once" protocol:
#   Stage A ~10,000 player-games – sanity-check the whole pipeline end to end.
#   Stage B ~25,000 player-games – compare model coefficients/results with A.
#   Stage C ~50,000 player-games – only if B is still materially moving.
#
#   STAGE=A sh scripts/corpus/run-v2-staged.sh
#   STAGE=B sh scripts/corpus/run-v2-staged.sh
#   STAGE=C sh scripts/corpus/run-v2-staged.sh
#
# Same seed and month across stages, so each stage's sample is close to a
# superset of the previous one's (bottom-k sampling with a larger k plus the
# same priority order) — not guaranteed exactly nested because of the
# per-player cap's global greedy pass, but close. Each stage gets its own
# output directory (data/rating-corpus-v2-stage<X>) so results are never
# overwritten and can be diffed against the previous stage.
#
# Sizing: 18 strata (2 time classes × 9 rating bands), 2 player-games/game.
set -eu
STAGE=${STAGE:?Set STAGE=A, B, or C}
MONTH=${MONTH:-2026-08}
SEED=${SEED:-20260925}
case "$STAGE" in
  A) TARGET_PLAYER_GAMES=10000 ;;
  B) TARGET_PLAYER_GAMES=25000 ;;
  C) TARGET_PLAYER_GAMES=50000 ;;
  *) echo "STAGE must be A, B or C" >&2; exit 1 ;;
esac
TARGET_GAMES=$((TARGET_PLAYER_GAMES / 2))
PER_STRATUM=$((TARGET_GAMES / 18))
SCAN=${SCAN:-$((TARGET_GAMES * 30))}   # generous over-read so every stratum can fill
OUT_DIR="data/rating-corpus-v2-stage${STAGE}"

echo "Stage $STAGE: target ~$TARGET_PLAYER_GAMES player-games (~$TARGET_GAMES games), per-stratum $PER_STRATUM, scan up to $SCAN games, seed $SEED, month $MONTH -> $OUT_DIR"

sed "s#^OUT=data/rating-corpus-v2\$#OUT=${OUT_DIR}#" scripts/corpus/run-v2.sh > ".cache/run-v2-stage${STAGE}.sh"
MONTH="$MONTH" SEED="$SEED" PER_STRATUM="$PER_STRATUM" SCAN="$SCAN" sh ".cache/run-v2-stage${STAGE}.sh"

echo "Stage $STAGE complete. Compare $OUT_DIR/benchmark.json and $OUT_DIR/outcome-model.json against the previous stage."
