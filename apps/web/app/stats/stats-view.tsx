"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client";
import { units, usd } from "@/lib/format";
import type { CampaignWithLive } from "@/lib/types";

// Totals across campaigns from the same live reads the home page uses (cached a few seconds per pool).
export function StatsView() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api<{ campaigns: CampaignWithLive[] }>("/api/campaigns"),
    refetchInterval: 15_000,
  });

  if (isPending) return <Skeleton className="h-64 rounded-xl" aria-label="Loading stats" />;
  if (isError && !data) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="font-medium">Couldn’t load stats</p>
        <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
        <Button variant="secondary" className="mt-4" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  const campaigns = data.campaigns;
  const live = campaigns.map((c) => c.live).filter((l) => l !== null);
  const graduated = live.filter((l) => l.status === "reselling").length;
  const funding = live.filter((l) => l.status === "funding").length;
  const raised = live.reduce((a, l) => a + (l.status === "funding" ? l.raisedUsdc : l.goalUsdc), 0);
  const sold = live.reduce((a, l) => a + l.unitsSold, 0);
  const unread = campaigns.length - live.length;

  return (
    <div className="flex flex-col gap-8">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Campaigns launched" value={String(campaigns.length)} />
        <Stat label="Funded and reselling" value={String(graduated)} detail={`${funding} still funding`} />
        <Stat label="Raised so far" value={usd(raised)} detail="USDC, including funded campaigns" />
        <Stat label="Pre-order units sold" value={units(sold)} />
      </dl>
      {unread > 0 && <p className="text-sm text-muted-foreground">{unread} campaign{unread === 1 ? "" : "s"} couldn’t be read from chain just now and {unread === 1 ? "is" : "are"} left out.</p>}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Campaign</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Raised</th>
              <th className="px-4 py-3 text-right font-medium">Units sold</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {campaigns.map((c) => (
              <tr key={c.pool}>
                <td className="px-4 py-3">
                  <Link href={`/c/${c.pool}`} className="underline-offset-4 hover:underline">{c.campaign.name}</Link>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{c.live ? { funding: "Funding", funded: "Goal reached", reselling: "Reselling" }[c.live.status] : "–"}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">{c.live ? usd(c.live.status === "funding" ? c.live.raisedUsdc : c.live.goalUsdc) : "–"}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">{c.live ? `${units(c.live.unitsSold)} / ${c.campaign.plan.tiers.reduce((a, t) => a + t.units, 0)}` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-3xl tabular-nums">{value}</dd>
      {detail && <dd className="mt-1 text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}
