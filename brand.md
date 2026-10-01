# Brand — Backed

_Status: active · set 2026-09-29_

**Backed** — back it early, pay less. Pre-orders for real products on a bonding curve: early backers pay less, reaching the goal funds the maker, and a resale market pays the maker royalties.

Category: defi · Mood: warm · Reference: Jupiter

## Palette — Sunset on Slate

Sunset Trade's golden-hour orange on cool blue-slate surfaces: a trading desk at dusk. Orange is the only accent; everything else is slate.

### Dark seeds
| Role | OKLCH | Hex |
|---|---|---|
| bg-base | `oklch(0.14 0.02 250)` | `#040A11` |
| bg-elevated | `oklch(0.19 0.025 250)` | `#0B151F` |
| primary | `oklch(0.7 0.19 40)` | `#FC6B33` |
| primary-soft | `oklch(0.82 0.13 40)` | `#FFA682` |
| fg-base | `oklch(0.97 0.008 250)` | `#F1F6FA` |

### Light seeds
| Role | OKLCH | Hex |
|---|---|---|
| bg-base | `oklch(0.98 0.006 250)` | `#F5F9FC` |
| bg-elevated | `oklch(1 0 0)` | `#FFFFFF` |
| primary | `oklch(0.55 0.18 40)` | `#C33E00` |
| primary-soft | `oklch(0.72 0.13 40)` | `#E98664` |
| fg-base | `oklch(0.18 0.02 250)` | `#0B121A` |

All foreground/background pairs pass WCAG AA in both modes (checked numerically). Radius: 0.75rem.

### shadcn tokens (applied in `apps/web/app/globals.css`)
```css
/* :root (light) */
--background: oklch(0.98 0.006 250);
--foreground: oklch(0.18 0.02 250);
--card: oklch(1 0 0);
--card-foreground: oklch(0.18 0.02 250);
--popover: oklch(1 0 0);
--popover-foreground: oklch(0.18 0.02 250);
--primary: oklch(0.55 0.18 40);
--primary-foreground: oklch(0.98 0 0);
--secondary: oklch(0.94 0.011 250);
--secondary-foreground: oklch(0.18 0.02 250);
--muted: oklch(0.95 0.006 250);
--muted-foreground: oklch(0.45 0.02 250);
--accent: oklch(0.93 0.016 233.2);
--accent-foreground: oklch(0.18 0.02 250);
--destructive: oklch(0.55 0.22 25);
--destructive-foreground: oklch(0.98 0 0);
--border: oklch(0.9 0.006 250);
--input: oklch(0.96 0.006 250);
--ring: oklch(0.55 0.18 40);

/* .dark */
--background: oklch(0.14 0.02 250);
--foreground: oklch(0.97 0.008 250);
--card: oklch(0.19 0.025 250);
--card-foreground: oklch(0.97 0.008 250);
--popover: oklch(0.21 0.025 250);
--popover-foreground: oklch(0.97 0.008 250);
--primary: oklch(0.7 0.19 40);
--primary-foreground: oklch(0.1 0 0);
--secondary: oklch(0.23 0.035 250);
--secondary-foreground: oklch(0.97 0.008 250);
--muted: oklch(0.21 0.025 250);
--muted-foreground: oklch(0.67 0.013 250);
--accent: oklch(0.25 0.035 229);
--accent-foreground: oklch(0.97 0.008 250);
--destructive: oklch(0.65 0.22 25);
--destructive-foreground: oklch(0.98 0 0);
--border: oklch(0.27 0.025 250);
--input: oklch(0.19 0.025 250);
--ring: oklch(0.7 0.19 40);
```

## Typography — Instrument Serif + Inter + JetBrains Mono
- **Headlines:** Instrument Serif 400 (`font-heading` / `font-serif`). Big, short, sentence case. Italic for one emphasised word at most.
- **UI and body:** Inter (`font-sans`).
- **Numbers, prices, addresses:** JetBrains Mono with tabular figures (`font-mono tabular-nums`).
Wired with `next/font/google` in `apps/web/app/layout.tsx`.

## Gradients
None. Colour comes only from the tokens.

## Voice
- **Plain and direct.** Say what happens to the backer's money: "Back this", "Exit at the curve price", "Goal reached — the maker is funded". No hype, no "to the moon".
- **Warm, maker-first.** Campaigns are about people making real things. Name the maker, show the product.
- **Honest about mechanics.** Selling back is an exit at the current curve price, not a refund. The maker's trust tier and upfront share are always visible.

## Do / don't
- Do use orange (`primary`) for the one main action per screen and for progress.
- Do put every price and amount in JetBrains Mono.
- Don't use orange for body text or large fills; don't add a second accent hue.
- Don't hardcode colours — use tokens so light and dark both work.
