// Listing against the real DBC program on a local validator (pnpm core:test:localnet): a campaign
// built for a maker is listed once its create transaction lands, however the confirm arrives.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { createMint } from '@solana/spl-token'
import { getNetwork } from '../../network'
import { buildCreateCampaignTx } from '../../chain'
import { send } from '../../tx'
import { closeDb } from '../../db'
import { getCampaign, getPending, listCampaigns, savePending, type CampaignRecord } from '../../store'
import { confirmListing, reconcilePending } from '../../listing'
import type { Campaign } from '../../engine'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
const net = getNetwork({ ...process.env, NETWORK: 'localnet' })
const conn = new Connection(net.rpcUrl, 'confirmed')

// Fresh keys and mint per run: other suites share the validator.
const payer = Keypair.generate()
const maker = Keypair.generate()
let usdcMint: PublicKey

const campaign: Campaign = {
  name: 'Listing Mug',
  symbol: 'LMUG',
  uri: 'http://127.0.0.1:3201/m/test',
  plan: { tiers: [{ units: 2, startPrice: 3 }, { units: 2, startPrice: 4 }], finalPrice: 5, makerSharePct: 10 },
  dropBot: { startFeeBps: 1500, windowSec: 60 },
  normalFeeBps: 100,
}

async function airdrop(to: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL)
  const latest = await conn.getLatestBlockhash('confirmed')
  await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
}

// Builds a campaign like POST /api/campaigns does and records it as pending; send() lands it.
async function build(createdAtMs = Date.now()) {
  const built = await buildCreateCampaignTx({ connection: conn, campaign, tier: 'C', platform: payer.publicKey, maker: maker.publicKey, usdcMint })
  const record: CampaignRecord = {
    pool: built.pool.toBase58(),
    config: built.config.toBase58(),
    baseMint: built.baseMint.toBase58(),
    usdcMint: usdcMint.toBase58(),
    maker: maker.publicKey.toBase58(),
    createdAt: new Date(createdAtMs).toISOString(),
    createSignature: '',
    campaign,
    trust: { tier: 'C', score: 0, reasons: [], maxMakerSharePct: 10 },
    goalUsdc: built.onChain.goalUsdc,
    totalUnits: built.onChain.totalUnits,
    fields: built.fields,
  }
  savePending(record, createdAtMs)
  return { record, send: () => send(conn, built.tx, [payer, ...built.extraSigners, maker], `create ${record.pool.slice(0, 8)}`) }
}

before(async () => {
  if (skip) return
  process.env.NETWORK = 'localnet'
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-localnet-listing-'))
  process.env.PLATFORM_FEE_CLAIMER = Keypair.generate().publicKey.toBase58()
  closeDb()
  await Promise.all([airdrop(payer.publicKey, 5), airdrop(maker.publicKey, 1)])
  usdcMint = await createMint(conn, payer, payer.publicKey, null, 6)
})

test('confirm twice: both succeed and the campaign is listed once', { skip }, async () => {
  const { record, send } = await build()
  const sig = await send()
  const first = await confirmListing(conn, record.pool, sig)
  const second = await confirmListing(conn, record.pool, sig)
  assert.equal(first.alreadyListed, false)
  assert.equal(second.alreadyListed, true)
  assert.equal(getCampaign(record.pool)?.createSignature, sig)
  assert.equal(listCampaigns().filter((c) => c.pool === record.pool).length, 1)
  assert.equal(getPending(record.pool), undefined)
})

test('confirm sent before the pool lands succeeds through the server-side wait', { skip }, async () => {
  const { record, send } = await build()
  const confirming = confirmListing(conn, record.pool, undefined, { waitMs: 30_000 })
  await new Promise((r) => setTimeout(r, 1500))
  const sig = await send()
  const { record: listed } = await confirming
  assert.equal(listed.createSignature, sig, 'the create signature is found on-chain')
})

test('a signature from another transaction is rejected', { skip }, async () => {
  const a = await build()
  const b = await build()
  const sigB = await b.send()
  await a.send()
  await assert.rejects(confirmListing(conn, a.record.pool, sigB, { waitMs: 5000 }), /did not create this campaign/)
  assert.ok(getPending(a.record.pool), 'still pending, so a correct confirm can follow')
})

test('reconcile lists a landed pool nobody confirmed and expires a build that never landed', { skip }, async () => {
  const landed = await build()
  const sig = await landed.send()
  const dead = await build(Date.now() - 60 * 60_000)
  const result = await reconcilePending(conn)
  assert.ok(result.listed.includes(landed.record.pool))
  assert.ok(result.expired.includes(dead.record.pool))
  assert.equal(getCampaign(landed.record.pool)?.createSignature, sig)
  assert.equal(getPending(dead.record.pool), undefined)
  assert.equal(getCampaign(dead.record.pool), undefined)
})
