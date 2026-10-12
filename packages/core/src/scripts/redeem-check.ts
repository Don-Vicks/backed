// Redemption through the web API on a graduated campaign (WEB_URL, default http://localhost:3100):
// prepare, sign and submit with shipping; then the hijack attempts and the maker's orders sign-in.
//   pnpm --filter @preorder/core exec ts-node src/scripts/redeem-check.ts <pool>
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { getConnection } from '../network'
import { loadWallets } from '../wallets'
import { send } from '../tx'
import { getCampaign } from '../store'
import { buildResaleSwapTx } from '../resale'
import { ordersMessage } from '../redemptions'

const BASE = process.env.WEB_URL || 'http://localhost:3100'
const post = async (p: string, b: unknown) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() } }

async function main() {
  const pool = process.argv[2]
  const record = getCampaign(pool)!
  const c = getConnection(), w = loadWallets()
  const bal = async (kp: typeof w.maker) => Number((await c.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(record.baseMint), kp.publicKey)).catch(() => ({ value: { uiAmount: 0 } }))).value.uiAmount ?? 0)
  const holdings = await Promise.all([w.backer1, w.backer2, w.backer3].map(async (b) => ({ b, v: await bal(b) })))
  const top = holdings.sort((a, b) => b.v - a.v)[0]
  const holder = top.b
  if (top.v < 1) {
    await send(c, await buildResaleSwapTx(c, record, holder.publicKey, 'buy', 8), [holder], 'buy vouchers on resale to redeem')
  }
  console.log('holder has', (await bal(holder)).toFixed(4), 'vouchers')
  const shipping = { name: 'Ada Lovelace', email: 'ada@example.com', address: '12 Analytical Way\nLondon', country: 'UK' }
  const built = (await post('/api/redemptions/prepare', { pool, wallet: holder.publicKey.toBase58(), shipping })).body
  const tx = Transaction.from(Buffer.from(built.tx, 'base64')); tx.partialSign(holder)
  const signed = tx.serialize().toString('base64')
  console.log('submit        →', await post('/api/redemptions/submit', { pool, id: built.id, tx: signed, shipping }))
  console.log('submit again  →', await post('/api/redemptions/submit', { pool, id: built.id, tx: signed, shipping: { ...shipping, name: 'Mallory' } }))
  // A hijacker claims the holder's burn for a redemption of their own: only the burn sent for it counts.
  const forged = (await post('/api/redemptions/prepare', { pool, wallet: holder.publicKey.toBase58(), shipping: { ...shipping, name: 'Mallory' } })).body
  console.log('hijack        →', await post('/api/redemptions/confirm', { id: forged.id, signature: bs58.encode(tx.signature!) }))
  const signIn = async (kp: typeof w.maker) => {
    const { nonce } = (await post('/api/redemptions/nonce', { pool })).body
    const message = ordersMessage(pool, new Date().toISOString(), new URL(BASE).host, nonce)
    return post('/api/redemptions/signin', { pool, message, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)) })
  }
  const list = async (token?: string) => {
    const res = await fetch(`${BASE}/api/redemptions/list`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ pool }) })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
  const asMaker = await list((await signIn(w.maker)).body.token)
  console.log('maker list    →', asMaker.status, asMaker.body.redemptions?.map((r: any) => `${r.shipping?.name} ×${r.units}`))
  console.log('non-maker     →', (await signIn(w.backer1)).status)
  console.log('no session    →', (await list()).status)
}
main().catch((e) => { console.error('FAILED', e.stack ?? e); process.exit(1) })
