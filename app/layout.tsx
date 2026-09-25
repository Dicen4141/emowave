import type { Metadata } from "next";
import "./globals.css";

// The browser-tab icon is app/icon.svg, picked up by Next's file convention
// rather than declared here — the framework hashes it, sets the caching
// headers and injects the <link> itself, none of which a hand-written
// metadata.icons entry pointing into public/ would get. There is deliberately
// no reference to it in this file, so this comment is the only place that says
// where it lives.
export const metadata: Metadata = {
  title: "EmoWave",
  description: "View your EmoWave assessment report.",
};

export const viewport = {
  themeColor: "#0d111b",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
