/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow larger request bodies for PDF uploads on Server Actions / route handlers.
  experimental: {
    serverActions: {
      bodySizeLimit: "32mb",
    },
  },
  // pdfjs-dist resolves its worker file (pdf.worker.mjs) from disk at runtime.
  // Bundling it into a webpack vendor chunk breaks that lookup, so keep it
  // as a plain Node require for server routes instead.
  serverExternalPackages: ["pdfjs-dist"],
  // There's no page at "/" — the public landing page was removed. Clients open
  // their report straight from their /report/[id] link, so the only thing left
  // at the root is the admin tool. Handled here rather than by an app/page.tsx
  // that calls redirect(), so "/" never renders React at all.
  async redirects() {
    return [{ source: "/", destination: "/admin", permanent: false }];
  },
  // The app writes extraction dumps into /extractions at runtime. Without this,
  // the dev file-watcher treats each new .txt as a source change, recompiles
  // mid-request, and races the running request (ENOENT on .next/server/app/page.js).
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ["**/node_modules/**", "**/.next/**", "**/extractions/**"],
      };
    }
    return config;
  },
};

export default nextConfig;
