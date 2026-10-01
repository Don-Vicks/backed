// The platform's (DBC partner's) side end to end on the local validator (mainnet DBC + DAMM v2
// binaries): earnings, claims to a treasury, leftover burn, the unsigned claim script, and the pool
// and partner listings.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import { CpAmm, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import { buildBuyTx, buildCreateCampaignTx, buildMigrateTx, dbcClient, resolveResalePool } from '../../chain'
import type { Campaign } from '../../engine'
import { buildPartnerMetadataTx, buildPoolMetadataTx, campaignListing, partnerListing, readPartnerListing, readPoolListing } from '../../metadata'
import { getNetwork } from '../../network'
import { buildPlatformClaimTxs, readPlatformEarnings } from '../../platform'
import { buildResaleSwapTx } from '../../resale'
import type { CampaignRecord } from '../../store'
import { send } from '../../tx'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
Object.assign(process.env, { NETWORK: 'localnet', VESTING_SCHEDULE_OVERRIDE: JSON.stringify({ cliffSec: 20, periods: 2, periodSec: 10, bpsPerPeriod: 2500 }) })

const POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')
const ORIGIN = 'https://backed.example'
const CORE = path.join(__dirname, '..', '..', '..')

let conn: Connection
const [platform, maker, backer, reseller, treasury] = Array.from({ length: 5 }, () => Keypair.generate())
let usdcMint: PublicKey
let record: CampaignRecord

async function airdrop(pk: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
}

async function balance(mint: PublicKey | string, owner: PublicKey) {
  const a = await getAccount(conn, getAssociatedTokenAddressSync(new PublicKey(mint), owner, true)).catch(() => null)
  return new BN(a ? a.amount.toString() : '0')
}

const supply = async () => new BN((await getMint(conn, new PublicKey(record.baseMint))).supply.toString())
const raw = (n: number) => Math.round(n * 1e6)

// Signs with whichever of the given keys the transaction actually needs (the payer of the create
// transaction is being moved from the platform to the maker in another change).
function neededSigners(tx: Transaction, keys: Keypair[]) {
  return keys.filter((k) => tx.instructions.some((ix) => ix.keys.some((m) => m.isSigner && m.pubkey.equals(k.publicKey))))
}

before(async () => {
  if (skip) return
  conn = new Connection(getNetwork().rpcUrl, 'confirmed')
  if ((await conn.getBalance(POOL_AUTHORITY)) < 1 * LAMPORTS_PER_SOL) await airdrop(POOL_AUTHORITY, 5)
  for (const k of [platform, maker, backer, reseller]) await airdrop(k.publicKey, 20)
  process.env.PLATFORM_FEE_CLAIMER = platform.publicKey.toBase58()
  usdcMint = await createMint(conn, platform, platform.publicKey, null, 6)
  const fund = new Transaction()
  for (const k of [backer, reseller]) {
    const ata = getAssociatedTokenAddressSync(usdcMint, k.publicKey)
    fund.add(createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, ata, k.publicKey, usdcMint), createMintToInstruction(usdcMint, ata, platform.publicKey, 1_000_000_000n))
  }
  await send(conn, fund, [platform], 'mint test USDC')

  const campaign: Campaign = {
    name: 'Partner Tee',
    symbol: 'PTEE',
    uri: 'https://example.com/p.json',
    image: 'https://example.com/partner-tee.png',
    plan: { tiers: [{ units: 3, startPrice: 4 }, { units: 4, startPrice: 5 }], finalPrice: 6, makerSharePct: 20 },
    dropBot: { startFeeBps: 500, windowSec: 10 },
    normalFeeBps: 100,
    shipDays: 30,
    resaleRoyaltyBps: 500,
  }
  const built = await buildCreateCampaignTx({ connection: conn, campaign, tier: 'A', platform: platform.publicKey, maker: maker.publicKey, usdcMint })
  await send(conn, built.tx, [...neededSigners(built.tx, [maker, platform]), ...built.extraSigners], 'create campaign')
  record = {
    pool: built.pool.toBase58(),
    config: built.config.toBase58(),
    baseMint: built.baseMint.toBase58(),
    usdcMint: usdcMint.toBase58(),
    maker: maker.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    createSignature: '',
    campaign,
    trust: { tier: 'A', score: 80, reasons: [], maxMakerSharePct: 40 },
    goalUsdc: built.onChain.goalUsdc,
    totalUnits: built.onChain.totalUnits,
    fields: built.fields,
    migrationFeeOption: built.onChain.migrationFeeOption,
  }
})

