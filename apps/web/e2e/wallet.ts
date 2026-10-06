// A keypair-backed Wallet Standard wallet for Playwright. The page only ever sees the public key: it
// calls functions exposed on the BrowserContext, and Node signs. The app's WalletProvider (wallets={[]})
// discovers it like Phantom, through the Wallet Standard registration handshake.
import type { BrowserContext } from "@playwright/test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";

type InjectArgs = { name: string; address: string; publicKey: number[]; chains: string[] };

// Runs in the page before any app script (addInitScript), so it must be self-contained.
function injectWallet({ name, address, publicKey, chains }: InjectArgs) {
  type Listener = (props: { accounts: unknown[] }) => void;
  const w = window as unknown as Record<string, (b64?: string) => Promise<string>>;
  const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const listeners: Record<string, Listener[]> = { change: [] };
  const features = ["solana:signTransaction", "solana:signAndSendTransaction", "solana:signMessage"];
  const account = Object.freeze({ address, publicKey: new Uint8Array(publicKey), chains, features, label: name });
  let accounts: (typeof account)[] = [];
  const emit = () => listeners.change.forEach((l) => l({ accounts }));
  const wallet = {
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#7c3aed"/></svg>'),
    chains,
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          await w.__e2eWallet_connect();
          accounts = [account];
          emit();
          return { accounts };
        },
      },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { accounts = []; emit(); } },
      "standard:events": {
        version: "1.0.0",
        on: (ev: string, l: Listener) => {
          (listeners[ev] ||= []).push(l);
          return () => { listeners[ev] = listeners[ev].filter((x) => x !== l); };
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await w.__e2eWallet_signTx(b64(i.transaction))) }))),
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signature: unb64(await w.__e2eWallet_signAndSend(b64(i.transaction))) }))),
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs: { message: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await w.__e2eWallet_signMessage(b64(i.message))) }))),
      },
    },
  };
  const callback = ({ register }: { register: (w: unknown) => void }) => register(wallet);
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
  window.addEventListener("wallet-standard:app-ready", ((e: CustomEvent) => callback(e.detail)) as EventListener);
}

export type TestWallet = { keypair: Keypair; address: string; log: string[]; policy: { reject: boolean } };

// policy.reject = true makes every approval fail the way a user declining in Phantom does.
export async function attachWallet(context: BrowserContext, keypair: Keypair, { name = "E2E Wallet", rpc = "http://127.0.0.1:8899" } = {}): Promise<TestWallet> {
  const conn = new Connection(rpc, "confirmed");
  const log: string[] = [];
  const policy = { reject: false };
  const guard = (what: string) => {
    log.push(what);
    if (policy.reject) throw new Error("User rejected the request.");
  };
  const sign = (b64: string) => {
    const bytes = Buffer.from(b64, "base64");
    try {
      const tx = VersionedTransaction.deserialize(bytes);
      if (tx.version === "legacy") throw new Error("legacy");
      tx.sign([keypair]);
      return Buffer.from(tx.serialize()).toString("base64");
    } catch {
      const tx = Transaction.from(bytes);
      tx.partialSign(keypair);
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    }
  };
  await context.exposeFunction("__e2eWallet_connect", async () => guard("connect"));
  await context.exposeFunction("__e2eWallet_signTx", async (b64: string) => (guard("signTransaction"), sign(b64)));
  await context.exposeFunction("__e2eWallet_signAndSend", async (b64: string) => {
    guard("signAndSendTransaction");
    const sig = await conn.sendRawTransaction(Buffer.from(sign(b64), "base64"));
    return Buffer.from(bs58.decode(sig)).toString("base64");
  });
  await context.exposeFunction("__e2eWallet_signMessage", async (b64: string) => {
    guard("signMessage");
    return Buffer.from(nacl.sign.detached(Buffer.from(b64, "base64"), keypair.secretKey)).toString("base64");
  });
  const address = keypair.publicKey.toBase58();
  await context.addInitScript(injectWallet, { name, address, publicKey: Array.from(keypair.publicKey.toBytes()), chains: ["solana:localnet", "solana:devnet", "solana:mainnet"] });
  // WalletProvider's autoConnect reads localStorage.walletName.
  await context.addInitScript((n: string) => localStorage.setItem("walletName", JSON.stringify(n)), name);
  return { keypair, address, log, policy };
}
