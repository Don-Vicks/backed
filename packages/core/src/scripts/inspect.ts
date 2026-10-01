// Decodes a DBC config, a DBC pool (with its config and, once graduated, the DAMM v2 resale pool and
// its positions per owner) or a DAMM v2 pool, on the current NETWORK.
//   pnpm --filter @preorder/core inspect <address> [--json]
import { PublicKey } from '@solana/web3.js'
import { getConnection, getNetwork } from '../network'
import { inspectAddress, type ConfigView, type PoolView, type ResalePoolView, type VestingView } from '../inspect'

const vesting = (v: VestingView) =>
  v.initialized ? `${v.vestingPercentage}%, cliff ${v.cliffSec}s, ${v.numberOfPeriods} × ${v.frequencySec}s at ${v.bpsPerPeriod} bps` : 'none'

function printConfig(c: ConfigView) {
  console.log(`config ${c.address}`)
  console.log(`  quote mint          ${c.quoteMint}`)
  console.log(`  fee claimer         ${c.feeClaimer} (leftover → ${c.leftoverReceiver})`)
  console.log(`  base fee            ${c.baseFee.mode}, starts at ${c.baseFee.startBps} bps (periods ${c.baseFee.firstFactor}, ${c.baseFee.secondFactor}, ${c.baseFee.thirdFactor})`)
  console.log(`  dynamic fee         ${c.dynamicFee ? 'on' : 'off'}; creator gets ${c.creatorTradingFeePct}% of trading fees`)
  console.log(`  goal                ${c.goalUsdc} USDC (migrationQuoteThreshold)`)
  console.log(`  migration           ${c.migrationOption}, ${c.migrationFeeOption}; fee ${c.migrationFee.pct}% (creator ${c.migrationFee.creatorPct}%)`)
  console.log(`  supply raw          pre ${c.supply.preMigration}, post ${c.supply.postMigration}`)
  console.log(`  LP partner          ${c.lp.partnerPct}% liquid, ${c.lp.partnerLockedPct}% locked forever, vesting ${vesting(c.partnerVesting)}`)
  console.log(`  LP creator          ${c.lp.creatorPct}% liquid, ${c.lp.creatorLockedPct}% locked forever, vesting ${vesting(c.creatorVesting)}`)
}

function printResale(r: ResalePoolView) {
  console.log(`DAMM v2 pool ${r.address}: liquidity ${r.liquidity}, permanently locked ${r.permanentLockLiquidity}`)
  for (const p of r.positions) {
    console.log(`  ${(p.role === 'other' ? 'holder' : p.role).padEnd(7)} ${p.owner ?? '(unknown owner)'}  position ${p.position}`)
    console.log(`          ${p.sharePct}% of the pool: permanentLockedLiquidity ${p.permanentLockedPct}%, vested ${p.vestedPct}%, unlocked ${p.unlockedLiquidity}`)
  }
}

function printPool(p: PoolView) {
  console.log(`DBC pool ${p.address}`)
  console.log(`  creator (maker)     ${p.creator}`)
  console.log(`  voucher mint        ${p.baseMint}`)
  console.log(`  reserves            ${p.quoteReserveUsdc} USDC, ${p.baseReserveUnits} vouchers`)
  console.log(`  migrated            ${p.migrated} (migration fee withdraw bits ${p.migrationFeeWithdrawStatus.toString(2)})`)
  printConfig(p.config)
  if (p.resale) printResale(p.resale)
}

async function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  if (!arg) throw new Error('usage: inspect <dbc pool | dbc config | damm v2 pool> [--json]')
  const result = await inspectAddress(getConnection(), new PublicKey(arg))
  if (process.argv.includes('--json')) return console.log(JSON.stringify(result, null, 2))
  console.log(`network ${getNetwork().name}`)
  if (result.kind === 'dbc-pool') printPool(result.pool)
  else if (result.kind === 'dbc-config') printConfig(result.config)
  else printResale(result.pool)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
