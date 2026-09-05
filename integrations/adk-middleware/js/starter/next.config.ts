import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These packages are server-only and include optional Node integrations
  // (Express transports, database drivers, and worker transports) that should
  // be resolved by Node at runtime instead of traversed by the browser bundler.
  serverExternalPackages: [
    "@ag-ui/adk-js",
    "@copilotkit/runtime",
    "@google/adk",
  ],
};

export default nextConfig;
