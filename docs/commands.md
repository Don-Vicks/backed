> Prerequisites and every command, from a quick try to the platform scripts.

[← Back to the README](../README.md)

# Running Backed

Step by step, with prerequisites, expected output and troubleshooting: **[docs/replicate.md](replicate.md)**. The short version:

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
pnpm core:backup                                      # write a store backup now and list the ones kept
pnpm core:backup restore <file>                       # restore a backup over the database (stop the server first)
pnpm core:seed:demo                                   # three realistic campaigns with photos (a hoodie, a mug, a keyboard); needs PUBLIC_BASE_URL; not on mainnet
pnpm core:campaigns list | remove <pool>... [--yes]    # list this environment's campaigns, or remove test ones (dry run without --yes; only edits the app's list)
cd packages/core && npx ts-node src/scripts/api-smoke.ts   # drive the full flow through the web API at WEB_URL (localnet, or devnet with PUBLIC_BASE_URL)
pnpm --filter @preorder/core api-negative            # bad input, status gates and rate limits against a localnet server at WEB_URL: no 5xx
bash apps/web/e2e/run-localnet.sh                     # browser suite: seeds wallets, builds and starts the app on localnet, runs Playwright (args pass through)
pnpm --filter @preorder/core platform:claim [--unsigned] [--keep-leftover] [pool ...]   # collect the platform's fees and leftover
pnpm --filter @preorder/core partner:metadata [--unsigned]                              # one-off: the platform's on-chain partner listing
```

The two platform scripts sign with the platform key (`PLATFORM_SECRET_KEY`, else `keys/<network>/platform.json`) when it is the fee claimer the campaign's config names. Otherwise, or with `--unsigned`, they print each transaction as unsigned base58 with the fee claimer as signer and fee payer, ready to import into a Squads multisig. `/platform` shows the same numbers read-only. A campaign whose claim fails is reported and skipped, and the script exits non-zero at the end.

Makers add a product photo on the create page. The browser shrinks it to a 1200px JPEG, `POST /api/images` stores it in the database (PNG, JPEG or WebP only, read from the bytes, 1.5 MB cap, rate limited), and `GET /api/images/<id>` serves it as an immutable, content-addressed file. The demo photos in `examples/demo/` are drawings, not photographs; replace them with real ones for a real launch.
