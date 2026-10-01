import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Point the repo root at a temp dir before anything reads keys/.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-autogen-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'devnet'
for (const k of ['PLATFORM_SECRET_KEY', 'SHIPPING_KEY', 'SHIPPING_ENCRYPTION_KEY', 'TEST_KEYS_AUTOGEN', 'PUBLIC_BASE_URL']) delete process.env[k]

import { hasKeypair, loadKeypair, testKeysAutogen } from '../wallets'
import { openJson, sealJson, shippingKey, shippingKeyStatus } from '../seal'

const platformFile = path.join(root, 'keys', 'devnet', 'platform.json')
const shippingFile = path.join(root, 'keys', 'devnet', 'shipping-key')

test('without TEST_KEYS_AUTOGEN nothing is generated', () => {
  assert.equal(testKeysAutogen(), false)
  assert.equal(hasKeypair('platform'), false)
  assert.throws(() => loadKeypair('platform'))
  assert.equal(fs.existsSync(platformFile), false)
})

test('TEST_KEYS_AUTOGEN never applies on mainnet', () => {
  assert.equal(testKeysAutogen({ NETWORK: 'mainnet', TEST_KEYS_AUTOGEN: '1' }), false)
  assert.throws(() => shippingKey({ NETWORK: 'mainnet', TEST_KEYS_AUTOGEN: '1' }), /must be set on mainnet/)
})

test('on devnet the platform key is generated once, privately, and reused', () => {
  process.env.TEST_KEYS_AUTOGEN = '1'
  assert.equal(hasKeypair('platform'), true)
  const first = loadKeypair('platform')
  assert.equal(fs.statSync(platformFile).mode & 0o777, 0o600)
  assert.ok(loadKeypair('platform').publicKey.equals(first.publicKey))
})

test('on a deployed devnet the generated shipping key passes the status check and seals', () => {
  process.env.TEST_KEYS_AUTOGEN = '1'
  process.env.PUBLIC_BASE_URL = 'https://backed.example'
  const status = shippingKeyStatus()
  assert.equal(status.ok, true)
  assert.equal(status.configured, true)
  assert.equal(fs.statSync(shippingFile).mode & 0o777, 0o600)
  const sealed = sealJson({ name: 'Ada' }, 'row-1')
  assert.deepEqual(openJson(sealed, 'row-1'), { name: 'Ada' })
  assert.ok(shippingKey().equals(Buffer.from(fs.readFileSync(shippingFile, 'utf8').trim(), 'hex')))
})
