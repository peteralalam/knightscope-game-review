#!/bin/sh
# Build a native (x86-64 AVX2) Stockfish from the SAME vendored stockfish.js
# 19.0.0 source and Lite network the browser runs, for corpus analysis only.
#
#   sh scripts/corpus/build-native-engine.sh   # → .cache/native/stockfish
#
# Node-limited, single-threaded searches with the same hash size reproduce the
# WASM engine exactly (verify with scripts/corpus/native-parity.mjs); only speed
# differs. The one source change is a typo fix in the native-only branch of
# main.cpp (`uci.loop()` → `uci->loop()`), which the Emscripten build never compiles.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
tar xzf "$root/public/stockfish/19.0.0/source/stockfish.js-19.0.0-source.tar.gz" -C "$work"
src="$work/stockfish.js-19.0.0/src"
cp "$root/public/stockfish/19.0.0/source/nn-61e7af4bb97d.nnue" "$src/"
sed -i 's/    uci\.loop();/    uci->loop();/' "$src/main.cpp"
make -C "$src" -j"$(nproc)" build ARCH="${ARCH:-x86-64-avx2}" COMP=gcc LITE_NET=yes EXTRACXXFLAGS="-D__NO_SYZYGY__" >/dev/null
mkdir -p "$root/.cache/native"
cp "$src/stockfish" "$root/.cache/native/stockfish"
rm -rf "$work"
echo "built $root/.cache/native/stockfish"