test('pool listing: the maker publishes it after create, and it reads back', { skip }, async () => {
  const tx = await buildPoolMetadataTx(conn, record, maker.publicKey, ORIGIN)
  assert.ok(tx)
  await send(conn, tx!, [maker], 'create pool listing')
  const listing = await readPoolListing(conn, record.pool)
  assert.deepEqual(listing, { name: 'Partner Tee', website: `${ORIGIN}/c/${record.pool}`, logo: 'https://example.com/partner-tee.png' })
  assert.deepEqual(listing, campaignListing(record, ORIGIN))
  assert.equal(await buildPoolMetadataTx(conn, record, maker.publicKey, ORIGIN), null, 'only once')
  // The same listing through the SDK's own reader.
  const viaSdk = await dbcClient(conn).state.getPoolMetadata(record.pool)
  assert.equal(viaSdk.length, 1)
  assert.equal(viaSdk[0].website, listing!.website)
})

test('partner listing: once per fee claimer', { skip }, async () => {
  const tx = await buildPartnerMetadataTx(conn, platform.publicKey, ORIGIN)
  assert.ok(tx)
  await send(conn, tx!, [platform], 'create partner listing')
  assert.deepEqual(await readPartnerListing(conn, platform.publicKey), partnerListing(ORIGIN))
  assert.equal(await buildPartnerMetadataTx(conn, platform.publicKey, ORIGIN), null)
})

test('earnings: curve fees, the partner resale position and leftover, all from chain', { skip, timeout: 120_000 }, async () => {
  await send(conn, await buildBuyTx(conn, backer.publicKey, new PublicKey(record.pool), record.goalUsdc * 1.3), [backer], 'buy to the goal')
  const mig = await buildMigrateTx(conn, platform.publicKey, new PublicKey(record.pool))
  await send(conn, mig.tx, [platform, ...mig.extraSigners], 'migrateToDammV2')
  await send(conn, await buildResaleSwapTx(conn, record, reseller.publicKey, 'buy', 3), [reseller], 'resale buy 3 USDC')

  const { campaigns, failed, totals } = await readPlatformEarnings(conn, [record, { ...record, pool: Keypair.generate().publicKey.toBase58() }])
  assert.equal(failed.length, 1, 'an unreadable pool is reported, not fatal')
  assert.equal(campaigns.length, 1)
  const c = campaigns[0]
  console.log(`    platform: ${JSON.stringify(c)}`)
  const vp = (await dbcClient(conn).state.getPool(record.pool))!.poolState
  assert.equal(c.feeClaimer, platform.publicKey.toBase58())
  assert.equal(c.migrated, true)
  assert.equal(raw(c.curveFeesUnclaimedUsdc), vp.partnerQuoteFee.toNumber())
  assert.ok(vp.partnerQuoteFee.gtn(0) && c.curveFeesClaimedUsdc === 0)

  const damm = await resolveResalePool(conn, record)
  assert.equal(c.resalePool, damm.toBase58())
  const cpAmm = new CpAmm(conn)
  const state = await cpAmm.fetchPoolState(damm)
  const [p] = await cpAmm.getUserPositionByPool(damm, platform.publicKey)
  assert.equal(raw(c.resaleFeesUnclaimedUsdc), getUnClaimLpFee(state, p.positionState).feeTokenB.toNumber())
  assert.ok(c.resaleFeesUnclaimedUsdc > 0)
  // 5% of the resale pool, permanently locked: worth about 5% of the pool's USDC side.
  const usdcInPool = Number((await getAccount(conn, state.tokenBVault)).amount) / 1e6
  assert.ok(Math.abs(c.resaleLiquidityUsdc / usdcInPool - 0.05) < 0.01, `platform liquidity ${c.resaleLiquidityUsdc} of ${usdcInPool}`)

  // Leftover = base vault minus Meteora's migration fee (and unclaimed base fees, none here).
  const vault = new BN((await getAccount(conn, vp.baseVault)).amount.toString())
  const protocolFee = (vp as unknown as { protocolMigrationBaseFeeAmount: BN }).protocolMigrationBaseFeeAmount
  assert.equal(raw(c.leftoverVouchers), vault.sub(protocolFee).toNumber())
  assert.equal(c.surplusUsdc, 0, 'PartialFill stops at the goal: no surplus')
  assert.equal(c.migrationFeeUsdc, 0, 'the maker takes the whole graduation payout')
  assert.equal(totals.curveFeesUnclaimedUsdc, c.curveFeesUnclaimedUsdc)
})

