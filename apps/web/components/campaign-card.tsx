"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ChangePill, Sparkline, useTrades } from "@/components/sparkline";
import { imageSrc } from "@/lib/image-src";
import { usd, unitsShort } from "@/lib/format";
import type { CampaignWithLive } from "@/lib/types";

const STATUS_LABEL = { funding: "Funding", funded: "Goal reached", reselling: "Reselling" } as const;

export function CampaignCard({ c }: { c: CampaignWithLive }) {
  const live = c.live;
  const unitsTotal = c.campaign.plan.tiers.reduce((a, t) => a + t.units, 0);
  const { data } = useTrades(c.pool);
  const trades = data?.trades ?? [];
  const prices = live ? [...trades.slice(-30).map((t) => t.price), live.priceUsdc] : [];
  const loading = !data || data.warming;
  const backers = new Set(trades.filter((t) => t.side === "buy").map((t) => t.wallet)).size;
  return (
    <Link
      href={`/c/${c.pool}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:-translate-y-0.5 hover:ring-brand-gradient hover:shadow-[0_24px_60px_-30px_rgba(110,69,255,0.55)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="relative aspect-[16/9] overflow-hidden bg-muted bg-[radial-gradient(80%_90%_at_20%_0%,rgba(110,69,255,0.22),transparent_60%),radial-gradient(70%_80%_at_100%_100%,rgba(245,75,0,0.16),transparent_60%)]">
        {c.campaign.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- maker-supplied URLs on arbitrary hosts
          <img src={imageSrc(c.campaign.image)} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        ) : (
          <div className="flex h-full items-center justify-center font-heading text-5xl tracking-[-0.04em] text-foreground/85">{c.campaign.symbol}</div>
        )}
        <Badge variant={live?.status === "funding" ? "secondary" : "default"} className="absolute top-3 left-3 backdrop-blur">
          {live ? STATUS_LABEL[live.status] : "—"}
        </Badge>
      </div>
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <h3 className="font-heading text-xl leading-tight">{c.campaign.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{c.campaign.makerName ? `by ${c.campaign.makerName} · ` : ""}Maker trust level {c.trust.tier}</p>
        </div>
        {live ? (
          <>
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Price now</p>
                <p className="mt-0.5 flex items-center gap-2">
                  <span className="font-mono text-2xl tracking-tight tabular-nums">{usd(live.priceUsdc)}</span>
                  <ChangePill from={trades[0]?.price} to={live.priceUsdc} />
                </p>
              </div>
              {loading ? <div className="h-10 w-28 animate-pulse rounded-md bg-muted motion-reduce:animate-none" aria-hidden="true" /> : <Sparkline prices={prices} />}
            </div>
            <div>
              <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
                <span>
                  <span className="font-mono text-foreground tabular-nums">{usd(live.raisedUsdc, 0)}</span> of {usd(live.goalUsdc, 0)}
                </span>
                <span className="font-mono tabular-nums">{Math.round(live.progress * 100)}%</span>
              </div>
              <Progress value={Math.min(100, live.progress * 100)} aria-label={`${Math.round(live.progress * 100)}% funded`} />
            </div>
            <dl className="mt-auto grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Sold</dt>
                <dd className="font-mono text-sm tabular-nums">{unitsShort(live.unitsSold)} / {unitsTotal}</dd>
              </div>
              <div className="text-right">
                <dt className="text-muted-foreground">Backers</dt>
                <dd className="font-mono text-sm tabular-nums">{loading ? "…" : backers}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Live data unavailable right now.</p>
        )}
      </div>
    </Link>
  );
}
