"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ShippingDetails = { name: string; email: string; address: string; country: string };

// Collected before the burn: the details are stored (encrypted, for the maker only) and the burn the
// wallet then signs names them, so nobody else can claim that burn with other details.
export function ShippingForm({
  productName,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  productName: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (shipping: ShippingDetails) => void;
  onCancel: () => void;
}) {
  const text = (form: FormData, name: string) => String(form.get(name) ?? "");
  return (
    <form
      className="grid gap-3 rounded-xl border border-primary/50 bg-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        onSubmit({ name: text(form, "name"), email: text(form, "email"), address: text(form, "address"), country: text(form, "country") });
      }}
    >
      <div>
        <p className="font-heading text-2xl">Where should it ship?</p>
        <p className="text-sm text-muted-foreground">
          Next, your wallet burns 1 voucher for your {productName}. Only the maker sees these details; they never go on-chain.
        </p>
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
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={submitting}>{submitting ? "Redeeming…" : "Burn 1 voucher and place order"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
      </div>
    </form>
  );
}
