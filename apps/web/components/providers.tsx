"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RPC_URL } from "@/lib/format";
import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 4_000 } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={RPC_URL}>
        {/* Wallet Standard wallets (Phantom, Solflare, Backpack) are detected automatically. */}
        <WalletProvider wallets={[]} autoConnect>
          <WalletModalProvider>
            <TooltipProvider>
              {children}
              <Toaster theme="dark" position="bottom-right" closeButton />
            </TooltipProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
