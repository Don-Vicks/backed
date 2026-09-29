import fs from 'fs'
import path from 'path'

// Repo root = nearest ancestor with pnpm-workspace.yaml. Works from scripts (cwd = packages/core)
// and from the Next.js server (cwd = apps/web), where __dirname points into the build output.
let cached: string | undefined
export function repoRoot(): string {
  if (cached) return cached
  if (process.env.PREORDER_ROOT) return (cached = process.env.PREORDER_ROOT)
  let dir = process.cwd()
  while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('could not find repo root (pnpm-workspace.yaml)')
    dir = parent
  }
  return (cached = dir)
}
