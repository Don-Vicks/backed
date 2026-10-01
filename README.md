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
| **Platform revenue** | `feeClaimer` / `leftoverReceiver` (the platform's fee claimer), `claimPartnerTradingFeeToReceiver`, DAMM v2 `claimPositionFee2`, `withdrawLeftover` | The partner side has code behind it: [`platform.ts`](packages/core/src/platform.ts) reads what the platform is owed on every campaign from chain (`/platform` shows it) and builds the claims: partner curve fees and the partner resale position's fees to a treasury, and the leftover vouchers, which are burned in the same transaction because they were never sold. `withdrawLeftover` is permissionless; if someone else calls it first, the vouchers land unburned with the fee claimer, `/platform` shows them as "withdrawn, not burned", and the next claim burns them on their own (safe because both fee modes are USDC-only, so the claimer earns no vouchers as fees; it must not hold any for another reason). On localnet a campaign left 2 raw units of leftover: the rest of its base vault after graduation is Meteora's migration fee. The partner's share of any surplus (80% after Meteora, split like curve fees) and of the graduation payout are claimed too when non-zero. For Backed configs the payout share is always zero (the maker takes the whole payout) and the surplus is at most rounding dust: the curve ends at the goal and an ExactIn buy past it fails, but on localnet the PartialFill buy that completed a campaign left 4 raw units above the goal, 2 of them the partner's; the maker's share of a surplus has no button and would be withdrawn with the SDK's `creatorWithdrawSurplus`. |
| **On-chain listing** | `createPoolMetadata`, `createPartnerMetadata` | After create, the maker signs a second transaction that writes the campaign's name, page URL and image into its DBC pool metadata; the campaign page links it. The platform's own partner listing is a one-off script. |
| **No reused configs** | `createConfigAndPool` (the maker pays; `feeClaimer` = `PLATFORM_FEE_CLAIMER`, which never signs) | Each campaign gets its own fresh config. Config and pool go in one transaction when it fits under the 1232-byte limit with 16 bytes to spare; otherwise (long names with 3–4 tiers) it is split into `createConfig` + `createPool`, signed in one wallet prompt (`signAllTransactions`) and sent in order. |

### Why we build the curve ourselves

`buildCurveWithCustomSqrtPrices` sizes the curve from a total supply and adds a 25% swap buffer, which moves the goal away from what the maker asked for. The engine instead solves per-segment liquidity with `base = L·(√P1 − √P0)/(√P0·√P1)` and computes the goal with the SDK's own `getDeltaAmountQuoteUnsigned`. It then sets the minimum supply the program accepts: curve units + resale units, before and after migration. Because the last segment ends at the migration price, the SDK's 25% swap buffer comes to 0. On devnet the supply after graduation came to **12.2988 units against 12.30 planned**.

### Maker trust tier

The upfront share is capped by a trust tier scored from the maker wallet's **public mainnet history** ([`trust.ts`](packages/core/src/trust.ts)):

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

The tier also sets the **ship window**: when the maker's vesting 80% of the resale liquidity unlocks ([`vesting.ts`](packages/core/src/vesting.ts)). The split is the same for every tier (partner 5% and maker 15% permanent, maker 80% vesting), so the day-1 lock is 100% and the permanent floor is 20%:

| Tier | Cliff (days after the goal) | Then | Maker reaches* |
|---|---|---|---|
| A | max(14, ship date) — 25% of the vesting releases | 6 × 12.5% weekly | 40 + 0.8 × 60 = 88% |
| B | max(30, ship date + 14) — 10% releases | 12 × 7.5% weekly | 25 + 0.8 × 75 = 85% |
| C | max(60, ship date + 30) — nothing releases | 20 × 5% weekly | 10 + 0.8 × 90 = 82% |

\* Share of the raise in USDC, assuming no resale trading. Until the cliff, backers who want out can sell into the full resale pool.

A new or throwaway wallet can still run a campaign, but it takes less upfront and waits longer for the rest.

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
  chain.ts          transaction builders: create, buy, exit, graduate, withdraw, redeem (burn + memo)
  units.ts          back N whole units (ExactOut, last-buy sweep), top-up to a whole voucher, quotes
  voucher-units.ts  whole-unit rules: units validation, whole/fraction split, sweep decision (pure)
  live.ts           live campaign state, quotes, devnet/localnet faucet
  swaps.ts          slippage, chain clock, referral resolution, quote summaries
  network.ts        NETWORK switch (localnet, devnet, mainnet), RPC and explorer links
  resale.ts         DAMM v2 resale pool, quotes, swaps, maker earnings + claim
  vesting.ts        ship-window LP vesting by trust tier (pure, also used in the browser)
  unlock.ts         "Unlock production funds" (remove released LP + burn), backer floor, on-chain terms
  redemptions.ts    prepare/submit/recover redemptions, burn verification, sealed shipping, maker sign-in
  platform.ts       the platform's side (DBC partner): earnings across campaigns, claims, leftover burn
  metadata.ts       on-chain listings: DBC pool metadata (maker) and partner metadata (platform)
  db.ts, seal.ts    SQLite store (named migrations, legacy JSON import), shipping encryption at rest
  listing.ts        idempotent confirm and reconcile of pending campaigns
  inspect.ts        decodes a config, a pool and the DAMM v2 positions per owner (core:inspect, tests)
  localnet.ts       what a local validator clones from mainnet, and the localnet seed
  scripts/          lifecycle proof, launch, inspect, localnet seed, reconcile, API smoke and negative tests, platform claims, partner listing
scripts/localnet    start/stop/dump a validator with the mainnet Meteora programs
.github/workflows   CI: check (typecheck, lint, unit tests, build) and localnet (chain suites)
```

- **Wallet flow.** The server builds each transaction and the browser wallet signs it. Every wallet transaction carries a compute-unit price (p75 of recent fees on its writable accounts, capped by `PRIORITY_FEE_MAX_MICROLAMPORTS`; none on localnet). Campaign creation is paid and signed by the maker's wallet (payer and pool creator); the server only signs with the fresh config and mint keys, never the platform key. The server builds the campaign from an allowlist of fields: name ≤ 32 bytes, ticker `A–Z0–9` ≤ 10, description ≤ 1000, https image ≤ 200, whole units, at most 4 tiers, and the fixed launch fee (15% → 1% over 1, 2 or 5 min), with the goal at most 10,000,000 USDC and the final price at most 100× the first tier's. A create too large for one transaction goes out as createConfig then createPool in one approval; if only the first lands, **Finish launch** (`POST /api/campaigns/<pool>/resume`) creates the pool on the config the maker already paid for, with a fresh mint.
- **Graduation** can be triggered by anyone once the goal is reached, and the clicking wallet pays (about 0.033 SOL, mostly rent). The platform-paid path is reserved for an operator sending `Authorization: Bearer $ADMIN_TOKEN`. If Meteora's keeper graduates the pool first, the app says so.
- **Blinks.** Every campaign URL `/c/<pool>` is also a Solana Action (`/actions.json` maps it to `/api/actions/back/<pool>`). Shared links show **Back 1 · $X**, **Back 2 · $Y** and a whole-number **units** field in X or any Blink client, priced live with fees included; while the launch fee is above 5% the description says how high it is and when it falls. The `?ref=` referral carries through. Links shared before units existed (`?amount=`) still work. Funded campaigns return a disabled Action that points to the resale market.
- **Redemption** opens once the campaign graduates. `POST /api/redemptions/prepare` checks the shipping details and the voucher balance and returns a burn of one whole voucher carrying an SPL Memo `backed:redeem:<id>` signed by the owner; it stores nothing, so anyone asking in someone else's name changes nothing. The wallet signs it and the page sends it back with the shipping details (`POST /api/redemptions/submit`). The server checks it is exactly that burn, signed by that wallet alone, simulates it, keeps the shipping details encrypted as a pending redemption, sends the burn, waits for it and records the order, all in one request. The order is recorded only for that burn (the memo's id, the wallet as burn authority, this campaign's mint, exactly the units), so a burn signature seen on-chain cannot be claimed with someone else's address. Burns inside a transaction that calls the curve or the resale pool (a maker unlocking production funds) and burns signed by the pool's creator never count. If the server loses the confirmation, the pending row keeps the burn's signature: `GET /api/redemptions/pending` finds it once it has landed and the page finishes it (`POST /api/redemptions/confirm`) on the next visit; rows whose burn failed or expired are dropped. Pending rows are kept 30 days and never evicted early: at the cap, new redemptions wait. Shipping details never go on-chain.
- **Maker orders.** The maker signs a message naming this site's host and the campaign (exact text, dated within the last 5 minutes, not in the future) to list orders, download a CSV (cells that a spreadsheet would run as a formula are neutralised) and mark orders shipped, which deletes their shipping details.

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
pnpm core:test                                        # unit tests (pricing, engine vs SDK validation, trust, request schemas, caches, sign-in, sealed shipping, CSV, config, store, listing)
pnpm core:test:localnet                               # every suite in packages/core/src/__tests__/localnet/ against LOCALNET_RPC_URL: lifecycle, create (every share, split, maker-paid), graduation, swaps, slippage, referrals, redemptions, store/listing (see Localnet below)
pnpm core:inspect <pool | config | resale pool>       # decode a DBC config/pool and the DAMM v2 positions per owner (--json for machine output)
pnpm build && pnpm start                              # production build + server of the web app, from the repo root
pnpm core:launch --campaign examples/hoodie.json      # create a campaign from JSON
pnpm core:reconcile                                   # list pending campaigns that landed, expire ones that never will
cd packages/core && npx ts-node src/scripts/api-smoke.ts   # drive the full flow through the web API at WEB_URL (localnet, or devnet with PUBLIC_BASE_URL)
pnpm --filter @preorder/core api-negative            # bad input, status gates and rate limits against a localnet server at WEB_URL: no 5xx
pnpm --filter @preorder/core platform:claim [--unsigned] [--keep-leftover] [pool ...]   # collect the platform's fees and leftover
pnpm --filter @preorder/core partner:metadata [--unsigned]                              # one-off: the platform's on-chain partner listing
```

The two platform scripts sign with the platform key (`PLATFORM_SECRET_KEY`, else `keys/<network>/platform.json`) when it is the fee claimer the campaign's config names. Otherwise, or with `--unsigned`, they print each transaction as unsigned base58 with the fee claimer as signer and fee payer, ready to import into a Squads multisig. `/platform` shows the same numbers read-only. A campaign whose claim fails is reported and skipped, and the script exits non-zero at the end.

### Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that matter most:

- **`NETWORK`** (`localnet`, `devnet` or `mainnet`) is the only network switch. The scripts and the server read it at runtime; `next.config.ts` bakes it and the matching browser RPC (`PUBLIC_RPC_URL`, else a keyless default) into the bundle, so **changing it needs a rebuild**. `/api/health` returns 503 if the running server and the build disagree. `NETWORK=mainnet` switches to real USDC and mainnet RPC; the faucet only runs on devnet and localnet.
- **`PUBLIC_BASE_URL`** is the app's https origin. It goes into immutable on-chain metadata URIs and Blink icons, so it is required off localnet (`RAILWAY_PUBLIC_DOMAIN` is the fallback). Creating a campaign fails fast without it. Creating campaigns from a laptop on devnet therefore needs a public https URL (a tunnel); use localnet for local work.
- **`PLATFORM_SECRET_KEY`** and **`USDC_MINT`** let a deployed server run without the gitignored `keys/` directory. `PLATFORM_FEE_CLAIMER` sets who receives partner fees and leftover on every new campaign config; configs are immutable, so set it before launching. Campaign creation never uses the platform key; it signs only the faucet and the admin-only graduation path. `PLATFORM_TREASURY` is where `platform:claim` sends claimed USDC (default: the fee claimer).
- **`DATA_DIR`** holds the store: one SQLite file per network (`backed.<network>.sqlite`, WAL mode, via Node's built-in `node:sqlite`) with campaigns, pending creates, token metadata, orders and pending redemptions, rate-limit buckets and faucet claims. Every write is a transaction, so a crash or `kill -9` never leaves a torn file, and the scripts can run next to the server. Schema changes are an ordered list of named migrations in `packages/core/src/db.ts`. Old `data/*.json` files in `DATA_DIR` (including the JSON-file stores' pending redemptions, faucet claims and rate buckets) are imported once on first open, with shipping details re-sealed under `SHIPPING_KEY` (bad rows are skipped and logged, never blocking the store); a fully imported redemptions file is deleted. Use an absolute `DATA_DIR`.
- **`SHIPPING_KEY`** (alias `SHIPPING_ENCRYPTION_KEY`) encrypts shipping details at rest (AES-256-GCM, each row bound to its burn signature). Required on mainnet, where the server refuses to start without a valid key, and on a deployed devnet, where `/api/health` fails without it; a malformed key fails `/api/health` on any network. Localnet and a local devnet fall back to a public dev key with a warning. Rotate by moving the old key to `SHIPPING_KEY_PREVIOUS`; an order no key opens is listed as unreadable rather than hiding the others. Orders are deleted of their shipping details once the maker marks them shipped.
- **Listing is idempotent.** `POST /api/campaigns/confirm` can be retried: it waits up to ~15s for the pool on the server's RPC, checks the transaction that created the pool (succeeded, touches the pool, signed by the maker; for a split create, the createPool step) and lists the campaign once. Concurrent confirms of a pool share one wait, and a signature the RPC does not know falls back to the pool's first transaction instead of being polled. The create page keeps a sent launch in local storage and offers **Finish listing** instead of a second launch. Pending creates expire after 24h; the server's reconcile job (`RECONCILE_INTERVAL_SEC`), `pnpm core:reconcile` and `POST /api/admin/reconcile` (with `Authorization: Bearer $ADMIN_TOKEN`) list any pool that landed without a confirm, drop builds that never landed together with their token metadata, and prune idle rate-limit buckets and old faucet claims.
- **`/api/status`** is the deep check for operators: store writable and on a volume (under `RAILWAY_VOLUME_MOUNT_PATH` on Railway), no plaintext legacy redemptions file left, `SHIPPING_KEY` valid and set where required, RPC slot latency, and platform SOL against `STATUS_MIN_PLATFORM_SOL`. It returns 503 when any check fails and caches its result for 15s.
- **`ADMIN_TOKEN`** unlocks the operator routes: the platform-paid graduation (`POST /api/campaigns/<pool>/migrate` with `Authorization: Bearer …`) and `POST /api/admin/reconcile`. Use a random token of at least 32 characters (`openssl rand -hex 32`); empty or shorter disables that path, and a wrong token gets 401.
- **Maker sign-in host.** The orders page signs a message naming the host it is open on. The server accepts the `PUBLIC_BASE_URL` host and `RAILWAY_PUBLIC_DOMAIN` (both reach the same service); a signature made on any other host is refused with a message naming the right one.
- **`PRIORITY_FEE_MAX_MICROLAMPORTS`** caps the compute-unit price added to wallet transactions and the admin graduation (default 1,000,000). `/api/health` fails while it is not a whole number ≥ 1000.
- **Localnet**: `NETWORK=localnet` with a `solana-test-validator` that has the mainnet DBC, DAMM v2, Metaplex and Locker programs cloned. `LOCALNET_RPC_URL` defaults to `http://127.0.0.1:8899`, explorer links use the Solana Explorer's custom cluster, and `TRUST_FIXTURES` can stand in for mainnet wallet history. `VESTING_SCHEDULE_OVERRIDE` (JSON, seconds) replaces the tier ship-window schedule so a campaign unlocks in seconds; it is ignored on devnet and mainnet.

### API safeguards

- Every JSON body is capped at 32 KB and checked against a zod schema (`packages/core/src/requests.ts`); bad input is a 400 that says what is wrong.
- 4xx answers carry a message for the user. Anything else is a 500 with a generic message and a request id, and the server logs one JSON line with `reqId`, `route`, `wallet`, `sig` and the error. Faucet sends, confirmed creates, redemptions and platform-paid graduations log a JSON line with their signature too.
- Per-IP token buckets on create, preview, quotes, transaction builds (`/api/tx`, confirm, resume, redemptions), trust lookups, uncached campaign reads, faucet, graduation and the Blink POST (429 when empty). The client IP is the `X-Forwarded-For` entry `TRUSTED_PROXY_HOPS` from the right; an invalid value fails `/api/health` and every limited request rather than putting all clients in one bucket. With no proxy in front, `next start` fills `X-Forwarded-For` from the socket only when the client sent none, so the header is client-controlled: set `TRUSTED_PROXY_HOPS=0` there (one shared bucket). The buckets live in the store and fail open if it can't be written.
- Faucet (devnet/localnet): one claim per wallet per 24 h, 5 per IP and 300 in total per day. A claim is recorded before the transfer is sent, so concurrent requests can't all pass the caps, and given back only when the transfer provably did not run. `RATE_LIMITS=off` lifts the limits on localnet only.
- Live campaign state is cached per pool for 3 s and the resale panels' reads for 5 s, with concurrent reads coalesced; the listing reads pools and mints in batched `getMultipleAccountsInfo` calls; configs are read once. `GET /api/campaigns/<pool>?fresh=1` (rate-limited) skips the cache, the page uses it right after a graduation, and the status gates re-read a pool before refusing an action whose status the cache may not show yet. The pages keep the last data under a "delayed" banner when a poll fails.
- Status gates: buy and sell only while funding, withdraw, resale swaps and redemptions only after graduation (409), quotes only for listed campaigns (404); the Blink is disabled with the right copy outside funding or when its live state can't be read, and its POST answers 422.

### Localnet and CI

`scripts/localnet/start.sh` gives you a validator with the mainnet DBC, DAMM v2, Metaplex and Locker programs and every DAMM v2 migration config (the list comes from the DBC SDK, so it follows SDK upgrades). If a validator already answers on the port, it is reused and never reset, since other suites may share it; start.sh first checks it has every program and config and stops with the missing ones listed if not. Otherwise it starts one in the background and resumes its ledger if there is one. Either way it airdrops 5 SOL to the DBC pool authority `FhVo3mqL…HLuM`, which pays rent when a pool graduates.

```bash
bash scripts/localnet/start.sh             # :8899, ledger in .localnet/ (gitignored)
pnpm core:test:localnet                    # lifecycle and every other *.test.ts under __tests__/localnet/, subdirectories included
pnpm core:seed:localnet                    # wallets, SOL, mock USDC and <root>/.env.localnet for the app
bash scripts/localnet/stop.sh              # stops only a validator this script started
```

- `pnpm core:seed:localnet` writes everything under `PREORDER_ROOT` (a new temp dir when unset): keys for platform, maker, backer1–3 and referrer, a mock USDC mint whose authority is the platform key, 1000 USDC per backer, and `.env.localnet`. Load it with `set -a; . <root>/.env.localnet; set +a` before starting the web app or a script. It refuses a root that already holds localnet keys or a mock USDC, so it never orphans the campaigns or the faucet of an earlier seed.
- The lifecycle suite (`localnet/lifecycle.test.ts`) walks create, back, exit, the capped last buy, graduation, the maker's budget withdrawal, resale buy and sell, the maker's fee claim and a redemption, asserting the balances each step moves and the DAMM v2 positions after graduation. Each suite makes its own keys and mint, so suites can share a validator.
- To run a second validator next to a shared one, set `LOCALNET_RPC_PORT` (the faucet, gossip and dynamic ports move next to it) and `LOCALNET_LEDGER`, then point the tests at it with `LOCALNET_RPC_URL`. `SOLANA_BIN` names the Solana CLI directory if it is not on `PATH`. `LOCALNET_CLONE_URL` changes the cluster it clones from.
- `bash scripts/localnet/dump.sh <dir>` saves the programs and configs to files. `LOCALNET_DUMPS=<dir>` then starts a validator from them without cloning over a public RPC.

CI (`.github/workflows/ci.yml`) runs two jobs on every PR and push to `main`:

- **check** runs install with the frozen lockfile, both typechecks, lint, unit tests and a devnet production build. It needs no secrets.
- **localnet** runs the whole localnet suite on a fresh validator. It uses the pinned Solana CLI (v4.3.0 from `release.anza.xyz`, cached) and program and account dumps from mainnet, cached per week and per lockfile (saved right after the dump, so a red test run does not dump again).

### Deploy (Railway)

`railway.json` builds from the repo root with Railpack (`pnpm build`), starts with `pnpm start` (Next reads `PORT`) and health-checks `/api/health`, a liveness route that makes no RPC call. Railpack takes the Node version from `engines.node` (`22.22.x`). Set `NETWORK`, the RPC URLs, `PUBLIC_RPC_URL`, `PUBLIC_BASE_URL`, `PLATFORM_SECRET_KEY`, `PLATFORM_FEE_CLAIMER` and (off mainnet) `USDC_MINT` as service variables before the first build, and keep the service root at the repo root so the workspace resolves. Attach a volume at `/app/data`, set `DATA_DIR=/app/data` and turn on daily backups: token metadata sits behind immutable on-chain URIs, so losing the store breaks it for good. Also set `SHIPPING_KEY` and `ADMIN_TOKEN`. One replica only (SQLite on a single volume).

A devnet demo can skip pasting secrets: mount the volume at `/data`, set `PREORDER_ROOT=/data` (store in `/data/data`, keys in `/data/keys/devnet`) and `TEST_KEYS_AUTOGEN=1`. The server then generates its own platform key and `SHIPPING_KEY` on the volume on first use and logs the platform pubkey; fund that address with devnet SOL and hand it the mock USDC mint authority (`spl-token authorize <USDC_MINT> mint <pubkey>`). `TEST_KEYS_AUTOGEN` is ignored on mainnet.

---

## Known limits

- **Trust-minimized, not trustless.** A maker can take the upfront share and never ship. The trust tier limits how much they can take upfront and how long the rest waits. Vesting is time-based: DBC and DAMM v2 cannot release liquidity when goods ship, so after the ship window a maker who disappears leaves backers a 20% permanent market floor, not a refund.
- **Exit ≠ refund.** Selling back before the goal pays the current curve price, which can be more or less than the price paid.
- **Single-server storage.** The store is SQLite on one volume, so the app runs as one replica. Shipping details are encrypted at rest (and deleted once the maker marks an order shipped), but the server holds the key and decrypts them for the maker.
- **Maker sign-in is short-lived, not single-use.** A signed orders message works for 5 minutes on this site only; there is no server nonce or session cookie yet.
- **Trust signals are simple.** Wallet age, activity and first funder can be gamed with aged wallets, and activity with a month of daily self-transfers. They are one input, shown openly, and not a verdict; an attestation (X OAuth or SAS) is an open decision.

## Business model

Backed is the DBC **partner** on every campaign. It earns the partner half of curve trading fees (after Meteora's 20% protocol fee) and the fees on its 5% permanently locked share of each resale pool. `pnpm --filter @preorder/core platform:claim` collects both, and `/platform` shows them. Makers pay nothing upfront. First users are merch drops, indie hardware and game-key pre-orders, and hackathon teams. Later, a Shopify plugin so any store can offer pre-orders with a built-in resale market.
