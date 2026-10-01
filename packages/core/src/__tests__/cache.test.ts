import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LruMap, ttlCache } from '../cache'

test('LruMap drops the least recently used entry', () => {
  const m = new LruMap<string, number>(2)
  m.set('a', 1)
  m.set('b', 2)
  assert.equal(m.get('a'), 1) // a is now the most recent
  m.set('c', 3)
  assert.equal(m.get('b'), undefined)
  assert.equal(m.get('a'), 1)
  assert.equal(m.get('c'), 3)
  assert.equal(m.size, 2)
})

test('ttlCache serves fresh values, coalesces concurrent loads and does not cache failures', async () => {
  let now = 0
  const cache = ttlCache<number>(3000, 100, () => now)
  let loads = 0
  const load = async () => {
    loads++
    await new Promise((r) => setTimeout(r, 10))
    return loads
  }
  const [a, b, c] = await Promise.all([cache.get('p', load), cache.get('p', load), cache.get('p', load)])
  assert.deepEqual([a, b, c, loads], [1, 1, 1, 1])
  now = 2999
  assert.equal(await cache.get('p', load), 1)
  assert.equal(cache.fresh('p'), 1)
  now = 3000
  assert.equal(cache.fresh('p'), undefined)
  assert.equal(await cache.get('p', load), 2)

  await assert.rejects(cache.get('q', async () => Promise.reject(new Error('rpc down'))), /rpc down/)
  assert.equal(await cache.get('q', async () => 7), 7, 'a failed load is retried by the next caller')
  cache.set('r', 9)
  assert.equal(cache.fresh('r'), 9)
})
