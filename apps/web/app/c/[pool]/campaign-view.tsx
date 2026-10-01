"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Check, Coins, Copy, ExternalLink, Hourglass, Lock, Minus, Plus, ShieldCheck, Timer } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api, quoteErrorMessage, ReportedError, useSignAndSend, type BuiltTx } from "@/lib/client";
import { useDebounced } from "@/lib/use-debounced";
import { MakerPanel, ResalePanel } from "@/components/resale-panels";
import { RedeemPanel } from "@/components/redeem-panel";
import { IS_TEST_NETWORK, explorerAccount, short, units, unitsDown, usd } from "@/lib/format";
import { firstReleaseSec, formatAfterGoal, vestingEndSec } from "@preorder/core/src/vesting";
import { MAX_UNITS_PER_BUY, splitVouchers } from "@preorder/core/src/voucher-units";
import { imageSrc } from "@/lib/image-src";
import type { BuyQuote, CampaignWithLive, SellQuote, UnitsQuote } from "@/lib/types";

export function CampaignView({ pool }: { pool: string }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["campaign", pool],
    queryFn: () => api<{ campaign: CampaignWithLive }>(`/api/campaigns/${pool}`),
    refetchInterval: 5_000,
  });

  if (isPending) {
    return (
      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]" aria-busy="true" aria-label="Loading campaign">
        <Skeleton className="h-[28rem] rounded-xl" />
        <Skeleton className="h-[28rem] rounded-xl" />
      </div>
    );
  }
  // A failed poll keeps the last data on screen under a banner; only a first load that fails shows this.
  if (isError && !data) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="font-medium">Couldn’t load this campaign</p>
        <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" onClick={() => refetch()}>Try again</Button>
          <Button asChild variant="ghost"><Link href="/">All campaigns</Link></Button>
        </div>
      </div>
    );
  }
  return (
    <>
      {isError && (
        <p role="status" className="mb-4 rounded-lg border border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
          Live data is delayed. Showing the last update; it refreshes on its own.
        </p>
      )}
      <Loaded c={data.campaign} />
    </>
  );
}

