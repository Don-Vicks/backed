"use client";

import Link from "next/link";
import { useState } from "react";
import bs58 from "bs58";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ArrowLeft, Download, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";
import { explorerTx, short } from "@/lib/format";

type Redemption = {
  signature: string;
  wallet: string;
  units: number;
  createdAt: string;
  shipping: { name: string; email: string; address: string; country: string };
};

// Must match ordersMessage() in @preorder/core/src/redemptions.ts
const ordersMessage = (pool: string, issuedAt: string) => `Backed: view orders for campaign ${pool}\nIssued at: ${issuedAt}`;

function toCsv(rows: Redemption[]) {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header = ["date", "units", "name", "email", "address", "country", "wallet", "burn_signature"];
  const lines = rows.map((r) => [r.createdAt, r.units, r.shipping.name, r.shipping.email, r.shipping.address, r.shipping.country, r.wallet, r.signature].map(esc).join(","));
  return [header.join(","), ...lines].join("\n");
}

export function OrdersView({ pool }: { pool: string }) {
  const { publicKey, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const [rows, setRows] = useState<Redemption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!publicKey) return setVisible(true);
    if (!signMessage) return setError("This wallet can’t sign messages. Try Phantom, Solflare or Backpack.");
    setLoading(true);
    setError(null);
    try {
      const message = ordersMessage(pool, new Date().toISOString());
      const signature = bs58.encode(await signMessage(new TextEncoder().encode(message)));
      const { redemptions } = await api<{ redemptions: Redemption[] }>("/api/redemptions/list", { pool, message, signature });
      setRows(redemptions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t load orders");
    } finally {
      setLoading(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([toCsv(rows!)], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `backed-orders-${pool.slice(0, 8)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <Button asChild variant="ghost" className="-ml-3"><Link href={`/c/${pool}`}><ArrowLeft aria-hidden="true" /> Back to campaign</Link></Button>
      <h1 className="mt-4 font-heading text-5xl tracking-tight">Orders to ship</h1>
      <p className="mt-2 max-w-xl text-muted-foreground">Each order is backed by a voucher burn on-chain. Only the campaign’s maker wallet can see shipping details.</p>

      {rows === null ? (
        <div className="mt-8 rounded-xl border border-border bg-card p-6">
          <p className="flex items-center gap-2 font-medium"><Lock aria-hidden="true" className="size-4 text-primary" /> Sign in as the maker</p>
          <p className="mt-1 text-sm text-muted-foreground">Your wallet signs a message to prove it’s you. No transaction, no fee.</p>
          <Button className="mt-4" onClick={load} disabled={loading}>{loading ? "Waiting for signature…" : publicKey ? "Sign in to view orders" : "Connect wallet"}</Button>
          {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-border p-10 text-center">
          <p className="font-heading text-3xl">No orders yet</p>
          <p className="mt-2 text-muted-foreground">Orders appear here when backers redeem their vouchers.</p>
        </div>
      ) : (
        <div className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-muted-foreground"><span className="font-mono text-foreground">{rows.reduce((a, r) => a + r.units, 0)}</span> units across {rows.length} orders</p>
            <Button variant="secondary" onClick={download}><Download aria-hidden="true" /> Download CSV</Button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Date</th>
                  <th scope="col" className="px-4 py-3 font-medium">Units</th>
                  <th scope="col" className="px-4 py-3 font-medium">Ship to</th>
                  <th scope="col" className="px-4 py-3 font-medium">Proof</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {rows.map((r) => (
                  <tr key={r.signature}>
                    <td className="px-4 py-3 whitespace-nowrap">{new Date(r.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 font-mono">{r.units}</td>
                    <td className="px-4 py-3">
                      <span className="block font-medium">{r.shipping.name}</span>
                      <span className="block whitespace-pre-line text-muted-foreground">{r.shipping.address}, {r.shipping.country}</span>
                      {r.shipping.email && <span className="block text-muted-foreground">{r.shipping.email}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <a href={explorerTx(r.signature)} target="_blank" rel="noopener noreferrer" className="font-mono text-primary underline-offset-4 hover:underline">{short(r.signature, 6)}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
