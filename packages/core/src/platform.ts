// The platform's side of every campaign. Backed is the DBC partner: each campaign's config names the
// platform's fee claimer, which earns the partner half of curve trading fees, owns the permanently
// locked partner position in the resale pool, and receives the leftover vouchers after graduation.
// This module reads what the platform is owed and builds the transactions that collect it. None of
// them needs the maker; every one is signed by the fee claimer the config names (a hot key, a cold
// wallet or a multisig), so the claim script can also print them unsigned.
import BN from 'bn.js'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, createBurnInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { CollectFeeMode as DammCollectFeeMode, CpAmm, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import { CollectFeeMode } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { dbcClient, resolveResalePool } from './chain'
import { USDC_DECIMALS, VOUCHER_DECIMALS } from './engine'
import type { CampaignRecord } from './store'
import { withdrawAmounts } from './unlock'

const toNum = (bn: BN, decimals: number) => Number(bn.toString()) / 10 ** decimals
const ZERO = new BN(0)

// Where claimed USDC goes when the program lets the claim name a receiver. Defaults to the fee claimer.
export function platformTreasury(env: NodeJS.ProcessEnv = process.env): PublicKey | undefined {
  const raw = env.PLATFORM_TREASURY?.trim()
  if (!raw) return undefined
  try {
    return new PublicKey(raw)
  } catch {
    throw new Error('PLATFORM_TREASURY is not a valid Solana address')
  }
}

// What a campaign's DBC config says about the partner. Configs are immutable, so cached: a later
// change of PLATFORM_FEE_CLAIMER only applies to campaigns created after it.
export type PartnerTerms = {
  feeClaimer: PublicKey
  leftoverReceiver: PublicKey
  migrationQuoteThreshold: BN
  creatorTradingFeePct: number // the maker's share of curve trading fees; the partner gets the rest
  migrationFeePct: number // share of the raise paid out at graduation (the maker's upfront share)
  creatorMigrationFeePct: number // the maker's part of that payout; the partner gets the rest
  quoteOnlyCurveFees: boolean // curve trading fees are taken in USDC only, never in vouchers
}

const termsCache = new Map<string, PartnerTerms>()

export async function readPartnerTerms(connection: Connection, config: PublicKey | string): Promise<PartnerTerms> {
  const key = config.toString()
  const hit = termsCache.get(key)
  if (hit) return hit
  const c = await dbcClient(connection).state.getPoolConfig(config)
  if (!c) throw new Error(`config ${key} not found`)
  const terms: PartnerTerms = {
    feeClaimer: c.feeClaimer,
    leftoverReceiver: c.leftoverReceiver,
    migrationQuoteThreshold: c.migrationQuoteThreshold,
    creatorTradingFeePct: c.creatorTradingFeePercentage,
    migrationFeePct: c.migrationFeePercentage,
    creatorMigrationFeePct: c.creatorMigrationFeePercentage,
    quoteOnlyCurveFees: c.collectFeeMode === CollectFeeMode.QuoteToken,
  }
  termsCache.set(key, terms)
  return terms
}

// The DBC pool fields the partner's money depends on (VirtualPool.poolState).
type PartnerPoolState = {
  quoteReserve: BN
  partnerQuoteFee: BN
  partnerBaseFee: BN
  creatorBaseFee: BN
  protocolBaseFee: BN
  protocolMigrationBaseFeeAmount: BN
  isMigrated: number
  isWithdrawLeftover: number
  isPartnerWithdrawSurplus: number
  migrationFeeWithdrawStatus: number
  metrics: { totalTradingQuoteFee: BN }
}

const PARTNER_MIGRATION_FEE_WITHDRAWN = 0b100 // migrationFeeWithdrawStatus: 0b10 creator, 0b100 partner

// Pure: the partner's curve trading fees, as getPoolFeeBreakdown splits them (raw USDC).
export function partnerCurveFees(pool: Pick<PartnerPoolState, 'partnerQuoteFee' | 'metrics'>, creatorTradingFeePct: number) {
  const total = pool.metrics.totalTradingQuoteFee
  const partnerTotal = total.sub(total.muln(creatorTradingFeePct).divn(100))
  return { unclaimed: pool.partnerQuoteFee, claimed: BN.max(partnerTotal.sub(pool.partnerQuoteFee), ZERO) }
}

// Pure: vouchers withdrawLeftover would pay out now (raw). After graduation the base vault also holds
// unclaimed base-side trading fees and Meteora's migration fee (verified on localnet: a vault of 9421
// raw paid a leftover of 2 and kept the 9419 protocol migration fee), so the leftover is what is left.
export function leftoverVouchers(pool: PartnerPoolState, baseVaultAmount: BN): BN {
  if (pool.isMigrated !== 1 || pool.isWithdrawLeftover !== 0) return ZERO
  const held = pool.partnerBaseFee.add(pool.creatorBaseFee).add(pool.protocolBaseFee).add(pool.protocolMigrationBaseFeeAmount)
  return BN.max(baseVaultAmount.sub(held), ZERO)
}

// Pure: USDC raised above the goal (raw), shared by partner, maker and Meteora. Backed's curves end at
// the goal and the last buy is a PartialFill, so this is 0 unless a trade elsewhere overshoots it; an
// ExactIn buy past the goal fails on chain (6033, measured on localnet).
export function poolSurplus(pool: Pick<PartnerPoolState, 'quoteReserve' | 'isPartnerWithdrawSurplus'>, migrationQuoteThreshold: BN): BN {
  if (pool.isPartnerWithdrawSurplus !== 0 || pool.quoteReserve.lte(migrationQuoteThreshold)) return ZERO
  return pool.quoteReserve.sub(migrationQuoteThreshold)
}

// Pure: the partner's part of the surplus (raw USDC). DBC keeps 20% for Meteora and splits the rest
// between maker and partner like the curve trading fees; the maker withdraws its part separately.
export function partnerSurplus(pool: Pick<PartnerPoolState, 'quoteReserve' | 'isPartnerWithdrawSurplus'>, terms: Pick<PartnerTerms, 'migrationQuoteThreshold' | 'creatorTradingFeePct'>): BN {
  const shared = poolSurplus(pool, terms.migrationQuoteThreshold).muln(80).divn(100)
  return shared.sub(shared.muln(terms.creatorTradingFeePct).divn(100))
}

// Pure: the partner's unwithdrawn part of the graduation payout (raw USDC). Backed gives the maker
// all of it (creatorFeePercentage 100), so this is 0 for every Backed config.
export function partnerMigrationFee(pool: Pick<PartnerPoolState, 'isMigrated' | 'migrationFeeWithdrawStatus'>, terms: PartnerTerms): BN {
  if (pool.isMigrated !== 1 || (pool.migrationFeeWithdrawStatus & PARTNER_MIGRATION_FEE_WITHDRAWN) !== 0) return ZERO
  const fee = terms.migrationQuoteThreshold.muln(terms.migrationFeePct).divn(100)
  return fee.sub(fee.muln(terms.creatorMigrationFeePct).divn(100))
}

export type PlatformCampaign = {
  pool: string
  name: string
  feeClaimer: string // from the campaign's config, not today's env
  migrated: boolean
  curveFeesUnclaimedUsdc: number
  curveFeesClaimedUsdc: number
  resalePool: string | null
  resaleFeesUnclaimedUsdc: number // the partner position's unclaimed resale-pool fees (USDC only)
  resaleLiquidityUsdc: number // the partner position at today's pool price: permanently locked
  resaleLiquidityVouchers: number
  leftoverVouchers: number // withdrawable now (and burned by the claim)
  leftoverUnburnedVouchers: number // withdrawn by someone else (anyone may) and still held by the leftover receiver
  surplusUsdc: number // the partner's share of what was raised above the goal
  migrationFeeUsdc: number
}

export type PlatformTotals = Omit<PlatformCampaign, 'pool' | 'name' | 'feeClaimer' | 'migrated' | 'resalePool'>

export type PlatformEarnings = {
  campaigns: PlatformCampaign[]
  failed: string[] // pools whose chain state could not be read
  totals: PlatformTotals
}

type Positions = Awaited<ReturnType<CpAmm['getPositionsByUser']>>

// DAMM v2 positions by owner and pool, each owner read once. The SDK finds an owner's positions by
// scanning all its Token-2022 accounts (getTokenAccountsByOwner, a heavy RPC call), and the fee
// claimer holds one position per graduated campaign: reading it per campaign would cost N scans of
// N positions. One reader per pass over the campaigns.
export type PositionReader = { cpAmm: CpAmm; positions: (owner: PublicKey, pool: PublicKey) => Promise<Positions> }

export function positionReader(connection: Connection): PositionReader {
  const cpAmm = new CpAmm(connection)
  const byOwner = new Map<string, Promise<Map<string, Positions>>>()
  const positions = async (owner: PublicKey, pool: PublicKey) => {
    const key = owner.toBase58()
    let byPool = byOwner.get(key)
    if (!byPool) {
      byPool = cpAmm.getPositionsByUser(owner).then((all) => {
        const grouped = new Map<string, Positions>()
        for (const p of all) {
          const k = p.positionState.pool.toBase58()
          grouped.set(k, [...(grouped.get(k) ?? []), p])
        }
        return grouped
      })
      byOwner.set(key, byPool)
      byPool.catch(() => byOwner.delete(key)) // a failed scan is retried by the next campaign
    }
    return (await byPool).get(pool.toBase58()) ?? []
  }
  return { cpAmm, positions }
}

type PartnerChain = {
  terms: PartnerTerms
  pool: PartnerPoolState
  baseVaultAmount: BN
  receiverVouchers: BN // after withdrawLeftover: the leftover receiver's balance of this campaign's vouchers
  resale: { address: PublicKey; cpAmm: CpAmm; state: Awaited<ReturnType<CpAmm['fetchPoolState']>>; positions: Positions } | null
}

async function tokenBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<BN> {
  const account = await getAccount(connection, getAssociatedTokenAddressSync(mint, owner, true)).catch(() => null)
  return new BN(account ? account.amount.toString() : '0')
}

async function readPartnerChain(connection: Connection, record: CampaignRecord, reader: PositionReader): Promise<PartnerChain> {
  const [virtualPool, terms] = await Promise.all([dbcClient(connection).state.getPool(record.pool), readPartnerTerms(connection, record.config)])
  if (!virtualPool) throw new Error(`pool ${record.pool} not found`)
  const pool = virtualPool.poolState as unknown as PartnerPoolState & { baseVault: PublicKey }
  const baseVaultAmount = pool.isMigrated === 1 ? new BN((await getAccount(connection, pool.baseVault)).amount.toString()) : ZERO
  const withdrawn = pool.isMigrated === 1 && pool.isWithdrawLeftover === 1
  const receiverVouchers = withdrawn ? await tokenBalance(connection, new PublicKey(record.baseMint), terms.leftoverReceiver) : ZERO
  let resale: PartnerChain['resale'] = null
  if (pool.isMigrated === 1) {
    const { cpAmm } = reader
    const address = await resolveResalePool(connection, record)
    const state = await cpAmm.fetchPoolState(address).catch(() => null)
    // DBC gives the partner's resale position to the config's fee claimer at graduation.
    if (state) resale = { address, cpAmm, state, positions: await reader.positions(terms.feeClaimer, address) }
  }
  return { terms, pool, baseVaultAmount, receiverVouchers, resale }
}

export async function readPlatformCampaign(connection: Connection, record: CampaignRecord, reader = positionReader(connection)): Promise<PlatformCampaign> {
  const { terms, pool, baseVaultAmount, receiverVouchers, resale } = await readPartnerChain(connection, record, reader)
  const curve = partnerCurveFees(pool, terms.creatorTradingFeePct)
  let resaleFees = ZERO
  let liquidity = ZERO
  for (const p of resale?.positions ?? []) {
    resaleFees = resaleFees.add(getUnClaimLpFee(resale!.state, p.positionState).feeTokenB)
    const s = p.positionState
    liquidity = liquidity.add(s.unlockedLiquidity).add(s.vestedLiquidity).add(s.permanentLockedLiquidity)
  }
  const value = resale ? withdrawAmounts(resale.cpAmm, resale.state, liquidity) : { outAmountA: ZERO, outAmountB: ZERO }
  return {
    pool: record.pool,
    name: record.campaign.name,
    feeClaimer: terms.feeClaimer.toBase58(),
    migrated: pool.isMigrated === 1,
    curveFeesUnclaimedUsdc: toNum(curve.unclaimed, USDC_DECIMALS),
    curveFeesClaimedUsdc: toNum(curve.claimed, USDC_DECIMALS),
    resalePool: resale ? resale.address.toBase58() : null,
    resaleFeesUnclaimedUsdc: toNum(resaleFees, USDC_DECIMALS),
    resaleLiquidityUsdc: toNum(value.outAmountB, USDC_DECIMALS),
    resaleLiquidityVouchers: toNum(value.outAmountA, VOUCHER_DECIMALS),
    leftoverVouchers: toNum(leftoverVouchers(pool, baseVaultAmount), VOUCHER_DECIMALS),
    leftoverUnburnedVouchers: toNum(receiverVouchers, VOUCHER_DECIMALS),
    surplusUsdc: toNum(partnerSurplus(pool, terms), USDC_DECIMALS),
    migrationFeeUsdc: toNum(partnerMigrationFee(pool, terms), USDC_DECIMALS),
  }
}

const TOTAL_KEYS = [
  'curveFeesUnclaimedUsdc',
  'curveFeesClaimedUsdc',
  'resaleFeesUnclaimedUsdc',
  'resaleLiquidityUsdc',
  'resaleLiquidityVouchers',
  'leftoverVouchers',
  'leftoverUnburnedVouchers',
  'surplusUsdc',
  'migrationFeeUsdc',
] as const satisfies readonly (keyof PlatformTotals)[]

// Pure: sums the per-campaign numbers.
export function platformTotals(campaigns: PlatformCampaign[]): PlatformTotals {
  const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0])) as PlatformTotals
  for (const c of campaigns) for (const k of TOTAL_KEYS) totals[k] += c[k]
  return totals
}

