// What a maker may choose for a new campaign, and the parser that builds a Campaign from an untrusted
// request body. Only allowlisted fields get through, so nothing a client sends can reach the DBC config
// unchecked. Pure (no SDK), so the create form shares the same limits.
import { MAX_TIERS, priceTiers, validatePlan, type TierPlan } from './pricing'
import type { Campaign } from './engine'

// Launch (drop-bot) fee: the same for every campaign. It starts at 15% and falls to 1% over a short
// window the maker picks; the 1% stays for the rest of the curve.
export const DROP_BOT_START_FEE_BPS = 1500
export const NORMAL_FEE_BPS = 100
export const DROP_BOT_WINDOWS_SEC = [60, 120, 300] as const
export const DEFAULT_DROP_BOT_WINDOW_SEC = 120

// Metaplex limits on the token name and symbol; the symbol is also shown as a ticker.
export const NAME_MAX_BYTES = 32
export const SYMBOL_PATTERN = /^[A-Z0-9]{1,10}$/
export const DESCRIPTION_MAX_CHARS = 1000
export const IMAGE_URL_MAX_CHARS = 200
const MAX_UNITS_PER_TIER = 1_000_000
const MIN_PRICE = 0.01
const MAX_PRICE = 1_000_000
// Whole-plan bounds, so an in-range but extreme plan gets a clear message instead of an SDK error.
// Both ends were simulated against the mainnet DBC program on localnet.
export const MAX_GOAL_USDC = 10_000_000
export const MAX_PRICE_RATIO = 100 // final price / first early-bird price

// Throws unless the fee schedule is the fixed launch fee with an allowed window. Configs are immutable,
// so this is the only point where a predatory fee (say 90% for good) can be stopped.
export function checkLaunchFee(campaign: Pick<Campaign, 'dropBot' | 'normalFeeBps'>): void {
  const { startFeeBps, windowSec } = campaign.dropBot ?? {}
  if (startFeeBps !== DROP_BOT_START_FEE_BPS || campaign.normalFeeBps !== NORMAL_FEE_BPS) {
    throw new Error(`the launch fee is fixed: ${DROP_BOT_START_FEE_BPS / 100}% falling to ${NORMAL_FEE_BPS / 100}%`)
  }
  if (!(DROP_BOT_WINDOWS_SEC as readonly number[]).includes(windowSec as number)) {
    throw new Error(`the launch-fee window must be one of ${DROP_BOT_WINDOWS_SEC.join(', ')} seconds`)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function numberIn(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} must be a number`)
  if (v < min || v > max) throw new Error(`${what} must be between ${min} and ${max}`)
  return v
}

function optionalString(v: unknown, what: string): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new Error(`${what} must be text`)
  return v.trim()
}

// Builds the campaign from a request body. The server sets the metadata uri and the fees; the client's
// fee fields, if sent at all, must equal the fixed ones. Unknown fields are dropped.
export function campaignFromInput(input: unknown, uri: string): Campaign {
  if (!isObject(input)) throw new Error('campaign is missing')

  const name = optionalString(input.name, 'name')
  if (!name) throw new Error('Name the product')
  if (new TextEncoder().encode(name).length > NAME_MAX_BYTES) throw new Error(`name must be at most ${NAME_MAX_BYTES} bytes`)
  const symbol = optionalString(input.symbol, 'ticker').toUpperCase()
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error('ticker must be 1–10 letters or digits')
  const description = optionalString(input.description, 'description')
  if (description.length > DESCRIPTION_MAX_CHARS) throw new Error(`description must be at most ${DESCRIPTION_MAX_CHARS} characters`)
  const image = optionalString(input.image, 'image URL')
  if (image) {
    let url: URL | null = null
    try {
      url = new URL(image)
    } catch {}
    if (!url || url.protocol !== 'https:') throw new Error('image URL must start with https://')
    if (image.length > IMAGE_URL_MAX_CHARS) throw new Error(`image URL must be at most ${IMAGE_URL_MAX_CHARS} characters`)
  }

  const rawPlan = input.plan
  if (!isObject(rawPlan) || !Array.isArray(rawPlan.tiers)) throw new Error('plan is missing')
  if (rawPlan.tiers.length > MAX_TIERS) throw new Error(`at most ${MAX_TIERS} tiers`)
  const plan: TierPlan = {
    tiers: rawPlan.tiers.map((t, i) => {
      if (!isObject(t)) throw new Error(`tier ${i + 1} is missing`)
      return {
        units: numberIn(t.units, `tier ${i + 1} units`, 1, MAX_UNITS_PER_TIER),
        startPrice: numberIn(t.startPrice, `tier ${i + 1} price`, MIN_PRICE, MAX_PRICE),
      }
    }),
    finalPrice: numberIn(rawPlan.finalPrice, 'final price', MIN_PRICE, MAX_PRICE),
    makerSharePct: numberIn(rawPlan.makerSharePct, 'maker share', 0, 50),
  }
  validatePlan(plan) // whole units, rising prices, whole-percent share
  if (plan.finalPrice > plan.tiers[0].startPrice * MAX_PRICE_RATIO) {
    throw new Error(`the final price can be at most ${MAX_PRICE_RATIO}× the first tier's price`)
  }
  if (priceTiers(plan).goalUsdc > MAX_GOAL_USDC) throw new Error(`the goal can be at most ${MAX_GOAL_USDC.toLocaleString('en-US')} USDC`)

  // Fee fields a client leaves out get the fixed values; any other value is rejected, not rewritten.
  const dropBot = isObject(input.dropBot) ? input.dropBot : {}
  const requested = {
    dropBot: { startFeeBps: (dropBot.startFeeBps ?? DROP_BOT_START_FEE_BPS) as number, windowSec: dropBot.windowSec as number },
    normalFeeBps: (input.normalFeeBps ?? NORMAL_FEE_BPS) as number,
  }
  checkLaunchFee(requested)
  const campaign: Campaign = {
    name,
    symbol,
    uri,
    description,
    image: image || undefined,
    plan,
    dropBot: { startFeeBps: DROP_BOT_START_FEE_BPS, windowSec: requested.dropBot.windowSec },
    normalFeeBps: NORMAL_FEE_BPS,
  }
  return campaign
}
