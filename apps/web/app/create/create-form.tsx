"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { priceTiers, type TierPlan } from "@preorder/core/src/pricing";
import { DEFAULT_DROP_BOT_WINDOW_SEC, DROP_BOT_START_FEE_BPS, DROP_BOT_WINDOWS_SEC, NORMAL_FEE_BPS } from "@preorder/core/src/campaign-input";
import { RESALE_ROYALTY_BPS } from "@preorder/core/src/royalty";
import { LP_SPLIT, SHIP_DAYS, vestingSchedule } from "@preorder/core/src/vesting";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, ReportedError, useSignAndSendAll, type BuiltTx } from "@/lib/client";
import { useDebounced } from "@/lib/use-debounced";
import { confirmLaunch, setPendingLaunch, usePendingLaunch, type PendingLaunch } from "@/lib/pending-launch";
import { FinishListing } from "./finish-listing";
import type { Campaign, PreviewResponse } from "@/lib/types";
import { AdvancedSettings, CampaignPreview, PayoutStep, PriceStep, ProductStep, ReviewStep, StepIndicator, STEP_LABELS, deriveTicker, type TierInput } from "./steps";

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
  // The short code is made from the product name until the maker edits it (under Advanced settings).
  const [symbolInput, setSymbolInput] = useState<string | null>(null);
  const symbol = symbolInput ?? deriveTicker(name);
  const [makerName, setMakerName] = useState("");
  const [description, setDescription] = useState("Heavyweight cotton hoodie, printed after the goal is reached.");
  const [image, setImage] = useState("");
  // A local copy of an uploaded photo, shown at once (the uploaded URL is what the campaign stores).
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const changeImage = (url: string, previewSrc: string | null) => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImage(url);
    setImagePreview(previewSrc);
  };
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
  const [step, setStep] = useState(1);
  const [maxStep, setMaxStep] = useState(1);
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
      makerName: makerName.trim() || undefined,
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
    [name, symbol, description, makerName, image, tiers, finalPrice, effectiveShare, dropWindow, shipDays, royaltyPct],
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
  const previewKey = JSON.stringify({ campaign, maker: publicKey?.toBase58() });
  const previewInput = useDebounced(previewKey, 450);
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

  const shipDaysValid = Number.isInteger(num(shipDays)) && num(shipDays) >= SHIP_DAYS.min && num(shipDays) <= SHIP_DAYS.max;
  // Whether the step the maker is on is filled in well enough to continue.
  const stepReady = step === 1 ? !!name.trim() && /^[A-Z0-9]{1,10}$/.test(symbol) : step === 2 ? !!pricing.ok : step === 3 ? shipDaysValid && !preview?.error : true;
  const go = (n: number) => {
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  };
  const markResume = (pool: string) => {
    setResumePool(pool);
    go(4); // form edits no longer apply; the review step has the Finish launch button
  };

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
        if (resumePool || (e instanceof ReportedError && e.landed > 0 && (!sent.current || failedOnChain))) markResume(pool);
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

  const tier = preview?.trust?.tier ?? null;
  const onFinalStep = step === 4;

  const trustCard = (
    <TrustCard
      preview={preview}
      loading={previewLoading && !preview}
      connected={!!publicKey}
      unavailable={!!preview?.trustUnavailable}
      error={previewQuery.isError ? previewQuery.error.message : null}
      retry={() => previewQuery.refetch()}
    />
  );
  const advanced = (
    <AdvancedSettings
      symbol={symbol}
      setSymbol={setSymbolInput}
      royaltyPct={royaltyPct}
      setRoyaltyPct={setRoyaltyPct}
      dropWindow={dropWindow}
      setDropWindow={setDropWindow}
      dropWindows={DROP_WINDOWS}
      yourShareOfRoyaltyPct={100 - LP_SPLIT.partnerPermanentPct}
    />
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
      <form
        className="flex flex-col gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (!onFinalStep) {
            if (stepReady) go(step + 1); // Enter in a field moves on; it never launches early
            return;
          }
          launch();
        }}
      >
        <StepIndicator step={step} maxStep={maxStep} onGo={go} />

        {step === 1 && <ProductStep name={name} setName={setName} makerName={makerName} setMakerName={setMakerName} description={description} setDescription={setDescription} image={image} imagePreview={imagePreview} setImage={changeImage} />}
        {step === 2 && (
          <PriceStep
            tiers={tiers}
            updateTier={updateTier}
            addTier={() => setTiers((ts) => [...ts, { units: "10", startPrice: String(num(finalPrice) || 1) }])}
            removeTier={(i) => setTiers((ts) => ts.filter((_, j) => j !== i))}
            finalPrice={finalPrice}
            setFinalPrice={setFinalPrice}
            pricing={pricing}
          />
        )}
        {step === 3 && (
          <PayoutStep
            shipDays={shipDays}
            setShipDays={setShipDays}
            share={effectiveShare}
            setShare={setMakerShare}
            cap={cap}
            unitCost={unitCost}
            setUnitCost={setUnitCost}
            pricing={pricing.ok}
            vesting={vesting}
            trust={trustCard}
            advanced={advanced}
          />
        )}
        {step === 4 && (
          <ReviewStep
            name={name}
            pricing={pricing.ok}
            share={effectiveShare}
            shipDays={shipDays}
            trust={preview?.trust ?? null}
            vesting={vesting}
            royaltyPct={royaltyPct}
            dropWindowMin={dropWindow / 60}
            fields={preview?.fields ?? []}
            trustCard={trustCard}
            edit={go}
          />
        )}

        <div className="flex flex-col gap-3">
          {pendingLaunch && !launching && (
            <FinishListing launch={pendingLaunch} busy={listing} onFinish={() => finishListing(pendingLaunch)} onDiscard={() => setPendingLaunch(null)} />
          )}
          {resumePool && (
            <p className="text-sm text-muted-foreground" role="status">
              Step 1 landed: this campaign’s terms are on-chain. Finish launch creates its pool on them (one more approval); form edits no
              longer apply.
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" disabled={step === 1 || launching} onClick={() => go(step - 1)}>
              Back
            </Button>
            {onFinalStep ? (
              <Button type="submit" size="lg" disabled={launching || listing || !!pendingLaunch || (!!publicKey && !resumePool && !!blocking)}>
                {!publicKey ? "Connect wallet to launch" : launching ? "Launching…" : resumePool ? "Finish launch" : "Launch campaign"}
              </Button>
            ) : (
              <Button type="submit" size="lg" disabled={!stepReady}>
                Continue to {STEP_LABELS[step].toLowerCase()}
              </Button>
            )}
          </div>
          {onFinalStep && publicKey && blocking && <p className="text-sm text-destructive" role="alert">{blocking}</p>}
        </div>
      </form>

      <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Live preview">
        <CampaignPreview name={name} makerName={makerName} description={description} image={imagePreview ?? image} pricing={pricing.ok} shipDays={shipDays} tier={tier} />
      </aside>
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
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" /> Your trust level
        </h2>
        {trust && <Badge>Level {trust.tier} · up to {trust.maxMakerSharePct}% upfront</Badge>}
      </div>
      {!connected ? (
        <p className="mt-2 text-sm text-muted-foreground">Connect your wallet to see your trust level. We score it from your wallet’s public history on Solana. Older, more active wallets can take more of the money upfront and get the rest sooner.</p>
      ) : loading ? (
        <div className="mt-3 grid gap-2"><Skeleton className="h-4" /><Skeleton className="h-4 w-2/3" /></div>
      ) : error && !trust ? (
        <div className="mt-2 text-sm" role="alert">
          <p className="text-muted-foreground">{error}</p>
          {checkAgain}
        </div>
      ) : unavailable && !trust ? (
        <div className="mt-2 text-sm" role="alert">
          <p className="text-muted-foreground">Your trust check is unavailable right now, so your level is unknown. Launching needs it.</p>
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
