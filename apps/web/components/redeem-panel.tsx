"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ShippingForm, type ShippingDetails } from "@/components/shipping-form";
import { api, ApiError, ReportedError, useSignAndSend, type BuiltTx } from "@/lib/client";
import type { CampaignWithLive } from "@/lib/types";

type Unfinished = { id: string; signature: string; units: number; createdAt: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Records the order for a landed burn. The server may not see the burn for a moment (409): retry a few times.
async function confirm(id: string, signature: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<{ ok: true; units: number; already: boolean }>("/api/redemptions/confirm", { id, signature });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409) || attempt >= 4) throw e;
      await sleep(1500);
    }
  }
}

// Redeem a voucher for the item, after graduation. Shipping details come first; the burn the wallet
// signs names them; then the order is confirmed. A burn whose confirm never arrived (closed tab, lost
// connection) is found again on the next visit and finished. Keyed on the wallet by the parent, so a
// wallet switch starts clean.
export function RedeemPanel({ c, vouchers, onDone }: { c: CampaignWithLive; vouchers: number; onDone: () => void }) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? "";
  const signAndSend = useSignAndSend();
  const queryClient = useQueryClient();
  const [formKey, setFormKey] = useState<number | null>(null); // a fresh form for each redemption
  const [placed, setPlaced] = useState(0); // orders placed here this visit
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // after a burn whose order is not recorded yet

  const pendingKey = ["redeemPending", c.pool, wallet];
  const { data: unfinished } = useQuery({
    queryKey: pendingKey,
    queryFn: () => api<{ pending: Unfinished[] }>(`/api/redemptions/pending?pool=${c.pool}&wallet=${wallet}`).then((r) => r.pending),
    enabled: !!wallet,
    staleTime: Infinity,
    retry: false,
  });
  const finish = useMutation({
    // Each one on its own: one that can't be confirmed does not hold up the rest.
    mutationFn: async (items: Unfinished[]) => {
      const results = await Promise.allSettled(items.map((u) => confirm(u.id, u.signature)));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) {
        queryClient.invalidateQueries({ queryKey: pendingKey });
        throw failed.reason;
      }
      return items.length;
    },
    onSuccess: (n) => {
      setNotice(null);
      toast.success(n === 1 ? "Your unfinished order is placed." : `${n} unfinished orders are placed.`);
      queryClient.invalidateQueries({ queryKey: pendingKey });
      onDone();
    },
  });
  useEffect(() => {
    if (unfinished?.length && finish.isIdle) finish.mutate(unfinished);
  }, [unfinished, finish]);

  async function redeem(shipping: ShippingDetails) {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    let burned = false;
    try {
      const prepare = () => api<BuiltTx & { id: string }>("/api/redemptions/prepare", { pool: c.pool, wallet, shipping });
      let built = await prepare();
      // An expired blockhash prepares again: a new pending redemption, named by the new burn.
      const signature = await signAndSend(built, "Redeem 1 voucher", async () => (built = await prepare()));
      burned = true;
      await confirm(built.id, signature);
      setFormKey(null);
      setPlaced((n) => n + 1);
      toast.success("Order placed. The maker will ship it.");
      onDone();
    } catch (e) {
      if (burned) {
        // The voucher is gone but the order is not recorded yet. Close the form (submitting it again would
        // burn another voucher) and let the unfinished-redemption check finish it.
        setFormKey(null);
        setNotice("Your voucher is burned, but the order didn’t go through yet. It is finished automatically; if this stays, reload the page.");
        finish.reset();
        queryClient.invalidateQueries({ queryKey: pendingKey });
      } else if (!(e instanceof ReportedError)) setError(e instanceof Error ? e.message : "Couldn’t redeem");
    } finally {
      setSubmitting(false);
    }
  }

  const count = unfinished?.length ?? 0;
  return (
    <div className="flex flex-col gap-4">
      {count > 0 && (
        <div role="status" className="rounded-xl border border-border bg-card p-5">
          <p className="font-medium">
            {count} unfinished redemption{count === 1 ? "" : "s"}
          </p>
          {finish.isError ? (
            <>
              <p className="mt-1 text-sm text-destructive">{finish.error instanceof Error ? finish.error.message : "Couldn’t finish it"}</p>
              <Button className="mt-3" variant="secondary" onClick={() => finish.mutate(unfinished!)}>Try again</Button>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              {finish.isSuccess ? "Done: the maker has your order." : "Your voucher was burned but the order wasn’t recorded. Finishing it now…"}
            </p>
          )}
        </div>
      )}

      {notice && count === 0 && (
        <p role="status" className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">{notice}</p>
      )}

      {placed > 0 && formKey === null && (
        <div className="rounded-xl border border-primary/50 bg-card p-5">
          <p className="flex items-center gap-2 font-heading text-2xl">
            <CheckCircle2 aria-hidden="true" className="size-5 text-primary" /> Order placed
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Your {c.campaign.name} is on the maker’s shipping list.</p>
        </div>
      )}

      {formKey !== null ? (
        <ShippingForm
          key={formKey}
          productName={c.campaign.name}
          submitting={submitting}
          error={error}
          onSubmit={redeem}
          onCancel={() => {
            setFormKey(null);
            setError(null);
          }}
        />
      ) : (
        vouchers > 0 && (
          <Button onClick={() => setFormKey(Date.now())} disabled={vouchers < 1}>
            {vouchers < 1 ? "Need 1 whole voucher to redeem" : placed > 0 ? "Redeem another" : "Redeem 1 for the item"}
          </Button>
        )
      )}
    </div>
  );
}
