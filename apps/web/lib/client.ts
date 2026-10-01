"use client";

import { useCallback } from "react";
import { Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import { explorerTx } from "@/lib/format";

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export type BuiltTx = { tx: string; lastValidBlockHeight: number };

function fromBase64(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Takes a server-built transaction, has the wallet sign it, sends it and waits for confirmation.
// onSent runs once the RPC accepted the transaction (it may still land after a confirm timeout).
export function useSignAndSend() {
  const { connection } = useConnection();
  const { signTransaction, publicKey } = useWallet();

  return useCallback(
    async (built: BuiltTx, label: string, { onSent }: { onSent?: (signature: string) => void } = {}) => {
      if (!publicKey || !signTransaction) throw new Error("Connect a wallet first");
      const toastId = toast.loading(`${label}: approve in your wallet`);
      try {
        const tx = Transaction.from(fromBase64(built.tx));
        const signed = await signTransaction(tx);
        toast.loading(`${label}: sending`, { id: toastId });
        const signature = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
        onSent?.(signature);
        toast.loading(`${label}: confirming`, { id: toastId });
        const result = await connection.confirmTransaction(
          { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight: built.lastValidBlockHeight },
          "confirmed",
        );
        if (result.value.err) throw new Error("Transaction failed on-chain");
        toast.success(label, {
          id: toastId,
          action: { label: "View", onClick: () => window.open(explorerTx(signature), "_blank", "noopener") },
        });
        return signature;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error(message.includes("User rejected") ? `${label}: cancelled` : `${label} failed: ${message}`, { id: toastId });
        throw e;
      }
    },
    [connection, publicKey, signTransaction],
  );
}
