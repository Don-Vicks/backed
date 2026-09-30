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

const BASE = 'http://localhost:3100'
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
  const built = (await post('/api/tx', { kind: 'redeem', pool, wallet: holder.publicKey.toBase58() })).body
  const tx = Transaction.from(Buffer.from(built.tx, 'base64')); tx.partialSign(holder)
  const sig = await c.sendRawTransaction(tx.serialize())
  await c.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: built.lastValidBlockHeight }, 'confirmed')
  console.log('✓ burned 1 voucher', sig.slice(0, 16))
  const shipping = { name: 'Ada Lovelace', email: 'ada@example.com', address: '12 Analytical Way\nLondon', country: 'UK' }
  console.log('submit        →', await post('/api/redemptions', { pool, signature: sig, wallet: holder.publicKey.toBase58(), shipping }))
  console.log('reuse sig     →', await post('/api/redemptions', { pool, signature: sig, wallet: holder.publicKey.toBase58(), shipping }))
  console.log('wrong wallet  →', (await post('/api/redemptions', { pool, signature: sig, wallet: w.maker.publicKey.toBase58(), shipping })).body)
  const msg = ordersMessage(pool, new Date().toISOString())
  const signAs = (kp: typeof w.maker) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey))
  const asMaker = await post('/api/redemptions/list', { pool, message: msg, signature: signAs(w.maker) })
  console.log('maker list    →', asMaker.status, asMaker.body.redemptions?.map((r: any) => `${r.shipping.name} ×${r.units}`))
  console.log('non-maker     →', (await post('/api/redemptions/list', { pool, message: msg, signature: signAs(w.backer1) })).status)
}
main().catch((e) => { console.error('FAILED', e.stack ?? e); process.exit(1) })
