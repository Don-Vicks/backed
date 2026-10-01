// Redemptions against the mainnet DBC and DAMM v2 programs on a local validator (pnpm core:test:localnet):
// shipping is kept only with a burn its wallet signed, so preparing in someone else's name stores nothing
// and someone else's burn signature is worthless; nothing is redeemable before graduation; a burn whose
// order was not recorded is found again by its signature; and burns that are not redemptions (no memo,
// wrong amount, a resale trade, the pool's creator) are never sent, and never count if they land.
// Fresh keypairs, mints and a temp data dir, so it can share a validator with other runs.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createMint,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-redeem-localnet-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'localnet'
delete process.env.SHIPPING_ENCRYPTION_KEY

import { getNetwork } from '../../network'
import { send } from '../../tx'
import { campaignToConfig, type Campaign } from '../../engine'
import { MEMO_PROGRAM_ID, REDEEM_MEMO_PREFIX, buildBuyTx, buildCreateCampaignTx, buildMigrateTx, buildRedeemTx, createCampaignSteps, dbcClient, toUsdcRaw } from '../../chain'
import { buildResaleSwapTx } from '../../resale'
import { saveCampaign, type CampaignRecord } from '../../store'
import {
  MAX_OPEN_REDEMPTIONS,
  confirmRedemption,
  findUnfinishedRedemptions,
  getPendingRedemption,
  listPendingRedemptions,
  listRedemptionViews,
  newRedemptionId,
  prepareRedemption,
  removePendingRedemption,
  savePendingRedemption,
  sealShipping,
  submitRedemption,
  verifyRedeemBurn,
  type PendingRedemption,
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
const mint = () => new PublicKey(record.baseMint)
const pendingFile = () => path.join(root, 'data', 'pending-redemptions.localnet.json')
const vouchers = async (owner: PublicKey) => BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint(), owner), 'confirmed')).value.amount)

// What the browser does with a prepared burn: the wallet signs it on a fresh blockhash.
async function signed(tx: Transaction, signers: Keypair[]) {
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.sign(...signers)
  return tx.serialize({ requireAllSignatures: false })
}

// A pending row as submit keeps it just before sending: for crafting the cases a crash leaves behind.
const row = (wallet: PublicKey, over: Partial<PendingRedemption> = {}): PendingRedemption => ({
  id: newRedemptionId(),
  pool: record.pool,
  wallet: wallet.toBase58(),
  units: 1,
  shipping: sealShipping(victimShipping, record.pool, wallet.toBase58()),
  createdAt: new Date().toISOString(),
  signature: bs58.encode(Buffer.alloc(64, 7)),
  lastValidBlockHeight: Number.MAX_SAFE_INTEGER,
  ...over,
})

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

test('nothing is redeemable before graduation', { skip }, async () => {
  await assert.rejects(prepareRedemption(conn, redeemable(), victim.publicKey), { status: 409, message: /graduates/ })
  // A burn built by hand and signed is refused before it is sent.
  const id = newRedemptionId()
  const raw = await signed(buildRedeemTx(victim.publicKey, mint(), id), [victim])
  const before = await vouchers(victim.publicKey)
  await assert.rejects(submitRedemption(conn, redeemable(), raw, id, victimShipping), { status: 409, message: /graduates/ })
  assert.equal(await vouchers(victim.publicKey), before)
  assert.equal(getPendingRedemption(id), undefined)
})

test('graduate the campaign', { skip }, async () => {
  await send(conn, (await buildBuyTx(conn, attacker.publicKey, new PublicKey(record.pool), 100)).tx, [attacker], 'attacker fills the goal')
  const { tx, extraSigners } = await buildMigrateTx(conn, attacker.publicKey, new PublicKey(record.pool))
  await send(conn, tx, [attacker, ...extraSigners], 'graduate')
  assert.equal(Number((await dbcClient(conn).state.getPool(new PublicKey(record.pool)))!.poolState.isMigrated), 1)
})

let victimSig: string
let victimId: string

