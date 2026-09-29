"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { short } from "@/lib/format";

export function WalletButton() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  if (publicKey) {
    return (
      <Button variant="secondary" onClick={() => disconnect()} aria-label={`Disconnect ${publicKey.toBase58()}`} className="font-mono">
        {short(publicKey.toBase58())}
      </Button>
    );
  }
  return (
    <Button onClick={() => setVisible(true)} disabled={connecting}>
      <Wallet aria-hidden="true" />
      {connecting ? "Connecting…" : <>Connect<span className="hidden sm:inline"> wallet</span></>}
    </Button>
  );
}
