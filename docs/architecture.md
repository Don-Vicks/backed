> How the code is laid out and how a request flows through it.

[← Back to the README](../README.md)

# Architecture

```
apps/web            Next.js 16 app: pages + API routes (the API builds unsigned transactions)
  e2e/              Playwright: every feature in Chromium with keypair wallets, on localnet
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
.github/workflows   CI: check (typecheck, lint, unit tests, build) and localnet (chain suites, then the browser suite)
```

- **Wallet flow.** The server builds each transaction and the browser wallet signs it. Every wallet transaction carries a compute-unit price (p75 of recent fees on its writable accounts, capped by `PRIORITY_FEE_MAX_MICROLAMPORTS`; none on localnet). Campaign creation is paid and signed by the maker's wallet (payer and pool creator); the server only signs with the fresh config and mint keys, never the platform key. The server builds the campaign from an allowlist of fields: name ≤ 32 bytes, ticker `A–Z0–9` ≤ 10, description ≤ 1000, https image ≤ 200, whole units, at most 4 tiers, and the fixed launch fee (15% → 1% over 1, 2 or 5 min), with the goal at most 10,000,000 USDC and the final price at most 100× the first tier's. A create too large for one transaction goes out as createConfig then createPool in one approval; if only the first lands, **Finish launch** (`POST /api/campaigns/<pool>/resume`) creates the pool on the config the maker already paid for, with a fresh mint.
- **Graduation** can be triggered by anyone once the goal is reached, and the clicking wallet pays (about 0.033 SOL, mostly rent). The platform-paid path is reserved for an operator sending `Authorization: Bearer $ADMIN_TOKEN`. If Meteora's keeper graduates the pool first, the app says so.
- **Blinks.** Every campaign URL `/c/<pool>` is also a Solana Action (`/actions.json` maps it to `/api/actions/back/<pool>`). Shared links show **Back 1 · $X**, **Back 2 · $Y** and a whole-number **units** field in X or any Blink client, priced live with fees included; while the launch fee is above 5% the description says how high it is and when it falls. The `?ref=` referral carries through. Links shared before units existed (`?amount=`) still work. Funded campaigns return a disabled Action that points to the resale market. **See it as a Blink** (`/c/<pool>/blink`) renders the card with Dialect's open-source renderer (`@dialectlabs/blinks`) and the connected wallet, so it can be shown and used without X; unfurling on X itself needs the domain in Dialect's registry.
- **Redemption** opens once the campaign graduates. `POST /api/redemptions/prepare` checks the shipping details and the voucher balance and returns a burn of one whole voucher carrying an SPL Memo `backed:redeem:<id>` signed by the owner; it stores nothing, so anyone asking in someone else's name changes nothing. The wallet signs it and the page sends it back with the shipping details (`POST /api/redemptions/submit`). The server checks it is exactly that burn, signed by that wallet alone, simulates it, keeps the shipping details encrypted as a pending redemption, sends the burn, waits for it and records the order, all in one request. The order is recorded only for that burn (the memo's id, the wallet as burn authority, this campaign's mint, exactly the units), so a burn signature seen on-chain cannot be claimed with someone else's address. Burns inside a transaction that calls the curve or the resale pool (a maker unlocking production funds) and burns signed by the pool's creator never count. If the server loses the confirmation, the pending row keeps the burn's signature: `GET /api/redemptions/pending` finds it once it has landed and the page finishes it (`POST /api/redemptions/confirm`) on the next visit; rows whose burn failed or expired are dropped. Pending rows are kept 30 days and never evicted early: at the cap, new redemptions wait. Shipping details never go on-chain.
- **Maker orders.** The maker signs a message naming this site's host and the campaign (exact text, dated within the last 5 minutes, not in the future) to list orders, download a CSV (cells that a spreadsheet would run as a formula are neutralised) and mark orders shipped, which deletes their shipping details.

Stack: `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`, `@meteora-ag/cp-amm-sdk@1.5.0`, `@solana/web3.js` v1, Next.js 16, React 19, Tailwind 4, shadcn/ui, Solana wallet adapter.
