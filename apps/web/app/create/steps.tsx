"use client";

// The create page, one plain-language step at a time. These components only present and edit the draft;
// the launch logic (build, sign, resume, recover) stays in create-form.tsx.
import type { ReactNode } from "react";
import { Check, Minus, Plus } from "lucide-react";
import { MAX_TIERS } from "@preorder/core/src/pricing";
import {
  DESCRIPTION_MAX_CHARS,
  DROP_BOT_START_FEE_BPS,
  NAME_MAX_BYTES,
  NORMAL_FEE_BPS,
} from "@preorder/core/src/campaign-input";
import { RESALE_ROYALTY_BPS } from "@preorder/core/src/royalty";
import { SHIP_DAYS, firstReleaseSec, formatAfterGoal, makerPayoutPct, unitsOwedAfterUnlock, vestingEndSec } from "@preorder/core/src/vesting";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhotoField } from "@/components/photo-field";
import { Progress } from "@/components/ui/progress";
import { units, usd } from "@/lib/format";
import type { ConfigField, PricingSummary, TrustResult, VestingSchedule } from "@/lib/types";

export type TierInput = { units: string; startPrice: string };

export const STEP_LABELS = ["What you’re selling", "Quantity and price", "Shipping and payout", "Review and launch"] as const;

const textareaClass =
  "rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

// A short ticker from the product name: initials for several words, the first letters for one.
export function deriveTicker(name: string): string {
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  if (words.length === 0) return "ITEM";
  const ticker = words.length === 1 ? words[0].slice(0, 5) : words.slice(0, 5).map((w) => w[0]).join("");
  return ticker || "ITEM";
}

