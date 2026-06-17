/**
 * Pear integration mount eval runner.
 *
 * Spawns real Claude agents via a local broker in a fixture dir containing a
 * fake .integrations/ writeback mount, then scores whether the agent wrote to
 * the correct path with a valid JSON payload.
 *
 * Usage:
 *   npx tsx evals/runner.ts [flags]
 *
 * Flags:
 *   --variant=bare,claude-md    Comma-separated variants (default: all)
 *   --scenario=s01,s02          Comma-separated scenario IDs (default: all)
 *   --repeat=N                  Runs per scenario×variant cell (default: 3)
 *   --model=claude-haiku-4-5-20251001  Model override
 *
 * Environment:
 *   RELAY_API_KEY  Optional. Reuse this workspace key instead of creating
 *                  a new ephemeral one (saves ~1s per runner invocation).
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import type { MountScenarioResult } from '@agent-relay/evals'
import { scoreMountRun } from '@agent-relay/evals/scoring/mount'

import { VARIANTS, variantClaudeMd, variantTaskPrefix } from './variants.js'
import type { Variant } from './variants.js'
import { createFixture, snapshotMount, newMountFiles } from './fixture.js'
import { runEval } from './harness.js'
import { writeReport } from './report.js'
import { SCENARIOS, scenarioById } from './scenarios/index.js'

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const entry = args.find((a) => a.startsWith(`--${flag}=`))
    return entry ? entry.split('=').slice(1).join('=') : null
  }

  const variantArg = get('variant')
  const scenarioArg = get('scenario')
  const repeatArg = get('repeat')
  const modelArg = get('model')
  const cliArg = get('cli')

  const variants = (variantArg ? variantArg.split(',') : [...VARIANTS]) as Variant[]
  const scenarios = scenarioArg
    ? scenarioArg.split(',').map((id) => {
        const s = scenarioById(id)
        if (!s) throw new Error(`Unknown scenario: ${id}`)
        return s
      })
    : SCENARIOS
  const repeat = repeatArg ? parseInt(repeatArg, 10) : 3
  const model = modelArg ?? undefined
  const cli = cliArg ?? undefined

  return { variants, scenarios, repeat, model, cli }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { variants, scenarios, repeat, model, cli } = parseArgs()

  const total = scenarios.length * variants.length * repeat
  const cliLabel = cli ?? 'claude'
  const modelLabel = model ?? 'default'
  console.log(
    `\nPear mount evals — ${scenarios.length} scenarios × ${variants.length} variants × ${repeat} runs = ${total} total  [${cliLabel} / ${modelLabel}]\n`,
  )

  const allEntries: MountScenarioResult[] = []
  let runIndex = 0

  for (const scenario of scenarios) {
    for (const variant of variants) {
      for (let r = 0; r < repeat; r++) {
        runIndex++
        const agentName = `eval-${scenario.id}-${variant}-r${r + 1}`
        process.stdout.write(`[${runIndex}/${total}] ${scenario.id} / ${variant} / run${r + 1} ... `)

        const fixtureDir = createFixture({ claudeMd: variantClaudeMd(variant) })

        try {
          const snapshot = snapshotMount(join(fixtureDir, '.integrations'))
          // For non-claude CLIs, embed the absolute fixture path so the model
          // writes to the correct location even if the CLI's cwd doesn't match.
          const mountDirHint = cli && cli !== 'claude' ? fixtureDir : undefined
          const prefix = variantTaskPrefix(variant, mountDirHint)
          const task = prefix ? `${prefix}${scenario.task}` : scenario.task

          const runResult = await runEval({ agentName, task, fixtureDir, cli, model })
          const newFiles = newMountFiles(join(fixtureDir, '.integrations'), snapshot)
          const score = scoreMountRun({
            mountDir: fixtureDir,
            newFiles,
            expectedPathPrefix: scenario.expectedPathPrefix,
            events: runResult.events,
            cleanExit: runResult.exit.reason === 'exited',
          })

          const status = score.pass ? '✓ PASS' : '✗ FAIL'
          const flags = [
            !score.wroteSomething && 'no-write',
            !score.correctPath && 'wrong-path',
            !score.jsonValid && 'invalid-json',
            score.discoveryViolation && 'discovery-write',
            score.usedRelayMessaging && 'used-relay',
          ].filter(Boolean)
          console.log(
            `${status}${flags.length ? ` (${flags.join(' ')})` : ''} [${Math.round(runResult.durationMs / 1000)}s]`,
          )

          allEntries.push({
            scenarioId: scenario.id,
            scenarioTitle: scenario.title,
            variant,
            run: r + 1,
            pass: score.pass,
            wroteSomething: score.wroteSomething,
            correctPath: score.correctPath,
            jsonValid: score.jsonValid,
            discoveryViolation: score.discoveryViolation,
            usedRelayMessaging: score.usedRelayMessaging,
            filesWritten: score.filesWritten,
            durationMs: runResult.durationMs,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(`ERROR: ${msg}`)
          allEntries.push({
            scenarioId: scenario.id,
            scenarioTitle: scenario.title,
            variant,
            run: r + 1,
            pass: false,
            wroteSomething: false,
            correctPath: false,
            jsonValid: false,
            discoveryViolation: false,
            usedRelayMessaging: false,
            filesWritten: [],
            durationMs: 0,
            error: msg,
          })
        } finally {
          rmSync(fixtureDir, { recursive: true, force: true })
        }
      }

      // Per-cell summary
      const cellRuns = allEntries.filter(
        (e) => e.scenarioId === scenario.id && e.variant === variant,
      )
      const passed = cellRuns.filter((e) => e.pass).length
      const pct = Math.round((passed / cellRuns.length) * 100)
      console.log(`  → ${scenario.id}/${variant}: ${passed}/${cellRuns.length} (${pct}%)\n`)
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────────

  console.log('\n── Results ──────────────────────────────────────────────────────────')
  for (const scenario of scenarios) {
    console.log(`\n${scenario.id}: ${scenario.title}`)
    for (const variant of variants) {
      const runs = allEntries.filter((e) => e.scenarioId === scenario.id && e.variant === variant)
      const passed = runs.filter((e) => e.pass).length
      const pct = runs.length ? Math.round((passed / runs.length) * 100) : 0
      const bar = '█'.repeat(Math.round(pct / 10)).padEnd(10, '░')
      console.log(`  ${variant.padEnd(14)} ${bar} ${passed}/${runs.length} (${pct}%)`)
    }
  }
  console.log()

  // ── Report ────────────────────────────────────────────────────────────────

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  writeReport(allEntries, stamp)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
