import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { MAX_CREATE_TX_BYTES, buildCreateCampaignTx, createCampaignSteps, serializedTxSize } from '../chain'
import type { Campaign } from '../engine'
import { MAX_TIERS } from '../pricing'

process.env.PLATFORM_FEE_CLAIMER = Keypair.generate().publicKey.toBase58()

// Builds offline: the SDK only looks up the quote mint's token program.
const connection = new Connection('http://127.0.0.1:1')
connection.getAccountInfo = async () => ({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82), executable: false, lamports: 1 })

const campaign = (tiers: number, name: string, symbol: string, uri: string): Campaign => ({
  name,
  symbol,
  uri,
  plan: { tiers: Array.from({ length: tiers }, (_, i) => ({ units: 10, startPrice: 4 + i })), finalPrice: 4 + tiers, makerSharePct: 10 },
  dropBot: { startFeeBps: 1500, windowSec: 120 },
  normalFeeBps: 100,
})
// The longest metadata uri PUBLIC_BASE_URL can produce within the tested budget: <origin>/m/<10 chars>.
const longUri = `https://${'o'.repeat(39)}.app/m/abcdefghij`

async function steps(c: Campaign) {
  const maker = Keypair.generate().publicKey
  const built = await buildCreateCampaignTx({ connection, campaign: c, tier: 'A', maker, usdcMint: Keypair.generate().publicKey })
  return { maker, built, steps: createCampaignSteps(built, maker) }
}

// What finalizeForWallet sends off localnet: a compute-unit price, the maker as fee payer.
function walletSize(tx: ReturnType<typeof createCampaignSteps>[number]['tx'], maker: PublicKey) {
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }))
  tx.feePayer = maker
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58()
  return serializedTxSize(tx)
}

test('worst-case create (4 tiers, 32-byte name, 10-byte ticker, 64-char uri) splits into two transactions under the limit', async () => {
  assert.equal(longUri.length, 64)
  const { maker, built, steps: s } = await steps(campaign(MAX_TIERS, 'N'.repeat(32), 'S'.repeat(10), longUri))
  assert.equal(s.length, 2)
  const [config, pool] = s
  assert.deepEqual(config.signers.map((k) => k.publicKey.toBase58()), [built.config.toBase58()])
  assert.deepEqual(pool.signers.map((k) => k.publicKey.toBase58()), [built.baseMint.toBase58()])
  for (const step of s) {
    const size = walletSize(step.tx, maker)
    assert.ok(size <= MAX_CREATE_TX_BYTES, `${size} bytes`)
    // Signers: the maker (fee payer) and the server's fresh keys, never the platform.
    const signers = step.tx.compileMessage().accountKeys.slice(0, step.tx.compileMessage().header.numRequiredSignatures)
    assert.deepEqual(
      signers.map((k) => k.toBase58()).sort(),
      [maker, ...step.signers.map((k) => k.publicKey)].map((k) => k.toBase58()).sort(),
    )
  }
})

test('a small create stays one atomic transaction, paid and signed by the maker', async () => {
  const { maker, built, steps: s } = await steps(campaign(1, 'Mug', 'MUG', 'https://backed.app/m/abcdefghij'))
  assert.equal(s.length, 1)
  assert.equal(s[0].tx, built.tx)
  assert.ok(walletSize(s[0].tx, maker) <= MAX_CREATE_TX_BYTES)
  const message = s[0].tx.compileMessage()
  const signers = message.accountKeys.slice(0, message.header.numRequiredSignatures).map((k) => k.toBase58())
  assert.deepEqual(signers.sort(), [maker, built.config, built.baseMint].map((k) => k.toBase58()).sort())
})

test('the one-transaction create no longer fits at 4 tiers, which is why it splits', async () => {
  const { maker, built } = await steps(campaign(MAX_TIERS, 'N'.repeat(32), 'S'.repeat(10), longUri))
  assert.ok(walletSize(built.tx, maker) > MAX_CREATE_TX_BYTES)
})
