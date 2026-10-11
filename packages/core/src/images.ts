// Product photos. A maker uploads one when creating a campaign; it is stored in the database and served
// from this app's own address, so the campaign (and its on-chain token metadata) points at a URL we control.
import crypto from 'crypto'
import { db } from './db'

export const IMAGE_MAX_BYTES = 1_500_000 // the browser shrinks photos far below this before uploading
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

// What the bytes really are, from their first few bytes. The client's Content-Type is never trusted,
// so a script or HTML page cannot be stored and served as a "photo".
export function detectImageType(bytes: Uint8Array): ImageType | null {
  const at = (i: number) => bytes[i]
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'image/png'
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  // WebP is "RIFF" <4-byte size> "WEBP"
  if (bytes.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp'
  return null
}

// A photo the maker can fix (wrong type, too big, empty). Anything else thrown is ours to deal with.
export class ImageError extends Error {}

export const IMAGE_ID_PATTERN = /^[0-9a-f]{32}$/

// Stores a photo and returns its id. Throws a plain message the maker can act on.
export function saveImage(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new ImageError('That file is empty')
  if (bytes.length > IMAGE_MAX_BYTES) throw new ImageError(`That photo is too large (the limit is ${Math.round(IMAGE_MAX_BYTES / 1_000_000 * 10) / 10} MB)`)
  const mime = detectImageType(bytes)
  if (!mime) throw new ImageError('Use a PNG, JPEG or WebP photo')
  const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  db().prepare('INSERT INTO images (id, mime, created_at, bytes) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run(id, mime, Date.now(), bytes)
  return id
}

export function getImage(id: string): { mime: ImageType; bytes: Uint8Array } | null {
  if (!IMAGE_ID_PATTERN.test(id)) return null
  const row = db().prepare('SELECT mime, bytes FROM images WHERE id = ?').get(id) as { mime: ImageType; bytes: Uint8Array } | undefined
  return row ? { mime: row.mime, bytes: row.bytes } : null
}
