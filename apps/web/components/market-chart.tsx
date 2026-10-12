"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client";
import { explorerTx, short, unitsShort, usd } from "@/lib/format";
import type { CampaignWithLive, Trade } from "@/lib/types";

// Meteora night, as lightweight-charts wants it (it draws on canvas, so no CSS variables).
const C = { text: "#9595B2", grid: "#1C1C2C", border: "#23233A", up: "#24C98D", down: "#F04438", orange: "#F54B00", violet: "#8664FF", gold: "#F5BD00" };

const INTERVALS = [
  { label: "1m", sec: 60 },
  { label: "5m", sec: 300 },
  { label: "15m", sec: 900 },
  { label: "1h", sec: 3600 },
  { label: "4h", sec: 14_400 },
  { label: "1D", sec: 86_400 },
] as const;

// The smallest interval that fits the last 40 trades in about 60 candles; older history scrolls left.
function autoInterval(all: Trade[]) {
  const trades = all.slice(-40);
  if (trades.length < 2) return INTERVALS[3].sec;
  const span = trades[trades.length - 1].time - trades[0].time;
  return (INTERVALS.find((i) => span / i.sec <= 60) ?? INTERVALS[INTERVALS.length - 1]).sec;
}

type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number; buy: number; sell: number };

function candles(trades: Trade[], sec: number): Candle[] {
  const out: Candle[] = [];
  for (const t of trades) {
    const time = (Math.floor(t.time / sec) * sec) as UTCTimestamp;
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, t.price);
      last.low = Math.min(last.low, t.price);
      last.close = t.price;
      last[t.side] += t.usdc;
    } else {
      // Each candle opens where the last one closed, so gaps between trades read as flat, not as jumps.
      const open = last ? last.close : t.price;
      out.push({ time, open, high: Math.max(open, t.price), low: Math.min(open, t.price), close: t.price, buy: t.side === "buy" ? t.usdc : 0, sell: t.side === "sell" ? t.usdc : 0 });
    }
  }
  return out;
}

