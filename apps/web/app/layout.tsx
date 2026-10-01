import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { BRAND } from "@preorder/core/src/brand";

// Brand typography (brand.md), Meteora's pairing: Plus Jakarta Sans for headlines, Inter for UI,
// JetBrains Mono for numbers.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

// Absolute base for link-preview images (opengraph-image), from the same public origin as token metadata.
const publicBase = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");

export const metadata: Metadata = {
  metadataBase: publicBase ? new URL(publicBase) : undefined,
  title: BRAND,
  description: "Back it early, pay less. Pre-orders for real products, priced on Meteora's Dynamic Bonding Curve.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${jakarta.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="relative flex min-h-full flex-col bg-background text-foreground">
        <div aria-hidden="true" className="page-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[34rem]" />
        <Providers>
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
