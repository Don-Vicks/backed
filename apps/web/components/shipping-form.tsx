"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

// Shown after a voucher burn. Details go to the maker only; the burn signature is the proof of claim.
export function ShippingForm({ pool, wallet, signature, productName }: { pool: string; wallet: string; signature: string; productName: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(form: FormData) {
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/redemptions", {
        pool,
        wallet,
        signature,
        shipping: { name: form.get("name"), email: form.get("email"), address: form.get("address"), country: form.get("country") },
      });
      setDone(true);
      toast.success("Order placed. The maker will ship it.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t submit");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-primary/50 bg-card p-5">
        <p className="flex items-center gap-2 font-heading text-2xl">
          <CheckCircle2 aria-hidden="true" className="size-5 text-primary" /> Order placed
        </p>
        <p className="mt-1 text-sm text-muted-foreground">Your {productName} is on the maker’s shipping list.</p>
      </div>
    );
  }

  return (
    <form
      className="grid gap-3 rounded-xl border border-primary/50 bg-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit(new FormData(e.currentTarget));
      }}
    >
      <div>
        <p className="font-heading text-2xl">Where should it ship?</p>
        <p className="text-sm text-muted-foreground">Your voucher is burned. Only the maker sees these details; they never go on-chain.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ship-name">Full name</Label>
        <Input id="ship-name" name="name" autoComplete="name" required maxLength={100} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ship-email">Email <span className="text-muted-foreground">(for tracking)</span></Label>
        <Input id="ship-email" name="email" type="email" autoComplete="email" maxLength={200} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ship-address">Shipping address</Label>
        <textarea
          id="ship-address"
          name="address"
          autoComplete="street-address"
          required
          rows={3}
          maxLength={500}
          className="rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ship-country">Country</Label>
        <Input id="ship-country" name="country" autoComplete="country-name" required maxLength={60} />
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Button type="submit" disabled={submitting}>{submitting ? "Submitting…" : "Place order"}</Button>
    </form>
  );
}
