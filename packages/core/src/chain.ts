// Transaction builders shared by the scripts and the web app. Each returns an unsigned Transaction
// (plus any extra signers), so the web app can hand it to a wallet and the scripts can sign locally.
import fs from 'fs'
import path from 'path'
import BN from 'bn.js'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { createBurnInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  SwapMode,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
  type PoolConfig,
  type SwapQuote2Params,
  type SwapQuote2Result,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { getNetwork } from './network'
import { SwapError, chainNow, slippageBps, toRawAmount, toSwapError } from './swaps'
import { keysDir, platformFeeClaimer } from './wallets'
import { LEGACY_MIGRATION_FEE_OPTION, USDC_DECIMALS, VOUCHER_DECIMALS, campaignToConfig, type Campaign } from './engine'
import { resalePoolFeeBps } from './royalty'
import type { CampaignRecord } from './store'
import type { TrustTierName } from './trust'

// Both throw a 400 SwapError for non-finite or oversized amounts rather than a bn.js assertion.
export const toUsdcRaw = (usdc: number) => toRawAmount(usdc, USDC_DECIMALS)
export const toVoucherRaw = (units: number) => toRawAmount(units, VOUCHER_DECIMALS)

const mockUsdcPath = () => path.join(keysDir(), 'mock-usdc.json')

// Mainnet: real USDC. Devnet/localnet: USDC_MINT, else the mock mint created by the lifecycle script.
export function getUsdcMint(): PublicKey {
  const net = getNetwork()
  const fromEnv = process.env.USDC_MINT?.trim()
  if (net.usdcMint) {
    // A stray devnet mint in a mainnet env must not silently price campaigns in a fake token.
    if (fromEnv && fromEnv !== net.usdcMint.toBase58()) throw new Error('USDC_MINT must be unset or real USDC on mainnet')
    return net.usdcMint
  }
  if (fromEnv) return new PublicKey(fromEnv)
  if (!fs.existsSync(mockUsdcPath())) throw new Error(`No mock USDC mint yet: set USDC_MINT or run \`pnpm core:lifecycle\` once on ${net.name}`)
  return new PublicKey(JSON.parse(fs.readFileSync(mockUsdcPath(), 'utf8')).mint)
}

export function saveMockUsdcMint(mint: PublicKey) {
  fs.mkdirSync(keysDir(), { recursive: true })
  fs.writeFileSync(mockUsdcPath(), JSON.stringify({ mint: mint.toBase58() }, null, 2))
}

export function dbcClient(connection: Connection) {
  return new DynamicBondingCurveClient(connection, 'confirmed')
}

// What a DBC config says about the resale pool it graduates into. The migrationFeeOption picks the
// DAMM v2 config the pool migrates into, and with it the pool's address. Configs are immutable, so cached.
export type ResaleConfig = { migrationFeeOption: MigrationFeeOption; poolFeeBps: number; dynamicFee: boolean }

const resaleConfigCache = new Map<string, ResaleConfig>()

export async function readResaleConfig(connection: Connection, config: PublicKey | string): Promise<ResaleConfig> {
  const key = config.toString()
  const hit = resaleConfigCache.get(key)
  if (hit) return hit
  const c = await dbcClient(connection).state.getPoolConfig(config)
  if (!c) throw new Error(`config ${key} not found`)
  const migrationFeeOption = c.migrationFeeOption as MigrationFeeOption
  // Customizable: the DBC config says whether the volatility fee is on. A fixed option: the DAMM v2
  // config it migrates into does; if that read fails, claim no volatility fee and don't cache.
  const dynamicFee =
    migrationFeeOption === MigrationFeeOption.Customizable
      ? c.migratedDynamicFee === 1
      : await fixedOptionDynamicFee(connection, migrationFeeOption).catch(() => null)
  const out: ResaleConfig = {
    migrationFeeOption,
    poolFeeBps: resalePoolFeeBps(migrationFeeOption, c.migratedPoolFeeBps),
    dynamicFee: dynamicFee ?? false,
  }
  if (dynamicFee !== null) resaleConfigCache.set(key, out)
  return out
}

async function fixedOptionDynamicFee(connection: Connection, migrationFeeOption: MigrationFeeOption): Promise<boolean> {
  const damm = await new CpAmm(connection).fetchConfigState(dammV2MigrationConfig(migrationFeeOption))
  return damm.poolFees.dynamicFee.initialized !== 0
}

export function dammV2MigrationConfig(migrationFeeOption: MigrationFeeOption): PublicKey {
  const config = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption]
  if (!config) throw new Error(`no DAMM v2 migration config for fee option ${migrationFeeOption}`)
  return config
}

