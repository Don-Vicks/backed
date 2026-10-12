import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-backup-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'localnet'
process.env.DATA_DIR = path.join(root, 'data')

import { ALERT_THROTTLE_MS, alertWebhook, resetAlertThrottle, sendAlert } from '../alert'
import { backupAgeSec, backupDir, backupKeep, backupStore, listBackups } from '../backup'
import { db } from '../db'

const read = (file: string, sql: string) => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const d = new DatabaseSync(file, { readOnly: true })
  try {
    return d.prepare(sql).all()
  } finally {
    d.close()
  }
}

test('a backup is a consistent, openable copy with every migration, readable by the owner only', () => {
  db().prepare("INSERT INTO metadata (id, created_at, data) VALUES ('m1', 1, '{}')").run()
  const { backup } = backupStore(new Date('2026-10-12T10:00:00.000Z'))
  assert.ok(backup.file.startsWith(backupDir()))
  assert.match(path.basename(backup.file), /^backed\.localnet\.2026-10-12T10-00-00-000Z\.sqlite$/)
  assert.equal((fs.statSync(backup.file).mode & 0o777).toString(8), '600')
  assert.deepEqual(read(backup.file, "SELECT id FROM metadata WHERE id = 'm1'").map((r: any) => r.id), ['m1'])
  const migrations = read(backup.file, 'SELECT name FROM schema_migrations').map((r: any) => r.name)
  assert.ok(migrations.includes('0006_inbox_keys'))
})

test('only the newest BACKUP_KEEP backups stay', () => {
  for (let i = 1; i <= 5; i++) backupStore(new Date(`2026-10-12T11:0${i}:00.000Z`), 3)
  const kept = listBackups()
  assert.equal(kept.length, 3)
  assert.ok(kept.every((b) => /2026-10-12T11-0[345]/.test(b.file)), kept.map((b) => b.file).join(' '))
})

test('backupAgeSec is null with no backups and counts from the newest', () => {
  fs.rmSync(backupDir(), { recursive: true, force: true })
  assert.equal(backupAgeSec(), null)
  const { backup } = backupStore(new Date())
  const age = backupAgeSec(Date.parse(backup.at) + 90_000)
  assert.ok(age !== null && age >= 89 && age <= 91)
})

test('BACKUP_KEEP falls back to the default for anything but a positive whole number', () => {
  assert.equal(backupKeep({ BACKUP_KEEP: '7' } as any), 7)
  for (const bad of ['0', '-1', '2.5', 'x']) assert.equal(backupKeep({ BACKUP_KEEP: bad } as any), 24)
  assert.equal(backupKeep({} as any), 24)
})

test('the alert webhook must be https (or http on localhost)', () => {
  assert.equal(alertWebhook({} as any), null)
  assert.equal(alertWebhook({ ALERT_WEBHOOK_URL: 'http://evil.example/hook' } as any), null)
  assert.equal(alertWebhook({ ALERT_WEBHOOK_URL: 'not a url' } as any), null)
  assert.ok(alertWebhook({ ALERT_WEBHOOK_URL: 'https://hooks.example/x' } as any))
  assert.ok(alertWebhook({ ALERT_WEBHOOK_URL: 'http://127.0.0.1:9/x' } as any))
})

test('alerts post once per key within the throttle window, and never throw', async () => {
  const bodies: any[] = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      bodies.push(JSON.parse(b))
      res.end('ok')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`
  resetAlertThrottle()
  try {
    const t = Date.now()
    assert.equal(await sendAlert('k', 'first', { a: 1 }, t), true)
    assert.equal(await sendAlert('k', 'second', {}, t + 1000), false, 'throttled')
    assert.equal(await sendAlert('other', 'third', {}, t + 1000), true, 'another key is its own')
    assert.equal(await sendAlert('k', 'later', {}, t + ALERT_THROTTLE_MS + 1), true, 'after the window')
    assert.equal(bodies.length, 3)
    assert.match(bodies[0].text, /first/)
    assert.equal(bodies[0].content, bodies[0].text, 'Discord reads content, Slack reads text')
  } finally {
    server.close()
  }
  process.env.ALERT_WEBHOOK_URL = 'http://127.0.0.1:1/unreachable'
  resetAlertThrottle()
  assert.equal(await sendAlert('down', 'x'), false, 'an unreachable webhook is swallowed')
  delete process.env.ALERT_WEBHOOK_URL
  assert.equal(await sendAlert('none', 'x'), false, 'no webhook configured')
})
