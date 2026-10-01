import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildBuyTx,
  buildMakerClaimTx,
  buildMakerWithdrawTx,
  buildRedeemTx,
  buildResaleSwapTx,
  buildSellBackTx,
  formatRawAmount,
  getCampaign,
  resolveReferral,
  slippageBps,
  summarizeBuyQuote,
  summarizeSellQuote,
  toVoucherRaw,
  VOUCHER_DECIMALS,
  type BuyQuote,
  type SellQuote,
} from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, publicKey, serialize } from "@/lib/server";

type Body = {
  kind: "buy" | "sell" | "redeem" | "withdraw" | "claim" | "resaleBuy" | "resaleSell";
  pool: string;
  wallet: string;
  usdc?: number;
  vouchers?: number; // sell / resaleSell; sell defaults to the whole balance
  ref?: string;
  slippageBps?: number; // 10–500, default 100
};

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
    const bps = slippageBps(body.slippageBps);

    let tx;
    let quote: BuyQuote | SellQuote | undefined; // what the curve swap was built from, for the UI
    if (body.kind === "buy") {
      if (!(body.usdc && body.usdc > 0)) throw new BadRequest("Enter an amount");
      // A bad, self or unusable referral is dropped silently: it must never block the buy.
      const referral = await resolveReferral(conn, new PublicKey(record.usdcMint), body.ref, wallet);
      const built = await buildBuyTx(conn, wallet, pool, body.usdc, { referral, slippageBps: bps });
      tx = built.tx;
      quote = summarizeBuyQuote(built.quote, bps);
    } else if (body.kind === "sell") {
      const account = await getAccount(conn, getAssociatedTokenAddressSync(baseMint, wallet)).catch(() => null);
      if (!account || account.amount === BigInt(0)) throw new BadRequest("You hold no vouchers for this campaign");
      const held = new BN(account.amount.toString());
      if (body.vouchers !== undefined && !(Number(body.vouchers) > 0)) throw new BadRequest("Enter an amount");
      // Checked in UI units before converting, so an absurd amount is this 400, not a conversion error.
      const heldUnits = formatRawAmount(account.amount, VOUCHER_DECIMALS);
      if (Number(body.vouchers) > Number(heldUnits)) throw new BadRequest(`You hold ${heldUnits} vouchers`);
      const amount = body.vouchers === undefined ? held : toVoucherRaw(Number(body.vouchers));
      if (amount.gt(held)) throw new BadRequest(`You hold ${heldUnits} vouchers`);
      const built = await buildSellBackTx(conn, wallet, pool, amount, { slippageBps: bps });
      tx = built.tx;
      quote = summarizeSellQuote(built.quote, bps);
    } else if (body.kind === "redeem") {
      tx = buildRedeemTx(wallet, baseMint);
    } else if (body.kind === "withdraw") {
      if (wallet.toBase58() !== record.maker) throw new BadRequest("Only the maker can withdraw the budget");
      tx = await buildMakerWithdrawTx(conn, wallet, pool);
    } else if (body.kind === "claim") {
      if (wallet.toBase58() !== record.maker) throw new BadRequest("Only the maker can claim maker fees");
      tx = await buildMakerClaimTx(conn, record);
      if (!tx) throw new BadRequest("Nothing to claim yet");
    } else if (body.kind === "resaleBuy") {
      if (!(body.usdc && body.usdc > 0)) throw new BadRequest("Enter an amount");
      tx = await buildResaleSwapTx(conn, record, wallet, "buy", body.usdc, bps);
    } else if (body.kind === "resaleSell") {
      if (!(body.vouchers && body.vouchers > 0)) throw new BadRequest("Enter an amount");
      tx = await buildResaleSwapTx(conn, record, wallet, "sell", body.vouchers, bps);
    } else {
      throw new BadRequest("Unknown transaction kind");
    }
    return Response.json({ ...serialize(await finalizeForWallet(tx, wallet)), ...(quote && { quote }) });
  } catch (e) {
    return errorResponse(e);
  }
}
