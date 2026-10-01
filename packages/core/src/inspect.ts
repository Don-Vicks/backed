// Read-only decoding of what a campaign put on-chain: its DBC config, its DBC pool and, once graduated,
// the DAMM v2 resale pool with every position and who holds it. Used by `pnpm --filter @preorder/core
// inspect <address>` and by the localnet tests to assert on fees, LP locks and vesting.
import BN from 'bn.js'
import { Connection, PublicKey } from '@solana/web3.js'
import {
  BaseFeeMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  MigrationFeeOption,
  MigrationOption,
  deriveDammV2PoolAddress,
  feeNumeratorToBps,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { dbcClient, resalePoolAddress } from './chain'
import { MIGRATION_FEE_OPTION, USDC_DECIMALS, VOUCHER_DECIMALS } from './engine'

const raw = (bn: BN | bigint) => bn.toString()
const ui = (bn: BN, decimals: number) => Number(bn.toString()) / 10 ** decimals
const enumName = (e: Record<string, string | number>, v: number) => (typeof e[v] === 'string' ? (e[v] as string) : String(v))
// Share of `part` in `whole` in percent, to 0.01%.
export const pctOf = (part: BN, whole: BN) => (whole.isZero() ? 0 : part.muln(10_000).div(whole).toNumber() / 100)

export type VestingView = {
  initialized: boolean
  vestingPercentage: number
  bpsPerPeriod: number
  numberOfPeriods: number
  frequencySec: number
  cliffSec: number
}

export type ConfigView = {
  address: string
  quoteMint: string
  feeClaimer: string
  leftoverReceiver: string
  baseFee: { mode: string; startBps: number; firstFactor: number; secondFactor: string; thirdFactor: string }
  dynamicFee: boolean
  collectFeeMode: number
  creatorTradingFeePct: number
  migrationOption: string
  migrationFeeOption: string
  migrationFee: { pct: number; creatorPct: number }
  goalUsdc: number
  supply: { preMigration: string; postMigration: string }
  lp: { partnerPct: number; partnerLockedPct: number; creatorPct: number; creatorLockedPct: number }
  partnerVesting: VestingView
  creatorVesting: VestingView
  tokenUpdateAuthority: number
}

export type PositionView = {
  position: string
  nftMint: string
  owner: string | null
  role: 'creator' | 'partner' | 'other'
  unlockedLiquidity: string
  vestedLiquidity: string
  permanentLockedLiquidity: string
  // Shares of the pool's total liquidity, in percent.
  sharePct: number
  permanentLockedPct: number
  vestedPct: number
}

export type ResalePoolView = { address: string; liquidity: string; permanentLockLiquidity: string; positions: PositionView[] }

export type PoolView = {
  address: string
  config: ConfigView
  creator: string
  baseMint: string
  quoteReserveUsdc: number
  baseReserveUnits: number
  migrated: boolean
  migrationFeeWithdrawStatus: number
  resale: ResalePoolView | null
}

function vestingView(v: PoolConfig['creatorLiquidityVestingInfo']): VestingView {
  return {
    initialized: v.isInitialized === 1,
    vestingPercentage: v.vestingPercentage,
    bpsPerPeriod: v.bpsPerPeriod,
    numberOfPeriods: v.numberOfPeriods,
    frequencySec: v.frequency,
    cliffSec: v.cliffDurationFromMigrationTime,
  }
}

export function configView(address: PublicKey, c: PoolConfig): ConfigView {
  const base = c.poolFees.baseFee
  return {
    address: address.toBase58(),
    quoteMint: c.quoteMint.toBase58(),
    feeClaimer: c.feeClaimer.toBase58(),
    leftoverReceiver: c.leftoverReceiver.toBase58(),
    baseFee: {
      mode: enumName(BaseFeeMode, base.baseFeeMode),
      startBps: feeNumeratorToBps(base.cliffFeeNumerator),
      firstFactor: base.firstFactor,
      secondFactor: raw(base.secondFactor),
      thirdFactor: raw(base.thirdFactor),
    },
    dynamicFee: c.poolFees.dynamicFee.initialized === 1,
    collectFeeMode: c.collectFeeMode,
    creatorTradingFeePct: c.creatorTradingFeePercentage,
    migrationOption: enumName(MigrationOption, c.migrationOption),
    migrationFeeOption: enumName(MigrationFeeOption, c.migrationFeeOption),
    migrationFee: { pct: c.migrationFeePercentage, creatorPct: c.creatorMigrationFeePercentage },
    goalUsdc: ui(c.migrationQuoteThreshold, USDC_DECIMALS),
    supply: { preMigration: raw(c.preMigrationTokenSupply), postMigration: raw(c.postMigrationTokenSupply) },
    lp: {
      partnerPct: c.partnerLiquidityPercentage,
      partnerLockedPct: c.partnerPermanentLockedLiquidityPercentage,
      creatorPct: c.creatorLiquidityPercentage,
      creatorLockedPct: c.creatorPermanentLockedLiquidityPercentage,
    },
    partnerVesting: vestingView(c.partnerLiquidityVestingInfo),
    creatorVesting: vestingView(c.creatorLiquidityVestingInfo),
    tokenUpdateAuthority: c.tokenUpdateAuthority,
  }
}

// Holder of a position NFT (supply 1): the owner of its largest token account.
async function nftOwner(connection: Connection, mint: PublicKey): Promise<string | null> {
  const largest = await connection.getTokenLargestAccounts(mint).catch(() => null)
  const holder = largest?.value.find((a) => a.uiAmount === 1)
  if (!holder) return null
  const info = await connection.getParsedAccountInfo(holder.address)
  const data = info.value?.data
  return data && 'parsed' in data ? (data.parsed.info.owner as string) : null
}

export async function inspectResalePool(
  connection: Connection,
  address: PublicKey,
  roles: { creator?: string; partner?: string } = {},
): Promise<ResalePoolView | null> {
  const cpAmm = new CpAmm(connection)
  const pool = await cpAmm.fetchPoolState(address).catch(() => null)
  if (!pool) return null
  const positions = await cpAmm.getAllPositionsByPool(address)
  const views = await Promise.all(
    positions.map(async ({ publicKey, account: p }): Promise<PositionView> => {
      const owner = await nftOwner(connection, p.nftMint)
      const total = p.unlockedLiquidity.add(p.vestedLiquidity).add(p.permanentLockedLiquidity)
      return {
        position: publicKey.toBase58(),
        nftMint: p.nftMint.toBase58(),
        owner,
        role: owner && owner === roles.creator ? 'creator' : owner && owner === roles.partner ? 'partner' : 'other',
        unlockedLiquidity: raw(p.unlockedLiquidity),
        vestedLiquidity: raw(p.vestedLiquidity),
        permanentLockedLiquidity: raw(p.permanentLockedLiquidity),
        sharePct: pctOf(total, pool.liquidity),
        permanentLockedPct: pctOf(p.permanentLockedLiquidity, pool.liquidity),
        vestedPct: pctOf(p.vestedLiquidity, pool.liquidity),
      }
    }),
  )
  views.sort((a, b) => b.sharePct - a.sharePct)
  return { address: address.toBase58(), liquidity: raw(pool.liquidity), permanentLockLiquidity: raw(pool.permanentLockLiquidity), positions: views }
}

// The DAMM v2 pool a DBC pool graduates into, from the migration fee option in its own config, so pools
// created under an earlier option still resolve after MIGRATION_FEE_OPTION changes.
export function resalePoolAddressFor(config: Pick<PoolConfig, 'migrationFeeOption' | 'quoteMint'>, baseMint: PublicKey): PublicKey {
  const option = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption] ? config.migrationFeeOption : MIGRATION_FEE_OPTION
  return resalePoolAddress(baseMint, config.quoteMint, option)
}

