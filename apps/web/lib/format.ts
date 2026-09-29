export const NETWORK = process.env.NEXT_PUBLIC_NETWORK ?? "devnet";

export function usd(n: number, digits = 2) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function units(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 1 });
}

export function short(address: string, chars = 4) {
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

export function explorerTx(sig: string) {
  return `https://solscan.io/tx/${sig}${NETWORK === "devnet" ? "?cluster=devnet" : ""}`;
}

export function explorerAccount(address: string) {
  return `https://solscan.io/account/${address}${NETWORK === "devnet" ? "?cluster=devnet" : ""}`;
}