export function resalePoolAddress(baseMint: PublicKey, usdcMint: PublicKey, migrationFeeOption: MigrationFeeOption) {
  return deriveDammV2PoolAddress(dammV2MigrationConfig(migrationFeeOption), baseMint, usdcMint)
}

// A campaign's resale pool, from its on-chain config. The option stored on the record (and, for
// records older than that field, the fixed 2% every earlier campaign used) only stands in when the
// config can't be read.
export async function resolveResalePool(connection: Connection, record: Pick<CampaignRecord, 'config' | 'baseMint' | 'usdcMint' | 'migrationFeeOption'>) {
  const option = await readResaleConfig(connection, record.config).then(
    (c) => c.migrationFeeOption,
    () => record.migrationFeeOption ?? LEGACY_MIGRATION_FEE_OPTION,
  )
  return resalePoolAddress(new PublicKey(record.baseMint), new PublicKey(record.usdcMint), option)
}

// Creates a fresh config AND the pool on it. The maker pays and signs; the platform key never signs
// (feeClaimer and leftoverReceiver are plain accounts), so a create costs the platform nothing.
// The server-generated config and mint keys sign too, which is what ties the pool to these terms.
export async function buildCreateCampaignTx(args: {
  connection: Connection
  campaign: Campaign
  tier: TrustTierName
  maker: PublicKey
  usdcMint: PublicKey
}) {
  const { params, pricing, onChain, fields } = campaignToConfig(args.campaign, args.tier)
  const config = Keypair.generate()
  const baseMint = Keypair.generate()
  // Configs are immutable, so fees and leftover go to the configured claimer from the first campaign.
  const feeClaimer = platformFeeClaimer()
  const tx = await dbcClient(args.connection).partner.createConfigAndPool({
    ...params,
    config: config.publicKey,
    feeClaimer,
    leftoverReceiver: feeClaimer,
    quoteMint: args.usdcMint,
    payer: args.maker,
    preCreatePoolParam: {
      name: args.campaign.name,
      symbol: args.campaign.symbol,
      uri: args.campaign.uri,
      poolCreator: args.maker,
      baseMint: baseMint.publicKey,
    },
  })
  const pool = deriveDbcPoolAddress(args.usdcMint, baseMint.publicKey, config.publicKey)
  return { tx, extraSigners: [config, baseMint], config: config.publicKey, baseMint: baseMint.publicKey, pool, pricing, onChain, fields }
}

// Largest create transaction handed to a wallet: the 1232-byte packet limit minus 16 bytes of headroom.
export const MAX_CREATE_TX_BYTES = 1216

// Wire size of a transaction once every required signature is present.
export function serializedTxSize(tx: Transaction): number {
  const message = tx.compileMessage()
  const signatures = message.header.numRequiredSignatures // < 128, so a 1-byte length prefix
  return 1 + 64 * signatures + message.serialize().length
}

export type CreateStep = { tx: Transaction; signers: Keypair[] }

// The create as the wallet signs it: one atomic transaction when config + pool fit (with room for a
// priority fee), else createConfig then createPool. The wallet signs both at once
// (signAllTransactions) and the client sends them in that order; each tier adds 32 bytes of curve.
export function createCampaignSteps(built: { tx: Transaction; config: PublicKey; extraSigners: Keypair[] }, payer: PublicKey): CreateStep[] {
  const probe = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...built.tx.instructions)
  probe.feePayer = payer
  probe.recentBlockhash = PublicKey.default.toBase58()
  if (serializedTxSize(probe) <= MAX_CREATE_TX_BYTES) return [{ tx: built.tx, signers: built.extraSigners }]
  const signs = (ix: Transaction['instructions'][number], key: PublicKey) => ix.keys.some((k) => k.isSigner && k.pubkey.equals(key))
  const step = (ixs: Transaction['instructions']): CreateStep => ({
    tx: new Transaction().add(...ixs),
    signers: built.extraSigners.filter((kp) => ixs.some((ix) => signs(ix, kp.publicKey))),
  })
  return [
    step(built.tx.instructions.filter((ix) => signs(ix, built.config))),
    step(built.tx.instructions.filter((ix) => !signs(ix, built.config))),
  ]
}

