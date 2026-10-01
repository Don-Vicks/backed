"use client";

import { useCallback } from "react";
import { Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import { friendlyTxError, isExpiredTxError, isUserRejection } from "@preorder/core/src/tx-errors";
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

// Thrown by the sign-and-send hooks after they have shown their own error toast, so callers skip a
// second one. The message is that toast's text; `toastId` lets a caller replace it, and `landed`
// counts the transactions that confirmed before the failure (a split create can stop halfway).
export class ReportedError extends Error {
  constructor(
    message: string,
    readonly toastId: string | number,
    readonly landed = 0,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// Simulation logs, program error codes and RPC internals are for the console, not the toast.
const looksRaw = (message: string) => message.length > 160 || /logs?:|program log|simulation failed|custom program error|instructionerror|0x[0-9a-f]+/i.test(message);

// The toast text for a failed transaction: cancelled, a known failure in plain language, or a generic line.
export function txErrorText(e: unknown, label: string): string {
  const message = e instanceof Error ? e.message : String(e);
  if (isUserRejection(message)) return `${label}: cancelled`;
  const friendly = friendlyTxError(message);
  if (friendly) return `${label} failed. ${friendly}`;
  if (looksRaw(message)) return `${label} failed. Something went wrong; try again.`;
  return `${label} failed: ${message}`;
}

function report(e: unknown, label: string, toastId: string | number, landed = 0): ReportedError {
  const text = txErrorText(e, label);
  if (!text.endsWith(": cancelled")) console.error(label, e);
  toast.error(text, { id: toastId });
  return new ReportedError(text, toastId, landed, { cause: e });
}

// Blocks a split create needs left on its last transaction's blockhash when the first is sent: room for
// the first to confirm (~0.4 s a block) before the next goes out.
const STEP_MARGIN_BLOCKS = 40;

function fromBase64(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Takes a server-built transaction, has the wallet sign it, sends it and waits for confirmation. With
// `rebuild`, a transaction whose blockhash expired (a slow approval, a congested network) is built
// again and the wallet asked once more.
export function useSignAndSend() {
  const { connection } = useConnection();
  const { signTransaction, publicKey } = useWallet();

  return useCallback(
    async (built: BuiltTx, label: string, rebuild?: () => Promise<BuiltTx>) => {
      if (!publicKey || !signTransaction) throw new Error("Connect a wallet first");
      const toastId = toast.loading(`${label}: approve in your wallet`);
      const attempt = async (b: BuiltTx) => {
        const tx = Transaction.from(fromBase64(b.tx));
        const signed = await signTransaction(tx);
        toast.loading(`${label}: sending`, { id: toastId });
        const signature = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
        toast.loading(`${label}: confirming`, { id: toastId });
        const result = await connection.confirmTransaction(
          { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight: b.lastValidBlockHeight },
          "confirmed",
        );
        if (result.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
        return signature;
      };
      try {
        let signature: string;
        try {
          signature = await attempt(built);
        } catch (e) {
          if (!rebuild || !(e instanceof Error) || !isExpiredTxError(e.message)) throw e;
          toast.loading(`${label}: that one expired, approve the new one`, { id: toastId });
          signature = await attempt(await rebuild());
        }
        toast.success(label, {
          id: toastId,
          action: { label: "View", onClick: () => window.open(explorerTx(signature), "_blank", "noopener") },
        });
        return signature;
      } catch (e) {
        throw report(e, label, toastId);
      }
    },
    [connection, publicKey, signTransaction],
  );
}

// Several server-built transactions that must land in order (a large create: config, then pool).
// The wallet signs them all in one prompt; each is sent only after the one before it confirms. If the
// approval took so long that the last one could expire before its turn, nothing is sent.
export function useSignAndSendAll() {
  const { connection } = useConnection();
  const { signAllTransactions, signTransaction, publicKey } = useWallet();

  return useCallback(
    async (built: BuiltTx[], label: string) => {
      if (!publicKey || !signTransaction) throw new Error("Connect a wallet first");
      const toastId = toast.loading(`${label}: approve in your wallet`);
      let landed = 0;
      try {
        const txs = built.map((b) => Transaction.from(fromBase64(b.tx)));
        const signed = signAllTransactions ? await signAllTransactions(txs) : await sequence(txs.map((tx) => () => signTransaction(tx)));
        if (built.length > 1 && (await connection.getBlockHeight("confirmed")) + STEP_MARGIN_BLOCKS > built[built.length - 1].lastValidBlockHeight) {
          throw new Error("the approval took too long, so nothing was sent. Try again.");
        }
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
          if (result.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
          landed++;
        }
        toast.success(label, {
          id: toastId,
          action: { label: "View", onClick: () => window.open(explorerTx(signature), "_blank", "noopener") },
        });
        return signature; // the last one, which completes the action
      } catch (e) {
        throw report(e, label, toastId, landed);
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
