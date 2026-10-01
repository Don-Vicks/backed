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

  // Meteora's palette: indigo-black, the gold-orange-violet gradient, orange for the numbers that matter.
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#0D0D13",
          backgroundImage: "radial-gradient(circle at 8% 0%, rgba(110,69,255,0.30), transparent 45%), radial-gradient(circle at 100% 0%, rgba(245,75,0,0.22), transparent 40%)",
          color: "#F9F9FB",
        }}
      >
        <div style={{ display: "flex", height: 10, backgroundImage: "linear-gradient(90deg, #6E45FF, #F54B00 60%, #F5BD00)" }} />
        <div style={{ display: "flex", flex: 1, flexDirection: "column", justifyContent: "space-between", padding: "60px 72px 64px" }}>
          <div style={{ display: "flex", fontSize: 26, color: "#F76727", letterSpacing: 3, textTransform: "uppercase" }}>{BRAND} · pre-order</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <div style={{ display: "flex", fontSize: 92, fontWeight: 700, letterSpacing: -3, lineHeight: 1.04 }}>{name}</div>
            {tiers && <div style={{ display: "flex", fontSize: 32, color: "#9595B2" }}>{tiers}</div>}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", fontSize: 30 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", color: "#F9F9FB" }}>Back it early. Pay less.</div>
              <div style={{ display: "flex", fontSize: 24, color: "#9595B2" }}>Priced on Meteora&apos;s Dynamic Bonding Curve</div>
            </div>
            {goal && <div style={{ display: "flex", color: "#F76727", fontSize: 34 }}>Goal {goal}</div>}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
