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

// The current origin and any the app was served from before (PREVIOUS_BASE_URLS, comma-separated).
// On-chain listings are immutable, so a campaign listed under an old domain keeps that website; it is
// still this app's listing when it names one of these origins.
export function publicOrigins(env: NodeJS.ProcessEnv, network: NetworkName, requestUrl?: string): string[] {
  const previous = (env.PREVIOUS_BASE_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => {
      try {
        return [new URL(s).origin]
      } catch {
        return [] // a typo here must not take the app down: it only widens a badge check
      }
    })
  return [...new Set([resolvePublicOrigin(env, network, requestUrl), ...previous])]
}

// Hosts the app answers on, for checking which site a wallet signed a message for: PUBLIC_BASE_URL's
// and, on Railway, the service's own domain (both reach the same server); the request's on localnet.
export function siteHosts(env: NodeJS.ProcessEnv, network: NetworkName, requestUrl?: string): string[] {
  const hosts = new Set([new URL(resolvePublicOrigin(env, network, requestUrl)).host])
  const railway = env.RAILWAY_PUBLIC_DOMAIN?.trim()
  if (railway) hosts.add(railway)
  return [...hosts]
}
