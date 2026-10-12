"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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

// The hero's right side: every live campaign in turn (furthest along first), with its live price on the
// curve. It moves on every few seconds, pauses while pointed at or focused, and never moves with reduced motion.
export function FeaturedCampaign() {
  const { data, isPending } = useCampaigns();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const list = useMemo(() => {
    const all = data?.campaigns.filter((c) => c.live) ?? [];
    const funding = all.filter((c) => c.live!.status === "funding");
    return (funding.length ? funding : all).sort((a, b) => b.live!.progress - a.live!.progress);
  }, [data]);
  const count = list.length;
  useEffect(() => {
    if (paused || count < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % count), 6000);
    return () => clearInterval(id);
  }, [paused, count]);

  if (isPending) return <Skeleton className="h-[30rem] rounded-2xl" />;
  if (count === 0) return null;
  const c = list[index % count];
  const live = c.live!;
  const unitsTotal = c.campaign.plan.tiers.reduce((a, t) => a + t.units, 0);
  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <Link
        key={c.pool}
        href={`/c/${c.pool}`}
        aria-label={`${c.campaign.name}: back it at ${usd(live.priceUsdc)}`}
        className="group block animate-in fade-in duration-500 rounded-2xl ring-brand-gradient bg-card/80 p-5 shadow-[0_40px_120px_-40px_rgba(110,69,255,0.55)] backdrop-blur transition-transform hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:animate-none"
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
              {live.status === "funding" ? "Funding now" : "Reselling"}{c.campaign.makerName ? ` · by ${c.campaign.makerName}` : ""}
            </p>
            <h2 className="truncate font-heading text-2xl">{c.campaign.name}</h2>
          </div>
        </div>
        <div className="mt-4">
          <CurveChart plan={c.campaign.plan} unitsSold={live.unitsSold} graduated={live.status !== "funding"} />
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
      {count > 1 && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Featured campaign">
          {list.map((x, i) => {
            const active = i === index % count;
            return (
              <button
                key={x.pool}
                type="button"
                onClick={() => setIndex(i)}
                aria-pressed={active}
                className={`relative flex min-w-0 shrink-0 items-center gap-2 overflow-hidden rounded-lg border px-2 py-1.5 text-left text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${active ? "border-primary/60 bg-card text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                <span className="size-6 shrink-0 overflow-hidden rounded bg-muted">
                  {x.campaign.image && (
                    // eslint-disable-next-line @next/next/no-img-element -- maker-supplied URLs on arbitrary hosts
                    <img src={imageSrc(x.campaign.image)} alt="" className="h-full w-full object-cover" />
                  )}
                </span>
                <span className="max-w-32 truncate">{x.campaign.name}</span>
                <span className="font-mono">{usd(x.live!.priceUsdc)}</span>
                {/* How long until the next one, while it moves on its own. */}
                {active && !paused && <span key={index} aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brand-gradient [animation:featured-timer_6s_linear] motion-reduce:hidden" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
