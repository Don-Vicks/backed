// The maker's inbox key (inbox-crypto.ts) per campaign, and what a redemption may carry because of it.
import { db, transaction } from './db'
import { HttpError } from './errors'
import { INBOX_KEY_PATTERN, isSealedToMaker } from './inbox-crypto'
import type { Shipping } from './redemptions'


export const getInboxKey = (pool: string): string | null =>
  ((db().prepare('SELECT public_key FROM inbox_keys WHERE pool = ?').get(pool) as { public_key: string } | undefined)?.public_key ?? null)

// Registers the campaign's inbox key once. The same key again is fine; a different one is a 409, because
// orders may already be sealed to the first.
export function registerInboxKey(pool: string, publicKey: string, now = Date.now()) {
  if (!INBOX_KEY_PATTERN.test(publicKey)) throw new HttpError('That is not a valid inbox key', 400)
  transaction((d) => {
    const existing = getInboxKey(pool)
    if (existing && existing !== publicKey) throw new HttpError('This campaign already has an inbox key; it can’t be changed', 409)
    if (!existing) d.prepare('INSERT INTO inbox_keys (pool, public_key, registered_at) VALUES (?, ?, ?)').run(pool, publicKey, now)
  })
}

// What a redemption's shipping details must look like for this campaign. With an inbox key the details
// must arrive sealed to it (the server never sees them in the clear); without one they arrive plain and
// are sealed at rest under SHIPPING_KEY. 400 for the wrong kind or none.
export function shippingFor(pool: string, input: { shipping?: Shipping; sealed?: string }): Shipping | string {
  if (getInboxKey(pool)) {
    if (input.shipping) throw new HttpError('This maker reads orders privately: seal the shipping details to their key instead of sending them', 400)
    if (!isSealedToMaker(input.sealed)) throw new HttpError('Shipping details are missing or not sealed', 400)
    return input.sealed
  }
  if (input.sealed) throw new HttpError('This campaign has no inbox key yet, so sealed shipping details are not accepted', 400)
  if (!input.shipping) throw new HttpError('Name, address and country are required', 400)
  return input.shipping
}
