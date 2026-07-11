import assert from "node:assert/strict";
import test from "node:test";
import initStockfish from "stockfish";

test("Stockfish lite answers the UCI protocol and evaluates a position", { timeout: 30_000 }, async () => {
  const engine = await initStockfish("lite-single");
  const output = [];

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Stockfish smoke test timed out")), 25_000);
    engine.listener = (line) => {
      output.push(line);
      if (line === "uciok") {
        engine.sendCommand("setoption name UCI_ShowWDL value true");
        engine.sendCommand("isready");
      } else if (line === "readyok") {
        engine.sendCommand("position startpos moves e2e4 e7e5 g1f3");
        engine.sendCommand("go nodes 5000");
      } else if (line.startsWith("bestmove ")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    engine.sendCommand("uci");
  });

  assert.ok(output.some((line) => /Stockfish 18/.test(line)));
  assert.ok(output.some((line) => /\bscore (?:cp|mate) -?\d+/.test(line)));
  assert.ok(output.some((line) => /\bwdl \d+ \d+ \d+/.test(line)));
  assert.ok(output.some((line) => /^bestmove [a-h][1-8][a-h][1-8]/.test(line)));
  engine.terminate?.();
});
