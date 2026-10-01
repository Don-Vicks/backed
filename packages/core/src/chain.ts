// Transaction builders shared by the scripts and the web app. Each returns an unsigned Transaction
// (plus any extra signers), so the web app can hand it to a wallet and the scripts can sign locally.
import fs from 'fs'
import path from 'path'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { createBurnInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  SwapMode,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { getNetwork } from './network'
import { keysDir, platformFeeClaimer } from './wallets'
import { LEGACY_MIGRATION_FEE_OPTION, USDC_DECIMALS, VOUCHER_DECIMALS, campaignToConfig, type Campaign } from './engine'
import { resalePoolFeeBps } from './royalty'
import type { CampaignRecord } from './store'
import type { TrustTierName } from './trust'

export const toUsdcRaw = (usdc: number) => new BN(Math.round(usdc * 10 ** USDC_DECIMALS))
export const toVoucherRaw = (units: number) => new BN(Math.round(units * 10 ** VOUCHER_DECIMALS))

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
  const out: ResaleConfig = {
    migrationFeeOption,
    poolFeeBps: resalePoolFeeBps(migrationFeeOption, c.migratedPoolFeeBps),
    // The fixed DAMM v2 migration configs all have the dynamic fee on.
    dynamicFee: migrationFeeOption !== MigrationFeeOption.Customizable || c.migratedDynamicFee === 1,
  }
  resaleConfigCache.set(key, out)
  return out
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

// One transaction creates a fresh config AND the pool on it, signed by the platform key.
// A fresh config per campaign means no one can launch another pool on a campaign's terms.
export async function buildCreateCampaignTx(args: {
  connection: Connection
  campaign: Campaign
  tier: TrustTierName
  platform: PublicKey
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
    payer: args.platform,
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

export async function buildBuyTx(connection: Connection, buyer: PublicKey, pool: PublicKey, usdc: number, referralTokenAccount: PublicKey | null = null) {
  return dbcClient(connection).pool.swap2({
    owner: buyer,
    pool,
    swapBaseForQuote: false,
    referralTokenAccount,
    swapMode: SwapMode.PartialFill, // the last buy before the goal only fills up to the goal
    amountIn: toUsdcRaw(usdc),
    minimumAmountOut: new BN(0),
  })
}

export async function buildSellBackTx(connection: Connection, seller: PublicKey, pool: PublicKey, vouchersRaw: BN) {
  return dbcClient(connection).pool.swap({
    owner: seller,
    pool,
    amountIn: vouchersRaw,
    minimumAmountOut: new BN(0),
    swapBaseForQuote: true,
    referralTokenAccount: null,
  })
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

// Redemption: burn exactly one whole voucher. The signature is the proof of claim.
export function buildRedeemTx(owner: PublicKey, baseMint: PublicKey) {
  const ata = getAssociatedTokenAddressSync(baseMint, owner)
  return new Transaction().add(createBurnInstruction(ata, baseMint, owner, BigInt(10 ** VOUCHER_DECIMALS)))
}
