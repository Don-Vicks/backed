// Live campaign reads and the server's send() against the mainnet DBC program on a local validator
// (pnpm core:test:localnet): batched listing reads, the per-pool caches (live state and resale panels),
// progress from one read, and identical transactions sent back to back. Fresh keypairs and mint, so it can share a validator.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMint, createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { getNetwork } from '../../network'
import { send } from '../../tx'
import { campaignToConfig, type Campaign } from '../../engine'
import { buildBuyTx, buildCreateCampaignTx, dbcClient, toUsdcRaw } from '../../chain'
import { forgetCampaignLive, readCampaignLive, readCampaignsLive } from '../../live'
import { readMakerEarnings, readResale, readResaleCached } from '../../resale'
import type { CampaignRecord } from '../../store'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
const conn = new Connection(getNetwork({ ...process.env, NETWORK: 'localnet' }).rpcUrl, 'confirmed')

const campaign: Campaign = {
  name: 'Live Test Mug',
  symbol: 'LIVE',
  uri: 'https://example.com/live.json',
  plan: { tiers: [{ units: 20, startPrice: 4 }, { units: 20, startPrice: 6 }], finalPrice: 8, makerSharePct: 10 },
  dropBot: { startFeeBps: 1500, windowSec: 60 },
  normalFeeBps: 100,
}

const platform = Keypair.generate()
const maker = Keypair.generate()
const backer = Keypair.generate()
let record: CampaignRecord

async function airdrop(pk: PublicKey) {
  const sig = await conn.requestAirdrop(pk, 10 * LAMPORTS_PER_SOL)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
}

// Counts calls per RPC method on a connection.
function counting(target: Connection) {
  const calls = new Map<string, number>()
  const proxy = new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1)
        return value.apply(t, args)
      }
    },
  })
  return { conn: proxy, calls }
}

before(async () => {
  if (skip) return
  process.env.NETWORK = 'localnet'
  process.env.PLATFORM_FEE_CLAIMER = platform.publicKey.toBase58()
  await Promise.all([platform, maker, backer].map((k) => airdrop(k.publicKey)))
  const usdcMint = await createMint(conn, platform, platform.publicKey, null, 6)
  const ata = getAssociatedTokenAddressSync(usdcMint, backer.publicKey)
  await send(
    conn,
    new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, ata, backer.publicKey, usdcMint))
      .add(createMintToInstruction(usdcMint, ata, platform.publicKey, BigInt(toUsdcRaw(500).toString()))),
    [platform],
    'fund backer',
  )
  const built = await buildCreateCampaignTx({ connection: conn, campaign, tier: 'C', maker: maker.publicKey, usdcMint })
  await send(conn, built.tx, [maker, ...built.extraSigners], 'createConfigAndPool')
  const { onChain, fields } = campaignToConfig(campaign, 'C')
  record = {
    pool: built.pool.toBase58(),
    config: built.config.toBase58(),
    baseMint: built.baseMint.toBase58(),
    usdcMint: usdcMint.toBase58(),
    maker: maker.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    createSignature: '',
    campaign,
    trust: { tier: 'C', score: 0, reasons: [], maxMakerSharePct: 10 },
    goalUsdc: onChain.goalUsdc,
    totalUnits: onChain.totalUnits,
    fields,
  }
  await send(conn, (await buildBuyTx(conn, backer.publicKey, built.pool, 50)).tx, [backer], 'backer backs 50 USDC')
})

test('the listing reads pools and mints in one batch, and an unreadable pool is null', { skip }, async () => {
  const { conn: counted, calls } = counting(conn)
  const bogus = { ...record, pool: Keypair.generate().publicKey.toBase58() }
  const [live, missing] = await readCampaignsLive(counted, [record, bogus])
  assert.equal(missing, null)
  assert.ok(live)
  assert.equal(live.status, 'funding')
  assert.ok(live.unitsSold > 0 && live.raisedUsdc > 0)
  // Pools + mints in one call, the config in a second; nothing per pool.
  assert.equal(calls.get('getMultipleAccountsInfo'), 2)
  assert.equal(calls.get('getAccountInfo') ?? 0, 0)
  // Progress from the accounts already read matches the SDK's own double read.
  const sdk = await dbcClient(conn).state.getPoolQuoteTokenCurveProgress(new PublicKey(record.pool))
  assert.ok(Math.abs(live.progress - sdk) < 1e-12, `${live.progress} vs ${sdk}`)
})

test('concurrent reads of one pool share a request, and the result is cached', { skip }, async () => {
  const fresh = { ...record } // same pool: the listing test above may have cached it, so wait it out
  await new Promise((r) => setTimeout(r, 3100))
  const { conn: counted, calls } = counting(conn)
  const reads = await Promise.all(Array.from({ length: 10 }, () => readCampaignLive(counted, fresh)))
  assert.equal(new Set(reads.map((r) => JSON.stringify(r))).size, 1)
  assert.equal(calls.get('getMultipleAccountsInfo'), 1, 'one batch for ten readers; the config is cached for good')
  await readCampaignLive(counted, fresh)
  assert.equal(calls.get('getMultipleAccountsInfo'), 1, 'served from the cache')
})

test('a fresh read skips the cache and refreshes it; a forgotten pool is read again', { skip }, async () => {
  await readCampaignLive(conn, record) // cached
  const { conn: counted, calls } = counting(conn)
  await readCampaignLive(counted, record, { fresh: true })
  assert.equal(calls.get('getMultipleAccountsInfo'), 1, 'fresh goes to the chain')
  await readCampaignLive(counted, record)
  assert.equal(calls.get('getMultipleAccountsInfo'), 1, 'and leaves the cache fresh')
  forgetCampaignLive(record.pool)
  await readCampaignLive(counted, record)
  assert.equal(calls.get('getMultipleAccountsInfo'), 2)
})

const total = (calls: Map<string, number>) => [...calls.values()].reduce((a, b) => a + b, 0)

test('concurrent resale-panel reads of one pool cost one set of RPC calls', { skip }, async () => {
  const once = counting(conn)
  const direct = await readResale(once.conn, record)
  const maker = direct?.maker ?? (await readMakerEarnings(once.conn, record))
  assert.ok(total(once.calls) > 0)

  const { conn: counted, calls } = counting(conn)
  const reads = await Promise.all(Array.from({ length: 10 }, () => readResaleCached(counted, record)))
  assert.equal(new Set(reads.map((r) => JSON.stringify(r))).size, 1)
  assert.deepEqual(reads[0], { resale: direct, maker })
  assert.equal(total(calls), total(once.calls), `ten readers: ${JSON.stringify([...calls])} vs one: ${JSON.stringify([...once.calls])}`)
  await readResaleCached(counted, record)
  assert.equal(total(calls), total(once.calls), 'served from the cache')
})

test('send() lands identical transactions sent at once, each exactly once', { skip }, async () => {
  const to = Keypair.generate().publicKey
  const transfer = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: platform.publicKey, toPubkey: to, lamports: LAMPORTS_PER_SOL / 100 }))
  const sigs = await Promise.all([1, 2, 3].map((i) => send(conn, transfer(), [platform], `identical transfer ${i}`)))
  assert.equal(new Set(sigs).size, 3)
  assert.equal(await conn.getBalance(to), (3 * LAMPORTS_PER_SOL) / 100)
})
