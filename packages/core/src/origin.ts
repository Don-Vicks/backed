// The app's public origin. It ends up in immutable on-chain metadata URIs and Blink icons, so it
// comes from config, never from the request: behind a proxy Next's req.url is the bind address.
import type { NetworkName } from './network'

export class ConfigError extends Error {}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'])

export function resolvePublicOrigin(env: NodeJS.ProcessEnv, network: NetworkName, requestUrl?: string): string {
  const configured =
    env.PUBLIC_BASE_URL?.trim() || (env.RAILWAY_PUBLIC_DOMAIN?.trim() ? `https://${env.RAILWAY_PUBLIC_DOMAIN.trim()}` : '')
  if (!configured) {
    if (network === 'localnet' && requestUrl) return new URL(requestUrl).origin
    throw new ConfigError(`PUBLIC_BASE_URL must be set on ${network}`)
  }
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new ConfigError(`PUBLIC_BASE_URL is not a URL: ${configured}`)
  }
  if (network !== 'localnet' && (url.protocol !== 'https:' || LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost'))) {
    throw new ConfigError(`PUBLIC_BASE_URL must be a public https URL on ${network}, got ${url.origin}`)
  }
  return url.origin
}
