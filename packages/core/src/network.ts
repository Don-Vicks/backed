import path from 'path'
import dotenv from 'dotenv'
import { repoRoot } from './paths'
import { Connection, PublicKey } from '@solana/web3.js'

dotenv.config({ path: path.join(repoRoot(), '.env'), quiet: true })

export type NetworkName = 'localnet' | 'devnet' | 'mainnet'
export const NETWORKS: readonly NetworkName[] = ['localnet', 'devnet', 'mainnet']

export type NetworkConfig = {
  name: NetworkName
  rpcUrl: string
  explorerCluster: string
  // USDC on mainnet; elsewhere USDC_MINT or the mock mint created by the scripts (stored in keys/)
  usdcMint: PublicKey | null
}

export const MAINNET_USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
export const DEFAULT_LOCALNET_RPC_URL = 'http://127.0.0.1:8899'
// Keyless endpoints that are safe to ship to the browser.
export const PUBLIC_RPC_URLS: Record<NetworkName, string> = {
  localnet: DEFAULT_LOCALNET_RPC_URL,
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
}

export function parseNetwork(value: string | undefined): NetworkName {
  const name = (value || 'devnet') as NetworkName
  if (!NETWORKS.includes(name)) throw new Error(`NETWORK must be localnet, devnet or mainnet, got ${value}`)
  return name
}

// Networks where SOL and the mock USDC are free: the faucet runs and tests may cut corners.
export const isTestNetwork = (name: NetworkName) => name !== 'mainnet'

export function getNetwork(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const name = parseNetwork(env.NETWORK)
  if (name === 'mainnet') {
    return { name, rpcUrl: env.MAINNET_RPC_URL || PUBLIC_RPC_URLS.mainnet, explorerCluster: '', usdcMint: MAINNET_USDC }
  }
  if (name === 'localnet') {
    const rpcUrl = env.LOCALNET_RPC_URL || DEFAULT_LOCALNET_RPC_URL
    return { name, rpcUrl, explorerCluster: `?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`, usdcMint: null }
  }
  return { name, rpcUrl: env.DEVNET_RPC_URL || PUBLIC_RPC_URLS.devnet, explorerCluster: '?cluster=devnet', usdcMint: null }
}

// Trust signals always come from mainnet history (devnet and localnet wallets have none).
export function trustRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRUST_RPC_URL || env.MAINNET_RPC_URL || PUBLIC_RPC_URLS.mainnet
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

// Localnet links go to the Solana Explorer, which reads the custom RPC URL from the link.
const explorerBase = (name: NetworkName) => (name === 'localnet' ? 'https://explorer.solana.com' : 'https://solscan.io')

export function explorerTx(sig: string): string {
  const net = getNetwork()
  return `${explorerBase(net.name)}/tx/${sig}${net.explorerCluster}`
}

export function explorerAccount(address: PublicKey | string): string {
  const net = getNetwork()
  return `${explorerBase(net.name)}/${net.name === 'localnet' ? 'address' : 'account'}/${address.toString()}${net.explorerCluster}`
}