export function StepIndicator({ step, maxStep, onGo }: { step: number; maxStep: number; onGo: (n: number) => void }) {
  return (
    <nav aria-label="Progress">
      <ol className="flex flex-wrap gap-x-4 gap-y-2">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const current = n === step;
          const done = n < step;
          return (
            <li key={label}>
              <button
                type="button"
                onClick={() => onGo(n)}
                disabled={n > maxStep}
                aria-current={current ? "step" : undefined}
                className="flex min-h-10 items-center gap-2 rounded-md text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
              >
                <span
                  className={`grid size-7 shrink-0 place-items-center rounded-full font-mono text-xs ${
                    current ? "bg-primary text-primary-foreground" : done ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {done ? <Check aria-hidden="true" className="size-3.5" /> : n}
                </span>
                <span className={`${current ? "font-medium text-foreground" : "hidden text-muted-foreground sm:inline"}`}>{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h2 className="font-heading text-4xl tracking-tight">{title}</h2>
      {children && <p className="mt-1 text-muted-foreground">{children}</p>}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

// Step 1 -----------------------------------------------------------------------------------------

export function ProductStep(p: {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  image: string;
  imagePreview: string | null;
  setImage: (url: string, previewSrc: string | null) => void;
}) {
  return (
    <section aria-labelledby="step-1" className="grid gap-5">
      <div id="step-1">
        <StepHeading title="What are you selling?">Tell backers what they’re pre-ordering. You can’t edit this after launch.</StepHeading>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="name">Product name</Label>
        <Input id="name" value={p.name} maxLength={NAME_MAX_BYTES} autoComplete="off" placeholder="e.g. Hackathon Hoodie" onChange={(e) => p.setName(e.target.value)} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="description">What do backers get?</Label>
        <textarea
          id="description"
          value={p.description}
          onChange={(e) => p.setDescription(e.target.value)}
          rows={4}
          maxLength={DESCRIPTION_MAX_CHARS}
          placeholder="Materials, sizes, colours, anything that helps someone decide."
          className={textareaClass}
        />
      </div>
      <PhotoField image={p.image} previewSrc={p.imagePreview} onChange={p.setImage} />
    </section>
  );
}

// Step 2 -----------------------------------------------------------------------------------------

export function PriceStep(p: {
  tiers: TierInput[];
  updateTier: (i: number, key: keyof TierInput, value: string) => void;
  addTier: () => void;
  removeTier: (i: number) => void;
  finalPrice: string;
  setFinalPrice: (v: string) => void;
  pricing: { ok: PricingSummary | null; error: string | null };
}) {
  return (
    <section aria-labelledby="step-2" className="grid gap-5">
      <div id="step-2">
        <StepHeading title="How many, and at what price?">
          Early backers pay less. The price climbs through your tiers as items sell. Prices are in USDC, a digital dollar.
        </StepHeading>
      </div>

      <div className="grid gap-4">
        {p.tiers.map((t, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-3 rounded-lg border border-border p-3">
            <div className="col-span-3 flex items-center gap-2 text-sm font-medium">
              <Badge variant="secondary">Tier {i + 1}</Badge>
              {i === 0 ? "The first backers" : "Then"}
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`units-${i}`}>Items in this tier</Label>
              <Input id={`units-${i}`} type="number" inputMode="numeric" min={1} step={1} value={t.units} className="font-mono" onChange={(e) => p.updateTier(i, "units", e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`price-${i}`}>Price at the start ($)</Label>
              <Input id={`price-${i}`} type="number" inputMode="decimal" min={0.01} step={0.01} value={t.startPrice} className="font-mono" onChange={(e) => p.updateTier(i, "startPrice", e.target.value)} />
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove tier ${i + 1}`} disabled={p.tiers.length === 1} onClick={() => p.removeTier(i)}>
              <Minus aria-hidden="true" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-3">
          <Button type="button" variant="secondary" disabled={p.tiers.length >= MAX_TIERS} onClick={p.addTier}>
            <Plus aria-hidden="true" /> Add a tier
          </Button>
          <div className="ml-auto grid w-52 gap-2">
            <Label htmlFor="final">Price of the last item ($)</Label>
            <Input id="final" type="number" inputMode="decimal" min={0.01} step={0.01} value={p.finalPrice} className="font-mono" onChange={(e) => p.setFinalPrice(e.target.value)} />
          </div>
        </div>
      </div>

      {p.pricing.ok ? (
        <div className="rounded-xl border border-primary/40 bg-card p-5">
          <p className="text-sm text-muted-foreground">If every item sells you raise</p>
          <p className="font-mono text-4xl tabular-nums">{usd(p.pricing.ok.goalUsdc)}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            That’s your <span className="text-foreground">funding goal</span> for {units(p.pricing.ok.preorderUnits)} items. When the last one is pre-ordered, the campaign is funded and you
            start getting paid.
          </p>
        </div>
      ) : (
        <p className="rounded-xl border border-destructive/50 p-4 text-sm text-destructive" role="alert">
          Fix this to continue: {p.pricing.error}
        </p>
      )}
    </section>
  );
}

// Step 3 -----------------------------------------------------------------------------------------

export function PayoutStep(p: {
  shipDays: string;
  setShipDays: (v: string) => void;
  share: number;
  setShare: (v: number) => void;
  cap: number;
  unitCost: string;
  setUnitCost: (v: string) => void;
  pricing: PricingSummary | null;
  vesting: VestingSchedule | null;
  trust: ReactNode;
  advanced: ReactNode;
}) {
  return (
    <section aria-labelledby="step-3" className="grid gap-6">
      <div id="step-3">
        <StepHeading title="When will you ship, and how do you get paid?">
          Backers pay before you’ve made anything, so most of your money is released after your ship date. That’s what makes them trust a new maker.
        </StepHeading>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="ship">I’ll ship within this many days after the goal is reached</Label>
        <Input id="ship" type="number" inputMode="numeric" min={SHIP_DAYS.min} max={SHIP_DAYS.max} step={1} value={p.shipDays} className="w-32 font-mono" onChange={(e) => p.setShipDays(e.target.value)} />
        <Hint>
          Between {SHIP_DAYS.min} and {SHIP_DAYS.max} days.
        </Hint>
      </div>

      {p.trust}

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="share">Take this share right when the goal is reached</Label>
          <span className="font-mono text-sm">
            {p.share}% <span className="text-muted-foreground">of {p.cap}% max</span>
          </span>
        </div>
        <input id="share" type="range" min={0} max={p.cap} step={1} value={p.share} onChange={(e) => p.setShare(Number(e.target.value))} className="accent-primary" />
        <Hint>The rest is released gradually after you ship. The higher your trust level, the more you can take upfront and the sooner the rest arrives.</Hint>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="unit-cost">
          What does one item cost you to make? <span className="text-muted-foreground">(optional, only you see this)</span>
        </Label>
        <Input id="unit-cost" type="number" inputMode="decimal" min={0} step={0.01} placeholder="e.g. 12" value={p.unitCost} className="w-40 font-mono" onChange={(e) => p.setUnitCost(e.target.value)} />
        <Hint>We’ll show how much of your production cost each payment covers.</Hint>
      </div>

      {p.pricing && p.vesting && <PayoutTimeline pricing={p.pricing} share={p.share} vesting={p.vesting} unitCost={Number(p.unitCost)} />}

      {p.advanced}
    </section>
  );
}

// What the maker is paid and when, assuming no resale trading, as three plain moments.
function PayoutTimeline({ pricing, share, vesting, unitCost }: { pricing: PricingSummary; share: number; vesting: VestingSchedule; unitCost: number }) {
  const pct = makerPayoutPct(share, vesting);
  const owed = unitsOwedAfterUnlock(pricing.preorderUnits, pricing.resaleUnits);
  const at = (p: number) => (pricing.goalUsdc * p) / 100;
  const cover = (usdc: number, items: number) => `${Math.round((usdc / (items * unitCost)) * 100)}%`;
  const rows = [
    { when: "The day the goal is reached", amount: at(pct.atGoal), note: `${pct.atGoal}% of the raise` },
    { when: `From ${formatAfterGoal(firstReleaseSec(vesting))}`, amount: at(pct.atFirstRelease), note: "first release after your ship date, total so far" },
    { when: `By ${formatAfterGoal(vestingEndSec(vesting))}`, amount: at(pct.max), note: `up to ${Math.round(pct.max)}% in total` },
  ];
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="font-heading text-2xl">Your payout</h3>
      <ol className="mt-3 divide-y divide-border">
        {rows.map((r) => (
          <li key={r.when} className="flex items-baseline justify-between gap-4 py-3">
            <span>
              <span className="block font-medium">{r.when}</span>
              <span className="text-sm text-muted-foreground">{r.note}</span>
            </span>
            <span className="font-mono text-xl whitespace-nowrap tabular-nums">{usd(r.amount, 0)}</span>
          </li>
        ))}
      </ol>
      {unitCost > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          That covers <span className="font-mono text-foreground">{cover(at(pct.atGoal), pricing.preorderUnits)}</span> of your production cost at the goal, and up to{" "}
          <span className="font-mono text-foreground">{cover(at(pct.max), owed)}</span> once everything is released.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">Estimates assume nobody trades the pre-orders after the goal. Trading changes the amounts.</p>
    </div>
  );
}

// The settings most makers never touch, tucked away. All have safe defaults.
export function AdvancedSettings(p: {
  symbol: string;
  setSymbol: (v: string) => void;
  royaltyPct: string;
  setRoyaltyPct: (v: string) => void;
  dropWindow: number;
  setDropWindow: (v: number) => void;
  dropWindows: { label: string; sec: number }[];
  yourShareOfRoyaltyPct: number;
}) {
  return (
    <details className="group rounded-xl border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">Advanced settings (the defaults are fine)</summary>
      <div className="mt-4 grid gap-6">
        <div className="grid gap-2">
          <Label htmlFor="symbol">Short code</Label>
          <Input id="symbol" value={p.symbol} maxLength={10} autoComplete="off" className="w-40 font-mono uppercase" onChange={(e) => p.setSymbol(e.target.value.toUpperCase())} required />
          <Hint>A 1 to 10 character code for your pre-order voucher in wallets. We made one from your product name.</Hint>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="royalty">Your cut when backers resell (%)</Label>
          <Input
            id="royalty"
            type="number"
            inputMode="decimal"
            min={RESALE_ROYALTY_BPS.min / 100}
            max={RESALE_ROYALTY_BPS.max / 100}
            step={0.25}
            value={p.royaltyPct}
            className="w-32 font-mono"
            onChange={(e) => p.setRoyaltyPct(e.target.value)}
          />
          <Hint>
            After the goal, backers can trade their pre-orders with each other. Each trade pays this fee ({RESALE_ROYALTY_BPS.min / 100} to {RESALE_ROYALTY_BPS.max / 100}%). After Meteora’s protocol share, you earn{" "}
            {p.yourShareOfRoyaltyPct}% of it.
          </Hint>
        </div>
        <div className="grid gap-2" role="radiogroup" aria-labelledby="drop-label">
          <span id="drop-label" className="text-sm font-medium">
            Launch-rush protection
          </span>
          <div className="flex flex-wrap gap-2">
            {p.dropWindows.map((w) => (
              <Button key={w.sec} type="button" role="radio" aria-checked={p.dropWindow === w.sec} variant={p.dropWindow === w.sec ? "default" : "secondary"} onClick={() => p.setDropWindow(w.sec)}>
                {w.label}
              </Button>
            ))}
          </div>
          <Hint>
            Bots grab cheap items the second a drop opens. For this long after launch, buying costs an extra fee that starts at {DROP_BOT_START_FEE_BPS / 100}% and falls to {NORMAL_FEE_BPS / 100}%, so real fans get a fair
            chance.
          </Hint>
        </div>
      </div>
    </details>
  );
}

// Step 4 -----------------------------------------------------------------------------------------

export function ReviewStep(p: {
  name: string;
  pricing: PricingSummary | null;
  share: number;
  shipDays: string;
  trust: TrustResult | null;
  vesting: VestingSchedule | null;
  royaltyPct: string;
  dropWindowMin: number;
  fields: ConfigField[];
  trustCard: ReactNode;
  edit: (step: number) => void;
}) {
  const pricing = p.pricing;
  const owed = pricing ? unitsOwedAfterUnlock(pricing.preorderUnits, pricing.resaleUnits) : null;
  const summary: [string, string, number][] = pricing
    ? [
        ["Product", p.name || "Untitled", 1],
        ["Items for sale", `${units(pricing.preorderUnits)} items, ${usd(pricing.segments[0].startPrice)} to ${usd(pricing.segments[pricing.segments.length - 1].endPrice)} each`, 2],
        ["Funding goal", usd(pricing.goalUsdc), 2],
        ["You get at the goal", `${usd(pricing.makerBudgetUsdc, 0)} (${p.share}%)`, 3],
        ["You ship within", `${p.shipDays} days of the goal`, 3],
      ]
    : [];
  return (
    <section aria-labelledby="step-4" className="grid gap-6">
      <div id="step-4">
        <StepHeading title="Ready to launch?">Check the details. Once you launch, the rules are locked in on-chain. Nobody can change them, including us.</StepHeading>
      </div>

      <dl className="divide-y divide-border rounded-xl border border-border bg-card">
        {summary.map(([label, value, step]) => (
          <div key={label} className="flex items-center justify-between gap-4 px-4 py-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="flex items-center gap-3 text-right">
              <span className="font-medium">{value}</span>
              <button type="button" onClick={() => p.edit(step)} className="rounded text-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                Edit
              </button>
            </dd>
          </div>
        ))}
      </dl>

      {p.trustCard}

      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="font-heading text-2xl">What you’re promising backers</h3>
        <ul className="mt-3 grid gap-2 text-sm text-muted-foreground">
          {pricing && owed !== null && (
            <li>
              Make and ship <span className="text-foreground">{units(pricing.preorderUnits)}</span> items, and up to{" "}
              <span className="text-foreground">{Math.ceil(owed)}</span> if backers also buy vouchers on the resale market.
            </li>
          )}
          <li>Your later payments come out gradually after your ship date, so backers aren’t paying for something that never ships.</li>
          <li>No more items can ever be created than the number shown above.</li>
          <li>
            Backers can trade their pre-orders after the goal. You earn a cut of every trade ({p.royaltyPct}% fee). {p.dropWindowMin} minutes of launch-rush protection apply at the start.
          </li>
        </ul>
      </div>

      <details className="rounded-xl border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">For the curious: how this becomes an on-chain contract</summary>
        <p className="mt-3 text-sm text-muted-foreground">Every input above becomes a setting on Meteora’s Dynamic Bonding Curve. This is the exact mapping.</p>
        {p.fields.length > 0 ? (
          <ul className="mt-3 divide-y divide-border">
            {p.fields.map((f) => (
              <li key={f.input} className="grid grid-cols-[8rem_1fr] gap-3 py-2 text-sm">
                <span className="text-muted-foreground">{f.input}</span>
                <span>
                  <span className="block">{f.value}</span>
                  <code className="font-mono text-xs [overflow-wrap:anywhere] text-primary">{f.dbcField}</code>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">The config preview is unavailable right now.</p>
        )}
      </details>
    </section>
  );
}

// The live preview -------------------------------------------------------------------------------

export function CampaignPreview(p: {
  name: string;
  description: string;
  image: string;
  pricing: PricingSummary | null;
  shipDays: string;
  tier: string | null;
}) {
  const first = p.pricing?.segments[0];
  const last = p.pricing?.segments[p.pricing.segments.length - 1];
  const initials = (p.name.trim().match(/[A-Za-z0-9]+/g) ?? ["?"]).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <p className="border-b border-border px-4 py-2 text-xs tracking-wide text-muted-foreground uppercase">What backers will see</p>
      <div className="aspect-[16/9] bg-muted">
        {p.image.trim() ? (
          // eslint-disable-next-line @next/next/no-img-element -- maker-supplied URL on an arbitrary host
          <img src={p.image.trim()} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center font-heading text-6xl text-muted-foreground" aria-hidden="true">
            {initials}
          </div>
        )}
      </div>
      <div className="grid gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-heading text-3xl leading-tight [overflow-wrap:anywhere]">{p.name.trim() || "Your product"}</h3>
          {p.tier && <Badge variant="outline">Maker level {p.tier}</Badge>}
        </div>
        {p.description.trim() && <p className="line-clamp-3 text-sm text-muted-foreground">{p.description.trim()}</p>}
        <Progress value={0} aria-label="Funding progress" />
        {first && last && p.pricing ? (
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-muted-foreground">Price now</dt>
              <dd className="font-mono tabular-nums">{usd(first.startPrice)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Goal</dt>
              <dd className="font-mono tabular-nums">{usd(p.pricing.goalUsdc, 0)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Items</dt>
              <dd className="font-mono tabular-nums">0 / {units(p.pricing.preorderUnits)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Fill in the quantity and price to see the numbers.</p>
        )}
        {Number(p.shipDays) > 0 && <p className="text-sm">Ships within {p.shipDays} days of the goal being reached.</p>}
        {p.pricing && (
          <div className="border-t border-border pt-3">
            <p className="mb-1 text-xs text-muted-foreground">Price ladder: the earlier you back, the less you pay</p>
            <ol className="grid gap-1 text-sm">
              {p.pricing.segments.map((s, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3">
                  <span>
                    {units(s.units)} items
                  </span>
                  <span className="font-mono text-xs tabular-nums">
                    {usd(s.startPrice)} → {usd(s.endPrice)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
