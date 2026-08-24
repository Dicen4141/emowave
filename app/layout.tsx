import type { Metadata } from "next";
import "./globals.css";

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
