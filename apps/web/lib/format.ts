// Both are set from the root NETWORK by next.config.ts at build time.
export const NETWORK = process.env.NEXT_PUBLIC_NETWORK as "localnet" | "devnet" | "mainnet";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL!;
// Test networks have free SOL and mock USDC, so the faucet and network badge show.
export const IS_TEST_NETWORK = NETWORK !== "mainnet";

export function usd(n: number, digits = 2) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function units(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 1 });
}

// Unit counts in summaries (cards, totals): whole when within a hair of one, else one decimal, so 0.98 reads 1 and 2.93 reads 2.9.
export function unitsShort(n: number) {
  const r = Math.round(n);
  return Math.abs(n - r) < 0.05 ? r.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

// Vouchers a buy delivers, rounded down so a count is never overstated: 2.000018 reads 2, 5.999986 reads 5.99.
export function unitsDown(n: number) {
  return (Math.floor(n * 100 + 1e-9) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function short(address: string, chars = 4) {
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

// Localnet links go to the Solana Explorer, which reads the custom RPC URL from the link.
const cluster =
  NETWORK === "localnet" ? `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}` : NETWORK === "devnet" ? "?cluster=devnet" : "";

export function explorerTx(sig: string) {
  return NETWORK === "localnet" ? `https://explorer.solana.com/tx/${sig}${cluster}` : `https://solscan.io/tx/${sig}${cluster}`;
}

export function explorerAccount(address: string) {
  return NETWORK === "localnet" ? `https://explorer.solana.com/address/${address}${cluster}` : `https://solscan.io/account/${address}${cluster}`;
}
