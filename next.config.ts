import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "3mb" } },   // service photos (max 2 MB each)
};
export default nextConfig;
