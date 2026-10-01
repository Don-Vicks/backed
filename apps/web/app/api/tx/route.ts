import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildBuyTx,
  buildMakerClaimTx,
  buildMakerWithdrawTx,
  buildResaleSwapTx,
  buildSellBackTx,
  DEFAULT_SLIPPAGE_BPS,
  formatRawAmount,
  getCampaign,
  HttpError,
  resolveReferral,
  schemas,
  summarizeBuyQuote,
  summarizeSellQuote,
  toVoucherRaw,
  VOUCHER_DECIMALS,
  type BuyQuote,
  type CampaignStatus,
  type SellQuote,
} from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, rateLimit, readJson, requestLog, requireStatus, serialize } from "@/lib/server";

// The campaign status each kind needs, and what to say otherwise (409). The program would reject these
// anyway, but only after the wallet prompt and a failed transaction.
const NEEDS: Partial<Record<string, [CampaignStatus, string]>> = {
  buy: ["funding", "This campaign has reached its goal"],
  sell: ["funding", "Exits close once the goal is reached"],
  withdraw: ["reselling", "The production budget unlocks when the campaign graduates"],
  resaleBuy: ["reselling", "The resale market opens after graduation"],
  resaleSell: ["reselling", "The resale market opens after graduation"],
};

// Unsigned transactions for the connected wallet to sign and send.
export async function POST(req: Request) {
  const log = requestLog("POST /api/tx");
  try {
    rateLimit(req, "tx");
    const body = await readJson(req, schemas.tx);
    const wallet = body.wallet;
    log.wallet = wallet.toBase58();
    const record = getCampaign(body.pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    const need = NEEDS[body.kind];
    if (need) await requireStatus(record, log, need[0], need[1]);
    const conn = connection();
    const pool = new PublicKey(record.pool);
    const baseMint = new PublicKey(record.baseMint);
    const bps = body.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

    let tx;
    let quote: BuyQuote | SellQuote | undefined; // what the curve swap was built from, for the UI
    if (body.kind === "buy") {
      if (!body.usdc) throw new BadRequest("Enter an amount");
      // A bad, self or unusable referral is dropped silently: it must never block the buy.
      const referral = await resolveReferral(conn, new PublicKey(record.usdcMint), body.ref, wallet);
      const built = await buildBuyTx(conn, wallet, pool, body.usdc, { referral, slippageBps: bps });
      tx = built.tx;
      quote = summarizeBuyQuote(built.quote, bps);
    } else if (body.kind === "sell") {
      const account = await getAccount(conn, getAssociatedTokenAddressSync(baseMint, wallet)).catch(() => null);
      if (!account || account.amount === BigInt(0)) throw new BadRequest("You hold no vouchers for this campaign");
      const held = new BN(account.amount.toString());
      // Checked in UI units before converting, so an absurd amount is this 400, not a conversion error.
      const heldUnits = formatRawAmount(account.amount, VOUCHER_DECIMALS);
      if (Number(body.vouchers) > Number(heldUnits)) throw new BadRequest(`You hold ${heldUnits} vouchers`);
      const amount = body.vouchers === undefined ? held : toVoucherRaw(Number(body.vouchers));
      if (amount.gt(held)) throw new BadRequest(`You hold ${heldUnits} vouchers`);
      const built = await buildSellBackTx(conn, wallet, pool, amount, { slippageBps: bps });
      tx = built.tx;
      quote = summarizeSellQuote(built.quote, bps);
    } else if (body.kind === "redeem") {
      // A burn with no shipping details bound to it could never be claimed; redeeming starts there.
      throw new BadRequest("Redeem through the shipping form (POST /api/redemptions/prepare)");
    } else if (body.kind === "withdraw") {
      if (wallet.toBase58() !== record.maker) throw new BadRequest("Only the maker can withdraw the budget");
      tx = await buildMakerWithdrawTx(conn, wallet, pool);
    } else if (body.kind === "claim") {
      if (wallet.toBase58() !== record.maker) throw new BadRequest("Only the maker can claim maker fees");
      tx = await buildMakerClaimTx(conn, record);
      if (!tx) throw new BadRequest("Nothing to claim yet");
    } else if (body.kind === "resaleBuy") {
      if (!body.usdc) throw new BadRequest("Enter an amount");
      tx = await buildResaleSwapTx(conn, record, wallet, "buy", body.usdc, bps);
    } else if (body.kind === "resaleSell") {
      if (!body.vouchers) throw new BadRequest("Enter an amount");
      tx = await buildResaleSwapTx(conn, record, wallet, "sell", body.vouchers, bps);
    } else {
      throw new BadRequest("Unknown transaction kind");
    }
    return Response.json({ ...serialize(await finalizeForWallet(tx, wallet)), ...(quote && { quote }) });
  } catch (e) {
    return errorResponse(e, log);
  }
}
