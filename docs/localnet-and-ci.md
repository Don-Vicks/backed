> A local validator with the mainnet Meteora programs, and how CI uses it.

[← Back to the README](../README.md)

# Localnet and CI

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
- **localnet** runs the whole localnet suite on a fresh validator, then the browser suite on the same validator: `apps/web/e2e/run-localnet.sh` seeds wallets and a mock USDC, builds and starts the app with a seconds-long vesting schedule, and Playwright drives one campaign through every feature in Chromium with keypair-backed Wallet Standard wallets (launch, referral buy, exit, a buy through the campaign's Blink, the capped last buy, graduation, resale with the price-impact guard, budget withdrawal, fee claim, unlock, redemption and shipping, link previews, the Blink, phone layouts). On failure the report and traces are uploaded as an artifact. It uses the pinned Solana CLI (v4.3.0 from `release.anza.xyz`, cached) and program and account dumps from mainnet, cached per week and per lockfile (saved right after the dump, so a red test run does not dump again).
