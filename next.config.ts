import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,

  // Bundles the server and only the dependencies it actually reaches into
  // .next/standalone, so the runtime image carries no node_modules and no
  // build toolchain. See the Dockerfile.
  output: 'standalone',
};

export default nextConfig;
