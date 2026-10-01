import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption, deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { dammV2MigrationConfig, resalePoolAddress } from '../chain'
import { LEGACY_MIGRATION_FEE_OPTION, MIGRATION_FEE_OPTION } from '../engine'
import { RESALE_ROYALTY_BPS, makerRoyaltyBps, resalePoolFeeBps, resaleRoyaltyBps } from '../royalty'
import { LP_SPLIT } from '../vesting'

test('default royalty is 300 bps; campaigns without one get it', () => {
  assert.equal(RESALE_ROYALTY_BPS.default, 300)
  assert.equal(resaleRoyaltyBps({}), 300)
  assert.equal(resaleRoyaltyBps({ resaleRoyaltyBps: 1000 }), 1000)
  assert.throws(() => resaleRoyaltyBps({ resaleRoyaltyBps: 99 }), /resale royalty/)
})

test('pool fee: the config’s own fee when Customizable, else the fixed DAMM v2 rate', () => {
  assert.equal(resalePoolFeeBps(MigrationFeeOption.Customizable, 450), 450)
  assert.equal(resalePoolFeeBps(MigrationFeeOption.FixedBps200, 0), 200)
  assert.equal(resalePoolFeeBps(MigrationFeeOption.FixedBps25, 0), 25)
  assert.equal(resalePoolFeeBps(MigrationFeeOption.FixedBps600, 0), 600)
  assert.throws(() => resalePoolFeeBps(7, 0), /unknown migration fee option/)
})

test('maker royalty = pool fee × (1 − protocol share) × maker liquidity share', () => {
  const atGraduation = (100 - LP_SPLIT.partnerPermanentPct) * 100
  const unlocked = (LP_SPLIT.creatorPermanentPct * 10_000) / (LP_SPLIT.creatorPermanentPct + LP_SPLIT.partnerPermanentPct)
  // 5% fee, 20% to Meteora: the LP fee is 4%, the maker's 95% of it is 3.8%, then 75% of it is 3%.
  assert.equal(makerRoyaltyBps(500, 20, atGraduation), 380)
  assert.equal(makerRoyaltyBps(500, 20, unlocked), 300)
  assert.equal(makerRoyaltyBps(300, 20, atGraduation), 228)
  assert.equal(makerRoyaltyBps(300, 0, 10_000), 300)
})

test('the resale pool address follows the migration fee option; old campaigns keep the fixed 2% pool', () => {
  const [base, usdc] = [Keypair.generate().publicKey, Keypair.generate().publicKey]
  assert.equal(MIGRATION_FEE_OPTION, MigrationFeeOption.Customizable)
  assert.equal(dammV2MigrationConfig(MigrationFeeOption.Customizable).toBase58(), 'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck')
  assert.equal(dammV2MigrationConfig(LEGACY_MIGRATION_FEE_OPTION).toBase58(), '2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq')
  const legacy = resalePoolAddress(base, usdc, LEGACY_MIGRATION_FEE_OPTION)
  const custom = resalePoolAddress(base, usdc, MigrationFeeOption.Customizable)
  assert.ok(!legacy.equals(custom))
  assert.ok(custom.equals(deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[6], base, usdc)))
  assert.throws(() => dammV2MigrationConfig(9 as MigrationFeeOption), /no DAMM v2 migration config/)
})
