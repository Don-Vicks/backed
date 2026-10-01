// What a local validator needs from mainnet to run Backed: the programs and the DAMM v2 migration
// configs, all read from the DBC SDK so a new SDK constant is picked up without editing a list.
// scripts/localnet/start.sh and dump.sh get these through `src/scripts/localnet-accounts.ts`.
// seedLocalnet() then fills a running validator with wallets and a mock USDC.
import fs from 'fs'
import path from 'path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMint, createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  LOCKER_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
  deriveDbcPoolAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { USDC_DECIMALS } from './engine'

// Upgradeable programs, cloned with their program data.
export const LOCALNET_PROGRAMS: Record<string, PublicKey> = {
  dbc: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  dammV2: DAMM_V2_PROGRAM_ID,
  metaplex: METAPLEX_PROGRAM_ID,
  locker: LOCKER_PROGRAM_ID,
}

// Every DAMM v2 migration config (one per MigrationFeeOption, Customizable included).
export const LOCALNET_ACCOUNTS: PublicKey[] = DAMM_V2_MIGRATION_FEE_ADDRESS.map((a) => new PublicKey(a))

// Pays rent for the DAMM v2 pool and positions during migration: a fresh validator must fund it,
// or migrateToDammV2 fails with "insufficient lamports".
export const DBC_POOL_AUTHORITY: PublicKey = deriveDbcPoolAuthority()

// A ready-to-use localnet world in `root` (a PREORDER_ROOT): fresh keys for every role, SOL for all of
// them, a mock USDC mint whose authority is the platform key (the faucet mints with it), 1000 USDC for
// each backer and an env file the scripts, the web server and tests can load. The maker and the
// referrer get no USDC account, as for a fresh wallet. Never reuses keys, so runs can share a validator.
export const SEED_ROLES = ['platform', 'maker', 'backer1', 'backer2', 'backer3', 'referrer'] as const
export type SeedRole = (typeof SEED_ROLES)[number]
export type Seeded = { root: string; envFile: string; rpcUrl: string; wallets: Record<SeedRole, Keypair>; usdcMint: PublicKey }

const SEED_SOL: Record<SeedRole, number> = { platform: 100, maker: 10, backer1: 10, backer2: 10, backer3: 10, referrer: 1 }
export const SEED_BACKER_USDC = 1000

export async function airdrop(connection: Connection, to: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL)
  const latest = await connection.getLatestBlockhash('confirmed')
  await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
}

export async function seedLocalnet(connection: Connection, root: string): Promise<Seeded> {
  const keys = path.join(root, 'keys', 'localnet')
  fs.mkdirSync(keys, { recursive: true })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  const wallets = Object.fromEntries(SEED_ROLES.map((r) => [r, Keypair.generate()])) as Record<SeedRole, Keypair>
  for (const role of SEED_ROLES) {
    fs.writeFileSync(path.join(keys, `${role}.json`), JSON.stringify(Array.from(wallets[role].secretKey)), { mode: 0o600 })
  }
  await Promise.all(SEED_ROLES.map((r) => airdrop(connection, wallets[r].publicKey, SEED_SOL[r])))

  const { platform } = wallets
  const usdcMint = await createMint(connection, platform, platform.publicKey, null, USDC_DECIMALS)
  fs.writeFileSync(path.join(keys, 'mock-usdc.json'), JSON.stringify({ mint: usdcMint.toBase58() }, null, 2))
  const tx = new Transaction()
  for (const b of [wallets.backer1, wallets.backer2, wallets.backer3]) {
    const ata = getAssociatedTokenAddressSync(usdcMint, b.publicKey)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, ata, b.publicKey, usdcMint))
    tx.add(createMintToInstruction(usdcMint, ata, platform.publicKey, BigInt(SEED_BACKER_USDC * 10 ** USDC_DECIMALS)))
  }
  await sendAndConfirmTransaction(connection, tx, [platform], { commitment: 'confirmed' })

  const rpcUrl = connection.rpcEndpoint
  const envFile = path.join(root, '.env.localnet')
  const env = {
    NETWORK: 'localnet',
    LOCALNET_RPC_URL: rpcUrl,
    PREORDER_ROOT: root,
    DATA_DIR: path.join(root, 'data'),
    USDC_MINT: usdcMint.toBase58(),
    // Localnet wallets have no mainnet history: score them offline (tier C, or TRUST_FIXTURES).
    TRUST_RPC_URL: rpcUrl,
  }
  fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  return { root, envFile, rpcUrl, wallets, usdcMint }
}
