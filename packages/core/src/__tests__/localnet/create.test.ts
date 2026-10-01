// Campaign creation and graduation against the mainnet DBC program on a local validator
// (pnpm core:test:localnet): every maker share passes createConfig, the maker pays for the create and
// the platform key never signs or pays, the worst-case create is split and lands, a split create stopped
// after its config finishes on that config, and graduation is paid by whichever wallet asks for it.
// Fresh keypairs and mints only, so it can share a validator.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMint, createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { getNetwork } from '../../network'
import { send } from '../../tx'
import type { Campaign } from '../../engine'
import { MAX_MAKER_SHARE } from '../../trust'
import { MAX_TIERS } from '../../pricing'
import { MAX_CREATE_TX_BYTES, buildBuyTx, buildCreateCampaignTx, buildCreatePoolTx, buildMigrateTx, createCampaignSteps, dbcClient, toUsdcRaw } from '../../chain'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
const conn = new Connection(getNetwork({ ...process.env, NETWORK: 'localnet' }).rpcUrl, 'confirmed')
const POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')

// The platform key is real but holds no SOL: if anything still made it pay or sign, the create fails.
const platform = Keypair.generate()
const mintAuthority = Keypair.generate()
const maker = Keypair.generate()
let usdcMint: PublicKey

const campaign = (name: string, symbol: string, uri: string, plan: Campaign['plan']): Campaign => ({
  name,
  symbol,
  uri,
  plan,
  dropBot: { startFeeBps: 1500, windowSec: 60 },
  normalFeeBps: 100,
})

// The plans the scripts and the web smoke test launch.
const plans: Record<string, Omit<Campaign['plan'], 'makerSharePct'>> = {
  hoodie: { tiers: [{ units: 20, startPrice: 25 }, { units: 30, startPrice: 30 }], finalPrice: 38 },
  lifecycle: { tiers: [{ units: 3, startPrice: 4 }, { units: 4, startPrice: 5 }], finalPrice: 6 },
  smoke: { tiers: [{ units: 2, startPrice: 3 }, { units: 2, startPrice: 4 }], finalPrice: 5 },
}

async function airdrop(pk: PublicKey, sol = 10) {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
}

before(async () => {
  if (skip) return
  process.env.NETWORK = 'localnet'
  process.env.PLATFORM_SECRET_KEY = JSON.stringify([...platform.secretKey])
  delete process.env.PLATFORM_FEE_CLAIMER // the claimer defaults to the platform key
  await Promise.all([mintAuthority, maker].map((k) => airdrop(k.publicKey, 50)))
  if ((await conn.getBalance(POOL_AUTHORITY)) < LAMPORTS_PER_SOL) await airdrop(POOL_AUTHORITY, 5)
  usdcMint = await createMint(conn, mintAuthority, mintAuthority.publicKey, null, 6)
})

test('createConfig + createPool simulate cleanly for every maker share 0..40 on three plans', { skip }, async () => {
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const failures: string[] = []
  for (const [name, plan] of Object.entries(plans)) {
    const shares = Array.from({ length: MAX_MAKER_SHARE.A + 1 }, (_, share) => share)
    await Promise.all(
      shares.map(async (share) => {
        const c = campaign(`Sweep ${name}`, 'SWEEP', 'https://backed.example/m/abcdefghij', { ...plan, makerSharePct: share })
        const built = await buildCreateCampaignTx({ connection: conn, campaign: c, tier: 'A', maker: maker.publicKey, usdcMint })
        built.tx.recentBlockhash = blockhash
        built.tx.feePayer = maker.publicKey
        built.tx.sign(maker, ...built.extraSigners)
        const sim = await conn.simulateTransaction(built.tx)
        if (sim.value.err) failures.push(`${name} share ${share}: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).filter((l) => /Error/.test(l)).join(' ')}`)
      }),
    )
  }
  assert.deepEqual(failures, [])
})

