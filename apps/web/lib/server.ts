import "server-only";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getConnection, scoreSignals, readTrustSignals, type TrustResult } from "@preorder/core";

export const connection = (): Connection => getConnection();

const mainnet = () =>
  new Connection(process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

// Trust lookups walk mainnet history; cache them for 10 minutes per wallet.
const trustCache = new Map<string, { at: number; result: TrustResult }>();
export async function trustFor(wallet: string, verifiedSocial = false): Promise<TrustResult> {
  const key = `${wallet}:${verifiedSocial}`;
  const hit = trustCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.result;
  const result = scoreSignals(await readTrustSignals(mainnet(), new PublicKey(wallet), { verifiedSocial }));
  trustCache.set(key, { at: Date.now(), result });
  return result;
}

export async function finalizeForWallet(tx: Transaction, feePayer: PublicKey) {
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayer;
  return tx;
}

// Transaction.from() on the client does not restore lastValidBlockHeight, so it travels alongside.
export const serialize = (tx: Transaction) => ({
  tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
  lastValidBlockHeight: tx.lastValidBlockHeight!,
});

export function publicKey(value: unknown, name = "wallet"): PublicKey {
  try {
    return new PublicKey(String(value));
  } catch {
    throw new BadRequest(`${name} is not a valid Solana address`);
  }
}

export class BadRequest extends Error {}

export function errorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const status = e instanceof BadRequest ? 400 : 500;
  if (status === 500) console.error(e);
  return Response.json({ error: message }, { status });
}
