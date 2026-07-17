#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIS = ['claude', 'codex', 'opencode', 'grok']
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../..')

function usage() {
  console.log(`Usage: npm run test:term-fidelity -- --cli=<name>|all [playwright options]

CLIs: ${CLIS.join(', ')}

The runner verifies the selected CLI executables, builds the Electron app,
then runs the real-app fidelity matrix. Set TERM_FIDELITY_SKIP_BUILD=1 only
when iterating against an already-current out/ build.`)
}

function parseArgs(argv) {
  let selected = 'all'
  const playwrightArgs = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }
    if (arg === '--cli') {
      selected = argv[index + 1] || ''
      index += 1
      continue
    }
    if (arg.startsWith('--cli=')) {
      selected = arg.slice('--cli='.length)
      continue
    }
    playwrightArgs.push(arg)
  }

  if (selected !== 'all' && !CLIS.includes(selected)) {
    throw new Error(`Unknown --cli value ${JSON.stringify(selected)}; expected ${CLIS.join(', ')} or all`)
  }

  return {
    selected,
    clis: selected === 'all' ? CLIS : [selected],
    playwrightArgs
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeout
  })

  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${[result.stdout, result.stderr].filter(Boolean).join('\n').trim()}`
      : ''
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}${detail}`)
  }

  return result
}

function executableCandidates(cli) {
  const names = process.platform === 'win32'
    ? [`${cli}.exe`, `${cli}.cmd`, cli]
    : [cli]
  const candidates = []
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(join(directory, name))
  }
  return [...new Set(candidates)]
}

function preflightCli(cli) {
  const candidates = executableCandidates(cli)
  let lastError = null
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    try {
      accessSync(candidate, constants.X_OK)
      run(candidate, ['--version'], { capture: true, timeout: 15_000 })
      return { directory: dirname(candidate), candidateIndex: index }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error(`No executable candidate found for ${cli}`)
}

try {
  const { selected, clis, playwrightArgs } = parseArgs(process.argv.slice(2))

  const executableDirectories = []
  for (const cli of clis) {
    try {
      executableDirectories.push(preflightCli(cli))
    } catch (error) {
      throw new Error(`CLI preflight failed for ${cli}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // If an earlier PATH entry is an installed-but-broken shim, preserve the
  // first candidate that actually passed `--version` for broker child spawns.
  // Deeper fallbacks sort first so they stay ahead of broken earlier entries.
  const pathPrefix = [...new Set(executableDirectories
    .sort((left, right) => right.candidateIndex - left.candidateIndex)
    .map((entry) => entry.directory))]
  const runEnv = {
    ...process.env,
    PATH: [...pathPrefix, process.env.PATH || ''].filter(Boolean).join(delimiter)
  }

  if (process.env.TERM_FIDELITY_SKIP_BUILD !== '1') {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    run(npm, ['run', 'build'], { env: runEnv })
  } else if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
    throw new Error('TERM_FIDELITY_SKIP_BUILD=1 was set, but out/main/index.js does not exist')
  }

  const playwrightCli = join(repoRoot, 'node_modules/@playwright/test/cli.js')
  run(process.execPath, [
    playwrightCli,
    'test',
    '--config',
    'playwright.term-fidelity.config.ts',
    ...playwrightArgs
  ], {
    env: {
      ...runEnv,
      TERM_FIDELITY_CLI: selected
    }
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
