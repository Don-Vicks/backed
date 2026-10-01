import { test } from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Keypair } from '@solana/web3.js'
import { BRAND } from '../brand'
import { campaignListing, partnerListing } from '../metadata'
import {
  earnsNoVouchers,
  leftoverVouchers,
  partnerCurveFees,
  partnerMigrationFee,
  partnerSurplus,
  platformTotals,
  platformTreasury,
  poolSurplus,
  type PartnerTerms,
  type PlatformCampaign,
} from '../platform'

const pool = (over: Partial<Parameters<typeof leftoverVouchers>[0]> = {}): Parameters<typeof leftoverVouchers>[0] => ({
  quoteReserve: new BN(35_325_411),
  partnerQuoteFee: new BN(699_306),
  partnerBaseFee: new BN(0),
  creatorBaseFee: new BN(0),
  protocolBaseFee: new BN(0),
  protocolMigrationBaseFeeAmount: new BN(9_419),
  isMigrated: 1,
  isWithdrawLeftover: 0,
  isPartnerWithdrawSurplus: 0,
  migrationFeeWithdrawStatus: 0,
  metrics: { totalTradingQuoteFee: new BN(1_398_610) },
  ...over,
})

const terms = (over: Partial<PartnerTerms> = {}): PartnerTerms => ({
  feeClaimer: Keypair.generate().publicKey,
  leftoverReceiver: Keypair.generate().publicKey,
  migrationQuoteThreshold: new BN(35_325_411),
  creatorTradingFeePct: 50,
  migrationFeePct: 20,
  creatorMigrationFeePct: 100,
  quoteOnlyCurveFees: true,
  ...over,
})

test('partner curve fees: the half the maker does not get, claimed = total − unclaimed', () => {
  assert.deepEqual(partnerCurveFees(pool(), 50), { unclaimed: new BN(699_306), claimed: new BN(0) })
  assert.deepEqual(partnerCurveFees(pool({ partnerQuoteFee: new BN(0) }), 50), { unclaimed: new BN(0), claimed: new BN(699_305) })
  assert.deepEqual(partnerCurveFees(pool({ partnerQuoteFee: new BN(0) }), 0), { unclaimed: new BN(0), claimed: new BN(1_398_610) })
})

test('leftover: the base vault minus fees and Meteora’s migration fee, only after graduation', () => {
  // The localnet measurement: a vault of 9421 raw paid out 2.
  assert.equal(leftoverVouchers(pool(), new BN(9_421)).toNumber(), 2)
  assert.equal(leftoverVouchers(pool({ partnerBaseFee: new BN(1) }), new BN(9_421)).toNumber(), 1)
  assert.equal(leftoverVouchers(pool({ isMigrated: 0 }), new BN(9_421)).toNumber(), 0)
  assert.equal(leftoverVouchers(pool({ isWithdrawLeftover: 1 }), new BN(9_421)).toNumber(), 0)
  assert.equal(leftoverVouchers(pool(), new BN(9_000)).toNumber(), 0, 'never negative')
})

test('surplus: only USDC above the goal, once', () => {
  assert.equal(poolSurplus(pool(), new BN(35_325_411)).toNumber(), 0)
  assert.equal(poolSurplus(pool({ quoteReserve: new BN(36_000_000) }), new BN(35_325_411)).toNumber(), 674_589)
  assert.equal(poolSurplus(pool({ quoteReserve: new BN(36_000_000), isPartnerWithdrawSurplus: 1 }), new BN(35_325_411)).toNumber(), 0)
})

test('partner surplus: 80% after Meteora, split with the maker like curve fees', () => {
  // Meteora's worked example: threshold 100, reserve 105, creator 25% → partner 3 of the 5 surplus.
  const t = terms({ migrationQuoteThreshold: new BN(100_000_000), creatorTradingFeePct: 25 })
  assert.equal(partnerSurplus(pool({ quoteReserve: new BN(105_000_000) }), t).toNumber(), 3_000_000)
  assert.equal(partnerSurplus(pool({ quoteReserve: new BN(105_000_000), isPartnerWithdrawSurplus: 1 }), t).toNumber(), 0)
  assert.equal(partnerSurplus(pool({ quoteReserve: new BN(100_000_000) }), t).toNumber(), 0)
  assert.equal(partnerSurplus(pool({ quoteReserve: new BN(36_000_000) }), terms()).toNumber(), 539_671 - 269_835)
})

