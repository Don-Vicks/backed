"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AreaSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle, createChart, type UTCTimestamp } from "lightweight-charts";
import { ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useTrades } from "@/components/sparkline";
import { explorerTx, short, unitsShort, usd } from "@/lib/format";
import type { CampaignWithLive, Trade } from "@/lib/types";

// Meteora night, as lightweight-charts wants it (it draws on canvas, so no CSS variables).
const C = { text: "#9595B2", grid: "rgba(35,35,58,0.55)", violet: "#8664FF", orange: "#F54B00", gold: "#F5BD00" };

const RANGES = [
  { label: "1H", sec: 3600 },
  { label: "24H", sec: 86_400 },
  { label: "7D", sec: 604_800 },
  { label: "All", sec: Infinity },
] as const;
type Range = (typeof RANGES)[number]["label"];

function ago(sec: number) {
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86_400)}d`;
}

// One point per trade, times nudged a second apart where two share one (the chart needs them strictly rising).
function points(trades: Trade[]) {
  const out: { time: UTCTimestamp; t: Trade }[] = [];
  for (const t of trades) out.push({ time: Math.max(t.time, (out[out.length - 1]?.time ?? 0) + 1) as UTCTimestamp, t });
  return out;
}

function PriceChart({ trades, goalPrice, nowPrice }: { trades: Trade[]; goalPrice: number; nowPrice: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: C.text, fontFamily: "var(--font-mono), ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "rgba(134,100,255,0.5)", width: 1, style: LineStyle.Solid, labelBackgroundColor: C.violet },
        horzLine: { color: "rgba(134,100,255,0.35)", labelBackgroundColor: C.violet },
      },
      handleScroll: false,
      handleScale: false,
      localization: { priceFormatter: (p: number) => usd(p) },
    });

    const ticks = points(trades);
    const price = chart.addSeries(AreaSeries, {
      lineColor: C.orange,
      lineWidth: 2,
      topColor: "rgba(245,75,0,0.30)",
      bottomColor: "rgba(110,69,255,0.00)",
      crosshairMarkerRadius: 5,
      crosshairMarkerBorderColor: "#F9F9FB",
      crosshairMarkerBackgroundColor: C.orange,
      priceLineColor: C.orange,
      priceLineStyle: LineStyle.Dotted,
    });
    const data = ticks.map(({ time, t }) => ({ time, value: t.price }));
    // Carry the line to now at the live price, so a quiet market still reads as current.
    const now = Math.floor(Date.now() / 1000) as UTCTimestamp;
    if (data.length && now > data[data.length - 1].time) data.push({ time: now, value: nowPrice });
    price.setData(data);
    price.createPriceLine({ price: goalPrice, color: C.gold, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "Goal" });

    // Each trade's size underneath: green buys, red sells.
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    volume.setData(ticks.map(({ time, t }) => ({ time, value: t.usdc, color: t.side === "buy" ? "rgba(36,201,141,0.4)" : "rgba(240,68,56,0.4)" })));

    // Framed once the chart has its real width: autoSize measures after the first paint.
    const frame = () => chart.timeScale().fitContent();
    frame();
    const observer = new ResizeObserver(frame);
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [trades, goalPrice, nowPrice]);

  return <div ref={ref} className="h-64 w-full sm:h-80" role="img" aria-label={`Voucher price chart, ${trades.length} trades`} />;
}

export function MarketChart({ c, curve }: { c: CampaignWithLive; curve: ReactNode }) {
  const live = c.live!;
  const [range, setRange] = useState<Range>("All");
  const [tabPick, setTab] = useState<"price" | "curve" | null>(null);
  const { data, isPending, dataUpdatedAt } = useTrades(c.pool);
  const trades = useMemo(() => data?.trades ?? [], [data]);
  // The trades in range, plus the one just before it, so the line starts at the price the range opened on.
  const shown = useMemo(() => {
    const from = dataUpdatedAt / 1000 - RANGES.find((r) => r.label === range)!.sec;
    const i = trades.findIndex((t) => t.time >= from);
    if (i === -1) return trades.slice(-1);
    return trades.slice(Math.max(0, i - 1));
  }, [trades, range, dataUpdatedAt]);
  // A campaign with no trades yet opens on its bonding curve, which already says what it will cost.
  const tab = tabPick ?? (data && trades.length < 2 ? "curve" : "price");
  const rangeChange = shown.length ? (live.priceUsdc - shown[0].price) / shown[0].price : null;

  const stats = useMemo(() => {
    const dayAgo = dataUpdatedAt / 1000 - 86_400; // as of the last read, so the memo stays pure
    return {
      volume24: trades.filter((t) => t.time >= dayAgo).reduce((a, t) => a + t.usdc, 0),
      volumeAll: trades.reduce((a, t) => a + t.usdc, 0),
      backers: new Set(trades.filter((t) => t.side === "buy").map((t) => t.wallet)).size,
    };
  }, [trades, dataUpdatedAt]);

  const up = (rangeChange ?? 0) >= 0;
  const stat = (label: string, value: ReactNode) => (
    <div className="px-5 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );

  return (
    <section aria-labelledby="market-title" className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5">
        <div>
          <h2 id="market-title" className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="relative flex size-2" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/70 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2 rounded-full bg-success" />
            </span>
            Voucher price · {live.status === "reselling" ? "Meteora DAMM v2" : "Meteora bonding curve"}
          </h2>
          <p className="mt-1 flex items-baseline gap-3">
            <span className="font-mono text-4xl tracking-tight tabular-nums">{usd(live.priceUsdc)}</span>
            {tab === "price" && rangeChange !== null && shown.length > 1 && (
              <span className={`rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums ${up ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}`}>
                {up ? "▲" : "▼"} {Math.abs(rangeChange * 100).toFixed(2)}%
                <span className="ml-1 text-muted-foreground">{range === "All" ? "all time" : range}</span>
              </span>
            )}
          </p>
        </div>
        <div role="tablist" aria-label="Chart" className="flex gap-1 rounded-lg bg-muted p-1">
          {(["price", "curve"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${tab === id ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {id === "price" ? "Price" : "Bonding curve"}
            </button>
          ))}
        </div>
      </div>

      {tab === "curve" ? (
        <div className="p-5">{curve}</div>
      ) : (
        <div className="pt-2">
          <div className="flex justify-end gap-0.5 px-5" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.label}
                type="button"
                aria-pressed={range === r.label}
                onClick={() => setRange(r.label)}
                className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${range === r.label ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="px-2">
            {isPending || data?.warming ? (
              <Skeleton className="mx-3 my-2 h-64 sm:h-80" />
            ) : trades.length === 0 ? (
              <div className="grid h-64 place-items-center text-center text-sm text-muted-foreground sm:h-80">
                <p>
                  No trades yet.
                  <br />
                  The first backer pays {usd(live.priceUsdc)}.
                </p>
              </div>
            ) : (
              <PriceChart trades={shown} goalPrice={c.campaign.plan.finalPrice} nowPrice={live.priceUsdc} />
            )}
          </div>
        </div>
      )}

      <dl className="grid grid-cols-2 divide-border border-t border-border sm:grid-cols-4 sm:divide-x">
        {stat("24h volume", usd(stats.volume24, 0))}
        {stat("All-time volume", usd(stats.volumeAll, 0))}
        {stat("Trades", trades.length)}
        {stat("Backers", stats.backers)}
      </dl>

      {tab === "price" && trades.length > 0 && (
        <div className="border-t border-border">
          <p className="px-5 pt-4 pb-2 text-sm font-medium">Recent trades</p>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-5 py-2 font-normal">Type</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Vouchers</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Price</th>
                  <th scope="col" className="hidden px-2 py-2 text-right font-normal sm:table-cell">Total</th>
                  <th scope="col" className="hidden px-2 py-2 font-normal sm:table-cell">Wallet</th>
                  <th scope="col" className="px-5 py-2 text-right font-normal">Age</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {[...trades].reverse().slice(0, 25).map((t) => (
                  <tr key={t.sig} className="border-t border-border/60 transition-colors hover:bg-muted/40">
                    <td className="px-5 py-2">
                      <span className={`inline-flex items-center gap-1.5 ${t.side === "buy" ? "text-success" : "text-destructive"}`}>
                        <span aria-hidden="true" className={`size-1.5 rounded-full ${t.side === "buy" ? "bg-success" : "bg-destructive"}`} />
                        {t.side === "buy" ? "Buy" : "Sell"}
                      </span>
                      <span className="ml-1.5 font-sans text-xs text-muted-foreground">{t.venue === "curve" ? "curve" : "resale"}</span>
                    </td>
                    <td className="px-2 py-2 text-right">{unitsShort(t.vouchers)}</td>
                    <td className="px-2 py-2 text-right">{usd(t.price)}</td>
                    <td className="hidden px-2 py-2 text-right sm:table-cell">{usd(t.usdc)}</td>
                    <td className="hidden px-2 py-2 text-muted-foreground sm:table-cell">{short(t.wallet)}</td>
                    <td className="px-5 py-2 text-right">
                      <a href={explorerTx(t.sig)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" aria-label={`Transaction, ${ago(t.time)} ago`}>
                        {ago(t.time)} <ExternalLink aria-hidden="true" className="size-3" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-3 text-xs text-muted-foreground">Prices include fees. Every trade is read straight from Solana.</p>
        </div>
      )}
    </section>
  );
}
