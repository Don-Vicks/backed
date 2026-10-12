import fs from "fs";
import path from "path";
import type { NextConfig } from "next";

// One network switch: the repo-root .env (or the host's env) sets NETWORK, and the browser bundle gets
// the matching cluster and RPC at build time. Changing NETWORK or PUBLIC_RPC_URL needs a rebuild.
// Self-contained on purpose: the config is loaded before the workspace TypeScript is compiled, and
// may run as ESM (no __dirname). Root lookup mirrors repoRoot() in packages/core/src/paths.ts.
function repoRoot() {
  if (process.env.PREORDER_ROOT) return process.env.PREORDER_ROOT;
  let dir = process.cwd();
  while (!fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}
const envFile = path.join(repoRoot(), ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables already set

const NETWORK = process.env.NETWORK || "devnet";
// Keyless defaults, mirrored from PUBLIC_RPC_URLS in packages/core/src/network.ts. The server's own
// DEVNET_RPC_URL/MAINNET_RPC_URL may carry an API key, so they never reach the browser.
const PUBLIC_RPC_DEFAULTS: Record<string, string> = {
  localnet: process.env.LOCALNET_RPC_URL || "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};
if (!(NETWORK in PUBLIC_RPC_DEFAULTS)) throw new Error(`NETWORK must be localnet, devnet or mainnet, got ${NETWORK}`);

const nextConfig: NextConfig = {
  devIndicators: false, // the dev-only badge sits over the page in demos and screenshots
  env: {
    NEXT_PUBLIC_NETWORK: NETWORK,
    NEXT_PUBLIC_RPC_URL: process.env.PUBLIC_RPC_URL || PUBLIC_RPC_DEFAULTS[NETWORK],
  },
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
