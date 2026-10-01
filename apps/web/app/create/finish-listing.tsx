"use client";

import { Button } from "@/components/ui/button";
import type { PendingLaunch } from "@/lib/pending-launch";

// Shown instead of a second Launch while a sent launch is not listed yet.
export function FinishListing({ launch, busy, onFinish, onDiscard }: { launch: PendingLaunch; busy: boolean; onFinish: () => void; onDiscard: () => void }) {
  return (
    <div className="rounded-xl border border-primary/40 bg-card p-4" role="status">
      <p className="text-sm">
        <span className="font-medium">“{launch.name}” was sent but isn’t listed yet.</span>{" "}
        <span className="text-muted-foreground">Finish listing instead of launching again, which would create a second campaign.</span>
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" onClick={onFinish} disabled={busy}>
          {busy ? "Listing…" : "Finish listing"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">If the launch landed on-chain, it is listed automatically within minutes either way.</p>
    </div>
  );
}
