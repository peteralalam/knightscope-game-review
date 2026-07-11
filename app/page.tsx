import type { Metadata } from "next";
import { ChessReviewApp } from "./ChessReviewApp";

export const metadata: Metadata = {
  title: { absolute: "KnightScope — Chess Game Review" },
  description:
    "Import a PGN and review every move with private, in-browser Stockfish analysis.",
};

export default function Home() {
  return <ChessReviewApp />;
}
