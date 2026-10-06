import { Suspense } from "react";
import type { Metadata } from "next";
import { getCampaign } from "@preorder/core";
import { BRAND } from "@preorder/core/src/brand";
import { CampaignView } from "./campaign-view";

// Shared campaign links unfurl with the product's name and terms (the image is opengraph-image.tsx).
export async function generateMetadata({ params }: PageProps<"/c/[pool]">): Promise<Metadata> {
  const { pool } = await params;
  const record = getCampaign(pool);
  if (!record) return { title: `Campaign not found · ${BRAND}` };
  const { name, description, plan } = record.campaign;
  const title = `${name} · ${BRAND}`;
  const lead = `Pre-order from $${plan.tiers[0].startPrice.toFixed(2)}, the price rises as more people back it, so early backers pay less.`;
  const text = description?.trim() ? `${description.trim()} ${lead}` : lead;
  return {
    title,
    description: text,
    openGraph: { title, description: text, type: "website" },
    twitter: { card: "summary_large_image", title, description: text },
  };
}

export default async function CampaignPage({ params }: PageProps<"/c/[pool]">) {
  const { pool } = await params;
  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <Suspense>
        <CampaignView pool={pool} />
      </Suspense>
    </div>
  );
}
