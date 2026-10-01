// Redemptions against the mainnet DBC and DAMM v2 programs on a local validator (pnpm core:test:localnet):
// shipping is bound to the burn by its memo, so someone else's burn signature is worthless; nothing is
// redeemable before graduation; a burn whose confirm was dropped is found again; and burns that are
// not redemptions (no memo, wrong amount, a resale trade, the pool's creator) never count.
// Fresh keypairs, mints and a temp data dir, so it can share a validator with other runs.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createBurnInstruction, createMint, createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-redeem-localnet-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'localnet'
delete process.env.SHIPPING_ENCRYPTION_KEY

import { getNetwork } from '../../network'
import { send } from '../../tx'
import { campaignToConfig, type Campaign } from '../../engine'
import { buildBuyTx, buildCreateCampaignTx, buildMigrateTx, buildRedeemTx, createCampaignSteps, dbcClient, toUsdcRaw } from '../../chain'
import { buildResaleSwapTx } from '../../resale'
import { saveCampaign, type CampaignRecord } from '../../store'
import {
  OPEN_REDEMPTIONS,
  confirmRedemption,
  findUnfinishedRedemptions,
  getPendingRedemption,
  listRedemptionViews,
  newRedemptionId,
  prepareRedemption,
  savePendingRedemption,
  sealShipping,
} from '../../redemptions'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
const conn = new Connection(getNetwork({ ...process.env, NETWORK: 'localnet' }).rpcUrl, 'confirmed')
const POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')

// Goal ≈ 10·√(3·4) + 10·√(4·5) ≈ 79 USDC: the victim holds ~9 vouchers, the maker ~2.
const campaign: Campaign = {
  name: 'Redeem Test Cap',
  symbol: 'CAP',
  uri: 'https://example.com/cap.json',
  plan: { tiers: [{ units: 10, startPrice: 3 }, { units: 10, startPrice: 4 }], finalPrice: 5, makerSharePct: 10 },
  dropBot: { startFeeBps: 1500, windowSec: 60 },
  normalFeeBps: 100,
}

const platform = Keypair.generate()
const maker = Keypair.generate()
const victim = Keypair.generate()
const attacker = Keypair.generate()
let usdcMint: PublicKey
let record: CampaignRecord

const victimShipping = { name: 'Victor Victim', email: 'v@example.com', address: '1 Real St', country: 'NL' }
const attackerShipping = { name: 'Mallory', email: 'm@example.com', address: '666 Drop Box', country: 'XX' }

async function airdrop(pk: PublicKey, sol = 10) {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
}

async function fundUsdc(owner: PublicKey, usdc: number) {
  const ata = getAssociatedTokenAddressSync(usdcMint, owner)
  await send(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, ata, owner, usdcMint),
      createMintToInstruction(usdcMint, ata, platform.publicKey, BigInt(toUsdcRaw(usdc).toString())),
    ),
    [platform],
    `fund ${owner.toBase58().slice(0, 4)} with ${usdc} USDC`,
  )
}

const redeemable = () => ({ ...record })

before(async () => {
  if (skip) return
  process.env.PLATFORM_FEE_CLAIMER = platform.publicKey.toBase58()
  await Promise.all([platform, maker, victim, attacker].map((k) => airdrop(k.publicKey)))
  if ((await conn.getBalance(POOL_AUTHORITY)) < LAMPORTS_PER_SOL) await airdrop(POOL_AUTHORITY, 5)
  usdcMint = await createMint(conn, platform, platform.publicKey, null, 6)
  for (const k of [victim, attacker, maker]) await fundUsdc(k.publicKey, 200)
  const built = await buildCreateCampaignTx({ connection: conn, campaign, tier: 'C', maker: maker.publicKey, usdcMint })
  for (const step of createCampaignSteps(built, maker.publicKey)) await send(conn, step.tx, [maker, ...step.signers], 'create')
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
  saveCampaign(record)
  await send(conn, (await buildBuyTx(conn, victim.publicKey, built.pool, 35)).tx, [victim], 'victim backs 35 USDC')
  // The maker backs too, so the creator holds vouchers of its own campaign.
  await send(conn, (await buildBuyTx(conn, maker.publicKey, built.pool, 10)).tx, [maker], 'maker backs 10 USDC')
})

test('prepare before graduation is refused with 409', { skip }, async () => {
  await assert.rejects(prepareRedemption(conn, redeemable(), victim.publicKey, victimShipping), { status: 409, message: /graduates/ })
})

test('graduate the campaign', { skip }, async () => {
  await send(conn, (await buildBuyTx(conn, attacker.publicKey, new PublicKey(record.pool), 100)).tx, [attacker], 'attacker fills the goal')
  const { tx, extraSigners } = await buildMigrateTx(conn, attacker.publicKey, new PublicKey(record.pool))
  await send(conn, tx, [attacker, ...extraSigners], 'graduate')
  assert.equal(Number((await dbcClient(conn).state.getPool(new PublicKey(record.pool)))!.poolState.isMigrated), 1)
})

let victimSig: string
let victimId: string

test('the owner prepares with shipping, burns with the memo, and the confirm records the order', { skip }, async () => {
  const { pending, tx } = await prepareRedemption(conn, redeemable(), victim.publicKey, victimShipping)
  assert.ok(!fs.readFileSync(path.join(root, 'data', 'pending-redemptions.localnet.json'), 'utf8').includes('Victor'), 'sealed at rest')
  victimSig = await send(conn, tx, [victim], 'victim burns 1 voucher with the memo')
  victimId = pending.id
  const { redemption, already } = await confirmRedemption(conn, pending.id, victimSig)
  assert.equal(already, false)
  assert.equal(redemption.units, 1)
  assert.equal(getPendingRedemption(pending.id), undefined)
  const again = await confirmRedemption(conn, pending.id, victimSig)
  assert.equal(again.already, true, 'confirming twice is harmless')
  const order = listRedemptionViews(record.pool).find((r) => r.signature === victimSig)
  assert.deepEqual(order?.shipping, victimShipping)
})

