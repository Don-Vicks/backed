# Backed

**Back it early. Pay less.** Pre-orders for real products, priced on a Meteora Dynamic Bonding Curve.

A $30 pre-order sells out, then resells for $300 on StockX, and the maker who made it gets nothing. Backed puts crowdfunding and resale on one curve:

1. **Early backers pay less.** A campaign's early-bird tiers are segments of a DBC curve, so the price rises as units sell.
2. **Reaching the goal funds the maker.** The funding goal *is* the DBC migration threshold. At graduation, the maker's production budget is paid out automatically.
3. **Vouchers keep a market, and the maker gets paid on a ship window.** After graduation the same token trades on a DAMM v2 pool. 20% of its liquidity is locked forever; the maker's other 80% unlocks after the promised ship date, on a schedule set by the maker's trust tier, and pays for production. Every position earns fees on every resale. Burn one voucher to claim the item.

No custom program. Every rule comes from DBC config, DAMM v2 and SPL token burns.

Built for the Colosseum **Crypto World's Fair** and Meteora's **Best use of DBC** track.

---

## How Backed uses DBC

The maker fills in a plain form. `campaignToConfig()` ([`packages/core/src/engine.ts`](packages/core/src/engine.ts)) turns it into a DBC config, and the create page shows the mapping live as they type. Once created, the config can't be changed by anyone, including the maker and the platform.

| What the maker sets | DBC setting | Why it's built this way |
|---|---|---|
| **Early-bird tiers** (whole units + start price per tier) | `curve[]` segments, `sqrtStartPrice` | Each tier is one curve segment. Liquidity is solved per segment so each tier sells its units, sized 10 raw units (0.00001 voucher) over so DBC's round-down on swap output never leaves a tier short. |
| **Funding goal** | `migrationQuoteThreshold` | Graduation *is* "funded". The goal is derived from the tiers: each tier raises units × √(start price × end price). |
| **Maker's upfront share** | `migrationFee.feePercentage`, `creatorFeePercentage: 100` | The production budget comes out of the raise at graduation and is withdrawn with `creatorWithdrawMigrationFee`. The maker's trust tier caps it (below). |
| **Drop-bot window** | `baseFee`: `FeeSchedulerExponential` | Scalpers rushing a drop are the same as snipers. The fee starts at 50% and falls to 1% over 5–30 min. (DBC deprecated the rate limiter for new pools in SDK 1.5.12, so there is no per-buy size limit.) |
| **Limited edition** | `tokenSupply` (fixed), `tokenUpdateAuthority: Immutable` | The supply cap is the production cap, and nobody can mint more. Supply is exactly the curve units plus the resale units. The curve ends at the migration price, so there is no swap buffer and nothing is minted or burned at graduation. |
| **Price in dollars** | `quoteMint` = USDC, `collectFeeMode: QuoteToken` | Product prices shouldn't move with SOL. All fees are collected in USDC. |
| **Back N units** | swap2 `SwapMode.ExactOut` (`amountOut` = N vouchers, `maximumAmountIn` from `swapQuote2`) | A voucher redeems for one item only when whole, so backers pick a number of units, not dollars. ExactOut delivers exactly N vouchers for at most the quote plus 1%. When the buy would leave less than one unit on the curve, it switches to `PartialFill` and takes everything left, so whole-unit buys alone reach the goal. A fractional balance from a dollar-amount buy (still under *Advanced*) can be topped up to the next whole voucher the same way. |
| **Exit before the goal** | *(DBC sells are always open)* | A backer can sell back along the curve at any time before graduation. It isn't a refund: it pays the current curve price. |
| **Resale market** | `migrationOption: MET_DAMM_V2` | Graduation opens a DAMM v2 pool, so vouchers stay liquid after the pre-order. |
| **Resale royalty** (1–10%, default 3%) | `migrationFeeOption: Customizable`, `migratedPoolFee: { poolFeeBps, collectFeeMode: QuoteToken, dynamicFee: Enabled }` | The maker picks the resale pool's fee. Every resale pays it in USDC, plus DAMM v2's volatility fee when the price moves fast. The DAMM v2 config the pool migrates into (and so the pool's address) follows from the config's on-chain `migrationFeeOption`; campaigns created before this kept the fixed 2% config (`FixedBps200`). |
| **Ship date** (14–180 days) | `creatorLiquidityVestingInfo`: 80% vesting, cliff and weekly periods by trust tier | The maker's production money beyond the upfront share. DBC writes the schedule into the maker's DAMM v2 position at graduation ("inner vesting"); the maker withdraws each released tranche with **Unlock production funds** (`removeLiquidity`, minimums from `getWithdrawQuote`: slippage on the USDC side, the full quote on the voucher side) and every voucher that comes out is burned in the same transaction, so it stops being owed. Before the cliff the program refuses the withdrawal. |
| **Resale floor and royalties** | `creatorPermanentLockedLiquidityPercentage: 15`, `partnerPermanentLockedLiquidityPercentage: 5`, `creatorLiquidityPercentage: 0` | 20% of resale liquidity is locked forever, so vouchers always have a market. Fees are split by liquidity, so the maker's royalty per trade is **pool fee × (1 − Meteora's protocol share) × the maker's share of pool liquidity**, all read from chain: 95% of the liquidity at graduation, 75% once fully unlocked. On localnet a 5% pool paid 0.15 USDC on a 3 USDC buy: 0.03 to Meteora's 20% protocol share, 0.114 to the maker (3.8% of the trade) and 0.006 to the platform; fully unlocked, the same pool pays the maker 3%. |
| **Curve trading fees** | `creatorTradingFeePercentage: 50`, `dynamicFeeEnabled` | After Meteora's 20% protocol fee, the maker earns half of the curve's trading fees. Both fee streams are claimed in one transaction. |
| **Affiliate links** | swap `referralTokenAccount` | Share links carry `?ref=<wallet>`. On referred buys, the sharer gets DBC's referral cut (20% of the protocol fee). The buyer pays nothing extra. |
| **No reused configs** | `createConfigAndPool` (one transaction, platform key = `feeClaimer`) | Each campaign gets its own config, created in the same transaction as its pool. Nobody can launch another pool on a campaign's terms. |