test('the owner prepares, signs and submits; the server sends the burn and records the order', { skip }, async () => {
  const before = await vouchers(victim.publicKey)
  const { id, tx } = await prepareRedemption(conn, redeemable(), victim.publicKey)
  const raw = await signed(tx, [victim])
  const { redemption, already } = await submitRedemption(conn, redeemable(), raw, id, victimShipping)
  assert.equal(already, false)
  assert.equal(redemption.units, 1)
  assert.equal(await vouchers(victim.publicKey), before - BigInt(1e6))
  assert.equal(getPendingRedemption(id), undefined, 'the pending row is gone once the order is recorded')
  assert.ok(!fs.readFileSync(path.join(root, 'data', 'redemptions.localnet.json'), 'utf8').includes('Victor'), 'sealed at rest')
  victimSig = redemption.signature
  victimId = id
  // The same signed burn again (a retry), even with other shipping: the order already recorded.
  const again = await submitRedemption(conn, redeemable(), raw, id, attackerShipping)
  assert.equal(again.already, true)
  assert.equal((await confirmRedemption(conn, id, victimSig)).already, true, 'confirming it is harmless too')
  const order = listRedemptionViews(record.pool).find((r) => r.signature === victimSig)
  assert.deepEqual(order?.shipping, victimShipping)
})

test('a third party’s prepares in the owner’s name store nothing and do not lock the owner out', { skip }, async () => {
  const stored = fs.existsSync(pendingFile()) ? fs.readFileSync(pendingFile(), 'utf8') : ''
  for (let i = 0; i < 3 * MAX_OPEN_REDEMPTIONS; i++) await prepareRedemption(conn, redeemable(), victim.publicKey)
  assert.equal(fs.existsSync(pendingFile()) ? fs.readFileSync(pendingFile(), 'utf8') : '', stored)
  // The attacker cannot get a prepared burn accepted without the owner's signature...
  const theirs = await prepareRedemption(conn, redeemable(), victim.publicKey)
  const asPayer = await signed(theirs.tx, [attacker])
  await assert.rejects(submitRedemption(conn, redeemable(), asPayer, theirs.id, attackerShipping), { status: 400, message: /not signed by its wallet/ })
  const unsigned = await prepareRedemption(conn, redeemable(), victim.publicKey)
  unsigned.tx.feePayer = victim.publicKey
  unsigned.tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  const raw = unsigned.tx.serialize({ requireAllSignatures: false })
  await assert.rejects(submitRedemption(conn, redeemable(), raw, unsigned.id, attackerShipping), { status: 400, message: /not signed by its wallet/ })
  // ...and the owner redeems as usual.
  const { id, tx } = await prepareRedemption(conn, redeemable(), victim.publicKey)
  assert.equal((await submitRedemption(conn, redeemable(), await signed(tx, [victim]), id, victimShipping)).already, false)
})

test('someone else’s burn signature is worthless, and cannot drop a pending row', { skip }, async () => {
  // A redemption prepared in the victim's name was never stored: there is nothing to claim.
  const forged = await prepareRedemption(conn, redeemable(), victim.publicKey)
  await assert.rejects(confirmRedemption(conn, forged.id, victimSig), { status: 404 })
  // A pending row of the attacker's own only takes the burn sent for it, and a wrong one changes nothing.
  const own = row(attacker.publicKey)
  savePendingRedemption(own)
  await assert.rejects(confirmRedemption(conn, own.id, victimSig), { status: 400, message: /not the burn sent/ })
  assert.ok(getPendingRedemption(own.id), 'kept')
  removePendingRedemption(own.id)
  // And the real redemption cannot be re-pointed at another burn.
  await assert.rejects(confirmRedemption(conn, victimId, 'x'.repeat(88)), { status: 409 })
  const orders = listRedemptionViews(record.pool)
  assert.ok(orders.every((o) => o.shipping?.name === 'Victor Victim'))
})

