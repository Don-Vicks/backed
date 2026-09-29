import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildBuyTx, buildMakerWithdrawTx, buildRedeemTx, buildSellBackTx, getCampaign } from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, publicKey, serialize } from "@/lib/server";

type Body = { kind: "buy" | "sell" | "redeem" | "withdraw"; pool: string; wallet: string; usdc?: number; ref?: string };

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
    if (body.kind === "buy") {
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
      if (wallet.toBase58() !== record.maker) throw new BadRequest("Only the maker can withdraw the budget");
      tx = await buildMakerWithdrawTx(conn, wallet, pool);
    } else {
      throw new BadRequest("Unknown transaction kind");
    }
    return Response.json(serialize(await finalizeForWallet(tx, wallet)));
  } catch (e) {
    return errorResponse(e);
  }
}