// The pool step again, for a split create whose config landed but whose pool did not (expired, failed,
// or the maker gave up): a createPool on that existing config with a fresh mint key, so the maker
// keeps the config they paid for. The pool address follows the new mint.
export async function buildCreatePoolTx(args: {
  connection: Connection
  config: PublicKey
  campaign: Pick<Campaign, 'name' | 'symbol' | 'uri'>
  maker: PublicKey
  usdcMint: PublicKey
}) {
  const baseMint = Keypair.generate()
  const tx = await dbcClient(args.connection).creator.createPool({
    config: args.config,
    baseMint: baseMint.publicKey,
    name: args.campaign.name,
    symbol: args.campaign.symbol,
    uri: args.campaign.uri,
    payer: args.maker,
    poolCreator: args.maker,
  })
  const pool = deriveDbcPoolAddress(args.usdcMint, baseMint.publicKey, args.config)
  return { tx, extraSigners: [baseMint], baseMint: baseMint.publicKey, pool }
}

// Quote a curve swap against the live pool at the chain's clock, so the fee schedule matches
// what the program charges. Throws a SwapError the routes can show when the curve can't take it.
type CurveSwap = { swapBaseForQuote: boolean; hasReferral?: boolean; slippageBps?: number } & (
  | { swapMode: SwapMode.ExactIn | SwapMode.PartialFill; amountIn: BN }
  | { swapMode: SwapMode.ExactOut; amountOut: BN }
)

// The pool, its config and the chain clock its fee schedule runs on, read once per quote or build.
export type CurveState = { virtualPool: VirtualPool; config: PoolConfig; now: number }

// Pass the build's own client (swapClient) so the plan and the swap2 instruction share one read.
export async function readCurve(connection: Connection, pool: PublicKey | string, client: DynamicBondingCurveClient = swapClient(connection)): Promise<CurveState> {
  const [virtualPool, now] = await Promise.all([
    client.state.getPool(pool).catch((e) => {
      if (/discriminator/i.test(e instanceof Error ? e.message : '')) return null // some other account
      throw e
    }),
    chainNow(connection),
  ])
  if (!virtualPool) throw new SwapError('Campaign pool not found', 404)
  const config = await client.state.getPoolConfig(virtualPool.poolState.config)
  if (!config) throw new Error(`config ${virtualPool.poolState.config.toBase58()} not found`)
  return { virtualPool, config, now }
}

// Pass the build's own client (swapClient) so the quote and the swap share one read of the pool.
export async function quoteCurveSwap(
  connection: Connection,
  pool: PublicKey,
  swap: CurveSwap,
  client: DynamicBondingCurveClient = dbcClient(connection),
): Promise<SwapQuote2Result> {
  const { virtualPool, config, now } = await readCurve(connection, pool, client)
  try {
    return client.pool.swapQuote2({
      ...swap,
      virtualPool,
      config,
      hasReferral: swap.hasReferral ?? false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(now),
      slippageBps: slippageBps(swap.slippageBps),
    } as SwapQuote2Params)
  } catch (e) {
    throw toSwapError(e)
  }
}

// One client per swap build, with its pool and config reads shared: swap2 re-reads both through
// PoolService's own (protected) StateService, so point that at the same memoized one. The quote and
// the instruction then see the same state, and a build reads each account once instead of twice.
// If a later SDK moves that field, swap2 simply reads the accounts again.
export function swapClient(connection: Connection) {
  const client = dbcClient(connection)
  const state = client.state
  const pools = new Map<string, ReturnType<typeof state.getPool>>()
  const configs = new Map<string, ReturnType<typeof state.getPoolConfig>>()
  const getPool = state.getPool.bind(state)
  const getPoolConfig = state.getPoolConfig.bind(state)
  state.getPool = (address) => {
    const key = address.toString()
    if (!pools.has(key)) pools.set(key, getPool(address))
    return pools.get(key)!
  }
  state.getPoolConfig = (address) => {
    const key = address.toString()
    if (!configs.has(key)) configs.set(key, getPoolConfig(address))
    return configs.get(key)!
  }
  ;(client.pool as unknown as { state: typeof state }).state = state
  return client
}

