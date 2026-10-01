import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CampaignList } from "@/components/campaign-list";
import { BRAND } from "@preorder/core/src/brand";

const STEPS = [
  { title: "Back it early", body: "Campaigns start cheap and the price rises as more people join, so the first backers pay the least." },
  { title: "Goal reached, maker funded", body: "When enough is raised, the maker is paid to start making it. Most of their money is released only after the promised ship date." },
  { title: "Claim it or resell it", body: "Redeem your voucher to get the item, or sell it to someone else on the resale market. The maker earns on every resale." },
];

// Plain contrasts with typical crowdfunding, worded as tendencies rather than claims about one platform.
const COMPARISON = [
  { topic: "Price", typical: "A fixed price per reward, and the early-bird slots run out.", backed: "The price rises smoothly, so earlier always means cheaper." },
  { topic: "Changed your mind?", typical: "You’re locked in once the campaign ends.", backed: "Sell your spot to anyone, any time." },
  { topic: "When it sells out", typical: "Resellers keep the profit. The maker gets nothing.", backed: "The maker earns a cut of every resale." },
  { topic: "Is the maker accountable?", typical: "The money usually arrives as soon as the campaign ends.", backed: "Most of it is released after the promised ship date." },
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
          Pre-order things from the people making them. Early backers pay less, your spot is yours to resell, and the maker earns a
          cut every time it changes hands.
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

      <section aria-labelledby="why-title" className="border-b border-border py-12">
        <h2 id="why-title" className="font-heading text-4xl">
          Why not just use crowdfunding?
        </h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">{BRAND} is crowdfunding with the missing parts: fair early prices, a way out, and a maker who is paid for shipping.</p>
        <div className="mt-6 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="w-40 px-4 py-3 font-medium"><span className="sr-only">Topic</span></th>
                <th scope="col" className="px-4 py-3 font-medium">Typical crowdfunding</th>
                <th scope="col" className="px-4 py-3 font-medium text-primary">{BRAND}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {COMPARISON.map((r) => (
                <tr key={r.topic}>
                  <th scope="row" className="px-4 py-3 align-top font-medium">{r.topic}</th>
                  <td className="px-4 py-3 align-top text-muted-foreground">{r.typical}</td>
                  <td className="px-4 py-3 align-top">{r.backed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="campaigns" aria-labelledby="campaigns-title" className="scroll-mt-20 py-12">
        <h2 id="campaigns-title" className="mb-6 font-heading text-4xl">Live campaigns</h2>
        <CampaignList />
      </section>
    </div>
  );
}
