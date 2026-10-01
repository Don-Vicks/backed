# Backed

**Back it early. Pay less.** Pre-orders for real products, priced on a Meteora Dynamic Bonding Curve.

A $30 pre-order sells out, then resells for $300 on StockX, and the maker who made it gets nothing. Backed puts crowdfunding and resale on one curve:

1. **Early backers pay less.** A campaign's early-bird tiers are segments of a DBC curve, so the price rises as units sell.
2. **Reaching the goal funds the maker.** The funding goal *is* the DBC migration threshold. At graduation, the maker's production budget is paid out automatically.
3. **Vouchers keep a market, and the maker keeps earning.** After graduation the same token trades on a DAMM v2 pool whose liquidity is locked forever, and the maker's locked position earns fees on every resale. Burn one voucher to claim the item.

No custom program. Every rule comes from DBC config, DAMM v2 and SPL token burns.

Built for the Colosseum **Crypto World's Fair** and Meteora's **Best use of DBC** track.

---

## How Backed uses DBC

The maker fills in a plain form. `campaignToConfig()` ([`packages/core/src/engine.ts`](packages/core/src/engine.ts)) turns it into a DBC config, and the create page shows the mapping live as they type. Once created, the config can't be changed by anyone, including the maker and the platform.

| What the maker sets | DBC setting | Why it's built this way |
|---|---|---|
| **Early-bird tiers** (units + start price per tier) | `curve[]` segments, `sqrtStartPrice` | Each tier is one curve segment. Liquidity is solved per segment so each tier sells exactly its units. |
| **Funding goal** | `migrationQuoteThreshold` | Graduation *is* "funded". The goal is derived from the tiers: each tier raises units × √(start price × end price). |
| **Maker's upfront share** | `migrationFee.feePercentage`, `creatorFeePercentage: 100` | The production budget comes out of the raise at graduation and is withdrawn with `creatorWithdrawMigrationFee`. The maker's trust tier caps it (below). |
| **Drop-bot window** | `baseFee`: `FeeSchedulerExponential` | Scalpers rushing a drop are the same as snipers. The fee starts at 50% and falls to 1% over 5–30 min. (DBC deprecated the rate limiter for new pools in SDK 1.5.12, so there is no per-buy size limit.) |
| **Limited edition** | `tokenSupply` (fixed), `tokenUpdateAuthority: Immutable` | The supply cap is the production cap, and nobody can mint more. Post-migration supply is set to exactly the curve units plus the resale units, and the program burns the unused swap buffer. |
| **Price in dollars** | `quoteMint` = USDC, `collectFeeMode: QuoteToken` | Product prices shouldn't move with SOL. All fees are collected in USDC. |
| **Exit before the goal** | *(DBC sells are always open)* | A backer can sell back along the curve at any time before graduation. It isn't a refund: it pays the current curve price. |
| **Resale market** | `migrationOption: MET_DAMM_V2`, `migrationFeeOption: FixedBps200` | Graduation opens a 2%-fee DAMM v2 pool, so vouchers stay liquid after the pre-order. |
| **Resale royalties** | `creatorPermanentLockedLiquidityPercentage: 80`, `partnerPermanentLockedLiquidityPercentage: 20` | 100% of resale liquidity is locked forever. Locked positions still earn trading fees, so the maker earns on every resale. |
| **Curve trading fees** | `creatorTradingFeePercentage: 50`, `dynamicFeeEnabled` | After Meteora's 20% protocol fee, the maker earns half of the curve's trading fees. Both fee streams are claimed in one transaction. |
| **Affiliate links** | swap `referralTokenAccount` | Share links carry `?ref=<wallet>`. On referred buys, the sharer gets DBC's referral cut (20% of the protocol fee). The buyer pays nothing extra. |
| **No reused configs** | `createConfigAndPool` (one transaction, platform key = `feeClaimer`) | Each campaign gets its own config, created in the same transaction as its pool. Nobody can launch another pool on a campaign's terms. |

### Why we build the curve ourselves

`buildCurveWithCustomSqrtPrices` sizes the curve from a total supply and adds a 25% swap buffer, which moves the goal away from what the maker asked for. The engine instead solves per-segment liquidity with `base = L·(√P1 − √P0)/(√P0·√P1)` and computes the goal with the SDK's own `getDeltaAmountQuoteUnsigned`. It then sets the minimum supply the program accepts: pre-migration = curve units + buffer + resale units, post-migration = curve units + resale units. On devnet the supply after graduation came to **12.2988 units against 12.30 planned**.

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

A new or throwaway wallet can still run a campaign, but it takes less upfront and more of the raise stays in the locked resale pool. The "verified social" input is a demo stand-in, not a real social check.

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
  live.ts           live campaign state, quotes, devnet/localnet faucet
  network.ts        NETWORK switch (localnet, devnet, mainnet), RPC and explorer links
  resale.ts         DAMM v2 resale pool, quotes, swaps, maker earnings + claim
  redemptions.ts    on-chain burn verification, shipping records, maker sign-in
  scripts/          lifecycle proof, launch, API smoke tests
