import { Suspense } from "react";
import type { Metadata } from "next";
import { getCampaign } from "@preorder/core";
import { BRAND } from "@preorder/core/src/brand";
import { BlinkView } from "./blink-view";

export async function generateMetadata({ params }: PageProps<"/c/[pool]/blink">): Promise<Metadata> {
  const { pool } = await params;
  const record = getCampaign(pool);
  return { title: record ? `${record.campaign.name} as a Blink · ${BRAND}` : `Campaign not found · ${BRAND}` };
}

export default async function BlinkPage({ params }: PageProps<"/c/[pool]/blink">) {
  const { pool } = await params;
  const record = getCampaign(pool);
  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <Suspense>
        <BlinkView pool={pool} name={record?.campaign.name ?? null} />
      </Suspense>
    </div>
  );
}
