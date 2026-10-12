"use client";

import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client";
import type { Trade } from "@/lib/types";

// A campaign's trades, shared by its card, the hero and the Market card (one cached request per pool).
export function useTrades(pool: string) {
  return useQuery({
    queryKey: ["trades", pool],
    queryFn: () => api<{ trades: Trade[]; warming?: boolean }>(`/api/campaigns/${pool}/trades`),
    // While the server is still reading a campaign's history from chain, ask again sooner.
    refetchInterval: (q) => (q.state.data?.warming ? 4000 : 15_000),
  });
}

// A small line of a campaign's trade prices, ending at the live price. Decorative: the numbers beside it say the same.
export function Sparkline({ prices, className = "h-10 w-28" }: { prices: number[]; className?: string }) {
  const id = `s${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  if (prices.length < 2) return <div className={className} aria-hidden="true" />;
  const W = 120;
  const H = 40;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const pts = prices.map((p, i) => [(i / (prices.length - 1)) * W, H - 3 - ((p - min) / span) * (H - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const up = prices[prices.length - 1] >= prices[0];
  const color = up ? "#24C98D" : "#F04438";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// The change from the first trade to the live price, as a small pill.
export function ChangePill({ from, to }: { from: number | undefined; to: number }) {
  if (!from) return null;
  const change = (to - from) / from;
  const up = change >= 0;
  return (
    <span className={`rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums ${up ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}`}>
      {up ? "▲" : "▼"} {Math.abs(change * 100).toFixed(2)}%
    </span>
  );
}
