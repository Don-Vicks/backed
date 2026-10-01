// Transaction builders shared by the scripts and the web app. Each returns an unsigned Transaction
// (plus any extra signers), so the web app can hand it to a wallet and the scripts can sign locally.
import fs from 'fs'
import path from 'path'
import BN from 'bn.js'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { createBurnInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  SwapMode,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
  type SwapQuote2Params,
  type SwapQuote2Result,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { getNetwork } from './network'
import { SwapError, chainNow, slippageBps, toRawAmount, toSwapError } from './swaps'
import { keysDir, platformFeeClaimer } from './wallets'
import { MIGRATION_FEE_OPTION, USDC_DECIMALS, VOUCHER_DECIMALS, campaignToConfig, type Campaign } from './engine'
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

export function resalePoolAddress(baseMint: PublicKey, usdcMint: PublicKey) {
  return deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION], baseMint, usdcMint)
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

// Quote a curve swap against the live pool at the chain's clock, so the fee schedule matches
// what the program charges. Throws a SwapError the routes can show when the curve can't take it.
type CurveSwap = { swapBaseForQuote: boolean; hasReferral?: boolean; slippageBps?: number } & (
  | { swapMode: SwapMode.ExactIn | SwapMode.PartialFill; amountIn: BN }
  | { swapMode: SwapMode.ExactOut; amountOut: BN }
)

// Pass the build's own client (swapClient) so the quote and the swap share one read of the pool.
export async function quoteCurveSwap(
  connection: Connection,
  pool: PublicKey,
  swap: CurveSwap,
  client: DynamicBondingCurveClient = dbcClient(connection),
): Promise<SwapQuote2Result> {
  const [virtualPool, now] = await Promise.all([
    client.state.getPool(pool).catch((e) => {
      if (/discriminator/i.test(e instanceof Error ? e.message : '')) return null // some other account
      throw e
    }),
    chainNow(connection),
  ])
  if (!virtualPool) throw new SwapError('Campaign pool not found', 404)
  const config = await client.state.getPoolConfig(virtualPool.poolState.config)
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
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbcClient(connection).migration.migrateToDammV2({
    payer,
    pool,
    dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION],
  })
  return { tx: transaction, extraSigners: [firstPositionNftKeypair, secondPositionNftKeypair] }
}

export async function buildMakerWithdrawTx(connection: Connection, maker: PublicKey, pool: PublicKey) {
  return dbcClient(connection).creator.creatorWithdrawMigrationFee({ pool, sender: maker })
}

// Redemption: burn exactly one whole voucher. The signature is the proof of claim.
export function buildRedeemTx(owner: PublicKey, baseMint: PublicKey) {
  const ata = getAssociatedTokenAddressSync(baseMint, owner)
  return new Transaction().add(createBurnInstruction(ata, baseMint, owner, BigInt(10 ** VOUCHER_DECIMALS)))
}
