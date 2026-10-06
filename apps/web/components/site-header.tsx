import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WalletButton } from "@/components/wallet-button";
import { FaucetButton } from "@/components/faucet-button";
import { BrandMark } from "@/components/brand-mark";
import { BRAND } from "@preorder/core/src/brand";
import { IS_TEST_NETWORK, NETWORK } from "@/lib/format";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-3">
        <Link href="/" className="flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <BrandMark className="size-7" />
          <span className="font-heading text-xl leading-none font-bold">{BRAND}</span>
        </Link>
        <a
          href="https://www.meteora.ag/"
          target="_blank"
          rel="noreferrer"
          className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground lg:inline-flex"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-brand-gradient" />
          Built on Meteora
        </a>
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
      <div aria-hidden="true" className="h-px bg-brand-gradient opacity-35" />
    </header>
  );
}