### Why we build the curve ourselves

`buildCurveWithCustomSqrtPrices` sizes the curve from a total supply and adds a 25% swap buffer, which moves the goal away from what the maker asked for. The engine instead solves per-segment liquidity with `base = L·(√P1 − √P0)/(√P0·√P1)` and computes the goal with the SDK's own `getDeltaAmountQuoteUnsigned`. It then sets the minimum supply the program accepts: curve units + resale units, before and after migration. Because the last segment ends at the migration price, the SDK's 25% swap buffer comes to 0. On devnet the supply after graduation came to **12.2988 units against 12.30 planned**.

### Maker trust tier

The upfront share is capped by a trust tier scored from the maker wallet's **public mainnet history** ([`trust.ts`](packages/core/src/trust.ts)):

| Signal | Effect |
|---|---|
| Wallet age | up to +40 |
| Transaction count | up to +25 |
| First funded by a brand-new wallet | −20 |
| Verified social account (demo flag) | +25 |

| Tier | Score | Max upfront share |
|---|---|---|
| A | ≥ 70 | 40% |
| B | ≥ 40 | 25% |
| C | < 40 | 10% |

The tier also sets the **ship window**: when the maker's vesting 80% of the resale liquidity unlocks ([`vesting.ts`](packages/core/src/vesting.ts)). The split is the same for every tier (partner 5% and maker 15% permanent, maker 80% vesting), so the day-1 lock is 100% and the permanent floor is 20%:

| Tier | Cliff (days after the goal) | Then | Maker reaches* |
|---|---|---|---|
| A | max(14, ship date) — 25% of the vesting releases | 6 × 12.5% weekly | 40 + 0.8 × 60 = 88% |
| B | max(30, ship date + 14) — 10% releases | 12 × 7.5% weekly | 25 + 0.8 × 75 = 85% |
| C | max(60, ship date + 30) — nothing releases | 20 × 5% weekly | 10 + 0.8 × 90 = 82% |

\* Share of the raise in USDC, assuming no resale trading. Until the cliff, backers who want out can sell into the full resale pool.

A new or throwaway wallet can still run a campaign, but it takes less upfront and waits longer for the rest. The "verified social" input is a demo stand-in, not a real social check.

---

## Proof on devnet

A campaign run through the whole lifecycle using the web API (`API Smoke Mug`):

