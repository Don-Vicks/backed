import "server-only";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  getConnection,
  getMetadata,
  getNetwork,
  readTrustSignals,
  resolvePublicOrigin,
  scoreSignals,
  SwapError,
  trustFixture,
  trustRpcUrl,
  type TrustResult,
} from "@preorder/core";

export const connection = (): Connection => getConnection();

// Origin for URLs that leave the app (token metadata, Blink icons). Throws a ConfigError when
// PUBLIC_BASE_URL is missing or not public https off localnet, so nothing immutable gets a bad URL.
export const publicOrigin = (req?: Request) => resolvePublicOrigin(process.env, getNetwork().name, req?.url);

export function metadataResponse(id: string) {
  const meta = getMetadata(id);
  if (!meta) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(meta, { headers: { "Cache-Control": "public, max-age=300" } });
}

// Trust lookups walk mainnet history; cache them for 10 minutes per wallet.
const trustCache = new Map<string, { at: number; result: TrustResult }>();
export async function trustFor(wallet: string, verifiedSocial = false): Promise<TrustResult> {
  const key = `${wallet}:${verifiedSocial}`;
  const hit = trustCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.result;
  const fixture = trustFixture(wallet);
  const signals = fixture
    ? { ...fixture, verifiedSocial: fixture.verifiedSocial || verifiedSocial }
    : await readTrustSignals(new Connection(trustRpcUrl(), "confirmed"), new PublicKey(wallet), { verifiedSocial });
  const result = scoreSignals(signals);
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
  const status = e instanceof BadRequest ? 400 : e instanceof SwapError ? e.status : 500;
  if (status === 500) console.error(e);
  return Response.json({ error: message }, { status });
}
