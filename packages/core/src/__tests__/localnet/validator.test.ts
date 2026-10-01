// Runs against a local validator with the mainnet Meteora programs cloned (pnpm core:test:localnet).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { getNetwork } from '../../network'

const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
const DAMM_V2 = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'
// DBC pool authority: pays rent during migration, so it must hold SOL on a fresh validator.
const POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
const net = getNetwork({ ...process.env, NETWORK: 'localnet' })
const conn = new Connection(net.rpcUrl, 'confirmed')

test('localnet RPC answers', { skip }, async () => {
  assert.ok((await conn.getSlot()) > 0)
})

test('DBC and DAMM v2 programs are deployed', { skip }, async () => {
  for (const id of [DBC, DAMM_V2]) {
    const info = await conn.getAccountInfo(new PublicKey(id))
    assert.ok(info?.executable, `${id} is not deployed on ${net.rpcUrl}`)
  }
})

test('DBC pool authority is funded for migrations', { skip }, async () => {
  const lamports = await conn.getBalance(new PublicKey(POOL_AUTHORITY))
  assert.ok(lamports >= 0.1 * LAMPORTS_PER_SOL, `airdrop SOL to ${POOL_AUTHORITY}`)
})
