# Brand — Backed

_Status: active · set 2026-10-01 (Meteora night; replaces Sunset on Slate from 2026-09-29)_

**Backed** — back it early, pay less. Pre-orders for real products on a bonding curve: early backers pay less, reaching the goal funds the maker, and a resale market pays the maker royalties.

Category: defi · Mood: night market, precise · Reference: Meteora (app.meteora.ag)

## Palette — Meteora night

Backed is built on Meteora and dresses like it: Meteora's v2 tokens (taken from app.meteora.ag's stylesheet), used with restraint. Indigo-black surfaces, Meteora orange for the one main action, violet for focus, and Meteora's gold-orange-violet gradient as the signature, in a few places only.

The name stays **Backed**, with a "Built on Meteora" mark in the header and footer: the look is Meteora's, but the product must never read as an official Meteora app. Don't use Meteora's logo or wordmark as ours.

### Dark seeds (the app ships dark)
| Role | Hex | Meteora token |
|---|---|---|
| background | `#0D0D13` | v2-base-3 |
| card | `#12121C` | v2-base--1 |
| popover / muted | `#181825` | v2-base-0 |
| secondary | `#202031` | v2-base-1 |
| accent (hover) | `#262636` | v2-base-2 |
| border | `#23233A` | between v2-border-tertiary and -secondary |
| input outline | `#434360` | v2-border-primary |
| primary (actions) | `#F54B00` | v2-accent-400 |
| ring, violet | `#8664FF` | v2-primary-500 |
| foreground | `#F9F9FB` | v2-text-primary |
| muted foreground | `#9595B2` | v2-text-secondary |
| success / danger | `#24C98D` / `#F04438` | v2-success / v2-danger |

Signature gradient: `linear-gradient(217deg, #F5BD00 -7.9%, #F54B00 28.48%, #6E45FF 91.8%)` (Meteora's `met-linear-gradient`), as `--gradient-brand`.

Contrast (WCAG AA, checked numerically): text on primary uses `#0D0D13` (5.4:1); primary as text on the background 5.4:1; muted foreground 6.7:1 on the background and 6.4:1 on cards; the violet focus ring 4.9:1. Radius: 0.875rem.

Light tokens exist in `globals.css` for completeness (`#C23B00` primary on white), but the app is dark only.

## Typography — Plus Jakarta Sans + Inter + JetBrains Mono
- **Headlines:** Plus Jakarta Sans 600 (`font-heading`), Meteora's display face, tracked tight (-0.025em, -0.035 to -0.04em at display sizes) with the word gaps given back (`word-spacing: 0.1em`). Sentence case, short.
- **UI and body:** Inter (`font-sans`), as Meteora.
- **Numbers, prices, addresses:** JetBrains Mono with tabular figures (`font-mono tabular-nums`).
Wired with `next/font/google` in `apps/web/app/layout.tsx`.

## Gradient, sparingly
Utilities in `globals.css`: `bg-brand-gradient`, `text-brand-gradient`, `ring-brand-gradient` (a hairline around a card) and `page-glow` (the soft violet and orange wash at the top of each page, after Meteora's header). Used for:
- one word of a headline ("Pay less."),
- progress bars and the price curve (violet where it starts, gold at the goal),
- the hairline under the header and around the campaign's price card,
- the mark: a pre-order curve rising to its goal (`components/brand-mark.tsx`, `app/icon.svg`).
Never behind body text, never on buttons.

## Voice
- **Plain and direct.** Say what happens to the backer's money: "Back this", "Exit at the curve price", "Goal reached — the maker is funded". No hype, no "to the moon".
- **Warm, maker-first.** Campaigns are about people making real things. Name the maker, show the product.
- **Honest about mechanics.** Selling back is an exit at the current curve price, not a refund. The maker's trust tier and upfront share are always visible.

## Do / don't
- Do use orange (`primary`) for the one main action per screen; progress and the curve take the gradient.
- Do put every price and amount in JetBrains Mono.
- Do say where Meteora does the work ("priced on Meteora's Dynamic Bonding Curve", "a Meteora DAMM v2 resale market").
- Don't use orange for body text or large fills; violet is for focus and the gradient, not a second button colour.
- Don't hardcode colours in components: use tokens. Link previews and the Blink icon (rendered outside the app) repeat the hex values.
