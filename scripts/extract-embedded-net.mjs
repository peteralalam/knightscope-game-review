// Recover the NNUE network embedded in a stockfish.js wasm binary, verified by
// the SHA-256 prefix Stockfish encodes in the net's file name.
//
//   node scripts/extract-embedded-net.mjs public/stockfish/19.0.0/stockfish-19-lite-single.wasm nn-61e7af4bb97d.nnue out.nnue
//
// GPLv3 requires the Corresponding Source for the object code we distribute;
// for Stockfish that includes the network the binary embeds. The linker's
// memory packing drops zero runs from data segments, so the net is recovered
// from the reconstructed linear-memory image, not from the raw file bytes.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [wasmPath, netName, outPath] = process.argv.slice(2);
const prefix = netName.match(/^nn-([0-9a-f]{12})\.nnue$/)?.[1];
if (!prefix) throw new Error("net name must look like nn-<12 hex>.nnue");
const wasm = readFileSync(wasmPath);

let offset = 8; // magic + version
const leb = () => {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = wasm[offset++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) return result;
  }
};
const segments = [];
while (offset < wasm.length) {
  const id = wasm[offset++];
  const size = leb();
  const end = offset + size;
  if (id === 11) {
    const count = leb();
    for (let index = 0; index < count; index += 1) {
      const flags = leb();
      if (flags === 1) throw new Error("passive data segments are not supported");
      if (flags === 2) leb(); // memory index
      if (wasm[offset++] !== 0x41) throw new Error("expected i32.const offset");
      // Signed LEB128 offset (always small and positive here).
      const address = leb();
      if (wasm[offset++] !== 0x0b) throw new Error("expected end of offset expression");
      const length = leb();
      segments.push({ address, bytes: wasm.subarray(offset, offset + length) });
      offset += length;
    }
  }
  offset = end;
}
const top = Math.max(...segments.map((segment) => segment.address + segment.bytes.length));
const memory = Buffer.alloc(top);
for (const segment of segments) segment.bytes.copy(memory, segment.address);

// Stockfish 19 NNUE files start with the little-endian version word 0x6A448AFA (nnue_common.h).
const magic = Buffer.from([0xfa, 0x8a, 0x44, 0x6a]);
for (let start = memory.indexOf(magic); start >= 0; start = memory.indexOf(magic, start + 1)) {
  const hash = createHash("sha256");
  hash.update(memory.subarray(start, start + 1024));
  for (let end = start + 1024; end <= memory.length; end += 1) {
    if (hash.copy().digest("hex").startsWith(prefix)) {
      writeFileSync(outPath, memory.subarray(start, end));
      const full = createHash("sha256").update(memory.subarray(start, end)).digest("hex");
      console.log(`${netName}: ${end - start} bytes, sha256 ${full}`);
      process.exit(0);
    }
    if (end < memory.length) hash.update(memory.subarray(end, end + 1));
  }
}
console.error(`no embedded ${netName} found`);
process.exit(1);
