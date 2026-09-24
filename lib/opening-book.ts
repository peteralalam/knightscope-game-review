/**
 * Opening-theory lookup. A position is "book" if it occurs in a named line of
 * the lichess-org/chess-openings dataset (CC0). Positions are stored as 40-bit
 * hashes of the FEN's placement / side / castling / en-passant fields, so move
 * order transpositions are recognized.
 *
 * Regenerate the data with `node scripts/build-opening-book.mjs <checkout>`.
 */
import { OPENING_BOOK_DATA, OPENING_BOOK_SOURCE } from "./opening-book-data.ts";

export { OPENING_BOOK_SOURCE };

const KEY_WIDTH = 8;

function fnv1a(text: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function positionKey(fen: string) {
  const identity = fen.split(" ").slice(0, 4).join(" ");
  const high = fnv1a(identity, 0x811c9dc5);
  const low = fnv1a(identity, 0x050c5d1f) & 0xff;
  return (high * 256 + low).toString(36).padStart(KEY_WIDTH, "0");
}

let book: Set<string> | null = null;

function load() {
  if (!book) {
    book = new Set();
    for (let index = 0; index < OPENING_BOOK_DATA.length; index += KEY_WIDTH) {
      book.add(OPENING_BOOK_DATA.slice(index, index + KEY_WIDTH));
    }
  }
  return book;
}

export function isBookPosition(fen: string) {
  return load().has(positionKey(fen));
}

export function openingBookSize() {
  return load().size;
}
