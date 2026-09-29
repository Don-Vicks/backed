import path from 'path'
import dotenv from 'dotenv'
import { repoRoot } from './paths'
import { Connection, PublicKey } from '@solana/web3.js'

dotenv.config({ path: path.join(repoRoot(), '.env'), quiet: true })

export type NetworkName = 'devnet' | 'mainnet'

export type NetworkConfig = {
  name: NetworkName
  rpcUrl: string
  explorerCluster: string
  // USDC on mainnet; on devnet the mock mint created by the lifecycle script (stored in keys/)
  usdcMint: PublicKey | null
}

const MAINNET_USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

export function getNetwork(): NetworkConfig {
  const name = (process.env.NETWORK ?? 'devnet') as NetworkName
  if (name !== 'devnet' && name !== 'mainnet') {
    throw new Error(`NETWORK must be devnet or mainnet, got ${name}`)
  }
  if (name === 'mainnet') {
    return {
      name,
      rpcUrl: process.env.MAINNET_RPC_URL || 'https://api.mainnet-beta.solana.com',
      explorerCluster: '',
      usdcMint: MAINNET_USDC,
    }
  }
  return {
    name,
    rpcUrl: process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com',
    explorerCluster: '?cluster=devnet',
    usdcMint: null,
  }
}

// Public RPC endpoints drop connections now and then (ECONNRESET, "fetch failed").
// Retry network-level failures a few times; HTTP errors are left to web3.js.
const retryingFetch: typeof fetch = async (input, init) => {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(input, init)
    } catch (e) {
      lastError = e
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt))
    }
  }
  throw lastError
}

export function getConnection(): Connection {
  return new Connection(getNetwork().rpcUrl, { commitment: 'confirmed', fetch: retryingFetch })
}

export function explorerTx(sig: string): string {
  return `https://solscan.io/tx/${sig}${getNetwork().explorerCluster}`
}

export function explorerAccount(address: PublicKey | string): string {
  return `https://solscan.io/account/${address.toString()}${getNetwork().explorerCluster}`
}
