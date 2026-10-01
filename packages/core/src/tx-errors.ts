// Plain-language messages for the transaction errors people actually hit, instead of raw simulation
// logs. Pure (no SDK), so the browser bundle can use it. Program error codes are taken from the IDLs;
// __tests__/tx-errors.test.ts checks them against the ones the SDKs ship.

// DBC (curve) custom errors. DAMM v2 (resale) uses the same 6002 for ExceededSlippage.
export const DBC_ERROR_CODES = { ExceededSlippage: 6002, AmountIsZero: 6005, NotEnoughLiquidity: 6012, PoolIsCompleted: 6013 } as const
// Anchor framework error: an account the instruction reads (here: the wallet's USDC account) does not exist.
export const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012 // 0xbc4
// SPL Token InsufficientFunds and System Program ResultWithNegativeLamports are both custom error 1.
export const INSUFFICIENT_FUNDS = 1 // 0x1

// The custom program error code in a wallet or RPC error message, in any of the forms they use:
// "custom program error: 0x1772", {"Custom":6002}, "Error Number: 6002".
export function customErrorCode(message: string): number | null {
  const hex = /custom program error: (0x[0-9a-f]+)/i.exec(message)
  if (hex) return parseInt(hex[1], 16)
  const dec = /"Custom":\s*(\d+)|Error Number: (\d+)/.exec(message)
  return dec ? Number(dec[1] ?? dec[2]) : null
}

// The blockhash ran out before the transaction landed (a slow wallet prompt, or a congested network).
export const isExpiredTxError = (message: string) =>
  /block height exceeded|blockhash not found|has expired|TransactionExpired/i.test(message)

export const isUserRejection = (message: string) => /user rejected|rejected the request|user denied|cancelled by user/i.test(message)

// A sentence for the toast, or null when the error is not one we know (the caller shows a generic line
// and logs the raw error).
export function friendlyTxError(message: string): string | null {
  if (isExpiredTxError(message)) return 'The transaction expired before it landed. Try again.'
  if (/no record of a prior credit|insufficient lamports|insufficient funds for (fee|rent)/i.test(message)) {
    return 'Your wallet needs a little SOL for network fees.'
  }
  switch (customErrorCode(message)) {
    case INSUFFICIENT_FUNDS:
      return 'Not enough funds in your wallet for this amount.'
    case ANCHOR_ACCOUNT_NOT_INITIALIZED:
      return 'Your wallet has no USDC account yet. Get some USDC first.'
    case DBC_ERROR_CODES.ExceededSlippage:
      return 'The price moved past your slippage limit. Check the new quote and try again.'
    case DBC_ERROR_CODES.PoolIsCompleted:
      return 'This campaign has reached its goal, so the curve no longer trades.'
    case DBC_ERROR_CODES.NotEnoughLiquidity:
      return 'Not enough liquidity on the curve for this amount.'
    case DBC_ERROR_CODES.AmountIsZero:
      return 'Amount is too small.'
    default:
      return null
  }
}
