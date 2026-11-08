import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // keep the native `ws` WebSocket client out of the bundler (used by the
  // server-side Binance market feed in market-feed.ts)
  serverExternalPackages: ["ws"],
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