| Step | Transaction / account |
|---|---|
| Campaign created (maker wallet signs, platform co-signs) | [tx](https://solscan.io/tx/5DSXxnDJuDu6WQEenQGmj6gEWLd9DEbejMoU6fnqMxXV1R1PEuatAv5jqfRmo3JpQJMtCuRPSVVAQP4QbE6DJzhf?cluster=devnet) · [pool](https://solscan.io/account/22EnU5dJp5FHABW99GkeZLAPVZEQgBq5yhscV6yvQrEY?cluster=devnet) · [config](https://solscan.io/account/7RqrUL2YwvkfkXGHrKX1fv1pZPkckCtXn4cvzfWgJRfR?cluster=devnet) |
| Graduated to DAMM v2 | [tx](https://solscan.io/tx/2QyHs2isMNUeJMBy6VfXtDtqHHtn6Mhw1hXgtaouRjfdDTudpxfwkrUxsZsx8ZEAxeJTZo4NGgf4B79VP7JMpq7z?cluster=devnet) · [resale pool](https://solscan.io/account/Pnq7QAbJ69pRkLurDwLaWgN7xSC58tqvKVD1CqEibHz?cluster=devnet) |
| Resale buy | [tx](https://solscan.io/tx/4hdTNWT7kHojtv8DuujDrcGRqBassnKPEStqAKHULJSdmwYnXrNzH2Y1Y5gKfFXLZswi3f2cUweqQhdkqscA46uV?cluster=devnet) |
| Maker claims curve fees + resale royalties in one tx | [tx](https://solscan.io/tx/3NjgNoxu1MDzYwTZHeK45yP9oHs69ns3nvFCTzVNxzWXABieMocTYnjJY5yCnfekGR1veoSstTQHZ89CN6rNvf4B?cluster=devnet) |

Also measured on devnet: the drop-bot fee on a 2 USDC buy was **40% at launch and 0.8% after the window**, and the maker's budget withdrawal was exactly the configured share of the goal.

---

## Architecture

```
apps/web            Next.js 16 app: pages + API routes (the API builds unsigned transactions)
packages/core       All Solana logic, shared by the scripts and the web server
  pricing.ts        pure tier → goal/units math (also used in the browser)
  engine.ts         campaignToConfig(): campaign + trust tier → DBC ConfigParameters
  trust.ts          maker trust tier from mainnet wallet history
  chain.ts          transaction builders: create, buy, exit, graduate, withdraw, redeem
  units.ts          back N whole units (ExactOut, last-buy sweep), top-up to a whole voucher, quotes
  voucher-units.ts  whole-unit rules: units validation, whole/fraction split, sweep decision (pure)
  live.ts           live campaign state, quotes, devnet/localnet faucet
  network.ts        NETWORK switch (localnet, devnet, mainnet), RPC and explorer links
  resale.ts         DAMM v2 resale pool, quotes, swaps, maker earnings + claim
  vesting.ts        ship-window LP vesting by trust tier (pure, also used in the browser)
  unlock.ts         "Unlock production funds" (remove released LP + burn), backer floor, on-chain terms
  redemptions.ts    on-chain burn verification, shipping records, maker sign-in
  scripts/          lifecycle proof, launch, API smoke tests
```

- **Wallet flow.** The server builds each transaction and the browser wallet signs it. Campaign creation is signed by the platform key (the DBC partner) and the fresh config and mint keys on the server, then by the maker's wallet as pool creator.
- **Graduation** can be triggered by anyone once the goal is reached, and the platform pays the fee.
- **Blinks.** Every campaign URL `/c/<pool>` is also a Solana Action (`/actions.json` maps it to `/api/actions/back/<pool>`). Shared links show **Back 1 · $X**, **Back 2 · $Y** and a whole-number **units** field in X or any Blink client, priced live with fees included; while the launch fee is above 5% the description says how high it is and when it falls. The `?ref=` referral carries through. Links shared before units existed (`?amount=`) still work. Funded campaigns return a disabled Action that points to the resale market.
- **Redemption.** The backer burns one whole voucher. The server checks the burn on-chain (mint, authority, amount, never reused) before accepting shipping details, and the details never go on-chain. The maker views orders by signing a time-stamped message with their wallet.

Stack: `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`, `@meteora-ag/cp-amm-sdk@1.5.0`, `@solana/web3.js` v1, Next.js 16, React 19, Tailwind 4, shadcn/ui, Solana wallet adapter.

---

## Run it

Needs Node 22.22 (`engines.node`, which Railway's Railpack reads before `.node-version`), pnpm 10 (`packageManager`) and a Solana CLI wallet with some devnet SOL (used to fund the test wallets).

```bash
pnpm install
cp .env.example .env        # NETWORK=devnet; optional Helius RPC URLs
pnpm core:wallets           # create + fund devnet test wallets (platform, maker, 3 backers)
pnpm core:lifecycle         # full on-chain proof; also creates the devnet mock USDC mint
pnpm --dir apps/web dev     # http://localhost:3100
```

In the app, connect Phantom, Solflare or Backpack on **devnet** and click **Get test USDC**. Creating a campaign on devnet needs `PUBLIC_BASE_URL` set to a public https URL (a tunnel), because the metadata URI is written on-chain; use `NETWORK=localnet` to create campaigns locally.

Other commands:

```bash
pnpm core:test                                        # unit tests (pricing, engine vs SDK validation, trust, sign-in, config)
pnpm core:test:localnet                               # checks against a local validator (LOCALNET_RPC_URL)
pnpm build && pnpm start                              # production build + server of the web app, from the repo root
pnpm core:launch --campaign examples/hoodie.json      # create a campaign from JSON
cd packages/core && npx ts-node src/scripts/api-smoke.ts   # drive the full flow through the web API at WEB_URL (localnet, or devnet with PUBLIC_BASE_URL)
```

### Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that matter most:

- **`NETWORK`** (`localnet`, `devnet` or `mainnet`) is the only network switch. The scripts and the server read it at runtime; `next.config.ts` bakes it and the matching browser RPC (`PUBLIC_RPC_URL`, else a keyless default) into the bundle, so **changing it needs a rebuild**. `/api/health` returns 503 if the running server and the build disagree. `NETWORK=mainnet` switches to real USDC and mainnet RPC; the faucet only runs on devnet and localnet.
- **`PUBLIC_BASE_URL`** is the app's https origin. It goes into immutable on-chain metadata URIs and Blink icons, so it is required off localnet (`RAILWAY_PUBLIC_DOMAIN` is the fallback). Creating a campaign fails fast without it. Creating campaigns from a laptop on devnet therefore needs a public https URL (a tunnel); use localnet for local work.
- **`PLATFORM_SECRET_KEY`** and **`USDC_MINT`** let a deployed server run without the gitignored `keys/` directory. `PLATFORM_FEE_CLAIMER` sets who receives partner fees and leftover on every new campaign config; configs are immutable, so set it before launching.
- **Localnet**: `NETWORK=localnet` with a `solana-test-validator` that has the mainnet DBC, DAMM v2, Metaplex and Locker programs cloned. `LOCALNET_RPC_URL` defaults to `http://127.0.0.1:8899`, explorer links use the Solana Explorer's custom cluster, and `TRUST_FIXTURES` can stand in for mainnet wallet history. `VESTING_SCHEDULE_OVERRIDE` (JSON, seconds) replaces the tier ship-window schedule so a campaign unlocks in seconds; it is ignored on devnet and mainnet.

### Deploy (Railway)

`railway.json` builds from the repo root with Railpack (`pnpm build`), starts with `pnpm start` (Next reads `PORT`) and health-checks `/api/health`, a liveness route that makes no RPC call. Railpack takes the Node version from `engines.node` (`22.22.x`). Set `NETWORK`, the RPC URLs, `PUBLIC_RPC_URL`, `PUBLIC_BASE_URL`, `PLATFORM_SECRET_KEY`, `PLATFORM_FEE_CLAIMER` and (off mainnet) `USDC_MINT` as service variables before the first build, and keep the service root at the repo root so the workspace resolves.

---

## Known limits

- **Trust-minimized, not trustless.** A maker can take the upfront share and never ship. The trust tier limits how much they can take upfront and how long the rest waits. Vesting is time-based: DBC and DAMM v2 cannot release liquidity when goods ship, so after the ship window a maker who disappears leaves backers a 20% permanent market floor, not a refund.
- **Exit ≠ refund.** Selling back before the goal pays the current curve price, which can be more or less than the price paid.
- **Demo storage.** Campaign records, token metadata and shipping details are kept in JSON files on the server. Production needs a database, and encryption for shipping data.
- **Trust signals are simple.** Wallet age, activity and first funder can be gamed with aged wallets. They are one input, shown openly, and not a verdict.

## Business model

Backed is the DBC **partner** on every campaign. It earns the partner half of curve trading fees (after Meteora's 20% protocol fee) and the fees on its 5% permanently locked share of each resale pool. Makers pay nothing upfront. First users are merch drops, indie hardware and game-key pre-orders, and hackathon teams. Later, a Shopify plugin so any store can offer pre-orders with a built-in resale market.
