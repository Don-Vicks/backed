"use client";

import "@dialectlabs/blinks/index.css";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { Blink } from "@dialectlabs/blinks";
import { useBlinkSolanaWalletAdapter } from "@dialectlabs/blinks/hooks/solana";
import { BlinkInstance, setProxyUrl, type BlinkSupportStrategy } from "@dialectlabs/blinks-core";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NETWORK } from "@/lib/format";

// The campaign's Blink (its Solana Action) in Dialect's open-source renderer: the card a Blink-enabled
// wallet shows when the link is shared on X. The SDK sends requests through proxy.dial.to by default,
// which is down; the Action answers CORS itself, so it is fetched directly.
setProxyUrl("");

// The SDK supports mainnet and devnet; the localnet Action names its own chain, so accept it there.
const acceptLocalnet: BlinkSupportStrategy = async () => ({ isSupported: true });
const supportStrategy = NETWORK === "localnet" ? acceptLocalnet : undefined;

const noSubscribe = () => () => {};
const useOrigin = () => useSyncExternalStore(noSubscribe, () => window.location.origin, () => null);

export function BlinkView({ pool, name }: { pool: string; name: string | null }) {
  const ref = useSearchParams().get("ref");
  const origin = useOrigin();
  let url: string | null = null;
  if (origin) {
    const u = new URL(`/api/actions/back/${pool}`, origin);
    if (ref) u.searchParams.set("ref", ref);
    url = u.toString();
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href={`/c/${pool}`} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="size-4" /> Back to campaign
      </Link>
      <div>
        <h1 className="font-heading text-3xl tracking-[-0.03em]">{name ? `${name} as a Blink` : "Campaign Blink"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every campaign link is also a Solana Action. This is the card a Blink-enabled wallet shows when the link is shared on X,
          drawn by Dialect&apos;s open-source renderer. Backing from it is a real transaction from your wallet.
        </p>
      </div>
      {url ? <BlinkCard url={url} host={new URL(url).host} /> : <Skeleton className="h-[34rem] rounded-2xl" />}
    </div>
  );
}

function BlinkCard({ url, host }: { url: string; host: string }) {
  const { connection } = useConnection();
  const { adapter } = useBlinkSolanaWalletAdapter(connection);
  // One instance per page view: the renderer keeps its own state (inputs, execution) on it.
  const { data: blink, isError, refetch } = useQuery({
    queryKey: ["blink", url],
    queryFn: () => BlinkInstance.fetch(url, supportStrategy),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  if (blink) return <Blink blink={blink} adapter={adapter} securityLevel="all" stylePreset="x-dark" websiteText={host} />;
  if (isError) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm text-muted-foreground">This campaign&apos;s Blink couldn&apos;t be loaded.</p>
        <Button variant="secondary" className="mt-3" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }
  return <Skeleton className="h-[34rem] rounded-2xl" aria-label="Loading the Blink" />;
}
