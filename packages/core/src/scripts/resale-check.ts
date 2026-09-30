// Exercises the resale module on a graduated campaign: read, quote, buy, sell, maker claim.
import { getConnection } from '../network'
import { loadWallets } from '../wallets'
import { send } from '../tx'
import { getCampaign } from '../store'
import { buildMakerClaimTx, buildResaleSwapTx, quoteResale, readResale } from '../resale'

async function main() {
  const pool = process.argv[2]
  const record = getCampaign(pool)
  if (!record) throw new Error('unknown campaign ' + pool)
  const c = getConnection()
  const w = loadWallets()
  const show = async (label: string) => {
    const r = await readResale(c, record)
    console.log(`${label}: price $${r!.priceUsdc.toFixed(4)} · pool ${r!.vouchersInPool.toFixed(3)} vouchers / $${r!.usdcInPool.toFixed(3)} · maker ${JSON.stringify(r!.maker)}`)
  }
  await show('before')
  const qb = await quoteResale(c, record, 'buy', 2)
  console.log(`quote buy $2 → ${qb.out.toFixed(4)} vouchers (min ${qb.minOut.toFixed(4)}), impact ${qb.priceImpactPct.toFixed(2)}%`)
  await send(c, await buildResaleSwapTx(c, record, w.backer3.publicKey, 'buy', 2), [w.backer3], 'backer3 buys $2 of vouchers on resale')
  const qs = await quoteResale(c, record, 'sell', 0.2)
  console.log(`quote sell 0.2 → $${qs.out.toFixed(4)}`)
  await send(c, await buildResaleSwapTx(c, record, w.backer3.publicKey, 'sell', 0.2), [w.backer3], 'backer3 sells 0.2 vouchers on resale')
  await show('after trades')
  const claim = await buildMakerClaimTx(c, record)
  if (claim) await send(c, claim, [w.maker], 'maker claims curve + resale fees')
  else console.log('nothing to claim')
  await show('after claim')
}
main().catch((e) => { console.error('FAILED', e.stack ?? e); process.exit(1) })
