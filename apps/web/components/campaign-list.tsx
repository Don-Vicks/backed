"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CampaignCard } from "@/components/campaign-card";
import { api } from "@/lib/client";
import type { CampaignWithLive } from "@/lib/types";

export function CampaignList() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api<{ campaigns: CampaignWithLive[] }>("/api/campaigns"),
    refetchInterval: 10_000,
  });

  if (isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading campaigns">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-80 rounded-xl" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="font-medium">Couldn’t load campaigns</p>
        <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
        <Button variant="secondary" className="mt-4" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }
  if (data.campaigns.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center">
        <p className="font-heading text-3xl">No campaigns yet</p>
        <p className="mt-2 text-muted-foreground">Be the first maker to open pre-orders.</p>
        <Button asChild className="mt-6"><Link href="/create">Start a campaign</Link></Button>
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {data.campaigns.map((c) => (
        <CampaignCard key={c.pool} c={c} />
      ))}
    </div>
  );
}