test('a signed burn that is not the one built is never sent', { skip }, async () => {
  const before = await vouchers(victim.publicKey)
  const { id, tx } = await prepareRedemption(conn, redeemable(), victim.publicKey)
  const two = await signed(buildRedeemTx(victim.publicKey, mint(), id, 2), [victim])
  await assert.rejects(submitRedemption(conn, redeemable(), two, id, victimShipping), { status: 400, message: /not the redemption transaction/ })
  const swap = await buildResaleSwapTx(conn, redeemable(), victim.publicKey, 'buy', 1)
  const withSwap = await signed(new Transaction().add(...swap.instructions, ...tx.instructions), [victim])
  await assert.rejects(submitRedemption(conn, redeemable(), withSwap, id, victimShipping), { status: 400, message: /not the redemption transaction/ })
  assert.equal(await vouchers(victim.publicKey), before)
  assert.equal(getPendingRedemption(id), undefined)
})

test('a burn that would fail is not sent and keeps nothing; an expired one asks for a new one', { skip }, async () => {
  const broke = Keypair.generate()
  await airdrop(broke.publicKey, 1)
  // An empty token account: the burn fails simulation.
  await send(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(broke.publicKey, getAssociatedTokenAddressSync(mint(), broke.publicKey), broke.publicKey, mint())), [broke], 'empty voucher account')
  const id = newRedemptionId()
  await assert.rejects(submitRedemption(conn, redeemable(), await signed(buildRedeemTx(broke.publicKey, mint(), id), [broke]), id, victimShipping), {
    status: 400,
    message: /not sent/,
  })
  assert.equal(getPendingRedemption(id), undefined)
  // A blockhash the cluster never handed out reads as expired, which the page answers by preparing again.
  const stale = buildRedeemTx(victim.publicKey, mint(), id)
  stale.feePayer = victim.publicKey
  stale.recentBlockhash = Keypair.generate().publicKey.toBase58()
  stale.sign(victim)
  await assert.rejects(submitRedemption(conn, redeemable(), stale.serialize(), id, victimShipping), { status: 400, message: /has expired/ })
  assert.equal(getPendingRedemption(id), undefined)
})

test('a wallet with too many unfinished redemptions finishes them first', { skip }, async () => {
  const rows = Array.from({ length: MAX_OPEN_REDEMPTIONS }, () => row(victim.publicKey))
  for (const r of rows) savePendingRedemption(r)
  const { id, tx } = await prepareRedemption(conn, redeemable(), victim.publicKey)
  await assert.rejects(submitRedemption(conn, redeemable(), await signed(tx, [victim]), id, victimShipping), { status: 429 })
  for (const r of rows) removePendingRedemption(r.id)
})

test('the pool’s creator cannot redeem, and a burn it signs never counts', { skip }, async () => {
  await assert.rejects(prepareRedemption(conn, redeemable(), maker.publicKey), { status: 409, message: /maker/ })
  const id = newRedemptionId()
  await assert.rejects(submitRedemption(conn, redeemable(), await signed(buildRedeemTx(maker.publicKey, mint(), id), [maker]), id, victimShipping), {
    status: 409,
    message: /maker/,
  })
  // Should such a burn land anyway, it does not verify, and confirming it drops its row.
  const sig = await send(conn, buildRedeemTx(maker.publicKey, mint(), id), [maker], 'creator burns with a memo')
  const r = row(maker.publicKey, { id, signature: sig })
  savePendingRedemption(r)
  await assert.rejects(confirmRedemption(conn, id, sig), { status: 400, message: /creator signed/ })
  assert.equal(getPendingRedemption(id), undefined, 'a burn that can never count is not offered again')
  // The creator paying the fee for a backer's burn is refused as well.
  const backer = row(victim.publicKey)
  const cosigned = await send(conn, buildRedeemTx(victim.publicKey, mint(), backer.id), [maker, victim], 'backer burn with the creator as fee payer')
  await assert.rejects(verifyRedeemBurn(conn, redeemable(), backer, cosigned, maker.publicKey), { status: 400, message: /creator signed/ })
})

