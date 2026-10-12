// pnpm core:backup [restore <file>]
// Writes a backup of the store now (the web server does the same every BACKUP_INTERVAL_SEC) and lists
// what is kept. `restore <file>` copies a backup over the database while the server is STOPPED, keeping
// the current file next to it as .before-restore.
import fs from 'fs'
import { backupStore, listBackups } from '../backup'
import { dbPath } from '../db'

const [cmd, file] = process.argv.slice(2)
if (cmd === 'restore') {
  if (!file || !fs.existsSync(file)) {
    console.error('usage: pnpm core:backup restore <backup file>')
    process.exit(1)
  }
  const target = dbPath()
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.before-restore`)
  for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true })
  fs.copyFileSync(file, target)
  console.log(`Restored ${file} to ${target} (previous file kept as ${target}.before-restore). Start the server again.`)
} else {
  const { backup, removed } = backupStore()
  console.log(`Backup written: ${backup.file} (${backup.bytes} bytes), ${removed.length} old one(s) removed`)
  for (const b of listBackups()) console.log(`  ${b.at}  ${b.bytes}  ${b.file}`)
}
