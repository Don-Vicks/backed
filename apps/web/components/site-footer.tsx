import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { BRAND } from "@preorder/core/src/brand";

const external = "inline-flex items-center gap-0.5 transition-colors hover:text-foreground";

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-sm">
          <Link href="/" className="inline-flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <BrandMark className="size-6" />
            <span className="font-heading text-lg font-bold">{BRAND}</span>
          </Link>
          <p className="mt-3 text-sm text-muted-foreground">
            Pre-orders where early backers pay less and the maker earns on every resale. Built on Meteora.
          </p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm text-muted-foreground">
          <Link href="/create" className="transition-colors hover:text-foreground">Start a campaign</Link>
          <a href="https://docs.meteora.ag/" target="_blank" rel="noreferrer" className={external}>
            Meteora docs <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
          <Link href="/stats" className="transition-colors hover:text-foreground">Stats</Link>
          <a href="https://www.meteora.ag/" target="_blank" rel="noreferrer" className={external}>
            <span className="whitespace-nowrap">Built on Meteora</span> <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
        </nav>
      </div>
    </footer>
  );
}
