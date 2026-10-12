// Shipping details sealed to the maker's browser, so the server only ever holds ciphertext it cannot open.
// Dependency-free (tweetnacl only) so the browser and the server build and check the same strings.
//
// The maker's inbox key is derived in their wallet: they sign inboxMessage() and the signature seeds an
// X25519 key pair (ed25519 signatures are deterministic, so the same wallet always gets the same key and
// nothing is stored). The public half is registered once per campaign. A backer's browser seals the
// details to it with a fresh ephemeral key (NaCl box), and only the maker's browser opens them.
import nacl from 'tweetnacl'
import { BRAND } from './brand'

export const SEALED_PREFIX = 'e2e1.'
// Ephemeral public key + nonce + box (16 bytes of tag at least).
const MIN_BYTES = 32 + nacl.box.nonceLength + nacl.box.overheadLength + 1
export const MAX_SEALED_CHARS = 3000

export type InboxShipping = { name: string; email: string; address: string; country: string }

// What the maker's wallet signs to derive its inbox key. It names the campaign and this site, so a
// signature made for another campaign or site is a different key.
export function inboxMessage(pool: string, domain: string) {
  return `${domain} asks you to unlock the ${BRAND} inbox.\nShipping details for campaign ${pool}\nOnly sign this on ${domain}. It lets this page read the orders you receive; it is not a sign-in and costs nothing.`
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

// The inbox key pair for a wallet's signature of inboxMessage(): sha512 of the signature, first 32 bytes.
export function inboxKeyPair(signature: Uint8Array) {
  return nacl.box.keyPair.fromSecretKey(nacl.hash(signature).slice(0, 32))
}

// An inbox public key as registered and served: 32 bytes, base64url.
export const INBOX_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const encodeInboxKey = (publicKey: Uint8Array) => b64(publicKey)

export function sealToMaker(shipping: InboxShipping, inboxKey: string): string {
  if (!INBOX_KEY_PATTERN.test(inboxKey)) throw new Error('The maker’s inbox key is not valid')
  const ephemeral = nacl.box.keyPair()
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const box = nacl.box(new TextEncoder().encode(JSON.stringify(shipping)), nonce, unb64(inboxKey), ephemeral.secretKey)
  const out = new Uint8Array(32 + nonce.length + box.length)
  out.set(ephemeral.publicKey, 0)
  out.set(nonce, 32)
  out.set(box, 32 + nonce.length)
  return SEALED_PREFIX + b64(out)
}

export function openFromBackers(sealed: string, inboxSecretKey: Uint8Array): InboxShipping {
  if (!sealed.startsWith(SEALED_PREFIX)) throw new Error('Not a sealed order')
  const bytes = unb64(sealed.slice(SEALED_PREFIX.length))
  const opened = nacl.box.open(bytes.slice(32 + nacl.box.nonceLength), bytes.slice(32, 32 + nacl.box.nonceLength), bytes.slice(0, 32), inboxSecretKey)
  if (!opened) throw new Error('This order was sealed to another key')
  return JSON.parse(new TextDecoder().decode(opened)) as InboxShipping
}

// Shape check only (the server cannot open it): the prefix, base64url, and a plausible size.
export function isSealedToMaker(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(SEALED_PREFIX) || value.length > MAX_SEALED_CHARS) return false
  const body = value.slice(SEALED_PREFIX.length)
  return /^[A-Za-z0-9_-]+$/.test(body) && Buffer.from(body, 'base64url').length >= MIN_BYTES
}

// The same rules the server's shipping schema applies, for the browser to run before it seals (the
// server cannot check what it cannot read). Returns what is wrong, or null.
export function checkShipping(s: InboxShipping): string | null {
  const required = 'Name, address and country are required'
  const limits: [string, number][] = [['name', 100], ['address', 500], ['country', 60]]
  for (const [k, max] of limits) {
    const v = (s[k as keyof InboxShipping] ?? '').trim()
    if (!v) return required
    if (v.length > max) return `${k} is too long (at most ${max} characters)`
  }
  const email = (s.email ?? '').trim()
  if (email.length > 200) return 'email is too long (at most 200 characters)'
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email'
  return null
}
