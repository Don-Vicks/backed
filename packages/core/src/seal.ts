// Encryption at rest for personal data (shipping details): AES-256-GCM with SHIPPING_KEY.
// Each value is bound to its row through additional authenticated data, so a ciphertext copied
// into another row fails to open.
import crypto from 'crypto'
import { getNetwork, isTestNetwork } from './network'

const VERSION = 'v1'
const IV_BYTES = 12
let warned = false

// SHIPPING_KEY: 32 bytes as 64 hex characters or base64. Required on mainnet. Devnet and localnet fall
// back to a public, derived dev key (with a warning) so local runs need no setup.
export function shippingKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.SHIPPING_KEY?.trim()
  if (raw) return parseShippingKey(raw)
  const net = getNetwork(env).name
  if (!isTestNetwork(net)) throw new Error('SHIPPING_KEY must be set on mainnet (32 bytes, hex or base64)')
  if (!warned) {
    warned = true
    console.warn(`SHIPPING_KEY is not set: shipping details on ${net} are encrypted with a public dev key`)
  }
  return devShippingKey(net)
}

const devShippingKey = (net: string) => crypto.createHash('sha256').update(`preorder-dev-shipping-key:${net}`).digest()

export function hasShippingKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.SHIPPING_KEY?.trim()
}

// Keys that may open stored values, in order: SHIPPING_KEY, then SHIPPING_KEY_PREVIOUS (comma-separated,
// for rotation), then the dev key on devnet and localnet (rows saved before SHIPPING_KEY was set).
export function shippingKeys(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const keys: Buffer[] = []
  try {
    keys.push(shippingKey(env))
  } catch {
    // Unset on mainnet, or malformed: the other keys may still open older rows.
  }
  for (const raw of (env.SHIPPING_KEY_PREVIOUS ?? '').split(',').map((v) => v.trim()).filter(Boolean)) {
    try {
      keys.push(parseShippingKey(raw))
    } catch {
      // Reported by shippingKeyStatus().
    }
  }
  const net = getNetwork(env).name
  if (isTestNetwork(net)) keys.push(devShippingKey(net))
  return keys.filter((k, i) => keys.findIndex((o) => o.equals(k)) === i)
}

// For /api/health (usable: shipping details can be stored, else the deploy fails its healthcheck) and
// /api/status (ok). A deployed devnet (public origin set) without its own key is not ok: the dev key
// is derived from public source, so it is effectively plaintext.
export function shippingKeyStatus(env: NodeJS.ProcessEnv = process.env): { ok: boolean; configured: boolean; usable: boolean; error?: string } {
  const configured = hasShippingKey(env)
  try {
    shippingKey(env)
  } catch (e) {
    return { ok: false, configured, usable: false, error: e instanceof Error ? e.message : String(e) }
  }
  for (const raw of (env.SHIPPING_KEY_PREVIOUS ?? '').split(',').map((v) => v.trim()).filter(Boolean)) {
    try {
      parseShippingKey(raw)
    } catch (e) {
      return { ok: false, configured, usable: true, error: `SHIPPING_KEY_PREVIOUS: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const net = getNetwork(env).name
  const deployed = net !== 'localnet' && !!(env.PUBLIC_BASE_URL?.trim() || env.RAILWAY_PUBLIC_DOMAIN?.trim())
  if (!configured && deployed) return { ok: false, configured, usable: true, error: `SHIPPING_KEY is not set on a deployed ${net}: the dev key is public` }
  return { ok: true, configured, usable: true }
}

export function parseShippingKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  // Never echo the value: only its decoded length.
  if (key.length !== 32) throw new Error(`SHIPPING_KEY must decode to 32 bytes, got ${key.length}`)
  return key
}

export function sealJson(value: unknown, aad: string, key: Buffer = shippingKey()): string {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

// Opens with the first key that fits (see shippingKeys).
export function openJsonAny<T>(sealed: string, aad: string, keys: Buffer[] = shippingKeys()): T {
  let error: unknown = new Error('No SHIPPING_KEY to open sealed values with')
  for (const key of keys) {
    try {
      return openJson<T>(sealed, aad, key)
    } catch (e) {
      error = e
    }
  }
  throw error
}

export function openJson<T>(sealed: string, aad: string, key: Buffer = shippingKey()): T {
  const [version, iv, tag, ct] = sealed.split('.')
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('Unreadable sealed value')
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const plain = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as T
  } catch {
    throw new Error('Cannot decrypt sealed value: wrong SHIPPING_KEY or tampered data')
  }
}
