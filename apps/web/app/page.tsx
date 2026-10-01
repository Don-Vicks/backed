import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CampaignList } from "@/components/campaign-list";
import { BRAND } from "@preorder/core/src/brand";

const STEPS = [
  { title: "Back it early", body: "Every campaign has early-bird tiers on a bonding curve. The first backers pay the least." },
  { title: "Goal reached, maker funded", body: "When the goal is hit, the maker gets an upfront budget automatically. The rest unlocks after the promised ship date." },
  { title: "Resell or redeem", body: "Your voucher trades on a resale market with a permanent floor, and the maker earns on every resale. Burn it to claim the item." },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-4">
      <section className="py-16 sm:py-24">
        <p className="text-sm font-medium text-primary">Pre-orders on Solana</p>
        <h1 className="mt-3 max-w-3xl font-heading text-5xl leading-[1.02] tracking-tight sm:text-7xl">
          Back it early. <em>Pay less.</em>
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          Pre-orders for real products, priced on a bonding curve. Resellers usually keep the profit on sold-out drops.
          On {BRAND}, the maker earns on every resale.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg"><a href="#campaigns">Browse campaigns <ArrowRight aria-hidden="true" /></a></Button>
          <Button asChild size="lg" variant="secondary"><Link href="/create">Start a campaign</Link></Button>
        </div>
      </section>

      <section aria-labelledby="how" className="grid gap-4 border-y border-border py-10 sm:grid-cols-3">
        <h2 id="how" className="sr-only">How it works</h2>
        {STEPS.map((s, i) => (
          <div key={s.title}>
            <p className="font-mono text-sm text-primary">0{i + 1}</p>
            <h3 className="mt-1 font-heading text-2xl">{s.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
          </div>
        ))}
      </section>

      <section id="campaigns" aria-labelledby="campaigns-title" className="scroll-mt-20 py-12">
        <h2 id="campaigns-title" className="mb-6 font-heading text-4xl">Live campaigns</h2>
        <CampaignList />
      </section>
    </div>
  );
}
