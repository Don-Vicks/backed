// Request handling shared by the web API routes: a body size limit, zod schemas for every JSON body,
// the client IP and per-route rate limits. Pure (no RPC), so all of it is unit-tested here.
import bs58 from 'bs58'
import { z } from 'zod'
import { PublicKey } from '@solana/web3.js'
import { HttpError } from './errors'
import { MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS } from './swaps'

// Route handlers have no body limit of their own; every JSON body here is far below this.
export const MAX_BODY_BYTES = 32 * 1024

// Reads at most maxBytes of the body (Content-Length is a hint, the stream is what counts) and parses
// it as JSON. With `optional`, an empty body reads as {}.
export async function readJsonBody(req: Request, maxBytes = MAX_BODY_BYTES, opts: { optional?: boolean } = {}): Promise<unknown> {
  const tooLarge = () => new HttpError(`Request body is larger than ${Math.round(maxBytes / 1024)} KB`, 413)
  if (Number(req.headers.get('content-length')) > maxBytes) throw tooLarge()
  const chunks: Uint8Array[] = []
  let size = 0
  if (req.body) {
    const reader = req.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(value)
    }
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text && opts.optional) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError('Request body must be JSON', 400)
  }
}

// zod's own messages name the field; ours (set per field below) are already sentences.
function issueMessage(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.')
  return path && /^(Invalid|Too (big|small)|Unrecognized)/.test(issue.message) ? `${path}: ${issue.message}` : issue.message
}

// For callers outside this package (the web routes), which do not depend on zod themselves.
export type BodySchema = z.ZodType
export type BodyOf<S extends BodySchema> = z.output<S>

// Parses a value with a schema, or throws a 400 HttpError with the first problem.
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(issueMessage(result.error.issues[0]), 400)
  return result.data
}

export const addressSchema = (what: string) =>
  z.string({ error: `${what} is missing` }).transform((s, ctx) => {
    try {
      return new PublicKey(s.trim())
    } catch {
      ctx.addIssue({ code: 'custom', message: `${what} is not a valid Solana address` })
      return z.NEVER
    }
  })

export const signatureSchema = z.string({ error: 'signature is missing' }).refine((s) => {
  try {
    return bs58.decode(s).length === 64
  } catch {
    return false
  }
}, 'signature is not a valid transaction signature')

// A UI amount (USDC or vouchers). The upper bound keeps raw amounts exact; the curve and the wallet
// balance limit real amounts long before it.
export const MAX_AMOUNT = 1_000_000_000
export const amountSchema = z
  .number({ error: 'Enter an amount' })
  .positive({ error: 'Enter an amount' })
  .max(MAX_AMOUNT, { error: 'Amount is too large' })

const slippage = z
  .number({ error: 'slippageBps must be a number' })
  .int({ error: 'slippageBps must be a whole number' })
  .min(MIN_SLIPPAGE_BPS, { error: `slippageBps must be from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}` })
  .max(MAX_SLIPPAGE_BPS, { error: `slippageBps must be from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}` })
  .optional()

const side = z.enum(['buy', 'sell'], { error: 'side must be buy or sell' })
const text = (what: string, max: number) => z.string({ error: `${what} must be text` }).trim().max(max, { error: `${what} is too long (at most ${max} characters)` })
const REQUIRED_SHIPPING = 'Name, address and country are required'
const shippingField = (what: string, max: number) =>
  z.string({ error: REQUIRED_SHIPPING }).trim().min(1, { error: REQUIRED_SHIPPING }).max(max, { error: `${what} is too long (at most ${max} characters)` })

// One schema per route body. Unknown keys are dropped; campaign is checked by campaignFromInput.
export const schemas = {
  createCampaign: z.object({ campaign: z.unknown(), maker: addressSchema('maker') }),
  preview: z.object({ campaign: z.unknown(), maker: addressSchema('maker').optional() }),
  confirmCampaign: z.object({ pool: addressSchema('pool'), signature: signatureSchema }),
  resumeCampaign: z.object({ maker: addressSchema('maker') }),
  migrate: z.object({ wallet: addressSchema('wallet').optional() }),
  quote: z.object({ pool: addressSchema('pool'), side: side.default('buy'), usdc: amountSchema.optional(), vouchers: amountSchema.optional(), slippageBps: slippage }),
  resaleQuote: z.object({ pool: addressSchema('pool'), side, amount: amountSchema, slippageBps: slippage }),
  tx: z.object({
    kind: z.enum(['buy', 'sell', 'redeem', 'withdraw', 'claim', 'resaleBuy', 'resaleSell'], { error: 'Unknown transaction kind' }),
    pool: addressSchema('pool'),
    wallet: addressSchema('wallet'),
    usdc: amountSchema.optional(),
    vouchers: amountSchema.optional(), // sell / resaleSell; sell defaults to the whole balance
    ref: z.string().max(64).optional().catch(undefined), // a bad referral is dropped, never an error
    slippageBps: slippage,
  }),
  faucet: z.object({ wallet: addressSchema('wallet') }),
  redemption: z.object({
    pool: addressSchema('pool'),
    signature: signatureSchema,
    wallet: addressSchema('wallet'),
    shipping: z.object(
      { name: shippingField('name', 100), email: text('email', 200).default(''), address: shippingField('address', 500), country: shippingField('country', 60) },
      { error: REQUIRED_SHIPPING },
    ),
  }),
  ordersSignIn: z.object({ pool: addressSchema('pool'), message: text('message', 500), signature: z.string({ error: 'signature is missing' }).max(200) }),
  blinkPost: z.object({ account: addressSchema('account') }),
  blinkAmount: z.coerce.number({ error: 'Enter an amount in USDC' }).pipe(amountSchema),
}

// The client's IP as the nearest trusted proxy saw it. Each proxy appends the address it received the
// request from to X-Forwarded-For, so the entry `hops` from the right is the one no client can forge;
// the leftmost entries are whatever the client sent. TRUSTED_PROXY_HOPS: 1 behind one proxy (Railway's
// edge, the default), 0 when the server is reached directly (then all requests share one bucket).
export function clientIp(headers: Headers, env: NodeJS.ProcessEnv = process.env): string {
  const hops = env.TRUSTED_PROXY_HOPS?.trim() ? Number(env.TRUSTED_PROXY_HOPS) : 1
  const chain = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!Number.isInteger(hops) || hops < 1 || chain.length === 0) return 'unknown'
  return chain[Math.max(0, chain.length - hops)]
}

// Per-IP token buckets: `capacity` requests at once, refilled at `perSec`. Sized for a person using the
// app (the create form previews on each pause in typing, the quote box on each amount) with room to spare.
export const RATE_LIMITS = {
  create: { capacity: 10, perSec: 1 / 30 },
  preview: { capacity: 20, perSec: 1 },
  quote: { capacity: 30, perSec: 2 },
  faucet: { capacity: 5, perSec: 1 / 60 },
  migrate: { capacity: 5, perSec: 1 / 10 },
  blink: { capacity: 10, perSec: 1 / 2 },
} as const satisfies Record<string, { capacity: number; perSec: number }>

export type RateLimitName = keyof typeof RATE_LIMITS

// Faucet (devnet/localnet): one claim per wallet a day, a few per IP, and a ceiling for everyone, so
// the platform key that pays for it cannot be drained by scripts.
export const FAUCET_LIMITS = { windowMs: 24 * 60 * 60_000, perWallet: 1, perIp: 5, total: 300 }