test('landed burns that are not redemptions never count', { skip }, async () => {
  const p = row(victim.publicKey)
  const ata = getAssociatedTokenAddressSync(mint(), victim.publicKey)
  const plain = await send(conn, new Transaction().add(createBurnInstruction(ata, mint(), victim.publicKey, BigInt(1e6))), [victim], 'plain burn')
  await assert.rejects(verifyRedeemBurn(conn, redeemable(), p, plain, maker.publicKey), { status: 400, message: /not made for this redemption/ })
  const two = await send(conn, buildRedeemTx(victim.publicKey, mint(), p.id, 2), [victim], 'burn 2 for a 1-unit redemption')
  await assert.rejects(verifyRedeemBurn(conn, redeemable(), p, two, maker.publicKey), { status: 400, message: /exactly 1 whole voucher/ })
  const swap = await buildResaleSwapTx(conn, redeemable(), victim.publicKey, 'buy', 1)
  const withSwap = await send(conn, new Transaction().add(...swap.instructions, ...buildRedeemTx(victim.publicKey, mint(), p.id).instructions), [victim], 'resale buy + burn with memo')
  await assert.rejects(verifyRedeemBurn(conn, redeemable(), p, withSwap, maker.publicKey), { status: 400, message: /pool liquidity/ })
})

test('a burn whose order was not recorded is found again by its signature and finished', { skip }, async () => {
  const before = listRedemptionViews(record.pool).length
  // As submit leaves it when the server loses the confirmation: the row is kept, then the burn lands.
  const { id, tx } = await prepareRedemption(conn, redeemable(), victim.publicKey)
  const latest = await conn.getLatestBlockhash('confirmed')
  tx.feePayer = victim.publicKey
  tx.recentBlockhash = latest.blockhash
  tx.sign(victim)
  const sig = bs58.encode(tx.signature!)
  const landed = row(victim.publicKey, { id, signature: sig, lastValidBlockHeight: latest.lastValidBlockHeight })
  savePendingRedemption(landed)
  await conn.confirmTransaction({ signature: await conn.sendRawTransaction(tx.serialize()), ...latest }, 'confirmed')
  // A row whose burn was never sent and has expired, and one whose burn failed on-chain: nothing burned.
  const height = await conn.getBlockHeight('confirmed')
  const expired = row(victim.publicKey, { lastValidBlockHeight: height - 1 })
  savePendingRedemption(expired)
  const tooMany = buildRedeemTx(victim.publicKey, mint(), newRedemptionId(), 1000)
  const failedLatest = await conn.getLatestBlockhash('confirmed')
  tooMany.feePayer = victim.publicKey
  tooMany.recentBlockhash = failedLatest.blockhash
  tooMany.sign(victim)
  const failedSig = await conn.sendRawTransaction(tooMany.serialize(), { skipPreflight: true })
  await conn.confirmTransaction({ signature: failedSig, ...failedLatest }, 'confirmed')
  const failed = row(victim.publicKey, { signature: failedSig, lastValidBlockHeight: failedLatest.lastValidBlockHeight })
  savePendingRedemption(failed)
  // Dust into the victim's voucher account with a memo naming the row: it is not the burn sent for it.
  const dust = new Transaction().add(
    createTransferInstruction(getAssociatedTokenAddressSync(mint(), attacker.publicKey), getAssociatedTokenAddressSync(mint(), victim.publicKey), attacker.publicKey, 1),
    new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(REDEEM_MEMO_PREFIX + expired.id) }),
  )
  await send(conn, dust, [attacker], 'dust with a redeem memo')

  const unfinished = await findUnfinishedRedemptions(conn, redeemable(), victim.publicKey)
  assert.deepEqual(unfinished, [{ id, signature: sig, units: 1, createdAt: landed.createdAt }])
  assert.deepEqual(listPendingRedemptions(record.pool, victim.publicKey.toBase58()).map((p) => p.id), [id], 'the expired and failed rows are dropped')
  assert.equal((await findUnfinishedRedemptions(conn, redeemable(), attacker.publicKey)).length, 0)
  await confirmRedemption(conn, id, sig)
  assert.equal(listRedemptionViews(record.pool).length, before + 1)
  assert.equal((await findUnfinishedRedemptions(conn, redeemable(), victim.publicKey)).length, 0)
})
