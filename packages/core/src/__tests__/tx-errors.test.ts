import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DynamicBondingCurveIdl } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk'
import { ANCHOR_ACCOUNT_NOT_INITIALIZED, DBC_ERROR_CODES, customErrorCode, friendlyTxError, isExpiredTxError } from '../tx-errors'

const code = (idl: { errors?: { code: number; name: string }[] }, name: string) => idl.errors?.find((e) => e.name === name)?.code

test('error codes match the IDLs the SDKs ship', () => {
  for (const [name, value] of Object.entries(DBC_ERROR_CODES)) assert.equal(code(DynamicBondingCurveIdl, name), value, name)
  // The resale pool (DAMM v2) reports slippage with the same code.
  assert.equal(code(CpAmmIdl, 'ExceededSlippage'), DBC_ERROR_CODES.ExceededSlippage)
  assert.equal(ANCHOR_ACCOUNT_NOT_INITIALIZED, 0xbc4)
})

test('custom error codes are read from every message form', () => {
  assert.equal(customErrorCode('Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1772'), 6002)
  assert.equal(customErrorCode('Transaction failed on-chain: {"InstructionError":[1,{"Custom":6013}]}'), 6013)
  assert.equal(customErrorCode('AnchorError caused by account: input_token_account. Error Code: AccountNotInitialized. Error Number: 3012.'), 3012)
  assert.equal(customErrorCode('fetch failed'), null)
})

test('known failures read as plain language; unknown ones are left to the caller', () => {
  assert.match(friendlyTxError('custom program error: 0x1')!, /Not enough funds/)
  assert.match(friendlyTxError('custom program error: 0xbc4')!, /no USDC account/)
  assert.match(friendlyTxError('custom program error: 0x1772')!, /slippage/)
  assert.match(friendlyTxError('{"InstructionError":[2,{"Custom":6013}]}')!, /reached its goal/)
  assert.match(friendlyTxError('Attempt to debit an account but found no record of a prior credit.')!, /SOL for network fees/)
  assert.match(friendlyTxError('Signature 5x… has expired: block height exceeded.')!, /expired/)
  assert.ok(isExpiredTxError('TransactionExpiredBlockheightExceededError'))
  assert.ok(isExpiredTxError('Blockhash not found'))
  assert.equal(friendlyTxError('Something odd'), null)
})