export async function inspectDbcPool(connection: Connection, address: PublicKey): Promise<PoolView> {
  const client = dbcClient(connection)
  const virtualPool = await client.state.getPool(address)
  if (!virtualPool) throw new Error(`${address.toBase58()} is not a DBC pool`)
  const s = virtualPool.poolState
  const config = await client.state.getPoolConfig(s.config)
  if (!config) throw new Error(`config ${s.config.toBase58()} not found`)
  const migrated = s.isMigrated === 1
  const resale = migrated
    ? await inspectResalePool(connection, resalePoolAddressFor(config, s.baseMint), {
        creator: s.creator.toBase58(),
        partner: config.feeClaimer.toBase58(),
      })
    : null
  return {
    address: address.toBase58(),
    config: configView(s.config, config),
    creator: s.creator.toBase58(),
    baseMint: s.baseMint.toBase58(),
    quoteReserveUsdc: ui(s.quoteReserve, USDC_DECIMALS),
    baseReserveUnits: ui(s.baseReserve, VOUCHER_DECIMALS),
    migrated,
    migrationFeeWithdrawStatus: s.migrationFeeWithdrawStatus,
    resale,
  }
}

export type Inspected =
  | { kind: 'dbc-pool'; pool: PoolView }
  | { kind: 'dbc-config'; config: ConfigView }
  | { kind: 'damm-v2-pool'; pool: ResalePoolView }

// Works out what the address is from its owner program and decodes it.
export async function inspectAddress(connection: Connection, address: PublicKey): Promise<Inspected> {
  const info = await connection.getAccountInfo(address)
  if (!info) throw new Error(`${address.toBase58()} not found on ${connection.rpcEndpoint}`)
  if (info.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) {
    const config = await dbcClient(connection).state.getPoolConfig(address).catch(() => null)
    if (config) return { kind: 'dbc-config', config: configView(address, config) }
    return { kind: 'dbc-pool', pool: await inspectDbcPool(connection, address) }
  }
  if (info.owner.equals(DAMM_V2_PROGRAM_ID)) {
    const pool = await inspectResalePool(connection, address)
    if (pool) return { kind: 'damm-v2-pool', pool }
  }
  throw new Error(`${address.toBase58()} is not a DBC config, DBC pool or DAMM v2 pool (owner ${info.owner.toBase58()})`)
}
