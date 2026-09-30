import { test } from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { Keypair } from '@solana/web3.js'
import { ordersMessage, verifyWalletMessage } from '../redemptions'

const sign = (kp: Keypair, msg: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey))

test('maker sign-in: valid signature passes', () => {
  const kp = Keypair.generate()
  const msg = ordersMessage('POOL', new Date().toISOString())
  assert.doesNotThrow(() => verifyWalletMessage(msg, sign(kp, msg), kp.publicKey))
})

test('maker sign-in: another wallet is rejected', () => {
  const kp = Keypair.generate()
  const msg = ordersMessage('POOL', new Date().toISOString())
  assert.throws(() => verifyWalletMessage(msg, sign(kp, msg), Keypair.generate().publicKey), /does not match/)
})

test('maker sign-in: stale message is rejected', () => {
  const kp = Keypair.generate()
  const msg = ordersMessage('POOL', new Date(Date.now() - 60 * 60_000).toISOString())
  assert.throws(() => verifyWalletMessage(msg, sign(kp, msg), kp.publicKey), /expired/)
})