test('plans at the allowlist bounds (goal ~10M USDC, final price 100x the first) simulate cleanly', { skip }, async () => {
  const bounds: Record<string, Omit<Campaign['plan'], 'makerSharePct'>> = {
    'max goal, cheap units': { tiers: [{ units: 1_000_000, startPrice: 9.9 }], finalPrice: 10.1 },
    'max goal, dear units': { tiers: [{ units: 10, startPrice: 900_000 }], finalPrice: 1_000_000 },
    'max ratio, one unit': { tiers: [{ units: 1, startPrice: 0.01 }], finalPrice: 1 },
    'max ratio, max units': { tiers: [{ units: 1_000_000, startPrice: 0.1 }], finalPrice: 10 },
  }
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const failures: string[] = []
  for (const [name, plan] of Object.entries(bounds)) {
    for (const share of [0, MAX_MAKER_SHARE.A]) {
      const c = campaign('Bounds', 'BOUND', 'https://backed.example/m/abcdefghij', { ...plan, makerSharePct: share })
      const built = await buildCreateCampaignTx({ connection: conn, campaign: c, tier: 'A', maker: maker.publicKey, usdcMint })
      built.tx.recentBlockhash = blockhash
      built.tx.feePayer = maker.publicKey
      built.tx.sign(maker, ...built.extraSigners)
      const sim = await conn.simulateTransaction(built.tx)
      if (sim.value.err) failures.push(`${name} share ${share}: ${JSON.stringify(sim.value.err)}`)
    }
  }
  assert.deepEqual(failures, [])
})

test('the worst-case create is split in two, lands, and costs the platform nothing', { skip }, async () => {
  const before = { platform: await conn.getBalance(platform.publicKey), maker: await conn.getBalance(maker.publicKey) }
  assert.equal(before.platform, 0)
  const tiers = Array.from({ length: MAX_TIERS }, (_, i) => ({ units: 10, startPrice: 4 + i }))
  const c = campaign('N'.repeat(32), 'S'.repeat(10), `https://${'o'.repeat(39)}.app/m/abcdefghij`, { tiers, finalPrice: 4 + MAX_TIERS, makerSharePct: 10 })
  const built = await buildCreateCampaignTx({ connection: conn, campaign: c, tier: 'A', maker: maker.publicKey, usdcMint })
  const steps = createCampaignSteps(built, maker.publicKey)
  assert.equal(steps.length, 2)
  for (const [i, step] of steps.entries()) {
    await send(conn, step.tx, [maker, ...step.signers], `create step ${i + 1}/2`)
    assert.ok(step.tx.serialize().length <= MAX_CREATE_TX_BYTES)
    // Signed by the maker and the step's fresh key only.
    assert.deepEqual(
      step.tx.signatures.map((s) => s.publicKey.toBase58()).sort(),
      [maker, ...step.signers].map((k) => k.publicKey.toBase58()).sort(),
    )
  }

  const client = dbcClient(conn)
  const pool = await client.state.getPool(built.pool)
  assert.ok(pool, 'pool not created')
  assert.ok(pool.poolState.creator.equals(maker.publicKey))
  const config = (await client.state.getPoolConfig(built.config))!
  assert.ok(config.feeClaimer.equals(platform.publicKey), 'feeClaimer is the configured claimer')
  assert.ok(config.leftoverReceiver.equals(platform.publicKey))

  assert.equal(await conn.getBalance(platform.publicKey), 0, 'the platform paid for a create')
  const spent = (before.maker - (await conn.getBalance(maker.publicKey))) / LAMPORTS_PER_SOL
  assert.ok(spent > 0.01 && spent < 0.1, `maker paid ${spent} SOL`)
})