test('the fee claimer earns no vouchers only when curve and resale fees are both USDC-only', () => {
  assert.equal(earnsNoVouchers(terms(), { collectFeeMode: 1 }), true)
  assert.equal(earnsNoVouchers(terms(), { collectFeeMode: 0 }), false, 'BothToken resale pool')
  assert.equal(earnsNoVouchers(terms({ quoteOnlyCurveFees: false }), { collectFeeMode: 1 }), false)
  assert.equal(earnsNoVouchers(terms(), null), false, 'resale pool not readable')
})

test('partner migration fee: 0 when the maker takes the whole payout, else the partner part until withdrawn', () => {
  assert.equal(partnerMigrationFee(pool(), terms()).toNumber(), 0)
  const shared = terms({ migrationQuoteThreshold: new BN(100_000_000), migrationFeePct: 20, creatorMigrationFeePct: 75 })
  assert.equal(partnerMigrationFee(pool(), shared).toNumber(), 5_000_000)
  assert.equal(partnerMigrationFee(pool({ migrationFeeWithdrawStatus: 0b100 }), shared).toNumber(), 0)
  assert.equal(partnerMigrationFee(pool({ migrationFeeWithdrawStatus: 0b10 }), shared).toNumber(), 5_000_000, 'the creator bit is not ours')
  assert.equal(partnerMigrationFee(pool({ isMigrated: 0 }), shared).toNumber(), 0)
})

test('totals add up every campaign', () => {
  const c = (n: number): PlatformCampaign => ({
    pool: `p${n}`,
    name: `c${n}`,
    feeClaimer: 'x',
    migrated: true,
    curveFeesUnclaimedUsdc: n,
    curveFeesClaimedUsdc: 2 * n,
    resalePool: null,
    resaleFeesUnclaimedUsdc: 0.5,
    resaleLiquidityUsdc: 10,
    resaleLiquidityVouchers: 1,
    leftoverVouchers: 0.000002,
    leftoverUnburnedVouchers: n === 2 ? 0.000003 : 0,
    surplusUsdc: 0,
    migrationFeeUsdc: 0,
  })
  const t = platformTotals([c(1), c(2)])
  assert.equal(t.curveFeesUnclaimedUsdc, 3)
  assert.equal(t.curveFeesClaimedUsdc, 6)
  assert.equal(t.resaleFeesUnclaimedUsdc, 1)
  assert.equal(t.resaleLiquidityUsdc, 20)
  assert.ok(Math.abs(t.leftoverVouchers - 0.000004) < 1e-12)
  assert.ok(Math.abs(t.leftoverUnburnedVouchers - 0.000003) < 1e-12)
  assert.equal(platformTotals([]).curveFeesUnclaimedUsdc, 0)
})

test('treasury comes from PLATFORM_TREASURY, else the fee claimer', () => {
  const k = Keypair.generate().publicKey
  assert.equal(platformTreasury({}), undefined)
  assert.ok(platformTreasury({ PLATFORM_TREASURY: ` ${k.toBase58()} ` })!.equals(k))
  assert.throws(() => platformTreasury({ PLATFORM_TREASURY: 'not-a-key' }), /PLATFORM_TREASURY/)
})

test('listings: the campaign page as website, the maker image as logo when it is a short https URL', () => {
  const record = { pool: 'Pool1111', campaign: { name: 'Hoodie', image: 'https://cdn.example/h.png' } } as Parameters<typeof campaignListing>[0]
  assert.deepEqual(campaignListing(record, 'https://backed.example'), { name: 'Hoodie', website: 'https://backed.example/c/Pool1111', logo: 'https://cdn.example/h.png' })
  const fallback = 'https://backed.example/blink-icon.svg'
  for (const image of [undefined, '', 'http://cdn.example/h.png', 'data:image/png;base64,AAAA', `https://cdn.example/${'x'.repeat(200)}.png`]) {
    assert.equal(campaignListing({ ...record, campaign: { ...record.campaign, image } }, 'https://backed.example').logo, fallback, String(image))
  }
  assert.deepEqual(partnerListing('https://backed.example'), { name: BRAND, website: 'https://backed.example', logo: fallback })
})
