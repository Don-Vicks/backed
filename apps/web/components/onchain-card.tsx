import { Check, ExternalLink } from "lucide-react";
import { explorerAccount, explorerTx, short } from "@/lib/format";
import type { CampaignWithLive } from "@/lib/types";

// Where the campaign lives on chain, so anyone can check it against Meteora's programs, and which
// stage of the DBC → DAMM v2 lifecycle it is in.
const STAGES = [
  { key: "funding", label: "Funding", detail: "Bonding curve (Meteora DBC)" },
  { key: "funded", label: "Goal reached", detail: "Ready to graduate" },
  { key: "reselling", label: "Reselling", detail: "Resale pool (Meteora DAMM v2)" },
] as const;

export function OnChainCard({ c }: { c: CampaignWithLive }) {
  const status = c.live?.status;
  const current = STAGES.findIndex((s) => s.key === status);
  const rows: { label: string; value: string; href: string }[] = [
    { label: "DBC pool", value: c.pool, href: explorerAccount(c.pool) },
    { label: "DBC config", value: c.config, href: explorerAccount(c.config) },
    { label: "Voucher mint", value: c.baseMint, href: explorerAccount(c.baseMint) },
    ...(c.live?.resalePool ? [{ label: "DAMM v2 resale pool", value: c.live.resalePool, href: explorerAccount(c.live.resalePool) }] : []),
    ...(c.createSignature ? [{ label: "Launch transaction", value: c.createSignature, href: explorerTx(c.createSignature) }] : []),
  ];

  return (
    <section aria-labelledby="onchain-title" className="rounded-xl border border-border bg-card p-5">
      <h2 id="onchain-title" className="font-heading text-2xl">On-chain</h2>
      <p className="text-sm text-muted-foreground">No custom program: this campaign is a Meteora DBC pool that graduates into a DAMM v2 pool.</p>
      <ol className="mt-4 grid gap-2 sm:grid-cols-3" aria-label="Lifecycle">
        {STAGES.map((s, i) => {
          const done = current > i;
          const now = current === i;
          return (
            <li key={s.key} className={`rounded-lg border p-3 ${now ? "border-primary/60 bg-primary/5" : "border-border"}`} aria-current={now ? "step" : undefined}>
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className={`grid size-5 place-items-center rounded-full font-mono text-[11px] ${now ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  {done ? <Check aria-hidden="true" className="size-3" /> : i + 1}
                </span>
                {s.label}
                {done && <span className="sr-only">(done)</span>}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{s.detail}</span>
            </li>
          );
        })}
      </ol>
      <dl className="mt-4 divide-y divide-border text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 py-2">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd>
              <a href={r.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono underline-offset-4 hover:underline">
                {short(r.value, 6)} <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