// Every campaign in the store, a few at a time so a long list doesn't burst the RPC. A campaign whose
// state can't be read is listed in `failed` instead of failing the whole view. The fee claimer's
// resale positions are read once for all of them.
export async function readPlatformEarnings(connection: Connection, records: CampaignRecord[], concurrency = 4): Promise<PlatformEarnings> {
  const campaigns: PlatformCampaign[] = []
  const failed: string[] = []
  const reader = positionReader(connection)
  for (let i = 0; i < records.length; i += concurrency) {
    const batch = records.slice(i, i + concurrency)
    const results = await Promise.allSettled(batch.map((r) => readPlatformCampaign(connection, r, reader)))
    results.forEach((r, j) => (r.status === 'fulfilled' ? campaigns.push(r.value) : failed.push(batch[j].pool)))
  }
  return { campaigns, failed, totals: platformTotals(campaigns) }
}

export type PlatformClaimKind = 'curveFees' | 'resaleFees' | 'leftover' | 'surplus' | 'migrationFee'

export type PlatformClaim = {
  kind: PlatformClaimKind
  label: string
  tx: Transaction // unsigned, no fee payer or blockhash yet
  signer: PublicKey // the config's fee claimer: signs and pays
  amount: BN // raw: USDC (the partner's share), or vouchers for leftover
}

