> How Backed uses Meteora's Dynamic Bonding Curve (DBC) and DAMM v2, setting by setting.

[← Back to the README](../README.md)

# How Backed uses DBC

The maker fills in a plain form. `campaignToConfig()` ([`packages/core/src/engine.ts`](../packages/core/src/engine.ts)) turns it into a DBC config, and the create page shows the mapping live as they type. Once created, the config can't be changed by anyone, including the maker and the platform.

| What the maker sets | DBC setting | Why it's built this way |
|---|---|---|
| **Early-bird tiers** (whole units + start price per tier) | `curve[]` segments, `sqrtStartPrice` | Each tier is one curve segment. Liquidity is solved per segment so each tier sells its units, sized 10 raw units (0.00001 voucher) over so DBC's round-down on swap output doesn't leave whole-unit buyers short. That covers whole-unit (ExactOut) buys only: each dollar-amount buy can round away up to 1 raw unit of the margin, so after many of them the last backer's buy can hold a hair under whole (it shows as "Back the last 5.99"). |
| **Funding goal** | `migrationQuoteThreshold` | Graduation *is* "funded". The goal is derived from the tiers: each tier raises units × √(start price × end price). |
| **Maker's upfront share** | `migrationFee.feePercentage`, `creatorFeePercentage: 100` | The production budget comes out of the raise at graduation and is withdrawn with `creatorWithdrawMigrationFee`. The maker's trust tier caps it (below). |
| **Drop-bot window** | `baseFee`: `FeeSchedulerExponential` | Scalpers rushing a drop are the same as snipers. The fee starts at 15% and falls to 1% over 1, 2 or 5 min, the same for every campaign (the server rejects any other fee schedule). (DBC deprecated the rate limiter for new pools in SDK 1.5.12, so there is no per-buy size limit.) |
| **Limited edition** | `tokenSupply` (fixed), `tokenUpdateAuthority: Immutable` | The supply cap is the production cap, and nobody can mint more. Supply is exactly the curve units plus the resale units. The curve ends at the migration price, so there is no swap buffer and nothing is minted or burned at graduation. |
| **Price in dollars** | `quoteMint` = USDC, `collectFeeMode: QuoteToken` | Product prices shouldn't move with SOL. All fees are collected in USDC. |
| **Back N units** | swap2 `SwapMode.ExactOut` (`amountOut` = N vouchers, `maximumAmountIn` from `swapQuote2`) | A voucher redeems for one item only when whole, so backers pick a number of units, not dollars. ExactOut delivers exactly N vouchers for at most the quote plus 1%. When the buy would leave less than one unit on the curve, it switches to `PartialFill` and takes everything left, so whole-unit buys alone reach the goal. That last buy's minimum out is never below the units asked for, so a buy that lands first and eats into them makes it fail, not deliver a fraction. A fractional balance from a dollar-amount buy (still under *Advanced*) can be topped up to the next whole voucher the same way. |
| **Exit before the goal** | *(DBC sells are always open)* | A backer can sell back any number of vouchers along the curve at any time before graduation. It isn't a refund: it pays the current curve price. |
| **Last buy stops at the goal** | `swap2` with `SwapMode.PartialFill` | A buy larger than what is left only takes what reaches the goal and leaves the rest in the wallet. The quote uses the same mode, so it shows "Only $X left to the goal" instead of failing. |
| **Slippage protection** | `swapQuote2` → `minimumAmountOut` | Every curve and resale swap carries a minimum output from a quote at the chain's clock (default 1%, requests may set 0.1–5%). A front-run between quote and signature makes the swap fail instead of filling at a worse price. |
| **Resale market** | `migrationOption: MET_DAMM_V2` | Graduation opens a DAMM v2 pool, so vouchers stay liquid after the pre-order. |
| **Resale royalty** (1–10%, default 3%) | `migrationFeeOption: Customizable`, `migratedPoolFee: { poolFeeBps, collectFeeMode: QuoteToken, dynamicFee: Enabled }` | The maker picks the resale pool's fee. Every resale pays it in USDC, plus DAMM v2's volatility fee when the price moves fast. The DAMM v2 config the pool migrates into (and so the pool's address) follows from the config's on-chain `migrationFeeOption`; campaigns created before this kept the fixed 2% config (`FixedBps200`). |
| **Ship date** (14–180 days) | `creatorLiquidityVestingInfo`: 80% vesting, cliff and weekly periods by trust tier | The maker's production money beyond the upfront share. DBC writes the schedule into the maker's DAMM v2 position at graduation ("inner vesting"); the maker withdraws each released tranche with **Unlock production funds** (`removeLiquidity`, minimums from `getWithdrawQuote`: slippage on the USDC side, the full quote on the voucher side) and every voucher that comes out is burned in the same transaction, so it stops being owed. Before the cliff the program refuses the withdrawal. |
| **Resale floor and royalties** | `creatorPermanentLockedLiquidityPercentage: 15`, `partnerPermanentLockedLiquidityPercentage: 5`, `creatorLiquidityPercentage: 0` | 20% of resale liquidity is locked forever, so vouchers always have a market. Fees are split by liquidity, so the maker's royalty per trade is **pool fee × (1 − Meteora's protocol share) × the maker's share of pool liquidity**, all read from chain: 95% of the liquidity at graduation, 75% once fully unlocked. On localnet a 5% pool paid 0.15 USDC on a 3 USDC buy: 0.03 to Meteora's 20% protocol share, 0.114 to the maker (3.8% of the trade) and 0.006 to the platform; fully unlocked, the same pool pays the maker 3%. |
| **Curve trading fees** | `creatorTradingFeePercentage: 50`, `dynamicFeeEnabled` | After Meteora's 20% protocol fee, the maker earns half of the curve's trading fees. Both fee streams are claimed in one transaction. |
| **Affiliate links** | swap `referralTokenAccount` | Share links carry `?ref=<wallet>`. On referred buys, the sharer gets DBC's referral cut (20% of the protocol fee). The buyer pays nothing extra. The ref is checked at each buy: one that is the buyer, malformed, or without a usable USDC account (yet) is dropped, never failing the buy. |
| **Platform revenue** | `feeClaimer` / `leftoverReceiver` (the platform's fee claimer), `claimPartnerTradingFeeToReceiver`, DAMM v2 `claimPositionFee2`, `withdrawLeftover` | The partner side has code behind it: [`platform.ts`](../packages/core/src/platform.ts) reads what the platform is owed on every campaign from chain (`/platform` shows it) and builds the claims: partner curve fees and the partner resale position's fees to a treasury, and the leftover vouchers, which are burned in the same transaction because they were never sold. `withdrawLeftover` is permissionless; if someone else calls it first, the vouchers land unburned with the fee claimer, `/platform` shows them as "withdrawn, not burned", and the next claim burns them on their own (safe because both fee modes are USDC-only, so the claimer earns no vouchers as fees; it must not hold any for another reason). On localnet a campaign left 2 raw units of leftover: the rest of its base vault after graduation is Meteora's migration fee. The partner's share of any surplus (80% after Meteora, split like curve fees) and of the graduation payout are claimed too when non-zero. For Backed configs the payout share is always zero (the maker takes the whole payout) and the surplus is at most rounding dust: the curve ends at the goal and an ExactIn buy past it fails, but on localnet the PartialFill buy that completed a campaign left 4 raw units above the goal, 2 of them the partner's; the maker's share of a surplus has no button and would be withdrawn with the SDK's `creatorWithdrawSurplus`. |
| **On-chain listing** | `createPoolMetadata`, `createPartnerMetadata` | After create, the maker signs a second transaction that writes the campaign's name, page URL and image into its DBC pool metadata; the campaign page links it. The platform's own partner listing is a one-off script. |
| **No reused configs** | `createConfigAndPool` (the maker pays; `feeClaimer` = `PLATFORM_FEE_CLAIMER`, which never signs) | Each campaign gets its own fresh config. Config and pool go in one transaction when it fits under the 1232-byte limit with 16 bytes to spare; otherwise (long names with 3–4 tiers) it is split into `createConfig` + `createPool`, signed in one wallet prompt (`signAllTransactions`) and sent in order. |

### Why we build the curve ourselves

`buildCurveWithCustomSqrtPrices` sizes the curve from a total supply and adds a 25% swap buffer, which moves the goal away from what the maker asked for. The engine instead solves per-segment liquidity with `base = L·(√P1 − √P0)/(√P0·√P1)` and computes the goal with the SDK's own `getDeltaAmountQuoteUnsigned`. It then sets the minimum supply the program accepts: curve units + resale units, before and after migration. Because the last segment ends at the migration price, the SDK's 25% swap buffer comes to 0. On devnet the supply after graduation came to **12.2988 units against 12.30 planned**.

### Maker trust tier

The upfront share is capped by a trust tier scored from the maker wallet's **public mainnet history** ([`trust.ts`](../packages/core/src/trust.ts)):

| Signal | Effect |
|---|---|
| Wallet age | up to +40 |
| Transaction count, spread over active days | up to +25 (500+ over 30 days, or 50+ over 7) |
| First funded by a brand-new wallet | −20 |

| Tier | Score | Max upfront share |
|---|---|---|
| A | ≥ 65 | 40% |
| B | ≥ 40 | 25% |
| C | < 40 | 10% |

Only on-chain signals count, so tier A takes both a year of history and 500+ transactions on 30+ distinct days: a burst of self-transfers in one sitting counts as one active day. The lookup walks back up to 10 pages (10,000 signatures) within an 8-second budget, and each RPC call is cut off at the budget. A longer history is marked truncated: its age is scored as a lower bound ("≥ N days") and the first funder is not checked. A walk that ran out of time is also marked partial: the form says so and offers to check again, and the result is cached for 30 s instead of 10 min. A failed lookup is never read as a new wallet: the create form says the check is unavailable and launching returns 503 until it works. Lookups that miss the cache spend a token from a tight per-IP bucket (5, then one per 30 s), since any address can be looked up.

The tier also sets the **ship window**: when the maker's vesting 80% of the resale liquidity unlocks ([`vesting.ts`](../packages/core/src/vesting.ts)). The split is the same for every tier (partner 5% and maker 15% permanent, maker 80% vesting), so the day-1 lock is 100% and the permanent floor is 20%:

| Tier | Cliff (days after the goal) | Then | Maker reaches* |
|---|---|---|---|
| A | max(14, ship date) — 25% of the vesting releases | 6 × 12.5% weekly | 40 + 0.8 × 60 = 88% |
| B | max(30, ship date + 14) — 10% releases | 12 × 7.5% weekly | 25 + 0.8 × 75 = 85% |
| C | max(60, ship date + 30) — nothing releases | 20 × 5% weekly | 10 + 0.8 × 90 = 82% |

\* Share of the raise in USDC, assuming no resale trading. Until the cliff, backers who want out can sell into the full resale pool.

A new or throwaway wallet can still run a campaign, but it takes less upfront and waits longer for the rest.
