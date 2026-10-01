# Submission: Superteam Earn, "Best use of Meteora's Dynamic Bonding Curve (DBC)"

Deadline: **2026-10-13 06:59 UTC**. The listing only accepts submissions made by a human. If the repo is private, give GitHub user **`dannxbt`** read access before submitting, as the listing asks.

**Project Name**
Backed

**Project Description**
Backed is pre-orders for real products, priced on a Meteora Dynamic Bonding Curve.
- A maker lists a product with early-bird tiers. Each tier is a DBC curve segment, so early backers pay less.
- The funding goal is the DBC migration threshold: reaching it pays the maker's upfront budget (the migration fee, capped by a wallet trust tier).
- Graduation opens a DAMM v2 resale pool with a royalty the maker sets (Customizable migration fee). 20% of its liquidity is locked forever, so vouchers always have a market.
- The maker's other 80% unlocks on a ship-date schedule through DBC liquidity vesting. That is the maker's production money, and the vouchers that come out with it are burned.
- Backers buy whole units (ExactOut swaps with slippage minimums), can exit at the curve price before the goal, and redeem by burning a voucher. The burn's memo binds it to their encrypted shipping details.
- The platform is the DBC partner and claims its side from chain.

There's no custom program: every rule is DBC config, DAMM v2 and SPL burns. The whole lifecycle is tested in CI against the mainnet DBC and DAMM v2 binaries on a local validator, once through the SDK and once clicked through the app in a real browser, from launch to a shipped order. The app is dressed in Meteora's own design language and draws each campaign's DBC price curve.

**Project Github Link**
https://github.com/Don-Vicks/preorder-curves (to replicate and test it: [`docs/replicate.md`](replicate.md))

**Project Website**
https://backed.up.railway.app (devnet; press "Get test USDC" after connecting a wallet)

**Project X Link**
(optional)

**Pitch deck or Loom/video**
Record the 3-minute Loom from [`docs/demo-script.md`](demo-script.md), or use the pitch deck: https://claude.ai/artifact/RpwieLyVcUzk4uh5KchqmH (anyone with the link can open it). The walkthrough with screenshots is [`docs/walkthrough.md`](walkthrough.md).

**Did you submit this project to the official Crypto World's Fair Hackathon on Colosseum?**
(Yes/No; submit there too, then paste the Colosseum project and profile links)
