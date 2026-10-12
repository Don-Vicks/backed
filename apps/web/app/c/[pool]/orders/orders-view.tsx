"use client";

import Link from "next/link";
import { useState } from "react";
import bs58 from "bs58";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ArrowLeft, Download, Lock, PackageCheck, ShieldCheck } from "lucide-react";
import { toCsv } from "@preorder/core/src/csv";
import { encodeInboxKey, inboxKeyPair, inboxMessage, openFromBackers } from "@preorder/core/src/inbox-crypto";
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
  sealed?: string; // sealed to the maker's inbox key; opened here, in the browser
  // null once shipped, or when no configured key opens it (SHIPPING_KEY changed without SHIPPING_KEY_PREVIOUS).
  shipping: { name: string; email: string; address: string; country: string } | null;
};

// A sign-in is a server session (30 minutes). It is kept in memory only, so closing the tab or switching
// wallets ends it on this screen; sign again a minute before it lapses.
const SESSION_MARGIN_MS = 60_000;
type Session = { token: string; expiresAt: number };

// Every text cell goes through csvCell, so a shipping name like "=HYPERLINK(…)" stays text.
function ordersCsv(rows: Redemption[]) {
  const header = ["date", "units", "name", "email", "address", "country", "wallet", "burn_signature", "shipped_at"];
  return toCsv(
    header,
    rows.map((r) => [r.createdAt, r.units, r.shipping?.name, r.shipping?.email, r.shipping?.address, r.shipping?.country, r.wallet, r.signature, r.shippedAt]),
  );
}

// The open session while it is still good, else a new one: the server issues a single-use nonce, the
// wallet signs it into the message for this site's host, and the signature buys the session.
async function reuseOrSignIn(last: Session | null, pool: string, signMessage?: (message: Uint8Array) => Promise<Uint8Array>): Promise<Session> {
  if (last && last.expiresAt - Date.now() > SESSION_MARGIN_MS) return last;
  if (!signMessage) throw new Error("This wallet can’t sign messages. Try Phantom, Solflare or Backpack.");
  const { nonce } = await api<{ nonce: string }>("/api/redemptions/nonce", { pool });
  const message = ordersMessage(pool, new Date().toISOString(), window.location.host, nonce);
  const signature = bs58.encode(await signMessage(new TextEncoder().encode(message)));
  return api<Session>("/api/redemptions/signin", { pool, message, signature });
}

type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;
type Inbox = ReturnType<typeof inboxKeyPair>;

// The maker's inbox key pair: the wallet signs a fixed message and the signature seeds the key, so the
// same wallet gets the same key on any device and the server never holds the private half.
async function deriveInbox(pool: string, signMessage?: SignMessage): Promise<Inbox> {
  if (!signMessage) throw new Error("This wallet can’t sign messages. Try Phantom, Solflare or Backpack.");
  return inboxKeyPair(await signMessage(new TextEncoder().encode(inboxMessage(pool, window.location.host))));
}

// Opens the orders sealed to the inbox key; one that doesn't open is shown as unreadable, the rest still show.
function openOrders(rows: Redemption[], inbox: Inbox): Redemption[] {
  return rows.map((r) => {
    if (!r.sealed) return r;
    try {
      return { ...r, sealed: undefined, shipping: openFromBackers(r.sealed, inbox.secretKey) };
    } catch {
      return { ...r, unreadable: true };
    }
  });
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
  const unitCount = rows?.reduce((a, r) => a + r.units, 0) ?? 0;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [inboxKey, setInboxKey] = useState<string | null>(null); // the registered key, when the maker has turned on private addresses
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [shipping, setShipping] = useState<string | null>(null); // the order being marked shipped

  async function signedIn(): Promise<{ Authorization: string }> {
    const next = await reuseOrSignIn(session, pool, signMessage);
    setSession(next);
    return { Authorization: `Bearer ${next.token}` };
  }

  async function load() {
    if (!publicKey) return setVisible(true);
    setLoading(true);
    setError(null);
    try {
      const auth = await signedIn();
      const { redemptions, inboxKey: key } = await api<{ redemptions: Redemption[]; inboxKey: string | null }>("/api/redemptions/list", { pool }, auth);
      setInboxKey(key);
      // Orders sealed to the inbox key open here with a key only this wallet can make.
      let opened = redemptions;
      if (key && redemptions.some((r) => r.sealed)) {
        const pair = inbox ?? (await deriveInbox(pool, signMessage));
        if (encodeInboxKey(pair.publicKey) !== key) throw new Error("This wallet’s inbox key doesn’t match the one registered for this campaign.");
        setInbox(pair);
        opened = openOrders(redemptions, pair);
      }
      setRows(opened);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t load orders");
    } finally {
      setLoading(false);
    }
  }

  // Registers the inbox key so backers seal their details to it from now on.
  async function enableInbox() {
    setEnabling(true);
    setError(null);
    try {
      const auth = await signedIn();
      const pair = inbox ?? (await deriveInbox(pool, signMessage));
      const publicKey = encodeInboxKey(pair.publicKey);
      await api("/api/redemptions/inbox", { pool, publicKey }, auth);
      setInbox(pair);
      setInboxKey(publicKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t turn on private addresses");
    } finally {
      setEnabling(false);
    }
  }

  async function markShipped(order: string) {
    setShipping(order);
    setError(null);
    try {
      const auth = await signedIn();
      await api("/api/redemptions/shipped", { pool, order }, auth);
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
      <h1 className="mt-4 font-heading text-4xl tracking-[-0.035em] sm:text-5xl">Orders to ship</h1>
      <p className="mt-2 max-w-xl text-muted-foreground">
        Each order is backed by a voucher burn on-chain. Only the campaign’s maker wallet can see shipping details, and marking an order shipped deletes them.
      </p>

      {rows !== null && !inboxKey && (
        <div className="mt-6 rounded-xl border border-primary/40 bg-card p-5">
          <p className="flex items-center gap-2 font-medium"><ShieldCheck aria-hidden="true" className="size-4 text-primary" /> Keep addresses private from Backed’s servers</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Turn this on and backers’ shipping details are encrypted in their browser for you alone; only this wallet can open them. Orders placed before you turn it on stay as they are.
            Your wallet signs one message to make the key; it costs nothing.
          </p>
          <Button className="mt-3" variant="secondary" onClick={enableInbox} disabled={enabling}>{enabling ? "Waiting for signature…" : "Turn on private addresses"}</Button>
          {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
        </div>
      )}

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
              <span className="font-mono text-foreground">{unitCount}</span> {unitCount === 1 ? "unit" : "units"} across {rows.length} {rows.length === 1 ? "order" : "orders"}
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
