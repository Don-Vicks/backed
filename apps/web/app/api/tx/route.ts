import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildBuyTx,
  buildBuyUnitsTx,
  buildMakerClaimTx,
  buildMakerUnlockTx,
  buildMakerWithdrawTx,
  buildRedeemTx,
  buildResaleSwapTx,
  buildSellBackTx,
  buildTopUpTx,
  getCampaign,
  onChainCreator,
  unitsReferral,
  UnitsError,
  type UnitsQuote,
} from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, publicKey, serialize } from "@/lib/server";

type Body = {
  kind: "buy" | "buyUnits" | "sell" | "redeem" | "withdraw" | "claim" | "unlock" | "resaleBuy" | "resaleSell";
  pool: string;
  wallet: string;
  usdc?: number;
  vouchers?: number;
  units?: number; // buyUnits: whole pre-order units
  topUp?: boolean; // buyUnits: instead of units, the rest of the next whole voucher
  slippageBps?: number; // buyUnits: 10–500, default 100
  ref?: string;
};

// The maker is whoever the DBC pool records as creator on chain, not what our store says.
async function isMaker(conn: Connection, pool: PublicKey, wallet: PublicKey) {
  return (await onChainCreator(conn, pool)).equals(wallet);
}

// Unsigned transactions for the connected wallet to sign and send.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const wallet = publicKey(body.wallet);
    const record = getCampaign(body.pool);
    if (!record) throw new BadRequest("Unknown campaign");
    const conn = connection();
    const pool = new PublicKey(record.pool);
    const baseMint = new PublicKey(record.baseMint);

    let tx;
    let quote: UnitsQuote | undefined; // what a units buy was built from, for the UI
    if (body.kind === "buyUnits") {
      // A bad, self or unusable referral is dropped: it must never block the buy.
      const referral = await unitsReferral(conn, new PublicKey(record.usdcMint), body.ref, wallet);
      const opts = { referral, slippageBps: body.slippageBps };
      const built = body.topUp ? await buildTopUpTx(conn, wallet, pool, baseMint, opts) : await buildBuyUnitsTx(conn, wallet, pool, body.units as number, opts);
      tx = built.tx;
      quote = built.quote;
    } else if (body.kind === "buy") {
      if (!(body.usdc && body.usdc > 0)) throw new BadRequest("Enter an amount");
      const referral = body.ref ? getAssociatedTokenAddressSync(new PublicKey(record.usdcMint), publicKey(body.ref, "ref"), true) : null;
      tx = await buildBuyTx(conn, wallet, pool, body.usdc, referral);
    } else if (body.kind === "sell") {
      const account = await getAccount(conn, getAssociatedTokenAddressSync(baseMint, wallet)).catch(() => null);
      if (!account || account.amount === BigInt(0)) throw new BadRequest("You hold no vouchers for this campaign");
      tx = await buildSellBackTx(conn, wallet, pool, new BN(account.amount.toString()));
    } else if (body.kind === "redeem") {
      tx = buildRedeemTx(wallet, baseMint);
    } else if (body.kind === "withdraw") {
      if (!(await isMaker(conn, pool, wallet))) throw new BadRequest("Only the maker can withdraw the budget");
      tx = await buildMakerWithdrawTx(conn, wallet, pool);
    } else if (body.kind === "claim") {
      if (!(await isMaker(conn, pool, wallet))) throw new BadRequest("Only the maker can claim maker fees");
      tx = await buildMakerClaimTx(conn, { ...record, maker: wallet.toBase58() });
      if (!tx) throw new BadRequest("Nothing to claim yet");
    } else if (body.kind === "unlock") {
      if (!(await isMaker(conn, pool, wallet))) throw new BadRequest("Only the maker can unlock production funds");
      const built = await buildMakerUnlockTx(conn, record, wallet);
      if (!built) throw new BadRequest("Nothing to unlock yet");
      tx = built.tx;
    } else if (body.kind === "resaleBuy") {
      if (!(body.usdc && body.usdc > 0)) throw new BadRequest("Enter an amount");
      tx = await buildResaleSwapTx(conn, record, wallet, "buy", body.usdc);
    } else if (body.kind === "resaleSell") {
      if (!(body.vouchers && body.vouchers > 0)) throw new BadRequest("Enter an amount");
      tx = await buildResaleSwapTx(conn, record, wallet, "sell", body.vouchers);
    } else {
      throw new BadRequest("Unknown transaction kind");
    }
    return Response.json({ ...serialize(await finalizeForWallet(tx, wallet)), ...(quote && { quote }) });
  } catch (e) {
    if (e instanceof UnitsError) return Response.json({ error: e.message }, { status: e.status });
    return errorResponse(e);
  }
}
