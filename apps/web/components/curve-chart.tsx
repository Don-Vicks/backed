import { useId } from "react";
import { priceTiers, type TierPlan } from "@preorder/core/src/pricing";
import { usd } from "@/lib/format";

// The pre-order curve as DBC prices it: within a tier of constant liquidity L, after x vouchers the
// price is 1 / (1/√P0 − x/L)², so each tier is a gentle upward curve from its start price to the next.
const W = 640;
const H = 260;
const PAD = { left: 56, right: 20, top: 20, bottom: 40 };

export function CurveChart({ plan, unitsSold, graduated = false }: { plan: TierPlan; unitsSold?: number; graduated?: boolean }) {
  const id = `g${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`; // safe inside url(#…)
  let segments;
  try {
    segments = priceTiers(plan).segments;
  } catch {
    return null; // an unfinished plan on the create form: nothing to draw yet
  }
  const totalUnits = segments.reduce((a, s) => a + s.units, 0);
  const minPrice = segments[0].startPrice;
  const maxPrice = plan.finalPrice;
  const yLow = minPrice * 0.8;
  const x = (u: number) => PAD.left + (u / totalUnits) * (W - PAD.left - PAD.right);
  const y = (p: number) => H - PAD.bottom - ((p - yLow) / (maxPrice - yLow)) * (H - PAD.top - PAD.bottom);

  // Price after `sold` units, walking the segments.
  const priceAt = (sold: number) => {
    let start = 0;
    for (const s of segments) {
      if (sold <= start + s.units) {
        const within = Math.max(0, sold - start);
        return 1 / (1 / Math.sqrt(s.startPrice) - within / s.weight) ** 2;
      }
      start += s.units;
    }
    return maxPrice;
  };

  const steps = 96;
  const points = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * totalUnits).map((u) => [x(u), y(priceAt(u))] as const);
  const line = points.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = `${line} L${x(totalUnits).toFixed(1)},${y(yLow).toFixed(1)} L${x(0).toFixed(1)},${y(yLow).toFixed(1)} Z`;

  // Units sold at the end of each tier but the last: where the dashed tier lines go.
  const bounds = segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).reduce((a, s) => a + s.units, 0));
  const sold = unitsSold === undefined ? undefined : Math.min(totalUnits, Math.max(0, unitsSold));
  const soldPrice = sold === undefined ? undefined : priceAt(sold);
  const label = `Pre-order price curve: ${segments.map((s, i) => `tier ${i + 1}, ${s.units} units from ${usd(s.startPrice)} to ${usd(s.endPrice)}`).join("; ")}.${
    sold === undefined ? "" : graduated ? " Goal reached." : ` ${sold.toFixed(2)} of ${totalUnits} units sold, price now ${usd(soldPrice!)}.`
  }`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label}>
      <defs>
        {/* Meteora's gradient along the curve: violet where it starts, gold at the goal. */}
        <linearGradient id={`${id}-line`} x1={x(0)} x2={x(totalUnits)} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8664FF" />
          <stop offset="0.6" stopColor="#F54B00" />
          <stop offset="1" stopColor="#F5BD00" />
        </linearGradient>
        <linearGradient id={`${id}-area`} x1="0" x2="0" y1={PAD.top} y2={y(yLow)} gradientUnits="userSpaceOnUse">
          <stop stopColor="#F54B00" stopOpacity="0.22" />
          <stop offset="1" stopColor="#6E45FF" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={`${id}-sold`} x1="0" x2="0" y1={PAD.top} y2={y(yLow)} gradientUnits="userSpaceOnUse">
          <stop stopColor="#F54B00" stopOpacity="0.5" />
          <stop offset="1" stopColor="#6E45FF" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id}-area)`} />
      {sold !== undefined && sold > 0 && (
        <path
          d={`${points.filter(([px]) => px <= x(sold) + 0.01).map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ")} L${x(sold).toFixed(1)},${y(soldPrice!).toFixed(1)} L${x(sold).toFixed(1)},${y(yLow).toFixed(1)} L${x(0).toFixed(1)},${y(yLow).toFixed(1)} Z`}
          fill={`url(#${id}-sold)`}
        />
      )}
      {bounds.map((b, i) => (
        <line key={i} x1={x(b)} x2={x(b)} y1={PAD.top} y2={y(yLow)} className="stroke-border" strokeDasharray="4 4" />
      ))}
      <line x1={x(0)} x2={x(totalUnits)} y1={y(yLow)} y2={y(yLow)} className="stroke-border" />
      <path d={line} fill="none" stroke={`url(#${id}-line)`} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      {segments.map((s, i) => {
        const start = segments.slice(0, i).reduce((a, t) => a + t.units, 0);
        return (
          <text key={i} x={x(start + s.units / 2)} y={H - 14} textAnchor="middle" className="fill-muted-foreground text-[13px]">
            Tier {i + 1} · {s.units} units
          </text>
        );
      })}
      <text x={PAD.left - 8} y={y(minPrice) + 4} textAnchor="end" className="fill-muted-foreground font-mono text-[13px]">
        {usd(minPrice)}
      </text>
      <text x={PAD.left - 8} y={y(maxPrice) + 4} textAnchor="end" className="fill-muted-foreground font-mono text-[13px]">
        {usd(maxPrice)}
      </text>
      <text x={x(totalUnits)} y={y(maxPrice) - 8} textAnchor="end" className="fill-foreground text-[13px]">
        Goal
      </text>
      {sold !== undefined && !graduated && (
        <g>
          <circle cx={x(sold)} cy={y(soldPrice!)} r={10} className="fill-primary/20" />
          <circle cx={x(sold)} cy={y(soldPrice!)} r={5} className="fill-foreground stroke-primary" strokeWidth={2.5} />
          <text x={Math.min(x(sold) + 10, W - PAD.right - 4)} y={y(soldPrice!) - 10} textAnchor={x(sold) > W * 0.7 ? "end" : "start"} className="fill-foreground font-mono text-[13px]">
            Now {usd(soldPrice!)}
          </text>
        </g>
      )}
    </svg>
  );
}