function ago(sec: number) {
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86_400)}d`;
}

function PriceChart({ trades, mode, sec, goalPrice, nowPrice }: { trades: Trade[]; mode: "candles" | "line"; sec: number; goalPrice: number; nowPrice: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: C.text, fontFamily: "var(--font-mono), ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.12, bottom: 0.26 } },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: C.violet, labelBackgroundColor: C.violet }, horzLine: { color: C.violet, labelBackgroundColor: C.violet } },
      localization: { priceFormatter: (p: number) => usd(p) },
    });
    chartRef.current = chart;

    const data = candles(trades, sec);
    const price =
      mode === "candles"
        ? chart.addSeries(CandlestickSeries, { upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down })
        : chart.addSeries(AreaSeries, { lineColor: C.orange, topColor: "rgba(245,75,0,0.32)", bottomColor: "rgba(110,69,255,0.02)", lineWidth: 2 });
    if (mode === "candles") price.setData(data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    else {
      const points = data.map((d) => ({ time: d.time, value: d.close }));
      // Carry the line to now at the live price, so a quiet market still reads as current.
      const now = (Math.floor(Date.now() / 1000 / sec) * sec) as UTCTimestamp;
      if (points.length && now > points[points.length - 1].time) points.push({ time: now, value: nowPrice });
      price.setData(points);
    }
    price.createPriceLine({ price: goalPrice, color: C.gold, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "Goal price" });

    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volume.setData(data.map((d) => ({ time: d.time, value: d.buy + d.sell, color: d.buy >= d.sell ? "rgba(36,201,141,0.45)" : "rgba(240,68,56,0.45)" })));

    // Buy and sell arrows while there are few enough to read.
    if (data.length <= 80) {
      createSeriesMarkers(
        price,
        data.flatMap((d) => [
          ...(d.buy > 0 ? [{ time: d.time, position: "belowBar" as const, color: C.up, shape: "arrowUp" as const, text: "" }] : []),
          ...(d.sell > 0 ? [{ time: d.time, position: "aboveBar" as const, color: C.down, shape: "arrowDown" as const, text: "" }] : []),
        ]),
      );
    }
    // The latest 60 candles; drag or scroll for older ones.
    if (data.length > 60) chart.timeScale().setVisibleLogicalRange({ from: data.length - 60, to: data.length + 3 });
    else chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [trades, mode, sec, goalPrice, nowPrice]);

  return <div ref={ref} className="h-72 w-full sm:h-80" role="img" aria-label={`Voucher price chart, ${trades.length} trades`} />;
}

export function MarketChart({ c }: { c: CampaignWithLive }) {
  const live = c.live!;
  const [mode, setMode] = useState<"candles" | "line">("candles");
  const [pick, setPick] = useState<number | null>(null);
  const { data, isPending, dataUpdatedAt } = useQuery({
    queryKey: ["trades", c.pool],
    queryFn: () => api<{ trades: Trade[] }>(`/api/campaigns/${c.pool}/trades`),
    refetchInterval: 15_000,
  });
  const trades = useMemo(() => data?.trades ?? [], [data]);
  const sec = pick ?? autoInterval(trades);

  const stats = useMemo(() => {
    const dayAgo = dataUpdatedAt / 1000 - 86_400; // as of the last read, so the memo stays pure
    const day = trades.filter((t) => t.time >= dayAgo);
    const first = trades[0]?.price;
    const backers = new Set(trades.filter((t) => t.side === "buy").map((t) => t.wallet)).size;
    return {
      change: first ? (live.priceUsdc - first) / first : null,
      volume24: day.reduce((a, t) => a + t.usdc, 0),
      volumeAll: trades.reduce((a, t) => a + t.usdc, 0),
      backers,
    };
  }, [trades, live.priceUsdc, dataUpdatedAt]);

  const chip = (active: boolean, label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded px-2 py-1 font-mono text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </button>
  );

  return (
    <section aria-labelledby="market-title" className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h2 id="market-title" className="font-heading text-2xl">Market</h2>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex size-2" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/70 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          {live.status === "reselling" ? "Trading on Meteora DAMM v2" : "Trading on Meteora’s bonding curve"}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-border px-5 py-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground" title="Change since the first trade">Price</dt>
          <dd className="font-mono text-lg tabular-nums">
            {usd(live.priceUsdc)}
            {stats.change !== null && (
              <span className={`ml-2 text-xs ${stats.change >= 0 ? "text-success" : "text-destructive"}`}>
                {stats.change >= 0 ? "+" : ""}
                {(stats.change * 100).toFixed(1)}%
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">24h volume</dt>
          <dd className="font-mono text-lg tabular-nums">{usd(stats.volume24, 0)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Trades</dt>
          <dd className="font-mono text-lg tabular-nums">{trades.length}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Backers</dt>
          <dd className="font-mono text-lg tabular-nums">{stats.backers}</dd>
        </div>
      </dl>

        <div className="px-2 pt-2 pb-1 sm:px-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1">
            <div className="flex gap-0.5">{INTERVALS.map((i) => chip(sec === i.sec, i.label, () => setPick(i.sec)))}</div>
            <div className="flex gap-0.5">
              {chip(mode === "candles", "Candles", () => setMode("candles"))}
              {chip(mode === "line", "Line", () => setMode("line"))}
            </div>
          </div>
          {isPending ? (
            <Skeleton className="m-2 h-72 sm:h-80" />
          ) : trades.length === 0 ? (
            <div className="grid h-72 place-items-center text-center text-sm text-muted-foreground sm:h-80">
              <p>
                No trades yet.
                <br />
                The first backer sets the first candle at {usd(live.priceUsdc)}.
              </p>
            </div>
          ) : (
            <PriceChart trades={trades} mode={mode} sec={sec} goalPrice={c.campaign.plan.finalPrice} nowPrice={live.priceUsdc} />
          )}
        </div>

      {trades.length > 0 && (
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
                  <tr key={t.sig} className="border-t border-border/60">
                    <td className="px-5 py-2">
                      <span className={t.side === "buy" ? "text-success" : "text-destructive"}>{t.side === "buy" ? "Buy" : "Sell"}</span>
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
          <p className="px-5 py-3 text-xs text-muted-foreground">
            {usd(stats.volumeAll, 0)} traded in total. Prices include fees. Read straight from Solana.
          </p>
        </div>
      )}
    </section>
  );
}
