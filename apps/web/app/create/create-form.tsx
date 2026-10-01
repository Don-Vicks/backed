"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Minus, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { MAX_TIERS, priceTiers, type TierPlan } from "@preorder/core/src/pricing";
import {
  DEFAULT_DROP_BOT_WINDOW_SEC,
  DESCRIPTION_MAX_CHARS,
  DROP_BOT_START_FEE_BPS,
  DROP_BOT_WINDOWS_SEC,
  IMAGE_URL_MAX_CHARS,
  NAME_MAX_BYTES,
  NORMAL_FEE_BPS,
} from "@preorder/core/src/campaign-input";
import { RESALE_ROYALTY_BPS } from "@preorder/core/src/royalty";
import { LP_SPLIT, SHIP_DAYS, firstReleaseSec, formatAfterGoal, makerPayoutPct, unitsOwedAfterUnlock, vestingEndSec, vestingSchedule } from "@preorder/core/src/vesting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, ReportedError, useSignAndSendAll, type BuiltTx } from "@/lib/client";
import { useDebounced } from "@/lib/use-debounced";
import { confirmLaunch, setPendingLaunch, usePendingLaunch, type PendingLaunch } from "@/lib/pending-launch";
import { FinishListing } from "./finish-listing";
import { units, usd } from "@/lib/format";
import type { Campaign, PreviewResponse, PricingSummary, VestingSchedule } from "@/lib/types";

type TierInput = { units: string; startPrice: string };

// The launch fee is fixed for every campaign; only the length of the window is the maker's choice.
const DROP_WINDOWS = DROP_BOT_WINDOWS_SEC.map((sec) => ({ label: `${sec / 60} min`, sec }));

