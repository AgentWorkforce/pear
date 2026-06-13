#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const repoRoot = join(packageRoot, '..', '..')
const entry = join(packageRoot, 'src', 'cli', 'fleet.ts')
const launcher = fileURLToPath(import.meta.url)
const cacheDir = join(repoRoot, 'node_modules', '.cache', 'pear-factory-sdk')
const rawArgs = process.argv.slice(2)
const forceRebuild = process.env.FLEET_FORCE_BUILD === '1' || rawArgs.includes('--rebuild')
const cliArgs = rawArgs.filter((arg) => arg !== '--rebuild')
const memoFile = join(cacheDir, 'fleet-memo.json')

mkdirSync(cacheDir, { recursive: true })

// The SDK package is type=commonjs, so Node strip-types loads .ts as CJS and rejects ESM imports.
// Bundle the thin CLI entry locally instead; esbuild is declared in this package for that launcher path.
const buildOptions = {
  entryPoints: [entry],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  absWorkingDir: repoRoot,
  logLevel: 'silent',
}

let outfile = readMemoizedOutfile()

if (!outfile) {
  const { buildSync } = require('esbuild')
  const metafileBuild = buildSync({
    ...buildOptions,
    write: false,
    metafile: true,
  })
  const hash = createHash('sha256')
  const launcherContent = readFileSync(launcher)
  const inputs = []
  hash.update(launcher)
  hash.update(launcherContent)
  for (const input of Object.keys(metafileBuild.metafile.inputs).sort()) {
    const inputPath = isAbsolute(input) ? input : join(repoRoot, input)
    const content = readFileSync(inputPath)
    const contentHash = sha256(content)
    inputs.push({ path: input, hash: contentHash })
    hash.update(input)
    hash.update(content)
  }
  outfile = join(cacheDir, `fleet-${hash.digest('hex').slice(0, 16)}.mjs`)
  buildSync({
    ...buildOptions,
    outfile,
  })
  writeFileSync(memoFile, JSON.stringify({
    launcherHash: sha256(launcherContent),
    inputs,
    outfile,
  }))
}

const mod = await import(pathToFileURL(outfile).href)
await mod.main(cliArgs)

function readMemoizedOutfile() {
  if (forceRebuild || !existsSync(memoFile)) {
    return undefined
  }
  try {
    const memo = JSON.parse(readFileSync(memoFile, 'utf8'))
    if (!memo || typeof memo.outfile !== 'string' || !existsSync(memo.outfile)) {
      return undefined
    }
    if (memo.launcherHash !== sha256(readFileSync(launcher))) {
      return undefined
    }
    if (!Array.isArray(memo.inputs)) {
      return undefined
    }
    for (const input of memo.inputs) {
      if (!input || typeof input.path !== 'string' || typeof input.hash !== 'string') {
        return undefined
      }
      const inputPath = isAbsolute(input.path) ? input.path : join(repoRoot, input.path)
      if (sha256(readFileSync(inputPath)) !== input.hash) {
        return undefined
      }
    }
    return memo.outfile
  } catch {
    return undefined
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}