export type SwapOptions = { referral?: PublicKey | null; slippageBps?: number }

// Back with USDC. PartialFill so the last buy stops exactly at the goal and refunds the rest;
// the quote's minimumAmountOut makes a front-run (or a stale quote) fail instead of filling worse.
export async function buildBuyTx(connection: Connection, buyer: PublicKey, pool: PublicKey, usdc: number, opts: SwapOptions = {}) {
  const referralTokenAccount = opts.referral ?? null
  const amountIn = toUsdcRaw(usdc)
  const client = swapClient(connection)
  const quote = await quoteCurveSwap(
    connection,
    pool,
    {
      swapBaseForQuote: false,
      swapMode: SwapMode.PartialFill,
      amountIn,
      hasReferral: !!referralTokenAccount,
      slippageBps: opts.slippageBps,
    },
    client,
  )
  if (!quote.minimumAmountOut?.gtn(0)) throw new SwapError('Amount is too small to buy any vouchers', 400)
  const tx = await client.pool.swap2({
    owner: buyer,
    pool,
    swapBaseForQuote: false,
    referralTokenAccount,
    swapMode: SwapMode.PartialFill,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut,
  })
  return { tx, quote }
}

// Exit on the curve: sell vouchersRaw back for USDC (ExactIn) with the quote's minimum.
export async function buildSellBackTx(connection: Connection, seller: PublicKey, pool: PublicKey, vouchersRaw: BN, opts: Omit<SwapOptions, 'referral'> = {}) {
  const client = swapClient(connection)
  const quote = await quoteCurveSwap(
    connection,
    pool,
    { swapBaseForQuote: true, swapMode: SwapMode.ExactIn, amountIn: vouchersRaw, slippageBps: opts.slippageBps },
    client,
  )
  if (!quote.minimumAmountOut?.gtn(0)) throw new SwapError('Amount is too small to sell', 400)
  const tx = await client.pool.swap2({
    owner: seller,
    pool,
    swapBaseForQuote: true,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn: vouchersRaw,
    minimumAmountOut: quote.minimumAmountOut,
  })
  return { tx, quote }
}

export async function buildMigrateTx(connection: Connection, payer: PublicKey, pool: PublicKey) {
  const virtualPool = await dbcClient(connection).state.getPool(pool)
  if (!virtualPool) throw new Error(`pool ${pool.toBase58()} not found`)
  const { migrationFeeOption } = await readResaleConfig(connection, virtualPool.poolState.config)
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbcClient(connection).migration.migrateToDammV2({
    payer,
    pool,
    dammConfig: dammV2MigrationConfig(migrationFeeOption),
  })
  return { tx: transaction, extraSigners: [firstPositionNftKeypair, secondPositionNftKeypair] }
}

export async function buildMakerWithdrawTx(connection: Connection, maker: PublicKey, pool: PublicKey) {
  return dbcClient(connection).creator.creatorWithdrawMigrationFee({ pool, sender: maker })
}

// SPL Memo v2. A memo instruction that lists an account fails unless that account signed.
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
export const REDEEM_MEMO_PREFIX = 'backed:redeem:'

// Redemption: burn whole vouchers, with a memo naming the pending redemption (which holds the shipping
// details) and signed by the owner. Only a burn carrying that memo can be claimed for those details,
// so a burn signature seen on-chain is useless to anyone with other shipping details.
export function buildRedeemTx(owner: PublicKey, baseMint: PublicKey, redemptionId: string, units = 1) {
  const ata = getAssociatedTokenAddressSync(baseMint, owner)
  return new Transaction().add(
    createBurnInstruction(ata, baseMint, owner, BigInt(units) * BigInt(10 ** VOUCHER_DECIMALS)),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
      data: Buffer.from(REDEEM_MEMO_PREFIX + redemptionId, 'utf8'),
    }),
  )
}