// The transactions that collect everything the platform is owed on one campaign, one per claim (each
// fits a multisig proposal on its own), and none for a claim that is zero. USDC goes to `treasury`
// (default: the fee claimer) where the program allows a receiver; surplus and leftover always go to
// the config's fee claimer and leftover receiver. Leftover vouchers were never sold, so by default
// they are burned in the same transaction, like the maker's unlocked vouchers: voucher supply stays
// equal to the units the maker owes. withdrawLeftover is permissionless: when someone else called it
// first, the vouchers sit unburned with the leftover receiver and the claim burns them on their own.
// `reader` shares the fee claimer's position scan across campaigns.
export async function buildPlatformClaimTxs(
  connection: Connection,
  record: CampaignRecord,
  opts: { treasury?: PublicKey; burnLeftover?: boolean; reader?: PositionReader } = {},
): Promise<PlatformClaim[]> {
  const { terms, pool, baseVaultAmount, receiverVouchers, resale } = await readPartnerChain(connection, record, opts.reader ?? positionReader(connection))
  const client = dbcClient(connection)
  const feeClaimer = terms.feeClaimer
  const treasury = opts.treasury ?? feeClaimer
  const poolKey = new PublicKey(record.pool)
  const claims: PlatformClaim[] = []
  const add = (kind: PlatformClaimKind, label: string, tx: Transaction, amount: BN) => claims.push({ kind, label, tx, signer: feeClaimer, amount })

  if (pool.partnerQuoteFee.gtn(0) || pool.partnerBaseFee.gtn(0)) {
    const tx = await client.partner.claimPartnerTradingFeeToReceiver({
      feeClaimer,
      payer: feeClaimer,
      pool: poolKey,
      maxBaseAmount: pool.partnerBaseFee,
      maxQuoteAmount: pool.partnerQuoteFee,
      receiver: treasury,
    })
    const vouchers = pool.partnerBaseFee.gtn(0) ? ` and ${pool.partnerBaseFee.toString()} raw vouchers` : ''
    add('curveFees', `claim partner curve trading fees${vouchers}`, tx, pool.partnerQuoteFee)
  }

  for (const p of resale?.positions ?? []) {
    const fee = getUnClaimLpFee(resale!.state, p.positionState)
    if (fee.feeTokenA.isZero() && fee.feeTokenB.isZero()) continue
    const s = resale!.state
    const tx = await resale!.cpAmm.claimPositionFee2({
      owner: feeClaimer,
      position: p.position,
      pool: resale!.address,
      positionNftAccount: p.positionNftAccount,
      tokenAMint: s.tokenAMint,
      tokenBMint: s.tokenBMint,
      tokenAVault: s.tokenAVault,
      tokenBVault: s.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      receiver: treasury,
      feePayer: feeClaimer,
    })
    add('resaleFees', 'claim partner resale-pool fees', tx, fee.feeTokenB)
  }

  const leftover = leftoverVouchers(pool, baseVaultAmount)
  const burn = (opts.burnLeftover ?? true) && terms.leftoverReceiver.equals(feeClaimer)
  const baseMint = new PublicKey(record.baseMint)
  const burnIx = (amount: BN) => createBurnInstruction(getAssociatedTokenAddressSync(baseMint, feeClaimer, true), baseMint, feeClaimer, BigInt(amount.toString()))
  if (leftover.gtn(0)) {
    // Permissionless; it always pays the config's leftover receiver.
    const tx = await client.migration.withdrawLeftover({ payer: feeClaimer, pool: poolKey })
    if (burn) tx.add(burnIx(leftover))
    add('leftover', burn ? 'withdraw and burn leftover vouchers' : 'withdraw leftover vouchers', tx, leftover)
  } else if (burn && receiverVouchers.gtn(0) && earnsNoVouchers(terms, resale?.state)) {
    // Withdrawn earlier by someone else. Burning the claimer's whole balance of this campaign's
    // vouchers is safe only while it earns none as fees; it must not hold any for another reason.
    add('leftover', 'burn leftover vouchers withdrawn earlier', new Transaction().add(burnIx(receiverVouchers)), receiverVouchers)
  }

  const total = poolSurplus(pool, terms.migrationQuoteThreshold)
  const surplus = partnerSurplus(pool, terms)
  if (surplus.gtn(0)) {
    const tx = await client.partner.partnerWithdrawSurplus({ feeClaimer, pool: poolKey })
    add('surplus', `withdraw partner surplus (partner share of ${total.toString()} raw)`, tx, surplus)
  }

  const migrationFee = partnerMigrationFee(pool, terms)
  if (migrationFee.gtn(0)) add('migrationFee', 'withdraw partner migration fee', await client.partner.partnerWithdrawMigrationFee({ pool: poolKey, sender: feeClaimer }), migrationFee)

  return claims
}

// Pure: whether the fee claimer can never be paid vouchers as fees, so any it holds of a graduated
// campaign's mint came from withdrawLeftover. Curve fees and resale-pool fees both in USDC only.
export function earnsNoVouchers(terms: Pick<PartnerTerms, 'quoteOnlyCurveFees'>, resaleState: { collectFeeMode: number } | null | undefined): boolean {
  return terms.quoteOnlyCurveFees && resaleState?.collectFeeMode === DammCollectFeeMode.OnlyB
}
