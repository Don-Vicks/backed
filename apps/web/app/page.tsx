import Link from "next/link";
import { ArrowRight, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CampaignList } from "@/components/campaign-list";
import { CampaignTotals, FeaturedCampaign } from "@/components/featured-campaign";
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
      <section className="grid items-center gap-12 py-16 sm:py-20 lg:grid-cols-[1.15fr_1fr]">
        <div className="animate-in fade-in slide-in-from-bottom-3 duration-700 motion-reduce:animate-none">
          <p className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-brand-gradient" />
            Pre-orders on Solana, priced by Meteora
          </p>
          <h1 className="mt-6 font-heading text-5xl leading-[1.02] tracking-[-0.04em] sm:text-7xl">
            Back it early. <span className="text-brand-gradient whitespace-nowrap">Pay less.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground">
            Pre-order things from the people making them. Early backers pay less, your spot is yours to resell, and the maker earns a
            cut every time it changes hands.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg"><a href="#campaigns">Browse campaigns <ArrowRight aria-hidden="true" /></a></Button>
            <Button asChild size="lg" variant="secondary"><Link href="/create">Start a campaign</Link></Button>
          </div>
          <CampaignTotals />
        </div>
        <div className="w-full max-w-xl animate-in fade-in slide-in-from-bottom-6 duration-1000 motion-reduce:animate-none lg:max-w-none">
          <FeaturedCampaign />
        </div>
      </section>

      <section id="campaigns" aria-labelledby="campaigns-title" className="scroll-mt-20 pb-16">
        <div className="mb-6 flex items-end justify-between gap-4">
          <h2 id="campaigns-title" className="font-heading text-3xl sm:text-4xl">Live campaigns</h2>
          <Link href="/stats" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">All stats</Link>
        </div>
        <CampaignList />
      </section>

      <section aria-labelledby="how" className="border-t border-border py-16">
        <h2 id="how" className="font-heading text-3xl sm:text-4xl">How it works</h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl border border-border bg-card/70 p-5">
              <p className="text-brand-gradient w-fit font-mono text-sm font-medium">0{i + 1}</p>
              <h3 className="mt-3 font-heading text-xl">{s.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="why-title" className="border-t border-border py-16">
        <h2 id="why-title" className="font-heading text-3xl sm:text-4xl">
          Why not just use crowdfunding?
        </h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">{BRAND} is crowdfunding with the missing parts: fair early prices, a way out, and a maker who is paid for shipping.</p>
        {/* Phones: one card per topic, so the Backed answer is never cut off. */}
        <ul className="mt-6 grid gap-3 sm:hidden">
          {COMPARISON.map((r) => (
            <li key={r.topic} className="rounded-xl border border-border bg-card p-4">
              <p className="font-medium">{r.topic}</p>
              <p className="mt-2 flex gap-2 text-sm text-muted-foreground"><X aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{r.typical}</p>
              <p className="mt-1.5 flex gap-2 text-sm"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />{r.backed}</p>
            </li>
          ))}
        </ul>
        <div className="mt-6 hidden overflow-hidden rounded-xl border border-border sm:block">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="w-48 px-4 py-3 font-medium"><span className="sr-only">Topic</span></th>
                <th scope="col" className="px-4 py-3 font-medium">Typical crowdfunding</th>
                <th scope="col" className="px-4 py-3 font-medium text-primary">{BRAND}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {COMPARISON.map((r) => (
                <tr key={r.topic}>
                  <th scope="row" className="px-4 py-3 align-top font-medium">{r.topic}</th>
                  <td className="px-4 py-3 align-top text-muted-foreground">{r.typical}</td>
                  <td className="px-4 py-3 align-top"><span className="flex gap-2"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />{r.backed}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
