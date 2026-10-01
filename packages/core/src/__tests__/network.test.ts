import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAINNET_USDC, getNetwork, isTestNetwork, parseNetwork, trustRpcUrl } from '../network'

test('NETWORK defaults to devnet and rejects unknown names', () => {
  assert.equal(parseNetwork(undefined), 'devnet')
  assert.equal(parseNetwork(''), 'devnet')
  assert.equal(parseNetwork('localnet'), 'localnet')
  assert.throws(() => parseNetwork('testnet'), /localnet, devnet or mainnet/)
})

test('localnet uses LOCALNET_RPC_URL, default 127.0.0.1:8899, and custom-cluster explorer links', () => {
  const def = getNetwork({ NETWORK: 'localnet' })
  assert.equal(def.rpcUrl, 'http://127.0.0.1:8899')
  assert.equal(def.usdcMint, null)
  assert.equal(def.explorerCluster, '?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899')
  assert.equal(getNetwork({ NETWORK: 'localnet', LOCALNET_RPC_URL: 'http://10.0.0.2:9000' }).rpcUrl, 'http://10.0.0.2:9000')
})

test('devnet and mainnet take their own RPC URLs and fall back to public endpoints', () => {
  assert.equal(getNetwork({ NETWORK: 'devnet' }).rpcUrl, 'https://api.devnet.solana.com')
  assert.equal(getNetwork({ NETWORK: 'devnet', DEVNET_RPC_URL: 'https://d.example' }).rpcUrl, 'https://d.example')
  const main = getNetwork({ NETWORK: 'mainnet', MAINNET_RPC_URL: 'https://m.example', DEVNET_RPC_URL: 'https://d.example' })
  assert.equal(main.rpcUrl, 'https://m.example')
  assert.equal(main.explorerCluster, '')
  assert.ok(main.usdcMint?.equals(MAINNET_USDC))
})

test('faucet networks are devnet and localnet only', () => {
  assert.equal(isTestNetwork('localnet'), true)
  assert.equal(isTestNetwork('devnet'), true)
  assert.equal(isTestNetwork('mainnet'), false)
})

test('trust lookups prefer TRUST_RPC_URL, then MAINNET_RPC_URL', () => {
  assert.equal(trustRpcUrl({ TRUST_RPC_URL: 'https://t.example', MAINNET_RPC_URL: 'https://m.example' }), 'https://t.example')
  assert.equal(trustRpcUrl({ MAINNET_RPC_URL: 'https://m.example' }), 'https://m.example')
  assert.equal(trustRpcUrl({}), 'https://api.mainnet-beta.solana.com')
})
