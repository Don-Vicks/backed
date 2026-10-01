import { ImageResponse } from "next/og";
import { getCampaign } from "@preorder/core";
import { priceTiers } from "@preorder/core/src/pricing";
import { BRAND } from "@preorder/core/src/brand";

// The card X, WhatsApp and Discord show for a shared campaign link. Built from the stored campaign only
// (no RPC), so an unfurl never waits on the chain; the page itself has the live numbers.
export const alt = "A pre-order campaign on a Meteora bonding curve";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const usd = (n: number) => `$${n.toFixed(2)}`;

export default async function Image({ params }: { params: Promise<{ pool: string }> }) {
  const { pool } = await params;
  const record = getCampaign(pool);
  const name = record?.campaign.name ?? "Campaign not found";
  const plan = record?.campaign.plan;
  let goal = "";
  let tiers = "";
  try {
    if (plan) {
      goal = usd(priceTiers(plan).goalUsdc);
      tiers = plan.tiers.map((t, i) => `Tier ${i + 1}: ${t.units} from ${usd(t.startPrice)}`).join("   ·   ");
    }
  } catch {
    // An old record with a plan the current rules reject: show the name only.
  }

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#040A11", color: "#F1F6FA" }}>
        <div style={{ display: "flex", fontSize: 28, color: "#FC6B33", letterSpacing: 2, textTransform: "uppercase" }}>{BRAND} · pre-order</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", fontSize: 92, lineHeight: 1.05 }}>{name}</div>
          {tiers && <div style={{ display: "flex", fontSize: 32, color: "#AEBBC8" }}>{tiers}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", fontSize: 32 }}>
          <div style={{ display: "flex", color: "#AEBBC8" }}>Back it early. Pay less.</div>
          {goal && <div style={{ display: "flex", color: "#FC6B33" }}>Goal {goal}</div>}
        </div>
      </div>
    ),
    size,
  );
}
