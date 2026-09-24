import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const image = `${origin}/og.png`;

  return {
    metadataBase: new URL(origin),
    title: {
      default: "KnightScope — Chess Game Review",
      template: "%s · KnightScope",
    },
    description:
      "A private, engine-backed chess review that grades every PGN move and estimates single-game playing strength.",
    applicationName: "KnightScope",
    openGraph: {
      title: "KnightScope — See the story behind every move",
      description: "Private, visual PGN analysis powered by Stockfish 19.",
      type: "website",
      images: [{ url: image, width: 1200, height: 630, alt: "KnightScope chess game review" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "KnightScope — Chess Game Review",
      description: "Private, visual PGN analysis powered by Stockfish 19.",
      images: [image],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#111713",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
