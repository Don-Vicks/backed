import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WalletButton } from "@/components/wallet-button";
import { FaucetButton } from "@/components/faucet-button";
import { BRAND } from "@preorder/core/src/brand";
import { IS_TEST_NETWORK, NETWORK } from "@/lib/format";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-4">
        <Link href="/" className="rounded-md font-heading text-3xl leading-none tracking-tight focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {BRAND}
        </Link>
        {IS_TEST_NETWORK && (
          <span className="hidden rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground capitalize sm:inline">{NETWORK}</span>
        )}
        <nav className="ml-auto flex items-center gap-1 sm:gap-2">
          <FaucetButton />
          <Button asChild variant="ghost" className="hidden md:inline-flex">
            <Link href="/stats">Stats</Link>
          </Button>
          <Button asChild variant="ghost" className="hidden sm:inline-flex">
            <Link href="/create">
              <Plus aria-hidden="true" />
              Start a campaign
            </Link>
          </Button>
          <WalletButton />
        </nav>
      </div>
    </header>
  );
}
