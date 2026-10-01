import type { Metadata } from "next";
import { BRAND } from "@preorder/core/src/brand";
import { CreateForm } from "./create-form";

export const metadata: Metadata = { title: `Start a campaign · ${BRAND}` };

export default function CreatePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="font-heading text-5xl tracking-tight">Start a campaign</h1>
      <p className="mt-2 max-w-xl text-muted-foreground">
        Open pre-orders for something you’re about to make. Backers pay early, you get funded, and nobody can change the rules once you launch. Four short steps, about two minutes.
      </p>
      <div className="mt-10">
        <CreateForm />
      </div>
    </div>
  );
}
