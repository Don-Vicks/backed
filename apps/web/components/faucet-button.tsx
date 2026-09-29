"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Droplet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";
import { NETWORK, explorerTx } from "@/lib/format";

// Devnet only: 50 test USDC (+ a little SOL for fees) so anyone can try backing a campaign.
export function FaucetButton() {
  const { publicKey } = useWallet();
  const [busy, setBusy] = useState(false);
  if (NETWORK !== "devnet" || !publicKey) return null;

  async function drip() {
    setBusy(true);
    try {
      const { signature } = await api<{ signature: string }>("/api/faucet", { wallet: publicKey!.toBase58() });
      toast.success("Sent 50 test USDC", { action: { label: "View", onClick: () => window.open(explorerTx(signature), "_blank", "noopener") } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Faucet failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" onClick={drip} disabled={busy} aria-label="Get 50 test USDC">
      <Droplet aria-hidden="true" />
      <span className="hidden md:inline">{busy ? "Sending…" : "Get test USDC"}</span>
    </Button>
  );
}
