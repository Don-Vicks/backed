"use client";

import Link from "next/link";
import { useState } from "react";
import bs58 from "bs58";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ArrowLeft, Download, Lock, PackageCheck } from "lucide-react";
import { toCsv } from "@preorder/core/src/csv";
import { ordersMessage } from "@preorder/core/src/messages";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";
import { explorerTx, short } from "@/lib/format";

type Redemption = {
  signature: string;
  wallet: string;
  units: number;
  createdAt: string;
  shippedAt?: string;
  unreadable?: true;
  // null once shipped, or when no configured key opens it (SHIPPING_KEY changed without SHIPPING_KEY_PREVIOUS).
  shipping: { name: string; email: string; address: string; country: string } | null;
};

// The sign-in is good for 5 minutes on the server; sign again a little before that.
const SIGN_IN_REUSE_MS = 4 * 60_000;
type SignIn = { message: string; signature: string; at: number };

// Every text cell goes through csvCell, so a shipping name like "=HYPERLINK(…)" stays text.
function ordersCsv(rows: Redemption[]) {
  const header = ["date", "units", "name", "email", "address", "country", "wallet", "burn_signature", "shipped_at"];
  return toCsv(
    header,
    rows.map((r) => [r.createdAt, r.units, r.shipping?.name, r.shipping?.email, r.shipping?.address, r.shipping?.country, r.wallet, r.signature, r.shippedAt]),
  );
}

// The last sign-in while it is still good, else a fresh one for this site's host.
async function reuseOrSignIn(last: SignIn | null, pool: string, signMessage?: (message: Uint8Array) => Promise<Uint8Array>): Promise<SignIn> {
  if (last && Date.now() - last.at < SIGN_IN_REUSE_MS) return last;
  if (!signMessage) throw new Error("This wallet can’t sign messages. Try Phantom, Solflare or Backpack.");
  const at = Date.now();
  const message = ordersMessage(pool, new Date(at).toISOString(), window.location.host);
  return { message, signature: bs58.encode(await signMessage(new TextEncoder().encode(message))), at };
}

// Keyed on the connected wallet: disconnecting or switching wallets drops the orders (and their
// shipping details) from the screen along with the sign-in.
export function OrdersView({ pool }: { pool: string }) {
  const { publicKey } = useWallet();
  return <Orders key={publicKey?.toBase58() ?? "none"} pool={pool} />;
}

function Orders({ pool }: { pool: string }) {
  const { publicKey, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const [rows, setRows] = useState<Redemption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  const [shipping, setShipping] = useState<string | null>(null); // the order being marked shipped

  async function signedIn(): Promise<SignIn> {
    const next = await reuseOrSignIn(signIn, pool, signMessage);
    setSignIn(next);
    return next;
  }

  async function load() {
    if (!publicKey) return setVisible(true);
    setLoading(true);
    setError(null);
    try {
      const { message, signature } = await signedIn();
      const { redemptions } = await api<{ redemptions: Redemption[] }>("/api/redemptions/list", { pool, message, signature });
      setRows(redemptions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t load orders");
    } finally {
      setLoading(false);
    }
  }

  async function markShipped(order: string) {
    setShipping(order);
    setError(null);
    try {
      const { message, signature } = await signedIn();
      await api("/api/redemptions/shipped", { pool, message, signature, order });
      setRows((all) => all?.map((r) => (r.signature === order ? { ...r, shipping: null, shippedAt: new Date().toISOString() } : r)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t mark it shipped");
    } finally {
      setShipping(null);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([ordersCsv(rows!)], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `backed-orders-${pool.slice(0, 8)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <Button asChild variant="ghost" className="-ml-3"><Link href={`/c/${pool}`}><ArrowLeft aria-hidden="true" /> Back to campaign</Link></Button>
      <h1 className="mt-4 font-heading text-5xl tracking-tight">Orders to ship</h1>
      <p className="mt-2 max-w-xl text-muted-foreground">
        Each order is backed by a voucher burn on-chain. Only the campaign’s maker wallet can see shipping details, and marking an order shipped deletes them.
      </p>

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
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              <span className="font-mono text-foreground">{rows.reduce((a, r) => a + r.units, 0)}</span> units across {rows.length} orders
              {rows.some((r) => r.shippedAt) && <>, {rows.filter((r) => r.shippedAt).length} shipped</>}
            </p>
            <Button variant="secondary" onClick={download}><Download aria-hidden="true" /> Download CSV</Button>
          </div>
          {error && <p className="mb-3 text-sm text-destructive" role="alert">{error}</p>}
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Date</th>
                  <th scope="col" className="px-4 py-3 font-medium">Units</th>
                  <th scope="col" className="px-4 py-3 font-medium">Ship to</th>
                  <th scope="col" className="px-4 py-3 font-medium">Proof</th>
                  <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">Status</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {rows.map((r) => (
                  <tr key={r.signature}>
                    <td className="px-4 py-3 whitespace-nowrap">{new Date(r.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 font-mono">{r.units}</td>
                    <td className="px-4 py-3">
                      {r.shipping ? (
                        <>
                          <span className="block font-medium">{r.shipping.name}</span>
                          <span className="block whitespace-pre-line text-muted-foreground">{r.shipping.address}, {r.shipping.country}</span>
                          {r.shipping.email && <span className="block text-muted-foreground">{r.shipping.email}</span>}
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          {r.shippedAt ? "Details deleted after shipping" : r.unreadable ? "Details unreadable with the server’s current shipping key: ask the operator to set SHIPPING_KEY_PREVIOUS" : "No details"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <a href={explorerTx(r.signature)} target="_blank" rel="noopener noreferrer" className="font-mono text-primary underline-offset-4 hover:underline">{short(r.signature, 6)}</a>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.shippedAt ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <PackageCheck aria-hidden="true" className="size-4 text-primary" /> Shipped {new Date(r.shippedAt).toLocaleDateString()}
                        </span>
                      ) : (
                        // Deletes the shipping details on the server: download the CSV first if you need them.
                        <Button size="sm" variant="secondary" onClick={() => markShipped(r.signature)} disabled={!!shipping}>
                          {shipping === r.signature ? "Saving…" : "Mark shipped"}
                        </Button>
                      )}
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