test('an attacker who submits the victim’s burn with other shipping gets 400', { skip }, async () => {
  // A pending redemption in the victim's name (prepare proves nothing about the caller)...
  const forged = await prepareRedemption(conn, redeemable(), victim.publicKey, attackerShipping)
  await assert.rejects(confirmRedemption(conn, forged.pending.id, victimSig), { status: 400, message: /not made for this redemption/ })
  // ...or in the attacker's own name.
  const own = await prepareRedemption(conn, redeemable(), attacker.publicKey, attackerShipping)
  await assert.rejects(confirmRedemption(conn, own.pending.id, victimSig), { status: 400, message: /not made for this redemption/ })
  // And the real redemption cannot be re-pointed at another burn.
  await assert.rejects(confirmRedemption(conn, victimId, 'x'.repeat(88)), { status: 409 })
  const orders = listRedemptionViews(record.pool)
  assert.equal(orders.length, 1)
  assert.equal(orders[0].shipping?.name, 'Victor Victim')
})

test('a burn without the memo cannot be claimed', { skip }, async () => {
  const { pending } = await prepareRedemption(conn, redeemable(), victim.publicKey, victimShipping)
  const ata = getAssociatedTokenAddressSync(new PublicKey(record.baseMint), victim.publicKey)
  const sig = await send(conn, new Transaction().add(createBurnInstruction(ata, new PublicKey(record.baseMint), victim.publicKey, BigInt(1e6))), [victim], 'plain burn')
  await assert.rejects(confirmRedemption(conn, pending.id, sig), { status: 400, message: /not made for this redemption/ })
})

test('a burn of the wrong amount does not count', { skip }, async () => {
  const { pending } = await prepareRedemption(conn, redeemable(), victim.publicKey, victimShipping)
  const tx = buildRedeemTx(victim.publicKey, new PublicKey(record.baseMint), pending.id, 2)
  const sig = await send(conn, tx, [victim], 'burn 2 for a 1-unit redemption')
  await assert.rejects(confirmRedemption(conn, pending.id, sig), { status: 400, message: /exactly 1 whole voucher/ })
})

test('a burn inside a resale-pool transaction is not a redemption', { skip }, async () => {
  const { pending, tx } = await prepareRedemption(conn, redeemable(), victim.publicKey, victimShipping)
  const swap = await buildResaleSwapTx(conn, redeemable(), victim.publicKey, 'buy', 1)
  const sig = await send(conn, new Transaction().add(...swap.instructions, ...tx.instructions), [victim], 'resale buy + burn with memo')
  await assert.rejects(confirmRedemption(conn, pending.id, sig), { status: 400, message: /pool liquidity/ })
})

test('the pool’s creator cannot redeem, and a burn it signs does not count', { skip }, async () => {
  await assert.rejects(prepareRedemption(conn, redeemable(), maker.publicKey, victimShipping), { status: 409, message: /maker/ })
  // A row as if prepared for the maker before that check; the burn carries its memo.
  const id = newRedemptionId()
  savePendingRedemption({ id, pool: record.pool, wallet: maker.publicKey.toBase58(), units: 1, shipping: sealShipping(victimShipping, record.pool, maker.publicKey.toBase58()), createdAt: new Date().toISOString() })
  const sig = await send(conn, buildRedeemTx(maker.publicKey, new PublicKey(record.baseMint), id), [maker], 'creator burns with a memo')
  await assert.rejects(confirmRedemption(conn, id, sig), { status: 400, message: /creator signed/ })
  // The creator paying the fee for a backer's burn is refused as well.
  const backerRow = await prepareRedemption(conn, redeemable(), victim.publicKey, victimShipping)
  const cosigned = await send(conn, backerRow.tx, [maker, victim], 'backer burn with the creator as fee payer')
  await assert.rejects(confirmRedemption(conn, backerRow.pending.id, cosigned), { status: 400, message: /creator signed/ })
})

test('a burn whose confirm was dropped is found again and confirmed', { skip }, async () => {
  const before = listRedemptionViews(record.pool).length
  // The victim has started six redemptions in the last two minutes: a seventh waits.
  await assert.rejects(prepareRedemption(conn, redeemable(), victim.publicKey, victimShipping), { status: 429 })
  const later = Date.now() + OPEN_REDEMPTIONS.windowMs
  const { pending, tx } = await prepareRedemption(conn, redeemable(), victim.publicKey, victimShipping, 1, later)
  const sig = await send(conn, tx, [victim], 'victim burns, then the tab closes')
  const unfinished = await findUnfinishedRedemptions(conn, redeemable(), victim.publicKey)
  // Earlier tests left burns with memos whose checks fail; only real candidates matter here.
  const found = unfinished.find((u) => u.id === pending.id)
  assert.deepEqual(found, { id: pending.id, signature: sig, units: 1, createdAt: pending.createdAt })
  assert.equal(await findUnfinishedRedemptions(conn, redeemable(), attacker.publicKey).then((u) => u.length), 0)
  await confirmRedemption(conn, found!.id, found!.signature)
  assert.equal(listRedemptionViews(record.pool).length, before + 1)
  assert.equal((await findUnfinishedRedemptions(conn, redeemable(), victim.publicKey)).some((u) => u.id === pending.id), false)
})
