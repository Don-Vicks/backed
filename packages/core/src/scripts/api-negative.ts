// Negative and edge cases of the web API, with fresh wallets against a localnet server at WEB_URL:
// bad input, unknown campaigns, status gates through funding → funded → reselling, Blink states and
// rate limits. Every answer must have the expected status, and none may be a 5xx.
//   NETWORK=localnet WEB_URL=http://localhost:3100 pnpm --filter @preorder/core api-negative
// The server needs NETWORK=localnet, its platform key as the mock USDC mint authority (faucet) and
// rate limits on (RATE_LIMITS unset); the trust lookup for the fresh maker reads mainnet unless
// TRUST_FIXTURES covers it. Requests carry a random X-Forwarded-For so each run gets fresh buckets.
import { randomInt } from 'crypto'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import { getConnection, getNetwork } from '../network'
import { MAX_BODY_BYTES } from '../requests'
import { ordersMessage } from '../messages'

const BASE = process.env.WEB_URL || 'http://localhost:3100'
const conn = getConnection()
const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`
const runIp = ip()

type Res = { status: number; json: any }
const rows: { label: string; status: number; want: number[]; note: string }[] = []

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': runIp, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = text.slice(0, 120)
  }
  return { status: res.status, json }
}

function expect(label: string, res: Res, ...want: number[]) {
  const note = JSON.stringify(res.json ?? '').slice(0, 110)
  rows.push({ label, status: res.status, want, note })
  return res
}

async function signSend(b64: string, signer: Keypair) {
  const tx = Transaction.from(Buffer.from(b64, 'base64'))
  tx.partialSign(signer)
  const signature = await conn.sendRawTransaction(tx.serialize())
  const latest = await conn.getLatestBlockhash('confirmed')
  const r = await conn.confirmTransaction({ signature, ...latest }, 'confirmed')
  if (r.value.err) throw new Error(`transaction failed: ${JSON.stringify(r.value.err)}`)
  return signature
}

async function airdrop(pk: PublicKey) {
  const sig = await conn.requestAirdrop(pk, 2 * LAMPORTS_PER_SOL)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
}

const live = async (pool: string) => (await call('GET', `/api/campaigns/${pool}`)).json.campaign.live

async function main() {
  if (getNetwork().name !== 'localnet') throw new Error('api-negative runs against localnet only (NETWORK=localnet)')
  const [maker, backer1, backer2] = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
  const pk = (k: Keypair) => k.publicKey.toBase58()
  const stranger = Keypair.generate().publicKey.toBase58() // a valid address that is no campaign
  for (const k of [maker, backer1, backer2]) await airdrop(k.publicKey)

  // --- faucet
  expect('faucet: bad wallet', await call('POST', '/api/faucet', { wallet: 'x' }), 400)
  expect('faucet: backer1', await call('POST', '/api/faucet', { wallet: pk(backer1) }), 200)
  const again = expect('faucet: backer1 again within 24h', await call('POST', '/api/faucet', { wallet: pk(backer1) }), 429, 200)
  const limitsOn = again.status === 429
  expect('faucet: backer2', await call('POST', '/api/faucet', { wallet: pk(backer2) }), 200)

  // --- create validation
  const campaign = {
    name: 'Neg Mug',
    symbol: 'NEG',
    plan: { tiers: [{ units: 2, startPrice: 3 }, { units: 2, startPrice: 4 }], finalPrice: 5, makerSharePct: 10 },
    dropBot: { startFeeBps: 1500, windowSec: 60 },
    normalFeeBps: 100,
  }
  const create = (c: unknown, m: unknown = pk(maker)) => call('POST', '/api/campaigns', { campaign: c, maker: m })
  expect('create: empty name', await create({ ...campaign, name: ' ' }), 400)
  expect('create: bad maker', await create(campaign, 'nope'), 400)
  expect('create: final price below a tier', await create({ ...campaign, plan: { ...campaign.plan, finalPrice: 1 } }), 400)
  expect('create: 50% launch fee', await create({ ...campaign, dropBot: { startFeeBps: 5000, windowSec: 300 } }), 400)
  expect('create: share above the tier cap', await create({ ...campaign, plan: { ...campaign.plan, makerSharePct: 40 } }), 400)
  expect('create: body over 32 KB', await create({ ...campaign, description: 'x'.repeat(MAX_BODY_BYTES) }), 413)
  expect('create: malformed JSON', await call('POST', '/api/campaigns', '{"campaign":'), 400)
  const preview = expect('preview: verifiedSocial is ignored', await call('POST', '/api/preview', { campaign, maker: pk(maker), verifiedSocial: true }), 200)
  if (preview.json.trust?.reasons?.some((r: string) => /social/i.test(r))) rows.push({ label: 'preview: no social reason', status: 0, want: [1], note: 'social reason present' })

  // --- create + confirm
  const created = expect('create: ok', await call('POST', '/api/campaigns', { campaign, maker: pk(maker), verifiedSocial: true }), 200)
  if (created.status !== 200) return
  let createSig = ''
  for (const t of created.json.txs) createSig = await signSend(t.tx, maker)
  const pool: string = created.json.pool
  expect('confirm: bogus signature', await call('POST', '/api/campaigns/confirm', { pool, signature: 'xyz' }), 400)
  expect('confirm: ok', await call('POST', '/api/campaigns/confirm', { pool, signature: createSig }), 200)
  expect('confirm: replay', await call('POST', '/api/campaigns/confirm', { pool, signature: createSig }), 200, 400)
  expect('campaign: unknown', await call('GET', `/api/campaigns/${stranger}`), 404)
  expect('campaigns: list', await call('GET', '/api/campaigns'), 200)
  expect('metadata: unknown', await call('GET', '/api/metadata/ffff'), 404)

  // --- funding: input errors and gates
  const tx = (body: Record<string, unknown>) => call('POST', '/api/tx', { pool, wallet: pk(backer1), ...body })
  expect('quote: usdc 0', await call('POST', '/api/quote', { pool, usdc: 0 }), 400)
  expect('quote: usdc "abc"', await call('POST', '/api/quote', { pool, usdc: 'abc' }), 400)
  expect('quote: invalid pool', await call('POST', '/api/quote', { pool: 'x', usdc: 1 }), 400)
  expect('quote: unknown pool', await call('POST', '/api/quote', { pool: stranger, usdc: 1 }), 404)
  expect('quote: more than is left to the goal', await call('POST', '/api/quote', { pool, usdc: 500 }), 200)
  expect('quote: sell with no amount', await call('POST', '/api/quote', { pool, side: 'sell' }), 400)
  expect('resale quote: before graduation', await call('POST', '/api/resale/quote', { pool, side: 'buy', amount: 1 }), 409)
  expect('resale quote: bad side', await call('POST', '/api/resale/quote', { pool, side: 'x', amount: 1 }), 400)
  for (const usdc of [0, -1, 'abc', null, 2e9]) expect(`tx buy: usdc ${JSON.stringify(usdc)}`, await tx({ kind: 'buy', usdc }), 400)
  expect('tx buy: 1e9 builds (fails on-chain)', await tx({ kind: 'buy', usdc: 1e9 }), 200)
  expect('tx: unknown kind', await tx({ kind: 'steal' }), 400)
  expect('tx: unknown pool', await call('POST', '/api/tx', { kind: 'buy', pool: stranger, wallet: pk(backer1), usdc: 1 }), 404)
  expect('tx: bad wallet', await call('POST', '/api/tx', { kind: 'buy', pool, wallet: 'x', usdc: 1 }), 400)
  expect('tx: slippage out of range', await tx({ kind: 'buy', usdc: 1, slippageBps: 5000 }), 400)
  // Whole-unit buys, the maker's unlock and the on-chain listing.
  const unitsQuote = (body: Record<string, unknown>) => call('POST', '/api/quote/units', { pool, ...body })
  expect('quote units: 1', await unitsQuote({ units: 1 }), 200)
  expect('quote units: half a unit', await unitsQuote({ units: 0.5 }), 400)
  expect('quote units: "two"', await unitsQuote({ units: 'two' }), 400)
  expect('quote units: unknown pool', await call('POST', '/api/quote/units', { pool: stranger, units: 1 }), 404)
  expect('quote units: top-up without a wallet', await unitsQuote({ topUp: true }), 400)
  expect('tx buyUnits: 0 units', await tx({ kind: 'buyUnits', units: 0 }), 400)
  expect('tx buyUnits: no units', await tx({ kind: 'buyUnits' }), 400)
  expect('tx buyUnits: more than are left', await tx({ kind: 'buyUnits', units: 1000 }), 409)
  expect('tx buyUnits: 1 builds', await tx({ kind: 'buyUnits', units: 1 }), 200)
  expect('tx unlock: before graduation', await call('POST', '/api/tx', { kind: 'unlock', pool, wallet: pk(maker) }), 409)
  expect('listing: bad wallet', await call('POST', `/api/campaigns/${pool}/listing`, { wallet: 'x' }), 400)
  expect('listing: by a backer', await call('POST', `/api/campaigns/${pool}/listing`, { wallet: pk(backer1) }), 400)
  expect('listing: unknown campaign', await call('POST', `/api/campaigns/${stranger}/listing`, { wallet: pk(maker) }), 404)
  expect('listing: maker builds', await call('POST', `/api/campaigns/${pool}/listing`, { wallet: pk(maker) }), 200)
  expect('platform: earnings', await call('GET', '/api/platform'), 200)
  expect('tx sell: no vouchers', await tx({ kind: 'sell' }), 400)
  expect('tx withdraw: before graduation', await call('POST', '/api/tx', { kind: 'withdraw', pool, wallet: pk(maker) }), 409)
  expect('tx claim: by a backer', await tx({ kind: 'claim' }), 400)
  expect('tx resaleBuy: before graduation', await tx({ kind: 'resaleBuy', usdc: 1 }), 409)
  expect('migrate: before the goal', await call('POST', `/api/campaigns/${pool}/migrate`, { wallet: pk(backer2) }), 409)
  expect('migrate: no wallet', await call('POST', `/api/campaigns/${pool}/migrate`), 400)
  expect('migrate: unknown campaign', await call('POST', `/api/campaigns/${stranger}/migrate`, { wallet: pk(backer2) }), 404)
  expect('migrate: wrong admin token', await call('POST', `/api/campaigns/${pool}/migrate`, {}, { authorization: 'Bearer nope' }), 401)

  // --- Blink while funding
  const blink = `/api/actions/back/${pool}`
  expect('blink OPTIONS', await call('OPTIONS', blink), 200)
  const g = expect('blink GET: funding', await call('GET', blink), 200)
  if (g.json.disabled) rows.push({ label: 'blink GET: enabled while funding', status: 0, want: [1], note: JSON.stringify(g.json.error) })
  // The unit buttons carry live prices, from the cached curve read.
  const priced = (g.json.links?.actions ?? []).filter((a: { label?: string }) => /^Back (1|2) · \$\d/.test(a.label ?? ''))
  if (priced.length !== 2) rows.push({ label: 'blink GET: priced unit buttons', status: 0, want: [1], note: JSON.stringify(g.json.links?.actions?.map((a: { label?: string }) => a.label)) })
  expect('blink GET: unknown', await call('GET', `/api/actions/back/${stranger}`), 404)
  expect('blink POST: amount "abc"', await call('POST', `${blink}?amount=abc`, { account: pk(backer1) }), 400)
  expect('blink POST: bad account', await call('POST', `${blink}?amount=5`, { account: 'x' }), 400)
  expect('blink POST: no body', await call('POST', `${blink}?amount=5`, ''), 400)
  expect('blink POST: ok', await call('POST', `${blink}?amount=5`, { account: pk(backer1) }), 200)
  expect('blink POST: units 1', await call('POST', `${blink}?units=1`, { account: pk(backer1) }), 200)
  expect('blink POST: units 0.5', await call('POST', `${blink}?units=0.5`, { account: pk(backer1) }), 400)

  // --- redemptions and orders (funding: nothing is redeemable yet)
  const shipping = { name: 'Ada', email: '', address: '1 St', country: 'X' }
  // Their own client IP: these share the transaction-build bucket with everything above.
  const redeemIp = { 'x-forwarded-for': ip() }
  const prepare = (body: Record<string, unknown>) => call('POST', '/api/redemptions/prepare', { pool, wallet: pk(backer1), shipping, ...body }, redeemIp)
  const submit = (body: Record<string, unknown>) => call('POST', '/api/redemptions/submit', { pool, shipping, ...body }, redeemIp)
  const confirm = (body: Record<string, unknown>) => call('POST', '/api/redemptions/confirm', body, redeemIp)
  const signB64 = (b64: string, k: Keypair, payer?: Keypair) => {
    const t = Transaction.from(Buffer.from(b64, 'base64'))
    if (payer) t.feePayer = payer.publicKey
    t.partialSign(payer ?? k)
    return t.serialize({ requireAllSignatures: false }).toString('base64')
  }
  expect('redeem prepare: missing fields', await prepare({ shipping: { name: 'a' } }), 400)
  expect('redeem prepare: bad email', await prepare({ shipping: { ...shipping, email: 'no' } }), 400)
  expect('redeem prepare: unknown campaign', await prepare({ pool: stranger }), 404)
  expect('redeem prepare: before graduation', await prepare({}), 409)
  expect('redeem submit: not a transaction', await submit({ id: 'AAAAAAAAAAAAAAAA', tx: 'AAAA' }), 400)
  expect('redeem submit: not base64', await submit({ id: 'AAAAAAAAAAAAAAAA', tx: 'not base64!' }), 400)
  expect('redeem confirm: bad id', await confirm({ id: '../x', signature: createSig }), 400)
  expect('redeem confirm: bad signature', await confirm({ id: 'AAAAAAAAAAAAAAAA', signature: 'x' }), 400)
  expect('redeem confirm: unknown id', await confirm({ id: 'AAAAAAAAAAAAAAAA', signature: createSig }), 404)
  expect('redeem pending: bad wallet', await call('GET', `/api/redemptions/pending?pool=${pool}&wallet=x`, undefined, redeemIp), 400)
  expect('redeem pending: unknown campaign', await call('GET', `/api/redemptions/pending?pool=${stranger}&wallet=${pk(backer1)}`, undefined, redeemIp), 404)
  expect('redeem pending: none', await call('GET', `/api/redemptions/pending?pool=${pool}&wallet=${pk(backer1)}`, undefined, redeemIp), 200)
  expect('tx redeem: memo-less burn refused', await call('POST', '/api/tx', { pool, wallet: pk(backer1), kind: 'redeem' }, redeemIp), 400)
  expect('orders: no message', await call('POST', '/api/redemptions/signin', { pool }), 400)
  expect('orders: list without a session', await call('POST', '/api/redemptions/list', { pool }), 401)
  expect('orders: list with a made-up session', await call('POST', '/api/redemptions/list', { pool }, { authorization: `Bearer ${'A'.repeat(43)}` }), 401)
  expect('orders: nonce, unknown campaign', await call('POST', '/api/redemptions/nonce', { pool: stranger }, { 'x-forwarded-for': ip() }), 404)
  const host = new URL(BASE).host
  const sign = (message: string, k = maker) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), k.secretKey))
  const nonce = async () => (await call('POST', '/api/redemptions/nonce', { pool }, { 'x-forwarded-for': ip() })).json.nonce as string
  // Signs a message built by `build(nonce)` and trades it for a session (a fresh nonce each time).
  const signIn = async (build: (n: string) => string, k = maker) => {
    const message = build(await nonce())
    return call('POST', '/api/redemptions/signin', { pool, message, signature: sign(message, k) }, { 'x-forwarded-for': ip() })
  }
  const now = () => new Date().toISOString()
  expect('orders: wrong signer', await signIn((n) => ordersMessage(pool, now(), host, n), backer1), 403)
  expect('orders: other site', await signIn((n) => ordersMessage(pool, now(), 'evil.example', n)), 403)
  expect('orders: dated ahead', await signIn((n) => ordersMessage(pool, new Date(Date.now() + 9 * 60_000).toISOString(), host, n)), 403)
  expect('orders: undated', await signIn((n) => ordersMessage(pool, 'NaN', host, n)), 403)
  expect('orders: substring', await signIn(() => `gm ${pool}\nIssued at: ${now()}`), 403)
  expect('orders: made-up nonce', await signIn(() => ordersMessage(pool, now(), host, 'A'.repeat(22))), 403)
  const opened = expect('orders: maker signs in', await signIn((n) => ordersMessage(pool, now(), host, n)), 200)
  const session = { authorization: `Bearer ${opened.json.token}` }
  expect('orders: maker', await call('POST', '/api/redemptions/list', { pool }, session), 200)
  // A signed message works once: the same one traded again is refused.
  const spentMessage = ordersMessage(pool, now(), host, await nonce())
  const spentBody = { pool, message: spentMessage, signature: sign(spentMessage) }
  expect('orders: sign-in once', await call('POST', '/api/redemptions/signin', spentBody, { 'x-forwarded-for': ip() }), 200)
  expect('orders: sign-in replayed', await call('POST', '/api/redemptions/signin', spentBody, { 'x-forwarded-for': ip() }), 403)
  // A session belongs to the maker wallet that signed it, and to one campaign.
  const other = await call('POST', '/api/redemptions/list', { pool: stranger }, session)
  expect('orders: session for another campaign', other, 404, 403)
  expect('orders: sign out', await call('POST', '/api/redemptions/signout', {}, session), 200)
  expect('orders: list after sign out', await call('POST', '/api/redemptions/list', { pool }, session), 401)
  const reopened = expect('orders: maker signs in again', await signIn((n) => ordersMessage(pool, now(), host, n)), 200)
  const makerSession = { authorization: `Bearer ${reopened.json.token}` }

  // --- fund to the goal: funded state
  const buy = expect('tx buy: to the goal', await tx({ kind: 'buy', usdc: 40 }), 200)
  await signSend(buy.json.tx, backer1)
  await new Promise((r) => setTimeout(r, 3500)) // past the live-state cache
  const funded = await live(pool)
  rows.push({ label: 'status after the goal', status: funded.status === 'funded' ? 200 : 0, want: [200], note: funded.status })
  expect('quote: funded', await call('POST', '/api/quote', { pool, usdc: 1 }), 409)
  expect('tx buy: funded', await tx({ kind: 'buy', usdc: 1 }), 409)
  expect('tx sell: funded', await tx({ kind: 'sell' }), 409)
  const gf = expect('blink GET: funded', await call('GET', blink), 200)
  if (!gf.json.disabled || !/reached its goal/.test(gf.json.error?.message)) rows.push({ label: 'blink GET: funded copy', status: 0, want: [1], note: JSON.stringify(gf.json.error) })
  expect('blink POST: funded', await call('POST', `${blink}?amount=5`, { account: pk(backer2) }), 422)

  // --- graduate (backer2 pays): reselling state
  const mig = expect('migrate: by backer2', await call('POST', `/api/campaigns/${pool}/migrate`, { wallet: pk(backer2) }), 200)
  if (mig.json.tx) await signSend(mig.json.tx, backer2)
  // Right after the graduation, before the live-state cache expires: gates and ?fresh=1 already see it.
  expect('tx withdraw: maker right after graduation', await call('POST', '/api/tx', { kind: 'withdraw', pool, wallet: pk(maker) }), 200)
  const fresh = expect('campaign: ?fresh=1 after graduation', await call('GET', `/api/campaigns/${pool}?fresh=1`), 200)
  if (fresh.json.campaign?.live?.status !== 'reselling') rows.push({ label: 'campaign: fresh read shows reselling', status: 0, want: [1], note: fresh.json.campaign?.live?.status })
  await new Promise((r) => setTimeout(r, 3500))
  expect('migrate: again', await call('POST', `/api/campaigns/${pool}/migrate`, { wallet: pk(backer2) }), 200)
  expect('resale quote: reselling', await call('POST', '/api/resale/quote', { pool, side: 'buy', amount: 1 }), 200)
  expect('tx resaleBuy: reselling', await call('POST', '/api/tx', { kind: 'resaleBuy', pool, wallet: pk(backer2), usdc: 1 }), 200)
  expect('quote units: reselling', await call('POST', '/api/quote/units', { pool, units: 1 }), 409)
  expect('tx buyUnits: reselling', await tx({ kind: 'buyUnits', units: 1 }), 409)
  expect('tx unlock: by a backer', await tx({ kind: 'unlock' }), 400)
  // Before the cliff there is nothing to unlock (400); a localnet VESTING_SCHEDULE_OVERRIDE may have passed it.
  expect('tx unlock: maker', await call('POST', '/api/tx', { kind: 'unlock', pool, wallet: pk(maker) }), 400, 200)
  expect('tx withdraw: maker after graduation', await call('POST', '/api/tx', { kind: 'withdraw', pool, wallet: pk(maker) }), 200)
  expect('tx withdraw: backer', await tx({ kind: 'withdraw' }), 400)
  expect('tx sell: reselling', await tx({ kind: 'sell' }), 409)
  // --- redemption after graduation: prepare, sign, submit; a hijack of that burn; the maker's orders
  // Anyone may prepare in the backer's name, as often as the IP limit allows: nothing is stored, so it
  // locks no one out.
  const thirdParty = { 'x-forwarded-for': ip() }
  for (let i = 0; i < 6; i++) {
    expect('redeem prepare: a third party, backer’s wallet', await call('POST', '/api/redemptions/prepare', { pool, wallet: pk(backer1), shipping }, thirdParty), 200)
  }
  const prep = expect('redeem prepare: reselling', await prepare({}), 200)
  if (prep.status === 200) {
    expect('redeem submit: unsigned', await submit({ id: prep.json.id, tx: prep.json.tx }), 400)
    expect('redeem submit: signed by someone else', await submit({ id: prep.json.id, tx: signB64(prep.json.tx, backer1, backer2) }), 400)
    const signedBurn = signB64(prep.json.tx, backer1)
    expect('redeem submit: for another id', await submit({ id: 'AAAAAAAAAAAAAAAA', tx: signedBurn }), 400)
    const done = expect('redeem submit: ok', await submit({ id: prep.json.id, tx: signedBurn }), 200)
    expect('redeem submit: again, other shipping', await submit({ id: prep.json.id, tx: signedBurn, shipping: { ...shipping, name: 'Mallory' } }), 200)
    const burn: string = done.json.signature ?? createSig
    expect('redeem confirm: again', await confirm({ id: prep.json.id, signature: burn }), 200)
    const forged = expect('redeem prepare: hijacker, backer’s wallet', await prepare({ shipping: { ...shipping, name: 'Mallory' } }), 200, 400)
    if (forged.status === 200) expect('redeem confirm: hijack with the backer’s burn', await confirm({ id: forged.json.id, signature: burn }), 404)
    const list = expect('orders: maker after a redemption', await call('POST', '/api/redemptions/list', { pool }, makerSession), 200)
    if (list.json.redemptions?.[0]?.shipping?.name !== 'Ada') rows.push({ label: 'orders: shows the owner’s shipping', status: 0, want: [1], note: JSON.stringify(list.json.redemptions) })
    const shipped = (order: string) => call('POST', '/api/redemptions/shipped', { pool, order }, makerSession)
    expect('orders: mark shipped', await shipped(burn), 200)
    expect('orders: mark shipped, unknown order', await shipped(createSig), 404)
  }
  expect('redeem prepare: the maker', await prepare({ wallet: pk(maker) }), 409)
  expect('redeem prepare: no vouchers', await prepare({ wallet: stranger }), 400)
  const gr = expect('blink GET: reselling', await call('GET', blink), 200)
  if (!gr.json.disabled || !/resale market/.test(gr.json.error?.message)) rows.push({ label: 'blink GET: reselling copy', status: 0, want: [1], note: JSON.stringify(gr.json.error) })
  expect('blink POST: reselling', await call('POST', `${blink}?amount=5`, { account: pk(backer2) }), 422)

  // --- rate limit: 30 rapid previews from one IP
  if (limitsOn) {
    const burstIp = ip()
    const burst = await Promise.all(Array.from({ length: 30 }, () => call('POST', '/api/preview', { campaign }, { 'x-forwarded-for': burstIp })))
    const limited = burst.filter((r) => r.status === 429).length
    rows.push({ label: `preview: 30 rapid calls (${limited} × 429)`, status: limited > 0 ? 429 : 200, want: [429], note: '' })
    for (const r of burst) if (r.status >= 500) rows.push({ label: 'preview burst', status: r.status, want: [200, 429], note: JSON.stringify(r.json) })
    const txIp = ip()
    const txBurst = await Promise.all(Array.from({ length: 40 }, () => call('POST', '/api/tx', { kind: 'steal' }, { 'x-forwarded-for': txIp })))
    const txLimited = txBurst.filter((r) => r.status === 429).length
    rows.push({ label: `tx: 40 rapid calls (${txLimited} × 429)`, status: txLimited > 0 ? 429 : 200, want: [429], note: '' })
  } else {
    console.log('Rate limits are off on this server (RATE_LIMITS=off): skipping the 429 checks.')
  }
}

main()
  .catch((e) => {
    rows.push({ label: 'script', status: 0, want: [1], note: e instanceof Error ? e.message.slice(0, 200) : String(e) })
  })
  .finally(() => {
    for (const r of rows) {
      const ok = r.want.includes(r.status) ? 'ok  ' : 'FAIL'
      console.log(`${ok} ${String(r.status).padEnd(4)} ${r.label.padEnd(44)} ${r.note}`)
    }
    const fiveHundreds = rows.filter((r) => r.status >= 500)
    const failed = rows.filter((r) => !r.want.includes(r.status))
    console.log(`\n${rows.length} checks, ${failed.length} failed, ${fiveHundreds.length} answered 5xx`)
    process.exit(failed.length || fiveHundreds.length ? 1 : 0)
  })
