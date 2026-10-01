import fs from 'fs'
import os from 'os'
import path from 'path'
import bs58 from 'bs58'
import { Keypair, PublicKey } from '@solana/web3.js'
import { getNetwork } from './network'
import { repoRoot } from './paths'

export const WALLET_ROLES = ['platform', 'maker', 'backer1', 'backer2', 'backer3'] as const
export type WalletRole = (typeof WALLET_ROLES)[number]

export function keysDir(): string {
  return path.join(repoRoot(), 'keys', getNetwork().name)
}

function keyPath(name: string): string {
  return path.join(keysDir(), `${name}.json`)
}

export function loadKeypairFile(file: string): Keypair {
  const resolved = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, 'utf8'))))
}

export function hasKeypair(name: string): boolean {
  const envName = KEY_ENV[name]
  return !!(envName && process.env[envName]?.trim()) || fs.existsSync(keyPath(name))
}

// A 64-byte secret key as a JSON byte array (solana-keygen format) or base58 (wallet export format).
export function parseSecretKey(raw: string): Keypair {
  const text = raw.trim()
  const bytes = text.startsWith('[') ? Uint8Array.from(JSON.parse(text) as number[]) : bs58.decode(text)
  if (bytes.length !== 64) throw new Error(`secret key must be 64 bytes, got ${bytes.length}`)
  return Keypair.fromSecretKey(bytes)
}

// Deployed servers have no keys/ directory, so the platform key can come from the environment.
const KEY_ENV: Partial<Record<string, string>> = { platform: 'PLATFORM_SECRET_KEY' }

export function loadKeypair(name: string): Keypair {
  const envName = KEY_ENV[name]
  const raw = envName ? process.env[envName] : undefined
  if (raw?.trim()) {
    try {
      return parseSecretKey(raw)
    } catch (e) {
      // Never echo the value itself.
      throw new Error(`${envName} is not a valid secret key: ${e instanceof Error ? e.message : e}`)
    }
  }
  return loadKeypairFile(keyPath(name))
}

// Receives DBC partner fees and leftover. Point it at a cold wallet or multisig on mainnet.
export function platformFeeClaimer(): PublicKey {
  const raw = process.env.PLATFORM_FEE_CLAIMER?.trim()
  if (!raw) return loadKeypair('platform').publicKey
  try {
    return new PublicKey(raw)
  } catch {
    throw new Error('PLATFORM_FEE_CLAIMER is not a valid Solana address')
  }
}

export function saveKeypair(name: string, kp: Keypair): void {
  fs.mkdirSync(keysDir(), { recursive: true })
  fs.writeFileSync(keyPath(name), JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 })
}

export function loadOrCreateKeypair(name: string): Keypair {
  if (hasKeypair(name)) return loadKeypair(name)
  const kp = Keypair.generate()
  saveKeypair(name, kp)
  return kp
}

export function loadWallets(): Record<WalletRole, Keypair> {
  return Object.fromEntries(WALLET_ROLES.map((r) => [r, loadKeypair(r)])) as Record<WalletRole, Keypair>
}

export function loadFunder(): Keypair {
  const file = process.env.FUNDER_KEYPAIR
  if (!file) throw new Error('FUNDER_KEYPAIR is not set in .env')
  return loadKeypairFile(file)
}
