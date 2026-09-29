import fs from 'fs'
import os from 'os'
import path from 'path'
import { Keypair } from '@solana/web3.js'
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
  return fs.existsSync(keyPath(name))
}

export function loadKeypair(name: string): Keypair {
  return loadKeypairFile(keyPath(name))
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
