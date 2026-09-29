import type { Metadata } from "next";
import { CreateForm } from "./create-form";

export const metadata: Metadata = { title: "Start a campaign · Backed" };

export default function CreatePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="font-heading text-5xl tracking-tight">Start a campaign</h1>
      <p className="mt-2 max-w-xl text-muted-foreground">
        Set your tiers and goal. We turn them into an on-chain bonding curve you can’t change after launch, and your backers can see every rule.
      </p>
      <div className="mt-10">
        <CreateForm />
      </div>
    </div>
  );
}