function Loaded({ c }: { c: CampaignWithLive }) {
  const live = c.live!;
  const plan = c.campaign.plan;
  const unitsTotal = plan.tiers.reduce((a, t) => a + t.units, 0);
  const statusLabel = { funding: "Funding", funded: "Goal reached", reselling: "Funded · reselling" }[live.status];

  return (
    // Phones get title, then price and the back panel, then the details; wide screens keep the
    // panel in a sticky right column beside both.
    <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr] lg:grid-rows-[auto_1fr]">
      <div className="flex flex-col gap-6 lg:col-start-1 lg:row-start-1">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={live.status === "funding" ? "secondary" : "default"}>{statusLabel}</Badge>
            <Badge variant="outline" title="Scored from the maker’s wallet history on Solana. Higher levels can take more money upfront and get the rest sooner.">
              <ShieldCheck aria-hidden="true" /> Maker trust level {c.trust.tier}
            </Badge>
          </div>
          <h1 className="mt-3 font-heading text-5xl tracking-tight sm:text-6xl">{c.campaign.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            by{" "}
            <a href={explorerAccount(c.maker)} target="_blank" rel="noopener noreferrer" className="font-mono underline-offset-4 hover:underline">
              {short(c.maker)}
            </a>
            {c.listing?.official && (
              <>
                {" · "}
                <a href={explorerAccount(c.listing.address)} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
                  Listed on-chain
                </a>
              </>
            )}
          </p>
        </div>

        {c.campaign.image && (
          // eslint-disable-next-line @next/next/no-img-element -- maker-supplied URL
          <img src={imageSrc(c.campaign.image)} alt={c.campaign.name} className="aspect-[16/9] w-full rounded-xl border border-border object-cover" />
        )}
        {c.campaign.description && <p className="text-lg text-muted-foreground">{c.campaign.description}</p>}
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">{live.status === "reselling" ? "Final pre-order price" : "Price now"}</span>
            <span className="font-mono text-3xl tabular-nums">{usd(live.priceUsdc)}</span>
          </div>
          <Progress className="mt-4" value={Math.min(100, live.progress * 100)} aria-label={`${Math.round(live.progress * 100)}% funded`} />
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Raised</dt>
              <dd className="font-mono tabular-nums">{usd(live.raisedUsdc)} <span className="text-muted-foreground">/ {usd(live.goalUsdc)}</span></dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Pre-orders sold</dt>
              <dd className="font-mono tabular-nums">{units(live.unitsSold)} / {unitsTotal}</dd>
            </div>
          </dl>
        </div>
        <ActionPanel c={c} />
      </aside>

      <div className="flex flex-col gap-6 lg:col-start-1 lg:row-start-2">
        <HowItWorks c={c} />

        <section aria-labelledby="tiers-title" className="rounded-xl border border-border bg-card p-5">
          <h2 id="tiers-title" className="font-heading text-2xl">Early-bird tiers</h2>
          <ol className="mt-3 divide-y divide-border">
            {plan.tiers.map((t, i) => {
              const end = plan.tiers[i + 1]?.startPrice ?? plan.finalPrice;
              const current = live.status === "funding" && i === live.tierIndex;
              const done = live.status !== "funding" || i < live.tierIndex;
              return (
                <li key={i} className="flex items-center justify-between gap-3 py-3">
                  <span className="flex items-center gap-3">
                    <span className={`grid size-7 place-items-center rounded-full font-mono text-xs ${current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                      {done && !current ? <Check aria-hidden="true" className="size-3.5" /> : i + 1}
                    </span>
                    <span>
                      <span className="font-medium whitespace-nowrap">{t.units} units</span>
                      {current && <span className="ml-2 text-xs text-primary">Current tier</span>}
                    </span>
                  </span>
                  <span className="font-mono text-sm whitespace-nowrap tabular-nums">{usd(t.startPrice)} → {usd(end)}</span>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-labelledby="terms-title" className="rounded-xl border border-border bg-card p-5">
          <h2 id="terms-title" className="font-heading text-2xl">Locked-in terms</h2>
          <p className="text-sm text-muted-foreground">Set on-chain at launch. Nobody, including the maker, can change them.</p>
          <ul className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <Term icon={<Timer aria-hidden="true" />} title="Launch-rush protection" body={`For the first ${Math.round(c.campaign.dropBot.windowSec / 60)} min, buying costs an extra fee that starts at ${c.campaign.dropBot.startFeeBps / 100}% and falls to ${c.campaign.normalFeeBps / 100}%, so bots can’t grab the cheap items.`} />
            <Term icon={<Lock aria-hidden="true" />} title="Limited edition" body={`At most ${units(c.totalUnits)} vouchers will ever exist. Nobody can create more.`} />
            <Term icon={<ShieldCheck aria-hidden="true" />} title="Maker’s upfront share" body={`${plan.makerSharePct}% of the money raised is paid to the maker when the goal is reached. The rest is released after shipping. (Trust level ${c.trust.tier} allows up to ${c.trust.maxMakerSharePct}%.)`} />
            <ResaleTerms c={c} />
          </ul>
          <a href={explorerAccount(c.config)} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
            Verify the config on-chain <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </section>
      </div>
    </div>
  );
}

// The whole deal in three plain sentences, for someone who has never seen a bonding curve.
function HowItWorks({ c }: { c: CampaignWithLive }) {
  const live = c.live!;
  const funded = live.status !== "funding";
  const days = c.campaign.shipDays;
  const steps: { title: string; body: string; done: boolean }[] = [
    {
      title: funded ? "Backed" : "You back it",
      body: funded
        ? "Backers paid in early, and the earliest paid the least. Each pre-order is a voucher for one item."
        : `You pay today’s price of ${usd(live.priceUsdc)} and get a voucher for one item. The price rises as more people join, so earlier is cheaper.`,
      done: funded,
    },
    {
      title: funded ? "Goal reached" : `At ${usd(live.goalUsdc, Number.isInteger(live.goalUsdc) ? 0 : 2)} raised, it’s funded`,
      body: funded
        ? `${c.campaign.name} is funded. The maker has their production money and is making it.`
        : `The maker gets paid and starts making ${c.campaign.name}. Until then, you can sell your voucher back at the current price.`,
      done: funded,
    },
    {
      title: days ? `It ships within ${days} days of the goal` : "You claim your item",
      body: days
        ? `${live.status === "reselling" ? "Redeem your voucher below" : "After the goal you redeem your voucher"} and enter your address to get your item. Prefer not to wait? Resell the voucher to someone else.`
        : "The maker didn’t set a ship date on this older campaign. After the goal you redeem your voucher and enter your address to get your item.",
      done: false,
    },
  ];
  return (
    <section aria-labelledby="how-title" className="rounded-xl border border-border bg-card p-5">
      <h2 id="how-title" className="font-heading text-2xl">How this pre-order works</h2>
      <ol className="mt-3 grid gap-4">
        {steps.map((st, i) => (
          <li key={st.title} className="flex gap-3">
            <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full font-mono text-xs ${st.done ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
              {st.done ? <Check aria-hidden="true" className="size-3.5" /> : i + 1}
            </span>
            <span>
              <span className="block font-medium">{st.title}</span>
              <span className="text-sm text-muted-foreground">{st.body}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// From the on-chain config. Campaigns created before ship-window vesting lock all resale liquidity.
function ResaleTerms({ c }: { c: CampaignWithLive }) {
  const t = c.terms;
  if (!t) {
    // The config read failed (e.g. a rate-limited RPC): unknown is not the same as "all locked".
    return (
      <>
        <Term icon={<Lock aria-hidden="true" />} title="Resale market" body="How resale liquidity is split and locked is fixed in this campaign’s on-chain config. Verify it below." />
        <RoyaltyTerm c={c} />
      </>
    );
  }
  if (!t.vesting) {
    return (
      <>
        <Term icon={<Lock aria-hidden="true" />} title="Resale market" body="100% of resale liquidity is locked forever. The maker’s locked position earns a share of every resale fee." />
        <RoyaltyTerm c={c} />
      </>
    );
  }
  const floor = t.partnerPermanentPct + t.creatorPermanentPct;
  const ship = c.campaign.shipDays ? `The maker promised to ship within ${c.campaign.shipDays} days of the goal. ` : "";
  return (
    <>
      <Term
        icon={<Hourglass aria-hidden="true" />}
        title="Ship window"
        body={`${ship}The maker’s production money (${t.creatorVestingPct}% of the resale pool) is released in steps from ${formatAfterGoal(firstReleaseSec(t.vesting))} to ${formatAfterGoal(vestingEndSec(t.vesting))}. Until then it stays in the pool, backing the resale market.`}
      />
      <Term
        icon={<Lock aria-hidden="true" />}
        title="Resale floor"
        body={`${floor}% of the resale pool is locked forever, so vouchers always have a buyer.`}
      />
      <RoyaltyTerm c={c} />
    </>
  );
}

// The resale pool fee (the maker's royalty), from the DBC config. Its split follows the liquidity terms,
// left out when they could not be read.
function RoyaltyTerm({ c }: { c: CampaignWithLive }) {
  const fee = c.resaleFee;
  const t = c.terms;
  if (!fee) return null;
  const charge = `Every resale pays a ${fee.poolFeeBps / 100}% fee in USDC${fee.dynamicFee ? ", more when the price moves fast" : ""}.`;
  if (!t) return <Term icon={<Coins aria-hidden="true" />} title="Resale royalty" body={`${charge} After Meteora’s protocol share, it goes to the resale pool’s liquidity positions, the maker’s included.`} />;
  const maker = t.creatorPermanentPct + t.creatorVestingPct + t.creatorUnlockedPct;
  const split = t.creatorVestingPct
    ? `the maker’s positions earn ${maker}% of what is left at graduation and ${Math.round((t.creatorPermanentPct * 100) / (t.creatorPermanentPct + t.partnerPermanentPct))}% once fully unlocked`
    : `the maker’s positions earn ${maker}% of what is left`;
  return (
    <Term
      icon={<Coins aria-hidden="true" />}
      title="Resale royalty"
      body={`${charge} After Meteora’s protocol share, ${split}.`}
    />
  );
}

function Term({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 text-primary [&_svg]:size-4">{icon}</span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="text-muted-foreground">{body}</span>
      </span>
    </li>
  );
}

function useBalances(c: CampaignWithLive) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["balances", c.pool, publicKey?.toBase58()],
    enabled: !!publicKey,
    refetchInterval: 6_000,
    queryFn: async () => {
      // null: no token account yet. Any other RPC error fails the query, which keeps the last balances.
      const read = async (mint: string) => {
        const ata = getAssociatedTokenAddressSync(new PublicKey(mint), publicKey!);
        return connection.getTokenAccountBalance(ata).then(
          (bal) => bal.value,
          (e: unknown) => {
            if (e instanceof Error && /could not find account/i.test(e.message)) return null;
            throw e;
          },
        );
      };
      const [vouchers, usdc] = await Promise.all([read(c.baseMint), read(c.usdcMint)]);
      return {
        vouchers: Number(vouchers?.uiAmount ?? 0),
        vouchersText: vouchers?.uiAmountString ?? "0", // full precision, for "you hold" and "All (…)"
        vouchersRaw: vouchers?.amount ?? "0", // exact, for whole units and the fraction left over
        usdc: Number(usdc?.uiAmount ?? 0),
        // Referral fees are paid into the sharer's USDC account; until it exists, a referred buy pays none.
        hasUsdcAccount: usdc !== null,
      };
    },
  });
}

// The wallet's USDC under a buy form; when it can't cover the buy, says where to get more.
function WalletUsdc({ usdc, short }: { usdc: number; short: boolean }) {
  return (
    <p className={`text-xs ${short ? "text-destructive" : "text-muted-foreground"}`}>
      {short ? "You have " : "Wallet: "}
      <span className="font-mono">{usd(usdc)}</span> USDC
      {short && (IS_TEST_NETWORK ? ". Get some with “Get test USDC” at the top." : ". Add USDC to your wallet to back this.")}
    </p>
  );
}

function ActionPanel({ c }: { c: CampaignWithLive }) {
  const live = c.live!;
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const signAndSend = useSignAndSend();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref") ?? undefined;
  const balances = useBalances(c);
  const [unitsInput, setUnitsInput] = useState("1");
  const [amount, setAmount] = useState("10");
  const [exitAmount, setExitAmount] = useState(""); // empty = the whole balance
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [listed, setListed] = useState(false); // published from this page; the server re-reads it within a minute

  const usdcAmount = Number(amount);
  const debouncedAmount = useDebounced(usdcAmount, 350);
  const quoteEnabled = live.status === "funding" && debouncedAmount > 0;
  const { data: quoteData, error: quoteError } = useQuery({
    queryKey: ["quote", c.pool, debouncedAmount, live.raisedUsdc],
    queryFn: () => api<BuyQuote>("/api/quote", { pool: c.pool, usdc: debouncedAmount }),
    enabled: quoteEnabled,
    retry: false,
  });
  const quote = quoteEnabled ? quoteData ?? null : null;
  // What the buy would take: all of it, or only what is left to the goal.
  const needUsdc = quote?.capped ? quote.spentUsdc : usdcAmount;
  const shortOfUsdc = !!publicKey && !!balances.data && usdcAmount > 0 && balances.data.usdc < needUsdc;

  const isMaker = publicKey?.toBase58() === c.maker;
  const vouchers = balances.data?.vouchers ?? 0;
  const vouchersText = balances.data?.vouchersText ?? "0";
  const exitVouchers = exitAmount === "" ? vouchers : Number(exitAmount);
  const exitTooMuch = exitVouchers > vouchers;
  const debouncedExit = useDebounced(exitVouchers, 350);
  const sellQuoteEnabled = live.status === "funding" && debouncedExit > 0 && debouncedExit <= vouchers;
  const { data: sellQuoteData, error: sellQuoteError } = useQuery({
    queryKey: ["sellQuote", c.pool, debouncedExit, live.raisedUsdc],
    queryFn: () => api<SellQuote>("/api/quote", { pool: c.pool, side: "sell", vouchers: debouncedExit }),
    enabled: sellQuoteEnabled,
    retry: false,
  });
  const sellQuote = sellQuoteEnabled ? sellQuoteData ?? null : null;

  // Whole units: the default way to back. The quote also says how many units are left.
  const unitCount = Number(unitsInput);
  const unitsValid = Number.isInteger(unitCount) && unitCount >= 1 && unitCount <= MAX_UNITS_PER_BUY;
  const debouncedUnits = useDebounced(unitsValid ? unitCount : 0, 250);
  const unitsQuoteEnabled = live.status === "funding" && debouncedUnits > 0;
  const { data: unitsQuoteData, error: unitsQuoteError } = useQuery({
    queryKey: ["quote-units", c.pool, debouncedUnits, live.raisedUsdc],
    queryFn: () => api<UnitsQuote>("/api/quote/units", { pool: c.pool, units: debouncedUnits }),
    enabled: unitsQuoteEnabled,
    retry: false,
  });
  const unitsQuote = unitsQuoteEnabled && debouncedUnits === unitCount ? unitsQuoteData ?? null : null;
  // Until the quote answers, cap the stepper by what live state says is left (the server's own cap).
  const unitsLeft = c.campaign.plan.tiers.reduce((a, t) => a + t.units, 0) - live.unitsSold;
  const maxUnits = unitsQuoteData?.maxUnits ?? Math.min(MAX_UNITS_PER_BUY, Math.max(1, Math.floor(unitsLeft)));
  // The most the units buy may spend, against the wallet (like shortOfUsdc for a dollar amount).
  const shortForUnits = !!publicKey && !!balances.data && !!unitsQuote && balances.data.usdc < unitsQuote.maxUsdc;
  const stepUnits = (delta: number) => setUnitsInput(String(Math.min(maxUnits, Math.max(1, (unitsValid ? unitCount : 1) + delta))));

  // A fractional balance (from a USDC-amount buy) can't be redeemed alone; offer to top it up.
  const held = splitVouchers(BigInt(balances.data?.vouchersRaw ?? "0"));
  const topUpEnabled = live.status === "funding" && !!publicKey && held.fractionRaw > BigInt(0);
  const { data: topUpData } = useQuery({
    queryKey: ["quote-topup", c.pool, publicKey?.toBase58(), balances.data?.vouchersRaw, live.raisedUsdc],
    queryFn: () => api<UnitsQuote>("/api/quote/units", { pool: c.pool, wallet: publicKey!.toBase58(), topUp: true }),
    enabled: topUpEnabled,
    retry: false,
  });
  const topUp = topUpEnabled ? topUpData ?? null : null;
  // Near the goal a top-up takes everything left (it would strand less than one unit otherwise).
  const topUpLabel = topUp?.completesGoal ? `Back the last ${unitsDown(topUp.vouchers)}` : `Top up to ${held.whole + 1}`;

  const refresh = () => {
    // Live state is cached for a few seconds server-side: read it once fresh so the raise and units move
    // as soon as the wallet's trade confirms (falls back to a normal refetch if that is rate-limited).
    api<{ campaign: CampaignWithLive }>(`/api/campaigns/${c.pool}?fresh=1`)
      .then((d) => queryClient.setQueryData(["campaign", c.pool], d))
      .catch(() => queryClient.invalidateQueries({ queryKey: ["campaign", c.pool] }));
    queryClient.invalidateQueries({ queryKey: ["balances", c.pool] });
    queryClient.invalidateQueries({ queryKey: ["resale", c.pool] });
  };

  // `busyKey` tells apart two buttons that send the same kind (backing units and topping up).
  async function run(
    kind: "buy" | "buyUnits" | "sell" | "redeem" | "withdraw" | "claim" | "unlock" | "resaleBuy" | "resaleSell",
    label: string,
    extra: Record<string, unknown> = {},
    busyKey: string = kind,
  ) {
    if (!publicKey) return setVisible(true);
    setBusy(busyKey);
    try {
      const build = () => api<BuiltTx & { quote?: BuyQuote }>("/api/tx", { kind, pool: c.pool, wallet: publicKey.toBase58(), ...extra });
      const built = await build();
      // The last buy before the goal only takes what is left; say so in the toasts.
      if (kind === "buy" && built.quote?.capped) label = `${label} with ${usd(built.quote.spentUsdc)}: the goal is reached`;
      await signAndSend(built, label, build);
      if (kind === "sell") setExitAmount("");
      refresh();
    } catch (e) {
      if (!(e instanceof ReportedError)) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // The clicking wallet pays for graduation. Meteora's keeper or another wallet may graduate the pool
  // first: the server then answers `already`, and a send that fails because of it still ends in the
  // resale market (its error toast is replaced, not stacked). Reads after it skip the server's
  // few-second cache (?fresh=1), which may not have seen the graduation yet.
  async function graduate() {
    if (!publicKey) return setVisible(true);
    setBusy("migrate");
    const alreadyDone = (id?: string | number) => toast.success("Already graduated. The resale market is open.", { id });
    const readFresh = () => api<{ campaign: CampaignWithLive }>(`/api/campaigns/${c.pool}?fresh=1`).catch(() => null);
    try {
      const build = () => api<Partial<BuiltTx> & { already?: boolean }>(`/api/campaigns/${c.pool}/migrate`, { wallet: publicKey.toBase58() });
      const built = await build();
      if (built.already || !built.tx) alreadyDone();
      else {
        await signAndSend(built as BuiltTx, "Graduate to the resale market", async () => {
          const again = await build();
          if (again.already || !again.tx) throw new Error("Already graduated"); // handled below as already done
          return again as BuiltTx;
        });
        await readFresh(); // the server's cache now shows the resale market to everyone
      }
      refresh();
    } catch (e) {
      const now = await readFresh();
      if (now?.campaign.live?.status === "reselling") {
        alreadyDone(e instanceof ReportedError ? e.toastId : undefined);
        refresh();
      } else if (e instanceof Error && !(e instanceof ReportedError)) toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  // The maker's on-chain listing (DBC pool metadata), when it wasn't sent right after create.
  async function publishListing() {
    if (!publicKey) return setVisible(true);
    setBusy("listing");
    try {
      const built = await api<BuiltTx>(`/api/campaigns/${c.pool}/listing`, { wallet: publicKey.toBase58() });
      await signAndSend(built, "Publish on-chain listing");
      setListed(true);
      refresh();
    } catch (e) {
      if (!(e instanceof ReportedError)) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function copyShare() {
    const url = new URL(window.location.href);
    // Always tag the link: the server checks the referrer's USDC account at each buy, so a link copied
    // before the sharer holds USDC starts earning once they do.
    url.search = publicKey ? `?ref=${publicKey.toBase58()}` : "";
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-4">
      {live.status === "funding" && (
        <div className="rounded-xl border border-border bg-card p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const what = unitsQuote?.completesGoal ? `the last ${unitsDown(unitsQuote.vouchers)}` : `${unitCount} unit${unitCount === 1 ? "" : "s"}`;
              run("buyUnits", `Back ${what} of ${c.campaign.name}`, { units: unitCount, ref });
            }}
          >
            <Label htmlFor="units">Pre-order units</Label>
            <p className="mt-1 text-xs text-muted-foreground">Each unit is one voucher, redeemable for one item.</p>
            <div className="mt-2 flex gap-2">
              <div className="flex items-center rounded-md border border-input">
                <Button type="button" variant="ghost" size="icon" aria-label="One unit fewer" onClick={() => stepUnits(-1)} disabled={!unitsValid || unitCount <= 1}>
                  <Minus aria-hidden="true" />
                </Button>
                <Input
                  id="units"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={maxUnits}
                  step={1}
                  value={unitsInput}
                  onChange={(e) => setUnitsInput(e.target.value)}
                  aria-invalid={!unitsValid}
                  className="w-14 border-0 text-center font-mono shadow-none focus-visible:ring-0"
                />
                <Button type="button" variant="ghost" size="icon" aria-label="One unit more" onClick={() => stepUnits(1)} disabled={unitsValid && unitCount >= maxUnits}>
                  <Plus aria-hidden="true" />
                </Button>
              </div>
              <Button type="submit" className="flex-1" disabled={!!busy || !unitsValid || (!!unitsQuoteData && unitCount > maxUnits) || shortForUnits}>
                {busy === "buyUnits"
                  ? "Backing…"
                  : unitsQuote
                    ? `Back ${unitsQuote.completesGoal ? `the last ${unitsDown(unitsQuote.vouchers)}` : unitCount} · ${usd(unitsQuote.usdc)}`
                    : `Back ${unitsValid ? unitCount : ""}`}
              </Button>
            </div>
            <p className="mt-2 min-h-5 text-sm text-muted-foreground" aria-live="polite">
              {!unitsValid ? (
                <span className="text-destructive">Pick a whole number of units</span>
              ) : unitsQuote ? (
                <>
                  ≈ <span className="font-mono text-foreground">{usd(unitsQuote.usdc)}</span> · fee{" "}
                  <span className={`font-mono ${unitsQuote.feePct > 5 ? "text-primary" : ""}`}>{unitsQuote.feePct.toFixed(1)}%</span>
                  {unitsQuote.feePct > 5 && " (launch fee still high)"} · at most <span className="font-mono">{usd(unitsQuote.maxUsdc)}</span>
                  {unitsQuote.completesGoal && <> · completes the goal with {unitsDown(unitsQuote.vouchers)} vouchers</>}
                </>
              ) : unitsQuoteError && debouncedUnits === unitCount ? (
                <span className="text-destructive">{quoteErrorMessage(unitsQuoteError)}</span>
              ) : null}
            </p>
            {publicKey && balances.data && <WalletUsdc usdc={balances.data.usdc} short={shortForUnits} />}
          </form>

          <details className="mt-4 border-t border-border pt-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">Advanced: back with a USDC amount</summary>
            <form
              className="mt-3"
              onSubmit={(e) => {
                e.preventDefault();
                run("buy", `Back ${c.campaign.name}`, { usdc: usdcAmount, ref });
              }}
            >
              <Label htmlFor="amount">Back with (USDC)</Label>
              <div className="mt-2 flex gap-2">
                <Input id="amount" type="number" inputMode="decimal" min={0.01} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" />
                <Button type="submit" variant="secondary" disabled={!!busy || !(usdcAmount > 0) || shortOfUsdc}>
                  {busy === "buy" ? "Backing…" : "Back this"}
                </Button>
              </div>
              <p className="mt-2 min-h-5 text-sm text-muted-foreground" aria-live="polite">
                {quoteEnabled && quoteError ? (
                  <span className="text-destructive">{quoteErrorMessage(quoteError)}</span>
                ) : quote ? (
                  <>
                    {quote.capped && (
                      <>
                        Only <span className="font-mono text-foreground">{usd(quote.spentUsdc)}</span> left to the goal: you’ll spend that, the rest stays in your wallet.{" "}
                      </>
                    )}
                    ≈ <span className="font-mono text-foreground">{units(quote.vouchers)}</span> vouchers (at least {units(quote.minVouchers)}) · fee{" "}
                    <span className={`font-mono ${quote.feePct > 5 ? "text-primary" : ""}`}>{quote.feePct.toFixed(1)}%</span>
                    {quote.feePct > 5 && " (drop-bot window still open)"}
                  </>
                ) : null}
              </p>
              {publicKey && balances.data && shortOfUsdc && <WalletUsdc usdc={balances.data.usdc} short />}
              <p className="text-xs text-muted-foreground">A dollar amount usually buys a fraction of a voucher. Only whole vouchers redeem for an item.</p>
            </form>
          </details>
        </div>
      )}

      {live.status === "funded" && (
        <div className="rounded-xl border border-primary/50 bg-card p-5">
          <p className="font-heading text-2xl">Goal reached</p>
          <p className="mt-1 text-sm text-muted-foreground">Graduate the campaign to fund the maker and open the resale market. Anyone can do it; your wallet pays the network fee and rent (about 0.033 SOL).</p>
          <Button className="mt-4 w-full" onClick={graduate} disabled={!!busy}>{busy === "migrate" ? "Graduating…" : "Graduate now"}</Button>
        </div>
      )}

      {/* Keyed on the wallet: a switch drops a half-filled form and any "Order placed" from the last one.
          The maker's own vouchers are not orders. */}
      {live.status === "reselling" && publicKey && !isMaker && <RedeemPanel key={publicKey.toBase58()} c={c} vouchers={vouchers} onDone={refresh} />}

      {live.status === "reselling" && <ResalePanel c={c} run={run} busy={busy} vouchers={vouchers} />}

      {isMaker && <MakerPanel c={c} run={run} busy={busy} />}

      {isMaker && c.listing === null && !listed && (
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="font-medium">On-chain listing</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Publish the campaign’s name, page and image in its DBC pool metadata, so anyone reading the pool on chain finds this page. You pay a little SOL
            for the account.
          </p>
          <Button className="mt-4 w-full" variant="secondary" onClick={publishListing} disabled={!!busy}>
            {busy === "listing" ? "Publishing…" : "Publish listing"}
          </Button>
        </div>
      )}

      {publicKey && vouchers > 0 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">Your vouchers</span>
            <span className="font-mono text-2xl tabular-nums">{held.whole}</span>
          </div>
          {held.fractionRaw > BigInt(0) && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                + <span className="font-mono">{held.fraction.toFixed(6).replace(/0+$/, "")}</span> of a voucher, not redeemable alone
              </span>
              {live.status === "funding" && (
                <Button size="sm" variant="secondary" onClick={() => run("buyUnits", topUpLabel, { topUp: true, ref }, "topUp")} disabled={!!busy}>
                  {busy === "topUp"
                    ? "Topping up…"
                    : `${topUpLabel}${topUp ? ` · ${usd(topUp.usdc)}` : ""}${topUp?.completesGoal ? " (completes the goal)" : ""}`}
                </Button>
              )}
            </div>
          )}
          <div className="mt-4 grid gap-2 empty:hidden">
            {live.status === "funding" && (
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  // No amount = the exact on-chain balance, so "all" never leaves dust behind.
                  run("sell", `Exit ${units(exitVouchers)} vouchers`, exitAmount === "" ? {} : { vouchers: exitVouchers });
                }}
              >
                <Label htmlFor="exit-amount">Exit with (vouchers)</Label>
                <div className="flex gap-2">
                  <Input
                    id="exit-amount"
                    type="number"
                    inputMode="decimal"
                    min={0.000001}
                    step="any"
                    placeholder={`All (${vouchersText})`}
                    value={exitAmount}
                    onChange={(e) => setExitAmount(e.target.value)}
                    className="font-mono"
                  />
                  <Button type="submit" variant="secondary" disabled={!!busy || !(exitVouchers > 0) || exitTooMuch}>
                    {busy === "sell" ? "Exiting…" : "Exit"}
                  </Button>
                </div>
                <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
                  {exitTooMuch ? (
                    <span className="text-destructive">You hold {vouchersText} vouchers.</span>
                  ) : sellQuoteEnabled && sellQuoteError ? (
                    <span className="text-destructive">{quoteErrorMessage(sellQuoteError)}</span>
                  ) : sellQuote ? (
                    <>
                      ≈ <span className="font-mono text-foreground">{usd(sellQuote.usdc)}</span> (at least {usd(sellQuote.minUsdc)}) · fee{" "}
                      <span className={`font-mono ${sellQuote.feePct > 5 ? "text-primary" : ""}`}>{sellQuote.feePct.toFixed(1)}%</span>
                    </>
                  ) : null}
                </p>
              </form>
            )}
          </div>
          {live.status === "funding" && <p className="mt-2 text-xs text-muted-foreground">Exiting sells back at today’s curve price, which may be higher or lower than what you paid.</p>}
        </div>
      )}

      <Button variant="ghost" onClick={copyShare}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "Link copied" : publicKey ? "Copy your referral link" : "Copy link"}
      </Button>
      {publicKey && balances.data?.hasUsdcAccount === false && (
        <p className="-mt-2 text-center text-xs text-muted-foreground">Referral fees are paid in USDC: you start earning them once your wallet holds USDC.</p>
      )}
    </div>
  );
}
