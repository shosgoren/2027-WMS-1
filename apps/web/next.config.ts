import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Docker/Fly imajı için kendi kendine yeten sunucu (`.next/standalone`, T-010 / ADR-013).
  output: "standalone",
};

export default nextConfig;
