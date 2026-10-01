// Listing against the real DBC program on a local validator (pnpm core:test:localnet): a campaign
// built for (and paid by) a maker is listed once its create lands, however the confirm arrives, in one
// transaction or split into createConfig then createPool, and after a resume onto a fresh pool.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { createMint } from '@solana/spl-token'
import { getNetwork } from '../../network'
import { buildCreateCampaignTx, buildCreatePoolTx, createCampaignSteps } from '../../chain'
import { MAX_TIERS } from '../../pricing'
import { send } from '../../tx'
import { closeDb, transaction } from '../../db'
import { deletePending, getCampaign, getPending, listCampaigns, savePending, type CampaignRecord } from '../../store'
import { confirmListing, reconcilePending } from '../../listing'
import type { Campaign } from '../../engine'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
const net = getNetwork({ ...process.env, NETWORK: 'localnet' })
const conn = new Connection(net.rpcUrl, 'confirmed')

// Fresh keys and mint per run: other suites share the validator. The maker pays for every create.
const payer = Keypair.generate() // mint authority of the mock USDC only
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

// The worst case POST /api/campaigns accepts: too big for one transaction, so it is split.
const large: Campaign = {
  ...campaign,
  name: 'N'.repeat(32),
  symbol: 'S'.repeat(10),
  uri: `https://${'o'.repeat(39)}.app/m/abcdefghij`,
  plan: { tiers: Array.from({ length: MAX_TIERS }, (_, i) => ({ units: 10, startPrice: 4 + i })), finalPrice: 4 + MAX_TIERS, makerSharePct: 10 },
}

// Builds a campaign like POST /api/campaigns does and records it as pending; send() lands its steps in
// order and returns the last signature (the one that creates the pool), sendStep(i) lands one step.
async function build(createdAtMs = Date.now(), c: Campaign = campaign) {
  const built = await buildCreateCampaignTx({ connection: conn, campaign: c, tier: 'C', maker: maker.publicKey, usdcMint })
  const steps = createCampaignSteps(built, maker.publicKey)
  const record: CampaignRecord = {
    pool: built.pool.toBase58(),
    config: built.config.toBase58(),
    baseMint: built.baseMint.toBase58(),
    usdcMint: usdcMint.toBase58(),
    maker: maker.publicKey.toBase58(),
    createdAt: new Date(createdAtMs).toISOString(),
    createSignature: '',
    campaign: c,
    trust: { tier: 'C', score: 0, reasons: [], maxMakerSharePct: 10 },
    goalUsdc: built.onChain.goalUsdc,
    totalUnits: built.onChain.totalUnits,
    fields: built.fields,
  }
  savePending(record, createdAtMs)
  const sendStep = (i: number) => send(conn, steps[i].tx, [maker, ...steps[i].signers], `create ${record.pool.slice(0, 8)} ${i + 1}/${steps.length}`)
  return {
    record,
    built,
    steps,
    sendStep,
    send: async () => {
      let sig = ''
      for (let i = 0; i < steps.length; i++) sig = await sendStep(i)
      return sig
    },
  }
}

before(async () => {
  if (skip) return
  process.env.NETWORK = 'localnet'
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-localnet-listing-'))
  process.env.PLATFORM_FEE_CLAIMER = Keypair.generate().publicKey.toBase58()
  closeDb()
  await Promise.all([airdrop(payer.publicKey, 1), airdrop(maker.publicKey, 5)])
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

test('split create: listed with the createPool signature; the createConfig one is not the create', { skip }, async () => {
  const split = await build(Date.now(), large)
  assert.equal(split.steps.length, 2)
  const configSig = await split.sendStep(0)
  const poolSig = await split.sendStep(1)
  await assert.rejects(confirmListing(conn, split.record.pool, configSig, { waitMs: 5000 }), /did not create this campaign/)
  const { record: listed } = await confirmListing(conn, split.record.pool, poolSig)
  assert.equal(listed.createSignature, poolSig)

  // Without a signature, the pool's own first transaction (createPool) is found.
  const other = await build(Date.now(), large)
  const otherSig = await other.send()
  assert.equal((await confirmListing(conn, other.record.pool)).record.createSignature, otherSig)
})

test('resume: a split create stopped after createConfig is listed under its new pool', { skip }, async () => {
  // Older than the reconcile grace period: the landed config keeps it resumable.
  const split = await build(Date.now() - 60 * 60_000, large)
  await split.sendStep(0)
  const reconciled = await reconcilePending(conn)
  assert.ok(reconciled.waiting.includes(split.record.pool), 'waiting, not expired')
  assert.ok(getPending(split.record.pool))
  // What POST /api/campaigns/<pool>/resume does: createPool on that config with a fresh mint, and the
  // pending row moves to the new pool address.
  const resumed = await buildCreatePoolTx({ connection: conn, config: split.built.config, campaign: large, maker: maker.publicKey, usdcMint })
  const record = { ...split.record, pool: resumed.pool.toBase58(), baseMint: resumed.baseMint.toBase58() }
  transaction(() => {
    savePending(record)
    deletePending(split.record.pool)
  })
  const sig = await send(conn, resumed.tx, [maker, ...resumed.extraSigners], 'resume createPool')
  const { record: listed } = await confirmListing(conn, record.pool, sig)
  assert.equal(listed.config, split.record.config)
  assert.equal(listed.baseMint, resumed.baseMint.toBase58())
  assert.equal(getPending(split.record.pool), undefined)
  assert.equal(getCampaign(split.record.pool), undefined, 'the stopped pool is not listed')
})
