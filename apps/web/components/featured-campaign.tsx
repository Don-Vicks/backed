"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { CurveChart } from "@/components/curve-chart";
import { imageSrc } from "@/lib/image-src";
import { api } from "@/lib/client";
import { unitsShort, usd } from "@/lib/format";
import type { CampaignWithLive } from "@/lib/types";

// Shares the campaign list's query, so the hero and the grid read one request.
export function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api<{ campaigns: CampaignWithLive[] }>("/api/campaigns"),
    refetchInterval: 10_000,
  });
}

// The hero's right side: the funding campaign furthest along, with its live price on the curve.
export function FeaturedCampaign() {
  const { data, isPending } = useCampaigns();
  if (isPending) return <Skeleton className="h-[26rem] rounded-2xl" />;
  const funding = (data?.campaigns ?? []).filter((c) => c.live?.status === "funding");
  const c = [...funding].sort((a, b) => (b.live?.progress ?? 0) - (a.live?.progress ?? 0))[0];
  if (!c?.live) return null;
  const live = c.live;
  const unitsTotal = c.campaign.plan.tiers.reduce((a, t) => a + t.units, 0);
  return (
    <Link
      href={`/c/${c.pool}`}
      className="group block rounded-2xl ring-brand-gradient bg-card/80 p-5 shadow-[0_40px_120px_-40px_rgba(110,69,255,0.55)] backdrop-blur transition-transform duration-300 hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="flex items-center gap-4">
        <div className="size-16 shrink-0 overflow-hidden rounded-xl bg-muted">
          {c.campaign.image && (
            // eslint-disable-next-line @next/next/no-img-element -- maker-supplied URLs on arbitrary hosts
            <img src={imageSrc(c.campaign.image)} alt="" className="h-full w-full object-cover" />
          )}
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="relative flex size-2" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/70 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2 rounded-full bg-success" />
            </span>
            Live now{c.campaign.makerName ? ` · by ${c.campaign.makerName}` : ""}
          </p>
          <h2 className="truncate font-heading text-2xl">{c.campaign.name}</h2>
        </div>
      </div>
      <div className="mt-4">
        <CurveChart plan={c.campaign.plan} unitsSold={live.unitsSold} />
      </div>
      <Progress className="mt-2" value={Math.min(100, live.progress * 100)} aria-label={`${Math.round(live.progress * 100)}% funded`} />
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Price now</dt>
          <dd className="font-mono tabular-nums">{usd(live.priceUsdc)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Raised</dt>
          <dd className="font-mono tabular-nums">{usd(live.raisedUsdc, 0)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Sold</dt>
          <dd className="font-mono tabular-nums">{unitsShort(live.unitsSold)} / {unitsTotal}</dd>
        </div>
      </dl>
      <p className="mt-4 flex items-center justify-between rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground">
        Back it at {usd(live.priceUsdc)}
        <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
      </p>
    </Link>
  );
}

// Totals across live campaigns, for the strip under the hero.
export function CampaignTotals() {
  const { data } = useCampaigns();
  const list = data?.campaigns ?? [];
  if (list.length === 0) return null;
  const raised = list.reduce((a, c) => a + (c.live?.raisedUsdc ?? 0), 0);
  const sold = list.reduce((a, c) => a + (c.live?.unitsSold ?? 0), 0);
  const stats = [
    [usd(raised, 0), "raised"],
    [String(list.length), list.length === 1 ? "campaign" : "campaigns"],
    [unitsShort(sold), "pre-orders"],
  ];
  return (
    <dl className="mt-10 flex flex-wrap gap-x-8 gap-y-3">
      {stats.map(([value, label]) => (
        <div key={label} className="flex flex-row-reverse items-baseline justify-end gap-2">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="font-mono text-2xl tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