```

- **Wallet flow.** The server builds each transaction and the browser wallet signs it. Campaign creation is signed by the platform key (the DBC partner) and the fresh config and mint keys on the server, then by the maker's wallet as pool creator.
- **Graduation** can be triggered by anyone once the goal is reached, and the platform pays the fee.
- **Blinks.** Every campaign URL `/c/<pool>` is also a Solana Action (`/actions.json` maps it to `/api/actions/back/<pool>`). Shared links can show **Back $10 / $25 / custom** buttons in X or any Blink client, and the `?ref=` referral carries through. Funded campaigns return a disabled Action that points to the resale market.
- **Redemption.** The backer burns one whole voucher. The server checks the burn on-chain (mint, authority, amount, never reused) before accepting shipping details, and the details never go on-chain. The maker views orders by signing a time-stamped message with their wallet.

Stack: `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`, `@meteora-ag/cp-amm-sdk@1.5.0`, `@solana/web3.js` v1, Next.js 16, React 19, Tailwind 4, shadcn/ui, Solana wallet adapter.

---

## Run it

Needs Node 22 (`.node-version`), pnpm 10 (`packageManager`) and a Solana CLI wallet with some devnet SOL (used to fund the test wallets).

```bash
pnpm install
cp .env.example .env        # NETWORK=devnet; optional Helius RPC URLs
pnpm core:wallets           # create + fund devnet test wallets (platform, maker, 3 backers)
pnpm core:lifecycle         # full on-chain proof; also creates the devnet mock USDC mint
pnpm --dir apps/web dev     # http://localhost:3100
```

In the app, connect Phantom, Solflare or Backpack on **devnet** and click **Get test USDC**.

Other commands:

```bash
pnpm core:test                                        # unit tests (pricing, engine vs SDK validation, trust, sign-in, config)
pnpm core:test:localnet                               # checks against a local validator (LOCALNET_RPC_URL)
pnpm build && pnpm start                              # production build + server of the web app, from the repo root
pnpm core:launch --campaign examples/hoodie.json      # create a campaign from JSON
cd packages/core && npx ts-node src/scripts/api-smoke.ts   # drive the full flow through the web API
```

### Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that matter most:

- **`NETWORK`** (`localnet`, `devnet` or `mainnet`) is the only network switch. The scripts and the server read it at runtime; `next.config.ts` bakes it and the matching browser RPC (`PUBLIC_RPC_URL`, else a keyless default) into the bundle, so **changing it needs a rebuild**. `/api/health` returns 503 if the running server and the build disagree. `NETWORK=mainnet` switches to real USDC and mainnet RPC; the faucet only runs on devnet and localnet.
- **`PUBLIC_BASE_URL`** is the app's https origin. It goes into immutable on-chain metadata URIs and Blink icons, so it is required off localnet (`RAILWAY_PUBLIC_DOMAIN` is the fallback). Creating a campaign fails fast without it. Creating campaigns from a laptop on devnet therefore needs a public https URL (a tunnel); use localnet for local work.
- **`PLATFORM_SECRET_KEY`** and **`USDC_MINT`** let a deployed server run without the gitignored `keys/` directory. `PLATFORM_FEE_CLAIMER` sets who receives partner fees.
- **Localnet**: `NETWORK=localnet` with a `solana-test-validator` that has the mainnet DBC, DAMM v2, Metaplex and Locker programs cloned. `LOCALNET_RPC_URL` defaults to `http://127.0.0.1:8899`, explorer links use the Solana Explorer's custom cluster, and `TRUST_FIXTURES` can stand in for mainnet wallet history.

### Deploy (Railway)

`railway.json` builds from the repo root with Railpack (`pnpm build`), starts with `pnpm start` (Next reads `PORT`) and health-checks `/api/health`, a liveness route that makes no RPC call. Set `NETWORK`, the RPC URLs, `PUBLIC_RPC_URL`, `PUBLIC_BASE_URL`, `PLATFORM_SECRET_KEY` and (off mainnet) `USDC_MINT` as service variables before the first build, and keep the service root at the repo root so the workspace resolves.

---

## Known limits

- **Trust-minimized, not trustless.** A maker can take the upfront share and never ship. The trust tier limits how much they can take upfront, and the rest stays locked in the resale pool.
- **Exit ≠ refund.** Selling back before the goal pays the current curve price, which can be more or less than the price paid.
- **Demo storage.** Campaign records, token metadata and shipping details are kept in JSON files on the server. Production needs a database, and encryption for shipping data.
- **Trust signals are simple.** Wallet age, activity and first funder can be gamed with aged wallets. They are one input, shown openly, and not a verdict.

## Business model

Backed is the DBC **partner** on every campaign. It earns the partner half of curve trading fees (after Meteora's 20% protocol fee) and the fees on its 20% locked share of each resale pool. Makers pay nothing upfront. First users are merch drops, indie hardware and game-key pre-orders, and hackathon teams. Later, a Shopify plugin so any store can offer pre-orders with a built-in resale market.
