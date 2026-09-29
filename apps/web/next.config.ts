import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @preorder/core is TypeScript source in the monorepo.
  transpilePackages: ["@preorder/core"],
  // Node-only chain SDKs run on the server as regular node_modules.
  serverExternalPackages: [
    "@meteora-ag/dynamic-bonding-curve-sdk",
    "@meteora-ag/cp-amm-sdk",
    "@coral-xyz/anchor",
    // One shared copy: SDK-built transactions must pass web3.js instanceof checks in our send helper.
    "@solana/web3.js",
    "@solana/spl-token",
  ],
};

export default nextConfig;
