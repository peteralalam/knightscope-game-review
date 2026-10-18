import type { Color, PieceSymbol } from "chess.js";

const OUTLINE: Record<Color, string> = { w: "#262d35", b: "#0b0f13" };
const DETAIL: Record<Color, string> = { w: "#4a5560", b: "#8c99a5" };

/** Shared gradient definitions; render once next to the board. */
export function PieceDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="glass-w" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0" stopColor="#aeb9c3" />
          <stop offset="0.28" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#dbe3e9" />
          <stop offset="1" stopColor="#8f9ca8" />
        </linearGradient>
        <linearGradient id="glass-b" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0" stopColor="#1b2229" />
          <stop offset="0.3" stopColor="#6a7783" />
          <stop offset="0.62" stopColor="#38424b" />
          <stop offset="1" stopColor="#12171c" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Glass-style pieces drawn on a 45×45 grid. */
const BASE = "M10 40v-3.5c0-1.6 1.2-2.5 2.8-2.5h19.4c1.6 0 2.8.9 2.8 2.5V40z";

function Shapes({ type }: { type: PieceSymbol }) {
  switch (type) {
    case "p":
      return (
        <>
          <circle cx="22.5" cy="11.5" r="5.6" />
          <path d="M16.2 20.4h12.6c1.3 0 1.3 3.2 0 3.2H16.2c-1.3 0-1.3-3.2 0-3.2z" />
          <path d="M17.6 23.4h9.8c.4 3.6 3.6 6.2 4.8 10.6H12.8c1.2-4.4 4.4-7 4.8-10.6z" />
          <path d={BASE} />
        </>
      );
    case "r":
      return (
        <>
          <path d="M12 7.5h4.6v3.2h3.2V7.5h5.4v3.2h3.2V7.5H33v9.4H12z" />
          <path d="M14.4 16.9h16.2l1 4H13.4z" />
          <path d="M14.8 20.9h15.4l1.4 13.1H13.4z" />
          <path d="M12 26h21v3.4H12z" />
          <path d={BASE} />
        </>
      );
    case "n":
      return (
        <>
          <path d="M12.6 34c0-5.2 2.2-8.2 4.6-11.2-3 .6-5.2 2.8-8.2 2.4-1.4-1.4-.8-3.4.8-5.2 2.4-2.6 3.6-5.2 4-8l-.6-3.4 3.6 1.6c1.6-2.6 4.4-4 7.4-3.8l.8-3 2.4 3.2C31.6 10 35 17.6 34.4 34z" />
          <path d={BASE} />
        </>
      );
    case "b":
      return (
        <>
          <circle cx="22.5" cy="6.6" r="2.4" />
          <path d="M22.5 9C29.4 13.6 31 20.6 26.8 25.4h-8.6C14 20.6 15.6 13.6 22.5 9z" />
          <path d="M16.2 25.4h12.6c1.3 0 1.3 3.4 0 3.4H16.2c-1.3 0-1.3-3.4 0-3.4z" />
          <path d="M18.2 28.8h8.6c.4 2.4 2.6 3.6 3.6 5.2H14.6c1-1.6 3.2-2.8 3.6-5.2z" />
          <path d={BASE} />
        </>
      );
    case "q":
      return (
        <>
          <path d="M12.4 34 10.2 15.6l6.6 8 1-11.6 4.7 10.6 4.7-10.6 1 11.6 6.6-8L32.6 34z" />
          <circle cx="10" cy="13.2" r="2.3" />
          <circle cx="17.6" cy="9.6" r="2.3" />
          <circle cx="22.5" cy="8.4" r="2.3" />
          <circle cx="27.4" cy="9.6" r="2.3" />
          <circle cx="35" cy="13.2" r="2.3" />
          <path d="M12.6 29.6h19.8V34H12.6z" />
          <path d={BASE} />
        </>
      );
    case "k":
      return (
        <>
          <path d="M20.6 3.4h3.8v3h3v3.6h-3v2.6h-3.8V10h-3V6.4h3z" />
          <path d="M22.5 13.2c7.8 0 11.6 6.4 9.6 12.4-.6 1.8-2.4 2.4-2.4 4.4H15.3c0-2-1.8-2.6-2.4-4.4-2-6 1.8-12.4 9.6-12.4z" />
          <path d="M13.4 29.6h18.2c1.8 0 1.8 4.4 0 4.4H13.4c-1.8 0-1.8-4.4 0-4.4z" />
          <path d={BASE} />
        </>
      );
  }
}

/** Fine inner lines (slits, eye, bands) drawn over the filled shapes. */
function Details({ type, color }: { type: PieceSymbol; color: Color }) {
  const stroke = DETAIL[color];
  const common = { fill: "none", stroke, strokeWidth: 1.1, strokeLinecap: "round" as const };
  switch (type) {
    case "n":
      return (
        <g {...common}>
          <circle cx="18.6" cy="14.6" r="0.9" fill={stroke} stroke="none" />
          <path d="M10.4 22.8l1.4-.4M25.6 12.6c3 3 4.6 8 4.4 14.6M22.4 11.4c4.4 2.4 6.2 7.6 6.4 13.4" />
        </g>
      );
    case "b":
      return (
        <g {...common}>
          <path d="M22.5 11.8v7M19.6 15h5.8" />
        </g>
      );
    case "k":
      return (
        <g {...common}>
          <path d="M22.5 6.4v3.4M20.8 8.1h3.4" />
        </g>
      );
    default:
      return null;
  }
}

export function ChessPiece({ type, color }: { type: PieceSymbol; color: Color }) {
  return (
    <svg className="piece-svg" viewBox="0 0 45 45" aria-hidden="true" focusable="false">
      <g fill={`url(#glass-${color})`} stroke={OUTLINE[color]} strokeWidth="1.5" strokeLinejoin="round">
        <Shapes type={type} />
      </g>
      <Details type={type} color={color} />
    </svg>
  );
}