function num(v: string) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function CreateForm() {
  const router = useRouter();
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const signAndSendAll = useSignAndSendAll();

  const [name, setName] = useState("Hackathon Hoodie");
  const [symbol, setSymbol] = useState("HOOD");
  const [description, setDescription] = useState("Heavyweight cotton hoodie, printed after the goal is reached.");
  const [image, setImage] = useState("");
  const [tiers, setTiers] = useState<TierInput[]>([
    { units: "20", startPrice: "25" },
    { units: "30", startPrice: "30" },
  ]);
  const [finalPrice, setFinalPrice] = useState("38");
  const [makerShare, setMakerShare] = useState(10);
  const [dropWindow, setDropWindow] = useState<number>(DEFAULT_DROP_BOT_WINDOW_SEC);
  const [shipDays, setShipDays] = useState(String(SHIP_DAYS.default));
  const [royaltyPct, setRoyaltyPct] = useState(String(RESALE_ROYALTY_BPS.default / 100));
  const [unitCost, setUnitCost] = useState("");
  const [launching, setLaunching] = useState(false);
  // A split create whose config landed but whose pool did not: launching again finishes it on that config.
  const [resumePool, setResumePool] = useState<string | null>(null);

  // The upfront share can never exceed the tier cap; derived, not synced with an effect.
  const [previewCap, setPreviewCap] = useState(10);
  const effectiveShare = Math.min(makerShare, previewCap);

  const campaign: Campaign = useMemo(
    () => ({
      name,
      symbol,
      uri: "",
      description,
      image: image.trim() || undefined,
      plan: {
        tiers: tiers.map((t) => ({ units: num(t.units), startPrice: num(t.startPrice) })),
        finalPrice: num(finalPrice),
        makerSharePct: effectiveShare,
      },
      dropBot: { startFeeBps: DROP_BOT_START_FEE_BPS, windowSec: dropWindow },
      normalFeeBps: NORMAL_FEE_BPS,
      shipDays: num(shipDays),
      resaleRoyaltyBps: Math.round(num(royaltyPct) * 100),
    }),
    [name, symbol, description, image, tiers, finalPrice, effectiveShare, dropWindow, shipDays, royaltyPct],
  );

  // Instant numbers, computed in the browser.
  const pricing = useMemo(() => {
    try {
      return { ok: priceTiers(campaign.plan as TierPlan), error: null };
    } catch (e) {
      return { ok: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [campaign.plan]);

  // Trust tier + on-chain field mapping from the server (debounced).
  const previewInput = useDebounced(JSON.stringify({ campaign, maker: publicKey?.toBase58() }), 450);
  const previewQuery = useQuery({
    queryKey: ["preview", previewInput],
    queryFn: () => api<PreviewResponse & { caps: Record<string, number> }>("/api/preview", JSON.parse(previewInput)),
    placeholderData: keepPreviousData,
  });
  const preview = previewQuery.data ?? null;
  const previewLoading = previewQuery.isFetching;
  const cap = preview?.trust?.maxMakerSharePct ?? 10;
  if (cap !== previewCap) setPreviewCap(cap); // adjust state during render (React-recommended pattern)

  // The ship-window schedule: the server's (it applies the tier and any localnet override), else a local estimate.
  const vesting = useMemo(() => {
    if (preview?.vesting) return preview.vesting;
    try {
      return vestingSchedule(preview?.trust?.tier ?? "C", num(shipDays));
    } catch {
      return null;
    }
  }, [preview, shipDays]);

  const blocking = pricing.error ?? preview?.error ?? (!name.trim() ? "Name the product" : null);

  // A sent launch that is not listed yet: finish it (once automatically on load) rather than launch twice.
  const pendingLaunch = usePendingLaunch();
  const [listing, setListing] = useState(false);
  // `publish`: right after a launch from this page, also offer the on-chain listing (DBC pool metadata),
  // a second, optional transaction. Skipping it or a failure doesn't stop the launch; the maker can
  // publish it later from the campaign page.
  async function finishListing(launch: PendingLaunch, { publish = false } = {}) {
    setListing(true);
    try {
      if ((await confirmLaunch(launch)) === "gone") {
        setPendingLaunch(null);
        toast.error("That launch never landed on-chain. You can launch again.");
        return;
      }
      setPendingLaunch(null);
      if (publish && publicKey) {
        await api<BuiltTx>(`/api/campaigns/${launch.pool}/listing`, { wallet: publicKey.toBase58() })
          .then((listing) => signAndSendAll([listing], "Publish on-chain listing"))
          .catch(() => undefined);
      }
      router.push(`/c/${launch.pool}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Listing failed");
    } finally {
      setListing(false);
    }
  }
  const autoFinished = useRef<string | null>(null);
  const autoFinish = useEffectEvent((launch: PendingLaunch) => {
    if (autoFinished.current === launch.pool) return;
    autoFinished.current = launch.pool;
    void finishListing(launch);
  });
  useEffect(() => {
    if (pendingLaunch && !launching) autoFinish(pendingLaunch);
  }, [pendingLaunch, launching]);

  async function launch() {
    if (!publicKey) return setVisible(true);
    setLaunching(true);
    try {
      // One transaction, or two (config, then pool) for larger campaigns; either way one wallet prompt.
      // A resume is one createPool on the config that already landed (none when the pool exists too).
      const maker = publicKey.toBase58();
      const { pool, txs } = resumePool
        ? await api<{ txs: BuiltTx[]; pool: string }>(`/api/campaigns/${resumePool}/resume`, { maker })
        : await api<{ txs: BuiltTx[]; pool: string }>("/api/campaigns", { campaign, maker });
      if (!txs.length) {
        // The pool was on-chain after all, and the resume listed it.
        setResumePool(null);
        router.push(`/c/${pool}`);
        return;
      }
      if (txs.length > 1) toast.info("Two steps in one approval. Your wallet may warn that step 2 will fail: it can’t see the config step 1 creates.");
      autoFinished.current = pool;
      // Remembered as soon as the RPC accepts the transaction that creates the pool (the last one): if it
      // lands but this page loses track, the banner finishes it. A rejected prompt or a failed preflight
      // never gets here, so nothing is left behind.
      const sent = { current: false };
      let pending: PendingLaunch;
      try {
        const signature = await signAndSendAll(txs, resumePool ? "Finish launch" : "Launch campaign", {
          onSent: (signature, i) => {
            if (i !== txs.length - 1) return;
            sent.current = true;
            setPendingLaunch({ pool, signature, name: campaign.name, at: Date.now() });
          },
        });
        pending = { pool, signature, name: campaign.name, at: Date.now() };
      } catch (e) {
        // Landed but failed: the pool was never created. A confirm timeout keeps it (it may still land).
        const cause = e instanceof ReportedError ? e.cause : e;
        const failedOnChain = cause instanceof Error && /failed on-chain/i.test(cause.message);
        if (sent.current && failedOnChain) setPendingLaunch(null);
        // The config landed but the pool did not: launching again finishes it on that config.
        if (resumePool || (e instanceof ReportedError && e.landed > 0 && (!sent.current || failedOnChain))) setResumePool(pool);
        throw e;
      }
      setResumePool(null);
      setPendingLaunch(pending);
      setLaunching(false);
      await finishListing(pending, { publish: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setResumePool(null); // nothing left to resume: start over
      if (!(e instanceof ReportedError)) toast.error(e instanceof Error ? e.message : "Launch failed");
    } finally {
      setLaunching(false);
    }
  }

  const updateTier = (i: number, key: keyof TierInput, value: string) =>
    setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, [key]: value } : t)));

  return (
    <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
      <form
        className="flex flex-col gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          launch();
        }}
      >
        <fieldset className="grid gap-4">
          <legend className="mb-2 font-heading text-3xl">The product</legend>
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <div className="grid gap-2">
              <Label htmlFor="name">Product name</Label>
              <Input id="name" value={name} maxLength={NAME_MAX_BYTES} autoComplete="off" onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="symbol">Ticker</Label>
              <Input id="symbol" value={symbol} maxLength={10} autoComplete="off" className="font-mono uppercase" onChange={(e) => setSymbol(e.target.value.toUpperCase())} required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={DESCRIPTION_MAX_CHARS}
              className="rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="image">Image URL <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="image" type="url" inputMode="url" placeholder="https://…" maxLength={IMAGE_URL_MAX_CHARS} value={image} onChange={(e) => setImage(e.target.value)} />
          </div>
        </fieldset>

        <fieldset className="grid gap-4">
          <legend className="mb-2 font-heading text-3xl">Early-bird tiers</legend>
          <p className="-mt-2 text-sm text-muted-foreground">Price rises smoothly through each tier. Early backers pay the least.</p>
          {tiers.map((t, i) => (
            <div key={i} className="grid grid-cols-[auto_1fr_1fr_auto] items-end gap-3">
              <span className="pb-2 font-mono text-sm text-muted-foreground">T{i + 1}</span>
              <div className="grid gap-2">
                <Label htmlFor={`units-${i}`}>Units</Label>
                <Input id={`units-${i}`} type="number" inputMode="numeric" min={1} step={1} value={t.units} className="font-mono" onChange={(e) => updateTier(i, "units", e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`price-${i}`}>Starts at (USDC)</Label>
                <Input id={`price-${i}`} type="number" inputMode="decimal" min={0.01} step={0.01} value={t.startPrice} className="font-mono" onChange={(e) => updateTier(i, "startPrice", e.target.value)} />
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove tier ${i + 1}`} disabled={tiers.length === 1} onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}>
                <Minus aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={tiers.length >= MAX_TIERS}
              onClick={() => setTiers((ts) => [...ts, { units: "10", startPrice: String(num(finalPrice) || 1) }])}
            >
              <Plus aria-hidden="true" /> Add tier
            </Button>
            <div className="ml-auto grid w-40 gap-2">
              <Label htmlFor="final">Final price (USDC)</Label>
              <Input id="final" type="number" inputMode="decimal" min={0.01} step={0.01} value={finalPrice} className="font-mono" onChange={(e) => setFinalPrice(e.target.value)} />
            </div>
          </div>
        </fieldset>

        <fieldset className="grid gap-4">
          <legend className="mb-2 font-heading text-3xl">Protections</legend>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="share">Your upfront share of the raise</Label>
              <span className="font-mono text-sm">{effectiveShare}% <span className="text-muted-foreground">/ cap {cap}%</span></span>
            </div>
            <input id="share" type="range" min={0} max={cap} step={1} value={effectiveShare} onChange={(e) => setMakerShare(Number(e.target.value))} className="accent-primary" />
            <p className="text-xs text-muted-foreground">Paid to you when the goal is reached. The rest seeds the resale market. Your trust tier sets the cap.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="ship">Ships within (days of the goal)</Label>
              <Input id="ship" type="number" inputMode="numeric" min={SHIP_DAYS.min} max={SHIP_DAYS.max} step={1} value={shipDays} className="font-mono" onChange={(e) => setShipDays(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="unit-cost">Cost to make one (USDC) <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="unit-cost" type="number" inputMode="decimal" min={0} step={0.01} placeholder="e.g. 12" value={unitCost} className="font-mono" onChange={(e) => setUnitCost(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              The rest of your money unlocks from the resale pool after your ship date, faster for higher trust tiers. Only you see the unit cost.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="royalty">Resale royalty (%)</Label>
            <Input
              id="royalty"
              type="number"
              inputMode="decimal"
              min={RESALE_ROYALTY_BPS.min / 100}
              max={RESALE_ROYALTY_BPS.max / 100}
              step={0.25}
              value={royaltyPct}
              className="w-32 font-mono"
              onChange={(e) => setRoyaltyPct(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The fee on every resale trade after the goal, paid in USDC ({RESALE_ROYALTY_BPS.min / 100}–{RESALE_ROYALTY_BPS.max / 100}%). After Meteora&rsquo;s protocol share, your
              positions earn {100 - LP_SPLIT.partnerPermanentPct}% of it, and {Math.round((LP_SPLIT.creatorPermanentPct * 100) / (LP_SPLIT.creatorPermanentPct + LP_SPLIT.partnerPermanentPct))}% once your funds are unlocked.
            </p>
          </div>
          <div className="grid gap-2" role="radiogroup" aria-labelledby="drop-label">
            <span id="drop-label" className="text-sm font-medium">Drop-bot window</span>
            <div className="flex gap-2">
              {DROP_WINDOWS.map((w) => (
                <Button key={w.sec} type="button" role="radio" aria-checked={dropWindow === w.sec} variant={dropWindow === w.sec ? "default" : "secondary"} onClick={() => setDropWindow(w.sec)}>
                  {w.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Bots that rush the launch pay a {DROP_BOT_START_FEE_BPS / 100}% fee that falls to {NORMAL_FEE_BPS / 100}% over this window.</p>
          </div>
        </fieldset>

        <div className="flex flex-col gap-2">
          {pendingLaunch && !launching && (
            <FinishListing launch={pendingLaunch} busy={listing} onFinish={() => finishListing(pendingLaunch)} onDiscard={() => setPendingLaunch(null)} />
          )}
          <Button type="submit" size="lg" disabled={launching || listing || !!pendingLaunch || (!!publicKey && !resumePool && !!blocking)}>
            {!publicKey ? "Connect wallet to launch" : launching ? "Launching…" : resumePool ? "Finish launch" : "Launch campaign"}
          </Button>
          {resumePool && (
            <p className="text-sm text-muted-foreground" role="status">
              Step 1 landed: this campaign’s terms are on-chain. Finish launch creates its pool on them (one more approval); form edits no
              longer apply.
            </p>
          )}
          {publicKey && blocking && <p className="text-sm text-destructive" role="alert">{blocking}</p>}
        </div>
      </form>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start" aria-live="polite">
        <TrustCard
          preview={preview}
          loading={previewLoading && !preview}
          connected={!!publicKey}
          unavailable={!!preview?.trustUnavailable}
          error={previewQuery.isError ? previewQuery.error.message : null}
          retry={() => previewQuery.refetch()}
        />
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-heading text-2xl">What backers see</h2>
          {pricing.ok ? (
            <dl className="mt-4 grid grid-cols-2 gap-4">
              <Stat label="Funding goal" value={usd(pricing.ok.goalUsdc)} />
              <Stat label="Pre-order units" value={units(pricing.ok.preorderUnits)} />
              <Stat label="Your budget at goal" value={usd(pricing.ok.makerBudgetUsdc)} />
              <Stat label="Units to produce (max)" value={units(pricing.ok.totalUnits)} />
            </dl>
          ) : (
            <p className="mt-3 text-sm text-destructive" role="alert">{pricing.error}</p>
          )}
        </div>
        {pricing.ok && vesting && <PayoutCard pricing={pricing.ok} share={effectiveShare} vesting={vesting} unitCost={num(unitCost)} />}
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-heading text-2xl">On-chain config</h2>
          <p className="text-sm text-muted-foreground">Every input becomes a Meteora DBC setting. It can’t be changed after launch.</p>
          {preview?.fields.length ? (
            <ul className="mt-4 divide-y divide-border">
              {preview.fields.map((f) => (
                <li key={f.input} className="grid grid-cols-[8rem_1fr] gap-3 py-2 text-sm">
                  <span className="text-muted-foreground">{f.input}</span>
                  <span>
                    <span className="block">{f.value}</span>
                    <code className="font-mono text-xs [overflow-wrap:anywhere] text-primary">{f.dbcField}</code>
                  </span>
                </li>
              ))}
            </ul>
          ) : previewLoading ? (
            <div className="mt-4 grid gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : blocking ? (
            <p className="mt-3 text-sm text-muted-foreground">Fix the highlighted inputs to see the config.</p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">The config preview is unavailable right now.</p>
          )}
        </div>
      </aside>
    </div>
  );
}

// What the maker is paid and when, and what they may owe, assuming no resale trading.
function PayoutCard({ pricing, share, vesting, unitCost }: { pricing: PricingSummary; share: number; vesting: VestingSchedule; unitCost: number }) {
  const pct = makerPayoutPct(share, vesting);
  const maxUsdc = (pricing.goalUsdc * pct.max) / 100;
  const owed = unitsOwedAfterUnlock(pricing.preorderUnits, pricing.resaleUnits);
  const cover = (usdc: number, units: number) => `${Math.round((usdc / (units * unitCost)) * 100)}%`;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-heading text-2xl">Your payout</h2>
      <p className="mt-2 text-sm">
        You receive <span className="font-mono">{pct.atGoal}%</span> at goal · <span className="font-mono">{Math.round(pct.atFirstRelease)}%</span> from{" "}
        {formatAfterGoal(firstReleaseSec(vesting))} · up to <span className="font-mono">{Math.round(pct.max)}%</span> by {formatAfterGoal(vestingEndSec(vesting))} ·{" "}
        <span className="font-mono">{pct.permanentFloorPct}%</span> permanent resale floor
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <Stat label="At goal" value={usd(pricing.makerBudgetUsdc)} />
        <Stat label={`By ${formatAfterGoal(vestingEndSec(vesting))}`} value={usd(maxUsdc)} />
        <Stat label="Units owed at goal (max)" value={units(pricing.totalUnits)} />
        <Stat label="Owed once unlocked" value={units(owed)} />
      </dl>
      {unitCost > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Covers <span className="font-mono text-foreground">{cover(pricing.makerBudgetUsdc, pricing.preorderUnits)}</span> of the pre-orders’ cost at goal and{" "}
          <span className="font-mono text-foreground">{cover(maxUsdc, owed)}</span> of what you owe once fully unlocked.
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Unlocking withdraws your share of the resale pool and burns the vouchers in it, so they are no longer owed. Resale trading changes the amounts.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xl tabular-nums">{value}</dd>
    </div>
  );
}

function TrustCard({
  preview,
  loading,
  connected,
  unavailable,
  error,
  retry,
}: {
  preview: PreviewResponse | null;
  loading: boolean;
  connected: boolean;
  unavailable: boolean; // the server's trust lookup failed
  error: string | null; // the preview request itself failed (e.g. too many requests)
  retry: () => void;
}) {
  const trust = preview?.trust;
  const checkAgain = (
    <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={retry}>Check again</Button>
  );
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-heading text-2xl">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" /> Maker trust
        </h2>
        {trust && <Badge>Tier {trust.tier} · cap {trust.maxMakerSharePct}%</Badge>}
      </div>
      {!connected ? (
        <p className="mt-2 text-sm text-muted-foreground">Connect your wallet to see your tier. It’s scored from your wallet’s public mainnet history.</p>
      ) : loading ? (
        <div className="mt-3 grid gap-2"><Skeleton className="h-4" /><Skeleton className="h-4 w-2/3" /></div>
      ) : error && !trust ? (
        <div className="mt-2 text-sm" role="alert">
          <p className="text-muted-foreground">{error}</p>
          {checkAgain}
        </div>
      ) : unavailable && !trust ? (
        <div className="mt-2 text-sm" role="alert">
          <p className="text-muted-foreground">Your trust check is unavailable right now, so your tier and cap are unknown. Launching needs it.</p>
          {checkAgain}
        </div>
      ) : trust ? (
        <>
          <ul className="mt-3 grid gap-1 text-sm text-muted-foreground">
            {trust.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {trust.signals.partial && checkAgain}
        </>
      ) : null}
    </div>
  );
}
