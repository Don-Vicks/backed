import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, resolvePublicOrigin, siteHosts } from '../origin'

test('PUBLIC_BASE_URL wins over RAILWAY_PUBLIC_DOMAIN and the request', () => {
  const env = { PUBLIC_BASE_URL: 'https://x.test/', RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app' }
  assert.equal(resolvePublicOrigin(env, 'mainnet', 'http://evil:3000/api'), 'https://x.test')
})

test('RAILWAY_PUBLIC_DOMAIN is the fallback, as https', () => {
  assert.equal(resolvePublicOrigin({ RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app' }, 'devnet'), 'https://app.up.railway.app')
})

test('the request origin is used only on localnet', () => {
  assert.equal(resolvePublicOrigin({}, 'localnet', 'http://localhost:3201/api/campaigns'), 'http://localhost:3201')
  assert.throws(() => resolvePublicOrigin({}, 'mainnet', 'http://localhost:3201/api/campaigns'), ConfigError)
  assert.throws(() => resolvePublicOrigin({}, 'devnet'), /PUBLIC_BASE_URL must be set on devnet/)
})

test('refuses localhost and plain http off localnet', () => {
  for (const url of ['https://localhost:3000', 'https://127.0.0.1', 'https://[::1]:8080', 'https://app.localhost', 'http://x.test']) {
    assert.throws(() => resolvePublicOrigin({ PUBLIC_BASE_URL: url }, 'mainnet'), ConfigError, url)
  }
  assert.throws(() => resolvePublicOrigin({ PUBLIC_BASE_URL: 'not a url' }, 'devnet'), /not a URL/)
  assert.equal(resolvePublicOrigin({ PUBLIC_BASE_URL: 'http://localhost:3201' }, 'localnet'), 'http://localhost:3201')
})

test('site hosts: the public URL’s and Railway’s own domain, for checking signed messages', () => {
  assert.deepEqual(siteHosts({ PUBLIC_BASE_URL: 'https://backed.example' }, 'devnet'), ['backed.example'])
  assert.deepEqual(siteHosts({ PUBLIC_BASE_URL: 'https://backed.example', RAILWAY_PUBLIC_DOMAIN: 'backed.up.railway.app' }, 'devnet'), [
    'backed.example',
    'backed.up.railway.app',
  ])
  assert.deepEqual(siteHosts({ RAILWAY_PUBLIC_DOMAIN: 'backed.up.railway.app' }, 'devnet'), ['backed.up.railway.app'])
  assert.deepEqual(siteHosts({}, 'localnet', 'http://localhost:3201/api/redemptions/list'), ['localhost:3201'])
  assert.throws(() => siteHosts({}, 'mainnet', 'https://evil.example/x'), ConfigError, 'never the request’s host off localnet')
})
