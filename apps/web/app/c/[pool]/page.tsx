import { Suspense } from "react";
import { CampaignView } from "./campaign-view";

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
