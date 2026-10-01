# 3-minute demo script (Loom)

Record against the deployed devnet app, or a local run with `VESTING_SCHEDULE_OVERRIDE` so the unlock fits in the video. Use two browser profiles with Phantom on devnet: a maker and a backer. Press **Get test USDC** in each first.

**0:00 – 0:20 · The problem.**
"A $30 drop sells out in a minute, bots and resellers flip it for $300, and the person who made it gets nothing. Kickstarter fixes funding but not resale. Backed puts pre-orders, funding and resale on one Meteora Dynamic Bonding Curve."

**0:20 – 0:55 · Maker creates a campaign** (`/create`).
- Type the name and two tiers. Point at the right-hand panel: "every input becomes a DBC setting: tiers are `curve[]` segments, the goal is `migrationQuoteThreshold`, the upfront budget is the migration fee, the drop-bot window is the fee scheduler."
- Point at **Your payout**: "10% at the goal, then the rest of my production money unlocks from the resale pool on a ship-date schedule. That's DBC's `creatorLiquidityVestingInfo`."
- Launch. "I sign and pay. The platform never signs anything, and the config can't be changed by anyone."

**0:55 – 1:30 · Backers.**
- Backer opens the campaign through a referral link and backs 2 units. "Whole units: ExactOut swaps with a slippage minimum."
- Show the price rising tier by tier and the progress bar. Exit 0.5 voucher: "you can leave at the curve price before the goal."
- Fill to the goal: "the last buy stops exactly at the goal."

**1:30 – 2:10 · Graduation and resale.**
- Graduate now: "the pool migrates to a DAMM v2 pool with the maker's 5% royalty. 20% of that liquidity is locked forever, so vouchers always keep a market. The other 80% unlocks to the maker after the ship date."
- Buy on resale and show the royalty and the backer floor.
- Maker: withdraw the budget, claim fees (one transaction for curve and resale fees), then **Unlock production funds**: "the vouchers it pulls out are burned, so they're no longer owed."

**2:10 – 2:45 · Redemption.**
- Backer redeems 1 voucher with shipping details: "the burn carries a memo that ties it to this order, so nobody else can claim it."
- Maker signs in to Orders, sees the order, and marks it shipped, which deletes the address.

**2:45 – 3:00 · Close.**
"No custom program: every rule is DBC config, DAMM v2 and SPL burns. It's tested end to end against the mainnet Meteora binaries in CI. Tokenized pre-orders: a new asset class, where makers get funded, early fans pay less, and the maker earns a royalty on every resale."
