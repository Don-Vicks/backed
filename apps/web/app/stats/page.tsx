import type { Metadata } from "next";
import { BRAND } from "@preorder/core/src/brand";
import { StatsView } from "./stats-view";

export const metadata: Metadata = { title: `Stats · ${BRAND}` };

export default function StatsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="font-heading text-4xl tracking-[-0.035em] sm:text-5xl">Stats</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Every campaign on {BRAND}, read live from its Meteora DBC pool or, after graduation, its DAMM v2 resale pool.
      </p>
      <div className="mt-10">
        <StatsView />
      </div>
    </div>
  );
}
