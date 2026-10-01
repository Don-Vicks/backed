"use client";

import { useCallback } from "react";
import { Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import { explorerTx } from "@/lib/format";

// A failed API call. `status` tells a message meant for the user (4xx) from a server fault (5xx).
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

// What to show for a failed quote: the server's reason when it is about the request, else a generic line.
export function quoteErrorMessage(e: unknown) {
  return e instanceof ApiError && e.status < 500 ? e.message : "Quote unavailable right now";
}

export type BuiltTx = { tx: string; lastValidBlockHeight: number };

function fromBase64(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Takes a server-built transaction, has the wallet sign it, sends it and waits for confirmation.
export function useSignAndSend() {
  const { connection } = useConnection();
  const { signTransaction, publicKey } = useWallet();

  return useCallback(
    async (built: BuiltTx, label: string) => {
      if (!publicKey || !signTransaction) throw new Error("Connect a wallet first");
      const toastId = toast.loading(`${label}: approve in your wallet`);
      try {
        const tx = Transaction.from(fromBase64(built.tx));
        const signed = await signTransaction(tx);
        toast.loading(`${label}: sending`, { id: toastId });
        const signature = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
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

// Several server-built transactions that must land in order (a large create: config, then pool).
// The wallet signs them all in one prompt; each is sent only after the one before it confirms.
export function useSignAndSendAll() {
  const { connection } = useConnection();
  const { signAllTransactions, signTransaction, publicKey } = useWallet();

  return useCallback(
    async (built: BuiltTx[], label: string) => {
      if (!publicKey || !signTransaction) throw new Error("Connect a wallet first");
      const toastId = toast.loading(`${label}: approve in your wallet`);
      try {
        const txs = built.map((b) => Transaction.from(fromBase64(b.tx)));
        const signed = signAllTransactions ? await signAllTransactions(txs) : await sequence(txs.map((tx) => () => signTransaction(tx)));
        let signature = "";
        for (const [i, tx] of signed.entries()) {
          const step = signed.length > 1 ? ` (${i + 1}/${signed.length})` : "";
          toast.loading(`${label}: sending${step}`, { id: toastId });
          signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
          toast.loading(`${label}: confirming${step}`, { id: toastId });
          const result = await connection.confirmTransaction(
            { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight: built[i].lastValidBlockHeight },
            "confirmed",
          );
          if (result.value.err) throw new Error("Transaction failed on-chain");
        }
        toast.success(label, {
          id: toastId,
          action: { label: "View", onClick: () => window.open(explorerTx(signature), "_blank", "noopener") },
        });
        return signature; // the last one, which completes the action
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error(message.includes("User rejected") ? `${label}: cancelled` : `${label} failed: ${message}`, { id: toastId });
        throw e;
      }
    },
    [connection, publicKey, signAllTransactions, signTransaction],
  );
}

async function sequence<T>(steps: (() => Promise<T>)[]) {
  const out: T[] = [];
  for (const step of steps) out.push(await step());
  return out;
}
