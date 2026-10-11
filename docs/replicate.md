# Replicate and test Backed

Each level below builds on the one before; stop at any level. Times are for a laptop with a normal connection.

| Level | What you get | Needs | Time |
|---|---|---|---|
| [0. Try it live](#0-try-it-live) | The deployed app on devnet | A browser wallet | 5 min |
| [1. Install and fast checks](#1-install-and-fast-checks) | Typecheck, lint, 193 unit tests | Node, pnpm | 5 min |
| [2. Chain tests on a local validator](#2-chain-tests-on-a-local-validator) | Every on-chain flow against the **mainnet** Meteora programs | + Solana CLI | 10 min |
| [3. Browser tests](#3-browser-tests) | Every feature clicked through in Chromium | + Chromium | 5 min |
| [4. Run the app yourself](#4-run-the-app-yourself) | Your own app on the local chain or devnet | + a browser wallet | 10 min |

CI runs levels 1 to 3 on every pull request ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

## 0. Try it live

1. Open <https://backed.up.railway.app>. It runs on **devnet**.
2. In your wallet, switch to devnet. In Phantom, that's Settings → Developer Settings → Testnet Mode → Solana Devnet.
3. Connect, then press **Get test USDC**. It sends 50 of the app's test USDC and a little SOL for fees. Ordinary devnet USDC won't work: campaigns use the app's own test token.
4. Back a campaign, or start one from **Start a campaign**.
5. Open a funding campaign's **See it as a Blink** to back it from its Blink card.

## 1. Install and fast checks

Prerequisites:
- **Node 22.22** (`.node-version`)
- **pnpm 10.28** (`packageManager` in `package.json`; `corepack enable` installs the right version)
- **Linux or macOS**

```bash
git clone https://github.com/Don-Vicks/backed.git
cd backed
corepack enable
pnpm install --frozen-lockfile

pnpm -C packages/core exec tsc --noEmit                                       # typecheck the Solana core
pnpm --dir apps/web exec next typegen && pnpm --dir apps/web exec tsc --noEmit # typecheck the web app
pnpm --filter @preorder/web lint                                              # lint
pnpm core:test                                                                # 193 unit tests
```

The unit tests need no network or chain. They cover:
- pricing math, and the DBC config the engine builds, validated by the Meteora SDK
- trust tiers, vesting schedules, request schemas
- caches, the maker sign-in, sealed shipping details, the CSV export, config and the store

They should end with `# pass 193` and `# fail 0`.

## 2. Chain tests on a local validator

These run every on-chain flow against a `solana-test-validator` loaded with the programs and accounts Meteora runs on mainnet: DBC, DAMM v2, Metaplex, the Locker and every DAMM v2 migration config.

Install the Solana CLI, the same version CI uses:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/v4.3.0/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version                                   # solana-cli 4.3.0
```

Then:

```bash
bash scripts/localnet/start.sh     # starts the validator on :8899 (ledger in .localnet/, gitignored)
pnpm core:test:localnet            # every suite in packages/core/src/__tests__/localnet/
```

The first start clones the programs and configs from mainnet over a public RPC, which takes a minute or two.
- **If the public RPC rate-limits you:** set `LOCALNET_CLONE_URL` to your own mainnet RPC URL.
- **To clone once and reuse:** run `bash scripts/localnet/dump.sh .localnet/dumps`, then start with `LOCALNET_DUMPS=.localnet/dumps bash scripts/localnet/start.sh`.

`start.sh` never resets a ledger: it reuses a validator that is already running, and resumes a stopped one. `bash scripts/localnet/stop.sh` stops a validator it started.

What the suites check, each with fresh wallets and a fresh mock USDC:
- **Lifecycle:** create, back, exit, the capped last buy, graduation to DAMM v2, the maker's budget withdrawal, resale buy and sell, fee claims and a redemption, asserting every balance each step moves.
- **Create:** every maker share and the transaction split for long names. Creation is maker-paid and the platform never signs.
- **Swaps:** slippage minimums and referrals.
- **Redemptions:** memo-bound burns.
- **Store and listing:** confirm, reconcile and on-chain listings.

## 3. Browser tests

One campaign through every feature in Chromium, with keypair wallets the page sees as ordinary browser wallets:
- faucet, launch, a referral buy, a partial exit
- a buy through the campaign's Blink, the capped last buy, graduation
- resale trades, the maker's withdrawal, fee claim and unlock
- redemption and shipping, link previews, the Blink endpoint, phone layouts, and no uncaught page errors

Every step is a real transaction on the local validator from level 2.

```bash
pnpm --dir apps/web exec playwright install --with-deps chromium   # once
bash apps/web/e2e/run-localnet.sh                                  # 13 tests, about 1.5 min after the build
```

The script does the setup for you:
- seeds wallets and a mock USDC into a temp dir
- builds and starts the app on port 3301, with a vesting schedule in seconds so the unlock fits in the run
- runs Playwright, then stops the app

Arguments pass through to Playwright: `--headed` shows the browser. The tests share one campaign and run in order, so run the whole file rather than picking one with `-g`. On failure, traces are in `apps/web/test-results/`; open one with `pnpm --dir apps/web exec playwright show-trace <trace.zip>`.

`E2E_SHOTS=$PWD/docs/walkthrough bash apps/web/e2e/run-localnet.sh` also regenerates the screenshots in [the walkthrough](walkthrough.md).

## 4. Run the app yourself

### On the local validator

```bash
export PREORDER_ROOT=$(mktemp -d)
pnpm core:seed:localnet                         # wallets, SOL, a mock USDC and $PREORDER_ROOT/.env.localnet
set -a; . "$PREORDER_ROOT/.env.localnet"; set +a
pnpm build && pnpm start                        # http://localhost:3000
```

Point a browser wallet at a custom RPC, `http://127.0.0.1:8899`, then connect and press **Get test USDC**. Optional settings:
- `VESTING_SCHEDULE_OVERRIDE='{"cliffSec": 30, "periods": 2, "periodSec": 20, "bpsPerPeriod": 2500}'` before `pnpm start` makes production funds unlock in seconds instead of weeks.
- `TRUST_FIXTURES` (see [`.env.example`](../.env.example)) gives a maker wallet a trust tier, since a fresh local wallet has no mainnet history.

### On devnet

You'll need a Solana CLI wallet with some devnet SOL, which funds the test wallets.

```bash
cp .env.example .env            # NETWORK=devnet; optional Helius RPC URLs
pnpm core:wallets               # create and fund devnet test wallets (platform, maker, 3 backers)
pnpm core:lifecycle             # the full lifecycle on devnet; also creates the devnet mock USDC
pnpm --dir apps/web dev         # http://localhost:3100
```

Creating campaigns needs `PUBLIC_BASE_URL` set to a public https URL, such as a tunnel, because each campaign's metadata URL is written on-chain.

To deploy your own copy on Railway, see [Deploy (Railway)](../README.md#deploy-railway). With `TEST_KEYS_AUTOGEN=1` a devnet server generates its own keys on its volume, so no secrets need pasting.

### Drive the API without a browser

With the local app running, and in the shell where you loaded `.env.localnet`:

```bash
(cd packages/core && WEB_URL=http://localhost:3000 npx ts-node src/scripts/api-smoke.ts)   # the whole flow over HTTP, signed by the seeded wallets
WEB_URL=http://localhost:3000 pnpm --filter @preorder/core api-negative                     # bad input, status gates, rate limits: never a 5xx
```

`api-negative` expects the server's rate limits on, so start the app without `RATE_LIMITS=off`.

## Troubleshooting

- **`Something already serves http://localhost:3301`:** another app is on the browser suite's port. Stop it, or set `E2E_PORT`.
- **`solana-test-validator not found`:** add the Solana CLI to `PATH`, or set `SOLANA_BIN` to its `bin` directory.
- **`start.sh` stops and lists missing programs:** the validator already on :8899 was started without them. Run a second one beside it with `LOCALNET_RPC_PORT=18899 LOCALNET_LEDGER=$(mktemp -d)/ledger`, then point the tests at it with `LOCALNET_RPC_URL=http://127.0.0.1:18899`.
- **`/api/health` returns 503 after you change `NETWORK`:** the network is baked into the build, so rebuild.