test('claims: USDC to the treasury, leftover withdrawn and burned, nothing left after', { skip, timeout: 60_000 }, async () => {
  const before = (await readPlatformEarnings(conn, [record])).campaigns[0]
  const claims = await buildPlatformClaimTxs(conn, record, { treasury: treasury.publicKey })
  const kinds = claims.map((c) => c.kind)
  assert.deepEqual(kinds, before.leftoverVouchers > 0 ? ['curveFees', 'resaleFees', 'leftover'] : ['curveFees', 'resaleFees'])
  for (const c of claims) assert.ok(c.signer.equals(platform.publicKey))

  const supply0 = await supply()
  for (const c of claims) await send(conn, c.tx, [platform], c.label)
  const toTreasury = await balance(usdcMint, treasury.publicKey)
  assert.equal(toTreasury.toNumber(), raw(before.curveFeesUnclaimedUsdc) + raw(before.resaleFeesUnclaimedUsdc))
  // Leftover vouchers were never sold: withdrawn and burned in one transaction.
  assert.equal(supply0.sub(await supply()).toNumber(), raw(before.leftoverVouchers))
  assert.ok((await balance(record.baseMint, platform.publicKey)).isZero())
  assert.ok((await balance(usdcMint, platform.publicKey)).isZero(), 'nothing claimed to the fee claimer itself')

  const after = (await readPlatformEarnings(conn, [record])).campaigns[0]
  assert.equal(after.curveFeesUnclaimedUsdc, 0)
  assert.equal(raw(after.curveFeesClaimedUsdc), raw(before.curveFeesUnclaimedUsdc))
  assert.equal(after.resaleFeesUnclaimedUsdc, 0)
  assert.equal(after.leftoverVouchers, 0)
  assert.equal(after.resaleLiquidityUsdc > 0, true, 'the permanent position stays')
  assert.deepEqual(await buildPlatformClaimTxs(conn, record), [])
})

test('the claim script prints unsigned base58 transactions when it does not hold the key', { skip, timeout: 120_000 }, async () => {
  await send(conn, await buildResaleSwapTx(conn, record, reseller.publicKey, 'buy', 2), [reseller], 'resale buy 2 USDC')
  const owed = (await readPlatformEarnings(conn, [record])).campaigns[0].resaleFeesUnclaimedUsdc
  assert.ok(owed > 0)

  // A root of its own: this record only, no keys/ directory, no PLATFORM_SECRET_KEY.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backed-claim-'))
  fs.mkdirSync(path.join(root, 'data'))
  fs.writeFileSync(path.join(root, 'data', 'campaigns.localnet.json'), JSON.stringify([record]))
  const env = { ...process.env, PREORDER_ROOT: root, NETWORK: 'localnet', PLATFORM_SECRET_KEY: '', PLATFORM_TREASURY: '' }
  const out = execFileSync(process.execPath, ['-r', 'ts-node/register', 'src/scripts/platform-claim.ts'], { cwd: CORE, env, encoding: 'utf8' })
  fs.rmSync(root, { recursive: true, force: true })
  console.log(out.replace(/^/gm, '    | '))
  const lines = out.split('\n')
  const printed = lines.flatMap((l, i) => (l.includes('unsigned: Partner Tee: claim partner resale-pool fees') ? [lines[i + 1].trim()] : []))
  assert.equal(printed.length, 1, 'one unsigned resale-fee claim')

  const tx = Transaction.from(bs58.decode(printed[0]))
  assert.ok(tx.feePayer!.equals(platform.publicKey))
  assert.ok(tx.signatures.every((s) => s.signature === null), 'unsigned')
  const usdc0 = await balance(usdcMint, platform.publicKey)
  await send(conn, tx, [platform], 'claim signed elsewhere')
  assert.equal((await balance(usdcMint, platform.publicKey)).sub(usdc0).toNumber(), raw(owed), 'no treasury set: to the fee claimer')
})
