"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Check, Copy, ExternalLink, Lock, ShieldCheck, Timer } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useSignAndSend, type BuiltTx } from "@/lib/client";
import { useDebounced } from "@/lib/use-debounced";
import { MakerPanel, ResalePanel } from "@/components/resale-panels";
import { explorerAccount, short, units, usd } from "@/lib/format";
import type { CampaignWithLive } from "@/lib/types";

type Quote = { vouchers: number; feeUsdc: number; feePct: number; minVouchers: number };

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
  if (isError) {
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
  return <Loaded c={data.campaign} />;
}

function Loaded({ c }: { c: CampaignWithLive }) {
  const live = c.live!;
  const plan = c.campaign.plan;
  const unitsTotal = plan.tiers.reduce((a, t) => a + t.units, 0);
  const statusLabel = { funding: "Funding", funded: "Goal reached", reselling: "Funded · reselling" }[live.status];

  return (
    <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={live.status === "funding" ? "secondary" : "default"}>{statusLabel}</Badge>
            <Badge variant="outline">
              <ShieldCheck aria-hidden="true" /> Maker tier {c.trust.tier}
            </Badge>
          </div>
          <h1 className="mt-3 font-heading text-5xl tracking-tight sm:text-6xl">{c.campaign.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            by{" "}
            <a href={explorerAccount(c.maker)} target="_blank" rel="noopener noreferrer" className="font-mono underline-offset-4 hover:underline">
              {short(c.maker)}
            </a>
          </p>
        </div>

        {c.campaign.image && (
          // eslint-disable-next-line @next/next/no-img-element -- maker-supplied URL
          <img src={c.campaign.image} alt={c.campaign.name} className="aspect-[16/9] w-full rounded-xl border border-border object-cover" />
        )}
        {c.campaign.description && <p className="text-lg text-muted-foreground">{c.campaign.description}</p>}

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
            <Term icon={<Timer aria-hidden="true" />} title="Drop-bot window" body={`Fee starts at ${c.campaign.dropBot.startFeeBps / 100}% and falls to ${c.campaign.normalFeeBps / 100}% over ${Math.round(c.campaign.dropBot.windowSec / 60)} min.`} />
            <Term icon={<Lock aria-hidden="true" />} title="Limited edition" body={`At most ${units(c.totalUnits)} vouchers will ever exist. No one can mint more.`} />
            <Term icon={<ShieldCheck aria-hidden="true" />} title="Maker’s upfront share" body={`${plan.makerSharePct}% of the raise at graduation (tier ${c.trust.tier} cap ${c.trust.maxMakerSharePct}%).`} />
            <Term icon={<Lock aria-hidden="true" />} title="Resale market" body="100% of resale liquidity is locked forever. The maker earns 80% of resale fees." />
          </ul>
          <a href={explorerAccount(c.config)} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
            Verify the config on-chain <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </section>
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
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
    </div>
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
      const read = async (mint: string) => {
        const ata = getAssociatedTokenAddressSync(new PublicKey(mint), publicKey!);
        const bal = await connection.getTokenAccountBalance(ata).catch(() => null);
        return bal ? Number(bal.value.uiAmount ?? 0) : 0;
      };
      const [vouchers, usdc] = await Promise.all([read(c.baseMint), read(c.usdcMint)]);
      return { vouchers, usdc };
    },
  });
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
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const usdcAmount = Number(amount);
  const debouncedAmount = useDebounced(usdcAmount, 350);
  const quoteEnabled = live.status === "funding" && debouncedAmount > 0;
  const { data: quoteData } = useQuery({
    queryKey: ["quote", c.pool, debouncedAmount, live.raisedUsdc],
    queryFn: () => api<Quote>("/api/quote", { pool: c.pool, usdc: debouncedAmount }),
    enabled: quoteEnabled,
  });
  const quote = quoteEnabled ? quoteData ?? null : null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["campaign", c.pool] });
    queryClient.invalidateQueries({ queryKey: ["balances", c.pool] });
    queryClient.invalidateQueries({ queryKey: ["resale", c.pool] });
  };

  async function run(kind: "buy" | "sell" | "redeem" | "withdraw" | "claim" | "resaleBuy" | "resaleSell", label: string, extra: Record<string, unknown> = {}) {
    if (!publicKey) return setVisible(true);
    setBusy(kind);
    try {
      const built = await api<BuiltTx>("/api/tx", { kind, pool: c.pool, wallet: publicKey.toBase58(), ...extra });
      await signAndSend(built, label);
      refresh();
    } catch (e) {
      if (e instanceof Error && !/cancelled|rejected|failed:/i.test(e.message)) toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function graduate() {
    setBusy("migrate");
    const id = toast.loading("Graduating to the resale market…");
    try {
      await api(`/api/campaigns/${c.pool}/migrate`, {});
      toast.success("Graduated. The resale market is open.", { id });
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Graduation failed", { id });
    } finally {
      setBusy(null);
    }
  }

  async function copyShare() {
    const url = new URL(window.location.href);
    url.search = publicKey ? `?ref=${publicKey.toBase58()}` : "";
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const isMaker = publicKey?.toBase58() === c.maker;
  const vouchers = balances.data?.vouchers ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {live.status === "funding" && (
        <form
          className="rounded-xl border border-border bg-card p-5"
          onSubmit={(e) => {
            e.preventDefault();
            run("buy", `Back ${c.campaign.name}`, { usdc: usdcAmount, ref });
          }}
        >
          <Label htmlFor="amount">Back with (USDC)</Label>
          <div className="mt-2 flex gap-2">
            <Input id="amount" type="number" inputMode="decimal" min={0.01} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" />
            <Button type="submit" disabled={!!busy || !(usdcAmount > 0)}>{busy === "buy" ? "Backing…" : "Back this"}</Button>
          </div>
          <p className="mt-2 min-h-5 text-sm text-muted-foreground" aria-live="polite">
            {quote ? (
              <>
                ≈ <span className="font-mono text-foreground">{units(quote.vouchers)}</span> vouchers · fee{" "}
                <span className={`font-mono ${quote.feePct > 5 ? "text-primary" : ""}`}>{quote.feePct.toFixed(1)}%</span>
                {quote.feePct > 5 && " (drop-bot window still open)"}
              </>
            ) : null}
          </p>
          {publicKey && balances.data && (
            <p className="text-xs text-muted-foreground">
              Wallet: <span className="font-mono">{usd(balances.data.usdc)}</span> USDC
            </p>
          )}
        </form>
      )}

      {live.status === "funded" && (
        <div className="rounded-xl border border-primary/50 bg-card p-5">
          <p className="font-heading text-2xl">Goal reached</p>
          <p className="mt-1 text-sm text-muted-foreground">Graduate the campaign to fund the maker and open the resale market. The platform pays the fee.</p>
          <Button className="mt-4 w-full" onClick={graduate} disabled={!!busy}>{busy === "migrate" ? "Graduating…" : "Graduate now"}</Button>
        </div>
      )}

      {live.status === "reselling" && <ResalePanel c={c} run={run} busy={busy} vouchers={vouchers} />}

      {isMaker && <MakerPanel c={c} run={run} busy={busy} />}

      {publicKey && vouchers > 0 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">Your vouchers</span>
            <span className="font-mono text-2xl tabular-nums">{units(vouchers)}</span>
          </div>
          <div className="mt-4 grid gap-2">
            {live.status === "funding" && (
              <Button variant="secondary" onClick={() => run("sell", "Exit at curve price")} disabled={!!busy}>
                {busy === "sell" ? "Exiting…" : "Exit at the curve price"}
              </Button>
            )}
            {live.status === "reselling" && (
              <Button onClick={() => run("redeem", "Redeem 1 voucher")} disabled={!!busy || vouchers < 1}>
                {busy === "redeem" ? "Redeeming…" : vouchers < 1 ? "Need 1 whole voucher to redeem" : "Redeem 1 for the item"}
              </Button>
            )}
          </div>
          {live.status === "funding" && <p className="mt-2 text-xs text-muted-foreground">Exiting sells back at today’s curve price, which may be higher or lower than what you paid.</p>}
        </div>
      )}

      <Button variant="ghost" onClick={copyShare}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "Link copied" : publicKey ? "Copy your referral link" : "Copy link"}
      </Button>
    </div>
  );
}
