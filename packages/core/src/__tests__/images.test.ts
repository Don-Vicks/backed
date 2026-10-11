import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeDb } from '../db'
import { IMAGE_MAX_BYTES, detectImageType, getImage, saveImage } from '../images'

beforeEach(() => {
  closeDb()
  process.env.DATA_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-images-')), 'data')
  process.env.NETWORK = 'localnet'
})

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 1])

test('detects PNG, JPEG and WebP from their bytes', () => {
  assert.equal(detectImageType(png), 'image/png')
  assert.equal(detectImageType(jpeg), 'image/jpeg')
  assert.equal(detectImageType(webp), 'image/webp')
})

test('rejects HTML, SVG and anything else that is not a photo', () => {
  assert.equal(detectImageType(new TextEncoder().encode('<script>alert(1)</script>')), null)
  assert.equal(detectImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(detectImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), null) // a WAV file
  assert.throws(() => saveImage(new TextEncoder().encode('GIF89a')), /PNG, JPEG or WebP/)
})

test('stores a photo once and reads it back with its real type', () => {
  const id = saveImage(jpeg)
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.equal(saveImage(jpeg), id) // same bytes, same id
  const got = getImage(id)
  assert.equal(got?.mime, 'image/jpeg')
  assert.deepEqual(Array.from(got!.bytes), Array.from(jpeg))
})

test('refuses empty and oversized files, and ids that are not hashes', () => {
  assert.throws(() => saveImage(new Uint8Array()), /empty/)
  const big = new Uint8Array(IMAGE_MAX_BYTES + 1)
  big.set(png)
  assert.throws(() => saveImage(big), /too large/)
  assert.equal(getImage('../../etc/passwd'), null)
  assert.equal(getImage('0'.repeat(32)), null)
})
