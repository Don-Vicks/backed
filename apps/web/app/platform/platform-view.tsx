"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client";
import { explorerAccount, short, usd } from "@/lib/format";
import type { PlatformResponse } from "@/lib/types";

const vouchers = (n: number) => n.toFixed(6).replace(/\.?0+$/, "");

// Read-only. The claims are signed by the fee claimer, so they run from the ops script, not from here.
export function PlatformView() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["platform"],
    queryFn: () => api<PlatformResponse>("/api/platform"),
    refetchInterval: 30_000,
  });

  if (isPending) return <Skeleton className="h-80 rounded-xl" aria-busy="true" aria-label="Loading earnings" />;
  if (isError) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="font-medium">Couldn’t load the platform’s earnings</p>
        <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
        <Button className="mt-4" variant="secondary" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  const t = data.totals;
  const stats = [
    { label: "Curve fees, unclaimed", value: usd(t.curveFeesUnclaimedUsdc, 3), note: `${usd(t.curveFeesClaimedUsdc, 3)} claimed` },
    { label: "Resale fees, unclaimed", value: usd(t.resaleFeesUnclaimedUsdc, 3), note: "from the platform’s resale positions" },
    { label: "Locked resale liquidity", value: usd(t.resaleLiquidityUsdc), note: `+ ${vouchers(t.resaleLiquidityVouchers)} vouchers, never withdrawable` },
    { label: "Leftover vouchers", value: vouchers(t.leftoverVouchers), note: t.surplusUsdc > 0 ? `surplus ${usd(t.surplusUsdc, 3)}` : "burned when claimed" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-card p-5">
            <dt className="text-sm text-muted-foreground">{s.label}</dt>
            <dd className="mt-1 font-mono text-3xl tabular-nums">{s.value}</dd>
            <dd className="mt-1 text-xs text-muted-foreground">{s.note}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="claimer-title" className="rounded-xl border border-border bg-card p-5 text-sm">
        <h2 id="claimer-title" className="font-heading text-2xl">Fee claimer</h2>
        {data.feeClaimer ? (
          <p className="mt-2 text-muted-foreground">
            New campaigns name{" "}
            <a href={explorerAccount(data.feeClaimer)} target="_blank" rel="noopener noreferrer" className="font-mono text-foreground underline-offset-4 hover:underline">
              {short(data.feeClaimer)}
            </a>{" "}
            in their config as partner fee claimer and leftover receiver. Claimed USDC goes to{" "}
            {data.treasury ? <span className="font-mono text-foreground">{short(data.treasury)}</span> : "the fee claimer"}.
            {data.listing ? (
              <> Its on-chain partner listing reads “{data.listing.name}”.</>
            ) : (
              " It has no on-chain partner listing yet."
            )}
          </p>
        ) : (
          <p className="mt-2 text-muted-foreground">No fee claimer is configured on this server. Each campaign below shows the one in its own config.</p>
        )}
        <p className="mt-2 text-muted-foreground">
          Claims run from <code className="font-mono text-foreground">pnpm --filter @preorder/core platform:claim</code>, which signs with the claimer’s key
          or prints unsigned transactions for a multisig.
        </p>
      </section>

      <section aria-labelledby="campaigns-title">
        <h2 id="campaigns-title" className="font-heading text-2xl">By campaign</h2>
        {data.campaigns.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No campaigns yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Campaign</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Curve fees</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Resale fees</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Locked liquidity</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Leftover</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.campaigns.map((c) => (
                  <tr key={c.pool}>
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <Link href={`/c/${c.pool}`} className="font-medium underline-offset-4 hover:underline">{c.name}</Link>
                      <span className="ml-2 text-xs text-muted-foreground">{c.migrated ? "reselling" : "funding"}</span>
                      {c.resalePool && (
                        <a href={explorerAccount(c.resalePool)} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-xs text-primary underline-offset-4 hover:underline">
                          resale pool <ExternalLink aria-hidden="true" className="size-3" />
                        </a>
                      )}
                    </th>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {usd(c.curveFeesUnclaimedUsdc, 3)}
                      {c.curveFeesClaimedUsdc > 0 && <span className="block text-xs text-muted-foreground">{usd(c.curveFeesClaimedUsdc, 3)} claimed</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{usd(c.resaleFeesUnclaimedUsdc, 3)}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{c.migrated ? usd(c.resaleLiquidityUsdc) : "–"}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{vouchers(c.leftoverVouchers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.failed.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {data.failed.length} campaign{data.failed.length === 1 ? "" : "s"} could not be read from chain and {data.failed.length === 1 ? "is" : "are"} left out.
          </p>
        )}
      </section>
    </div>
  );
}
