// Online backups of the store: VACUUM INTO writes a consistent copy while the server keeps serving, into
// <DATA_DIR>/backups, and the oldest copies beyond BACKUP_KEEP are removed. A copy sits on the same
// volume as the database, so it protects against a bad write or a deleted row, not the loss of the
// volume: take it off the machine too (docs/deploy.md).
import fs from 'fs'
import path from 'path'
import { db, dataDir } from './db'
import { getNetwork } from './network'

export const DEFAULT_BACKUP_KEEP = 24

export const backupDir = () => path.join(dataDir(), 'backups')

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-')
const FILE = /^backed\.([a-z]+)\.(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.sqlite$/

export type BackupInfo = { file: string; bytes: number; at: string }

// The backups of this network, newest first.
export function listBackups(): BackupInfo[] {
  const dir = backupDir()
  if (!fs.existsSync(dir)) return []
  const net = getNetwork().name
  return fs
    .readdirSync(dir)
    .filter((f) => FILE.exec(f)?.[1] === net)
    .map((f) => {
      const st = fs.statSync(path.join(dir, f))
      return { file: path.join(dir, f), bytes: st.size, at: st.mtime.toISOString() }
    })
    .sort((a, b) => b.at.localeCompare(a.at) || b.file.localeCompare(a.file))
}

export function backupKeep(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BACKUP_KEEP || DEFAULT_BACKUP_KEEP)
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_BACKUP_KEEP
}

// Writes a backup now and prunes the oldest ones. The copy is readable by the server's user only (it holds
// sealed shipping details and image bytes).
export function backupStore(now = new Date(), keep = backupKeep()): { backup: BackupInfo; removed: string[] } {
  const dir = backupDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `backed.${getNetwork().name}.${stamp(now)}.sqlite`)
  // The target is a path we built from a fixed pattern; VACUUM INTO takes a string literal, so quotes are doubled.
  db().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  fs.chmodSync(file, 0o600)
  const all = listBackups()
  const removed = all.slice(keep).map((b) => b.file)
  for (const f of removed) fs.rmSync(f, { force: true })
  return { backup: { file, bytes: fs.statSync(file).size, at: now.toISOString() }, removed }
}

// Seconds since the newest backup, or null when there is none.
export function backupAgeSec(now = Date.now()): number | null {
  const [newest] = listBackups()
  return newest ? Math.max(0, Math.round((now - Date.parse(newest.at)) / 1000)) : null
}
