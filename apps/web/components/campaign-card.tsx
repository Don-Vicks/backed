import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { imageSrc } from "@/lib/image-src";
import { usd, units } from "@/lib/format";
import type { CampaignWithLive } from "@/lib/types";

const STATUS_LABEL = { funding: "Funding", funded: "Goal reached", reselling: "Reselling" } as const;

export function CampaignCard({ c }: { c: CampaignWithLive }) {
  const live = c.live;
  const unitsTotal = c.campaign.plan.tiers.reduce((a, t) => a + t.units, 0);
  return (
    <Link
      href={`/c/${c.pool}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:-translate-y-0.5 hover:ring-brand-gradient hover:shadow-[0_24px_60px_-30px_rgba(110,69,255,0.55)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="aspect-[16/9] bg-muted bg-[radial-gradient(80%_90%_at_20%_0%,rgba(110,69,255,0.22),transparent_60%),radial-gradient(70%_80%_at_100%_100%,rgba(245,75,0,0.16),transparent_60%)]">
        {c.campaign.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- maker-supplied URLs on arbitrary hosts
          <img src={imageSrc(c.campaign.image)} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center font-heading text-5xl tracking-[-0.04em] text-foreground/85">{c.campaign.symbol}</div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-heading text-xl leading-tight">{c.campaign.name}</h3>
          <Badge variant={live?.status === "funding" ? "secondary" : "default"}>{live ? STATUS_LABEL[live.status] : "—"}</Badge>
        </div>
        {live ? (
          <>
            <Progress value={Math.min(100, live.progress * 100)} aria-label={`${Math.round(live.progress * 100)}% funded`} />
            <dl className="grid grid-cols-3 gap-2 text-sm">
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
                <dd className="font-mono tabular-nums">{units(live.unitsSold)} / {unitsTotal}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Live data unavailable right now.</p>
        )}
        <p className="mt-auto text-xs text-muted-foreground">{c.campaign.makerName ? `by ${c.campaign.makerName} · ` : ""}Maker trust level {c.trust.tier}</p>
      </div>
    </Link>
  );
}
