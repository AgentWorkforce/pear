#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const repoRoot = join(packageRoot, '..', '..')
const sourceRoot = join(packageRoot, 'src')
const entry = join(packageRoot, 'src', 'cli', 'fleet.ts')
const cacheDir = join(tmpdir(), 'pear-factory-sdk')
const hash = createHash('sha256')
  .update(entry)
for (const file of sourceFiles(sourceRoot)) {
  const stat = statSync(file)
  hash
    .update(file)
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
}
const cacheKey = hash
  .digest('hex')
  .slice(0, 16)
const outfile = join(cacheDir, `fleet-${cacheKey}.mjs`)

mkdirSync(cacheDir, { recursive: true })

if (!existsSync(outfile)) {
  // The SDK package is type=commonjs, so Node strip-types loads .ts as CJS and rejects ESM imports.
  // Bundle the thin CLI entry locally instead; esbuild is declared in this package for that launcher path.
  const { buildSync } = require('esbuild')
  buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    absWorkingDir: repoRoot,
    logLevel: 'silent',
  })
}

const mod = await import(pathToFileURL(outfile).href)
await mod.main(process.argv.slice(2))

function sourceFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path))
    } else if (entry.isFile() && path.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files.sort()
}