test('a split create stopped after createConfig is finished on that config with a fresh mint', { skip }, async () => {
  const tiers = Array.from({ length: MAX_TIERS }, (_, i) => ({ units: 10, startPrice: 4 + i }))
  const c = campaign('N'.repeat(32), 'S'.repeat(10), `https://${'o'.repeat(39)}.app/m/abcdefghij`, { tiers, finalPrice: 4 + MAX_TIERS, makerSharePct: 10 })
  const built = await buildCreateCampaignTx({ connection: conn, campaign: c, tier: 'A', maker: maker.publicKey, usdcMint })
  const [configStep] = createCampaignSteps(built, maker.publicKey)
  await send(conn, configStep.tx, [maker, ...configStep.signers], 'create step 1/2 only')
  const client = dbcClient(conn)
  assert.equal(await client.state.getPool(built.pool), null)

  // What /api/campaigns/<pool>/resume builds: one createPool, signed by the maker and the new mint.
  const resumed = await buildCreatePoolTx({ connection: conn, config: built.config, campaign: c, maker: maker.publicKey, usdcMint })
  assert.ok(!resumed.pool.equals(built.pool))
  await send(conn, resumed.tx, [maker, ...resumed.extraSigners], 'resume: createPool on the existing config')
  assert.deepEqual(resumed.tx.signatures.map((s) => s.publicKey.toBase58()).sort(), [maker.publicKey, resumed.baseMint].map((k) => k.toBase58()).sort())
  const pool = (await client.state.getPool(resumed.pool))!
  assert.ok(pool.poolState.config.equals(built.config))
  assert.ok(pool.poolState.creator.equals(maker.publicKey))
  assert.ok(pool.poolState.baseMint.equals(resumed.baseMint))
})

test('feeClaimer and leftoverReceiver follow PLATFORM_FEE_CLAIMER', { skip }, async () => {
  const claimer = Keypair.generate().publicKey
  process.env.PLATFORM_FEE_CLAIMER = claimer.toBase58()
  try {
    const c = campaign('Claimer Mug', 'MUG', 'https://backed.example/m/abcdefghij', { ...plans.smoke, makerSharePct: 10 })
    const built = await buildCreateCampaignTx({ connection: conn, campaign: c, tier: 'C', maker: maker.publicKey, usdcMint })
    const [step] = createCampaignSteps(built, maker.publicKey)
    await send(conn, step.tx, [maker, ...step.signers], 'create with a cold fee claimer')
    const config = (await dbcClient(conn).state.getPoolConfig(built.config))!
    assert.ok(config.feeClaimer.equals(claimer))
    assert.ok(config.leftoverReceiver.equals(claimer))
  } finally {
    delete process.env.PLATFORM_FEE_CLAIMER
  }
})

test('graduation is paid by the wallet that asks for it, not the platform', { skip }, async () => {
  const c = campaign('Graduate Mug', 'GRAD', 'https://backed.example/m/abcdefghij', { ...plans.smoke, makerSharePct: 10 })
  const built = await buildCreateCampaignTx({ connection: conn, campaign: c, tier: 'C', maker: maker.publicKey, usdcMint })
  for (const step of createCampaignSteps(built, maker.publicKey)) await send(conn, step.tx, [maker, ...step.signers], 'create')

  // One backer fills the goal; PartialFill stops at it.
  const backer = Keypair.generate()
  await airdrop(backer.publicKey)
  const ata = getAssociatedTokenAddressSync(usdcMint, backer.publicKey)
  await send(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(mintAuthority.publicKey, ata, backer.publicKey, usdcMint),
      createMintToInstruction(usdcMint, ata, mintAuthority.publicKey, BigInt(toUsdcRaw(100).toString())),
    ),
    [mintAuthority],
    'fund backer',
  )
  await send(conn, (await buildBuyTx(conn, backer.publicKey, built.pool, 100)).tx, [backer], 'fill the goal')
  const client = dbcClient(conn)
  assert.ok((await client.state.getPoolQuoteTokenCurveProgress(built.pool)) >= 1)

  // What the migrate route returns: the clicker pays, the position-NFT keys are already signed.
  const clicker = Keypair.generate()
  await airdrop(clicker.publicKey)
  const start = await conn.getBalance(clicker.publicKey)
  const { tx, extraSigners } = await buildMigrateTx(conn, clicker.publicKey, built.pool)
  await send(conn, tx, [clicker, ...extraSigners], 'clicker graduates the campaign')
  assert.equal(Number((await client.state.getPool(built.pool))!.poolState.isMigrated), 1)
  const paid = (start - (await conn.getBalance(clicker.publicKey))) / LAMPORTS_PER_SOL
  assert.ok(paid > 0 && paid < 0.1, `clicker paid ${paid} SOL`)
  assert.equal(await conn.getBalance(platform.publicKey), 0)
  console.log(`    graduation cost the clicking wallet ${paid.toFixed(4)} SOL`)
})
