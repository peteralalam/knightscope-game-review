import assert from "node:assert/strict";
import test from "node:test";
import { runSuite } from "../scripts/corpus/brilliant-suite.mjs";
import { createNodeEnginePool } from "../scripts/node-engine.mjs";

// Real Stockfish 19 over constructed traps and Lichess puzzle positions
// (data/brilliant-suite). A false Brilliant is a hard failure; a missed one is not.
test("Brilliant adversarial suite: no false positives, declined sacrifices still count", { timeout: 900_000 }, async () => {
  const engines = createNodeEnginePool(3);
  try {
    const results = await runSuite(engines, { preset: "balanced" });
    const falsePositives = results.filter((result) => result.mustNotBeBrilliant && result.grade === "brilliant");
    assert.deepEqual(falsePositives.map((result) => `${result.id} ${result.move}`), []);

    const byId = Object.fromEntries(results.map((result) => [result.id, result]));
    const declined = byId["declined-sacrifice/opera-nxb5"];
    assert.equal(declined.grade, "brilliant", "a sound offer does not need to be accepted");
    assert.equal(declined.brilliantDiagnostics.acceptanceIsBestDefense, false);
    assert.ok(declined.brilliantDiagnostics.expectedScoreAfterAcceptance >= declined.brilliantDiagnostics.expectedScoreAfter - 0.05);

    assert.equal(byId["sac-while-winning/opera-extra-queen"].brilliantDiagnostics.decision, "rejected: a simpler move was already winning");
    assert.match(byId["temporary-sacrifice/fork-trick"].brilliantDiagnostics.decision, /pseudo-sacrifice/);
    assert.notEqual(byId["forced-queen-sacrifice/qxd4"].grade, "brilliant");

    const sound = results.filter((result) => !result.mustNotBeBrilliant);
    assert.ok(sound.some((result) => result.grade === "brilliant"), "sound sacrifices can still be Brilliant");
  } finally {
    engines.forEach((engine) => engine.dispose());
  }
});
