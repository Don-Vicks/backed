// Exercises the web API exactly as the browser does, signing with local devnet test wallets.
import { Transaction } from '@solana/web3.js'
import { LIVE_TTL_MS } from '../live'
import { getConnection } from '../network'
import { loadWallets } from '../wallets'

const BASE = process.env.WEB_URL || 'http://localhost:3100'
async function api<T>(p: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + p, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(`${p}: ${data.error}`)
  return data as T
}

async function main() {
  const connection = getConnection()
  const w = loadWallets()
  const signSend = async (built: { tx: string; lastValidBlockHeight: number }, signer: typeof w.maker, label: string) => {
    const tx = Transaction.from(Buffer.from(built.tx, 'base64'))
    tx.partialSign(signer)
    const sig = await connection.sendRawTransaction(tx.serialize())
    await connection.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: built.lastValidBlockHeight }, 'confirmed')
    console.log(`✓ ${label} ${sig.slice(0, 16)}…`)
    return sig
  }

  const resume = process.argv.indexOf('--pool') > -1 ? process.argv[process.argv.indexOf('--pool') + 1] : null
  if (resume) return finish(resume)

  const campaign = {
    name: 'API Smoke Mug', symbol: 'MUG', uri: '', description: 'Created through the web API.',
    plan: { tiers: [{ units: 2, startPrice: 3 }, { units: 2, startPrice: 4 }], finalPrice: 5, makerSharePct: 10 },
    dropBot: { startFeeBps: 1500, windowSec: 60 }, normalFeeBps: 100,
  }
  const preview = await api<any>('/api/preview', { campaign, maker: w.maker.publicKey.toBase58() })
  console.log(`preview: tier ${preview.trust.tier}, goal ${preview.onChain.goalUsdc.toFixed(4)}, fields ${preview.fields.length}`)

  const created = await api<{ txs: { tx: string; lastValidBlockHeight: number }[]; pool: string }>('/api/campaigns', { campaign, maker: w.maker.publicKey.toBase58() })
  let sig = ''
  for (const built of created.txs) sig = await signSend(built, w.maker, 'maker signs, pays + sends create')
  await api('/api/campaigns/confirm', { pool: created.pool, signature: sig })
  console.log(`✓ confirmed, pool ${created.pool}`)

  // Every backer below spends test USDC; fresh localnet wallets start with none.
  for (const b of [w.backer1, w.backer2, w.backer3]) await api('/api/faucet', { wallet: b.publicKey.toBase58() })
  console.log('✓ faucet ×3')

  console.log('waiting 65s for the drop-bot window…')
  await new Promise((r) => setTimeout(r, 65_000))
  const q = await api<any>('/api/quote', { pool: created.pool, usdc: 3 })
  console.log(`quote 3 USDC → ${q.vouchers.toFixed(4)} vouchers, fee ${q.feePct.toFixed(2)}%`)
  const buy = await api<{ tx: string; lastValidBlockHeight: number }>('/api/tx', { kind: 'buy', pool: created.pool, wallet: w.backer1.publicKey.toBase58(), usdc: 3, ref: w.backer2.publicKey.toBase58() })
  await signSend(buy, w.backer1, 'backer1 backs 3 USDC (with referral)')
  const sell = await api<{ tx: string; lastValidBlockHeight: number }>('/api/tx', { kind: 'sell', pool: created.pool, wallet: w.backer1.publicKey.toBase58() })
  await signSend(sell, w.backer1, 'backer1 exits at curve price')

  // Fund to the goal, graduate via API, maker withdraws, backer redeems.
  let live = (await api<any>(`/api/campaigns/${created.pool}`)).campaign.live
  let i = 0
  const backers = [w.backer2, w.backer3, w.backer1]
  while (live.status === 'funding') {
    const b = backers[i++ % 3]
    const t = await api<{ tx: string; lastValidBlockHeight: number }>('/api/tx', { kind: 'buy', pool: created.pool, wallet: b.publicKey.toBase58(), usdc: 4 })
    await signSend(t, b, `buy 4 USDC`)
    await new Promise((r) => setTimeout(r, LIVE_TTL_MS)) // the server caches live state this long
    live = (await api<any>(`/api/campaigns/${created.pool}`)).campaign.live
    console.log(`  progress ${(live.progress * 100).toFixed(1)}%`)
    if (i > 20) throw new Error('did not fund')
  }
  // Graduation is paid by whoever clicks; here backer1. Meteora's keeper may already have done it.
  const migrate = await api<{ tx?: string; lastValidBlockHeight?: number; already?: boolean }>('/api/campaigns/' + created.pool + '/migrate', { wallet: w.backer1.publicKey.toBase58() })
  if (migrate.tx) await signSend(migrate as { tx: string; lastValidBlockHeight: number }, w.backer1, 'backer1 pays + sends graduation')
  else console.log('already graduated by the keeper')
  await finish(created.pool)
}

async function finish(pool: string) {
  const connection = getConnection()
  const w = loadWallets()
  const backers = [w.backer2, w.backer3, w.backer1]
  const created = { pool }
  const signSend = async (built: { tx: string; lastValidBlockHeight: number }, signer: typeof w.maker, label: string) => {
    const tx = Transaction.from(Buffer.from(built.tx, 'base64'))
    tx.partialSign(signer)
    const sig = await connection.sendRawTransaction(tx.serialize())
    await connection.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: built.lastValidBlockHeight }, 'confirmed')
    console.log(`✓ ${label} ${sig.slice(0, 16)}…`)
    return sig
  }
  let live: any
  const wd = await api<{ tx: string; lastValidBlockHeight: number }>('/api/tx', { kind: 'withdraw', pool: created.pool, wallet: w.maker.publicKey.toBase58() })
  await signSend(wd, w.maker, 'maker withdraws budget')
  live = (await api<any>(`/api/campaigns/${created.pool}`)).campaign.live
  console.log(`status ${live.status}, resale pool ${live.resalePool}`)
  const shipping = { name: 'Smoke Tester', email: '', address: '1 Test St', country: 'NL' }
  for (const b of backers) {
    const r = await api<{ id: string; tx: string; lastValidBlockHeight: number }>('/api/redemptions/prepare', { pool: created.pool, wallet: b.publicKey.toBase58(), shipping }).catch(() => null)
    if (!r) continue // holds < 1 voucher
    const tx = Transaction.from(Buffer.from(r.tx, 'base64'))
    tx.partialSign(b)
    const done = await api<{ signature: string }>('/api/redemptions/submit', { pool: created.pool, id: r.id, tx: tx.serialize().toString('base64'), shipping })
    console.log(`✓ redeem 1 voucher ${done.signature.slice(0, 16)}…, order recorded`)
    break
  }
  console.log(`\nAPI smoke passed. Open ${BASE}/c/${created.pool}`)
}
main().catch((e) => { console.error('FAILED', e.message ?? e); process.exit(1) })
