import type { Metadata } from "next";
import { BRAND } from "@preorder/core/src/brand";
import { PlatformView } from "./platform-view";

export const metadata: Metadata = { title: `Platform earnings · ${BRAND}` };

export default function PlatformPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="font-heading text-5xl tracking-tight">Platform earnings</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        {BRAND} is the Meteora DBC partner on every campaign. It earns the partner half of curve trading fees and the fees of its permanently locked share
        of each resale pool, and it receives the vouchers left over at graduation, which it burns. Everything below is read from chain.
      </p>
      <div className="mt-10">
        <PlatformView />
      </div>
    </div>
  );
}
