import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import bs58 from 'bs58'
import { Connection, Keypair } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'

// Point the repo root at a temp dir before anything reads keys/.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-wallets-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'devnet'
delete process.env.PLATFORM_SECRET_KEY
delete process.env.PLATFORM_FEE_CLAIMER
delete process.env.USDC_MINT

import { loadKeypair, parseSecretKey, platformFeeClaimer, saveKeypair } from '../wallets'
import { buildCreateCampaignTx, getUsdcMint, saveMockUsdcMint } from '../chain'
import { MAINNET_USDC } from '../network'

const fileKey = Keypair.generate()
saveKeypair('platform', fileKey)

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

test('parseSecretKey reads JSON byte arrays and base58', () => {
  const kp = Keypair.generate()
  assert.ok(parseSecretKey(JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey))
  assert.ok(parseSecretKey(` ${bs58.encode(kp.secretKey)}\n`).publicKey.equals(kp.publicKey))
  assert.throws(() => parseSecretKey('[1,2,3]'), /64 bytes/)
})

test('platform key falls back to keys/<network>/platform.json', () => {
  assert.ok(loadKeypair('platform').publicKey.equals(fileKey.publicKey))
})

test('PLATFORM_SECRET_KEY takes precedence over the file, as base58 or JSON', () => {
  const envKey = Keypair.generate()
  withEnv({ PLATFORM_SECRET_KEY: bs58.encode(envKey.secretKey) }, () => {
    assert.ok(loadKeypair('platform').publicKey.equals(envKey.publicKey))
  })
  withEnv({ PLATFORM_SECRET_KEY: JSON.stringify(Array.from(envKey.secretKey)) }, () => {
    assert.ok(loadKeypair('platform').publicKey.equals(envKey.publicKey))
  })
})

test('a bad PLATFORM_SECRET_KEY fails without echoing the value', () => {
  withEnv({ PLATFORM_SECRET_KEY: 'notakey0OIl' }, () => {
    assert.throws(
      () => loadKeypair('platform'),
      (e: Error) => e.message.startsWith('PLATFORM_SECRET_KEY is not a valid secret key') && !e.message.includes('notakey0OIl'),
    )
  })
  // JSON.parse quotes the bytes around a bad token; none of them may reach the message.
  const bytes = Array.from(Keypair.generate().secretKey).map((b, i) => (i < 40 ? 200 + (i % 50) : b))
  for (const bad of [`[${bytes.slice(0, 20).join(',')},x,${bytes.slice(21).join(',')}]`, `[${bytes.join(',')},]`]) {
    withEnv({ PLATFORM_SECRET_KEY: bad }, () => {
      assert.throws(
        () => loadKeypair('platform'),
        (e: Error) =>
          e.message === 'PLATFORM_SECRET_KEY is not a valid secret key: secret key is neither a JSON byte array nor base58' &&
          !/\d{3}/.test(e.message),
      )
    })
  }
})

test('other roles never read the platform env key', () => {
  withEnv({ PLATFORM_SECRET_KEY: bs58.encode(Keypair.generate().secretKey) }, () => {
    assert.throws(() => loadKeypair('maker'), /ENOENT/)
  })
})

test('fee claimer defaults to the platform key and can be overridden', () => {
  assert.ok(platformFeeClaimer().equals(fileKey.publicKey))
  const cold = Keypair.generate().publicKey
  withEnv({ PLATFORM_FEE_CLAIMER: cold.toBase58() }, () => assert.ok(platformFeeClaimer().equals(cold)))
  withEnv({ PLATFORM_FEE_CLAIMER: 'nope' }, () => assert.throws(() => platformFeeClaimer(), /not a valid Solana address/))
})

test('new configs send partner fees and leftover to PLATFORM_FEE_CLAIMER', async () => {
  const cold = Keypair.generate().publicKey
  const before = process.env.PLATFORM_FEE_CLAIMER
  process.env.PLATFORM_FEE_CLAIMER = cold.toBase58()
  try {
    const campaign = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../examples/hoodie.json'), 'utf8'))
    // Builds offline: the SDK only looks up the quote mint's token program.
    const connection = new Connection('http://127.0.0.1:1')
    connection.getAccountInfo = async () => ({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82), executable: false, lamports: 1 })
    const { tx } = await buildCreateCampaignTx({
      connection,
      campaign,
      tier: 'A',
      maker: Keypair.generate().publicKey,
      usdcMint: Keypair.generate().publicKey,
    })
    const createConfig = tx.instructions.find((ix) => ix.keys.some((k) => k.pubkey.equals(cold)))
    assert.ok(createConfig, 'fee claimer is in the create transaction')
  } finally {
    before === undefined ? delete process.env.PLATFORM_FEE_CLAIMER : (process.env.PLATFORM_FEE_CLAIMER = before)
  }
})

test('USDC_MINT takes precedence over the mock-mint file off mainnet', () => {
  const fileMint = Keypair.generate().publicKey
  const envMint = Keypair.generate().publicKey
  saveMockUsdcMint(fileMint)
  assert.ok(getUsdcMint().equals(fileMint))
  withEnv({ USDC_MINT: envMint.toBase58() }, () => assert.ok(getUsdcMint().equals(envMint)))
  withEnv({ NETWORK: 'localnet', USDC_MINT: envMint.toBase58() }, () => assert.ok(getUsdcMint().equals(envMint)))
})

test('mainnet always uses real USDC and refuses a different USDC_MINT', () => {
  withEnv({ NETWORK: 'mainnet' }, () => assert.ok(getUsdcMint().equals(MAINNET_USDC)))
  withEnv({ NETWORK: 'mainnet', USDC_MINT: MAINNET_USDC.toBase58() }, () => assert.ok(getUsdcMint().equals(MAINNET_USDC)))
  withEnv({ NETWORK: 'mainnet', USDC_MINT: Keypair.generate().publicKey.toBase58() }, () => {
    assert.throws(() => getUsdcMint(), /real USDC on mainnet/)
  })
})
