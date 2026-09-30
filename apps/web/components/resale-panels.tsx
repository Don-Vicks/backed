"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client";
import { useDebounced } from "@/lib/use-debounced";
import { units, usd } from "@/lib/format";
import type { CampaignWithLive } from "@/lib/types";

type MakerEarnings = {
  curveFeesUnclaimedUsdc: number;
  curveFeesClaimedUsdc: number;
  resaleFeesUnclaimedUsdc: number;
  resaleFeesUnclaimedVouchers: number;
  positions: number;
};
type ResaleView = { pool: string; priceUsdc: number; vouchersInPool: number; usdcInPool: number; maker: MakerEarnings };
type ResaleQuote = { out: number; minOut: number; feeUsdcEquivalent: number; priceImpactPct: number };

export type RunTx = (kind: "resaleBuy" | "resaleSell" | "claim" | "withdraw", label: string, extra?: Record<string, unknown>) => Promise<void>;

export function useResale(c: CampaignWithLive, enabled: boolean) {
  return useQuery({
    queryKey: ["resale", c.pool],
    queryFn: () => api<{ resale: ResaleView | null; maker: MakerEarnings }>(`/api/campaigns/${c.pool}/resale`),
    enabled,
    refetchInterval: 8_000,
  });
}

export function ResalePanel({ c, run, busy, vouchers }: { c: CampaignWithLive; run: RunTx; busy: string | null; vouchers: number }) {
  const resale = useResale(c, true);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("5");
  const value = Number(amount);
  const debounced = useDebounced(value, 350);
  const quote = useQuery({
    queryKey: ["resale-quote", c.pool, side, debounced, resale.data?.resale?.priceUsdc],
    queryFn: () => api<ResaleQuote>("/api/resale/quote", { pool: c.pool, side, amount: debounced }),
    enabled: debounced > 0,
  });
  const view = resale.data?.resale;
  const lastPreorderPrice = c.campaign.plan.finalPrice;

  if (resale.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (!view) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        The resale market is opening. This usually takes a few seconds after graduation.
      </div>
    );
  }

  const change = ((view.priceUsdc - lastPreorderPrice) / lastPreorderPrice) * 100;
  const notEnough = side === "sell" && value > vouchers;

  return (
    <form
      className="rounded-xl border border-border bg-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        run(side === "buy" ? "resaleBuy" : "resaleSell", side === "buy" ? "Buy on resale" : "Sell on resale", side === "buy" ? { usdc: value } : { vouchers: value });
      }}
    >
      <div className="flex items-baseline justify-between">
        <p className="font-heading text-2xl">Resale market</p>
        <p className="font-mono text-2xl tabular-nums">{usd(view.priceUsdc)}</p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        <span className={`font-mono ${change >= 0 ? "text-primary" : ""}`}>{change >= 0 ? "+" : ""}{change.toFixed(1)}%</span> vs the last pre-order price of {usd(lastPreorderPrice)}. The maker earns on every trade.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            onClick={() => {
              setSide(s);
              setAmount(s === "buy" ? "5" : String(Math.min(1, Math.floor(vouchers * 100) / 100) || "0.5"));
            }}
            className={`min-h-9 rounded-md text-sm font-medium capitalize transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${side === s ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {s}
          </button>
        ))}
      </div>

      <Label htmlFor="resale-amount" className="mt-4 block">{side === "buy" ? "Spend (USDC)" : "Sell (vouchers)"}</Label>
      <div className="mt-2 flex gap-2">
        <Input id="resale-amount" type="number" inputMode="decimal" min={0.000001} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" />
        <Button type="submit" disabled={!!busy || !(value > 0) || notEnough}>
          {busy === "resaleBuy" || busy === "resaleSell" ? "Sending…" : side === "buy" ? "Buy" : "Sell"}
        </Button>
      </div>
      <p className="mt-2 min-h-5 text-sm text-muted-foreground" aria-live="polite">
        {notEnough ? (
          <span className="text-destructive">You hold {units(vouchers)} vouchers.</span>
        ) : quote.data ? (
          <>
            ≈ <span className="font-mono text-foreground">{side === "buy" ? `${units(quote.data.out)} vouchers` : usd(quote.data.out)}</span>
            {quote.data.priceImpactPct > 2 && <> · price impact <span className="font-mono">{quote.data.priceImpactPct.toFixed(1)}%</span></>}
          </>
        ) : null}
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        Pool: <span className="font-mono">{units(view.vouchersInPool)}</span> vouchers · <span className="font-mono">{usd(view.usdcInPool)}</span>. Liquidity is locked forever.
      </p>
    </form>
  );
}

export function MakerPanel({ c, run, busy }: { c: CampaignWithLive; run: RunTx; busy: string | null }) {
  const live = c.live!;
  const resale = useResale(c, true);
  const maker = resale.data?.maker;
  const claimable = maker ? maker.curveFeesUnclaimedUsdc + maker.resaleFeesUnclaimedUsdc : 0;
  const claimableVouchers = maker?.resaleFeesUnclaimedVouchers ?? 0;
  const budget = (live.goalUsdc * c.campaign.plan.makerSharePct) / 100;

  return (
    <div className="rounded-xl border border-primary/40 bg-card p-5">
      <p className="flex items-center gap-2 font-heading text-2xl">
        <Coins aria-hidden="true" className="size-5 text-primary" /> Your earnings
      </p>
      <dl className="mt-4 grid gap-3 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">Production budget ({c.campaign.plan.makerSharePct}%)</dt>
          <dd className="font-mono tabular-nums">{usd(budget)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">Curve trading fees</dt>
          <dd className="font-mono tabular-nums">{maker ? usd(maker.curveFeesUnclaimedUsdc + maker.curveFeesClaimedUsdc, 3) : "…"}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">Resale royalties, unclaimed</dt>
          <dd className="font-mono tabular-nums">{maker ? usd(maker.resaleFeesUnclaimedUsdc, 3) : "…"}</dd>
        </div>
      </dl>
      <div className="mt-4 grid gap-2">
        {live.status === "reselling" &&
          (live.makerBudgetWithdrawn ? (
            <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">Production budget withdrawn.</p>
          ) : (
            <Button onClick={() => run("withdraw", "Withdraw production budget")} disabled={!!busy}>
              {busy === "withdraw" ? "Withdrawing…" : `Withdraw ${usd(budget)} budget`}
            </Button>
          ))}
        <Button variant="secondary" onClick={() => run("claim", "Claim fees")} disabled={!!busy || (claimable <= 0 && claimableVouchers <= 0)}>
          {busy === "claim" ? "Claiming…" : claimable > 0 ? `Claim ${usd(claimable, 3)} in fees` : "No fees to claim yet"}
        </Button>
      </div>
      {live.status === "funding" && <p className="mt-2 text-xs text-muted-foreground">Your budget unlocks when the goal is reached.</p>}
    </div>
  );
}
