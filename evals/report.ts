/**
 * Writes JSON and HTML eval reports to evals/reports/.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MountScenarioResult } from '@agent-relay/evals'
import { mountCellStats } from '@agent-relay/evals/scoring/mount'
import type { MountScore } from '@agent-relay/evals/scoring/mount'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPORTS_DIR = join(__dirname, 'reports')

export function writeReport(entries: MountScenarioResult[], stamp: string): void {
  mkdirSync(REPORTS_DIR, { recursive: true })

  const jsonPath = join(REPORTS_DIR, `report-${stamp}.json`)
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: stamp, entries }, null, 2))
  console.log(`JSON report: ${jsonPath}`)

  const htmlPath = join(REPORTS_DIR, `report-${stamp}.html`)
  writeFileSync(htmlPath, buildHtml(entries, stamp))
  console.log(`HTML report: ${htmlPath}`)
}

const VARIANT_ORDER = ['bare', 'claude-md', 'slim-inject', 'full-inject']

function buildHtml(entries: MountScenarioResult[], stamp: string): string {
  const scenarios = [...new Set(entries.map((e) => e.scenarioId))].sort()
  const variants = [...new Set(entries.map((e) => e.variant))].sort(
    (a, b) => VARIANT_ORDER.indexOf(a) - VARIANT_ORDER.indexOf(b),
  )

  function cell(sid: string, v: string): string {
    const runs = entries.filter((e) => e.scenarioId === sid && e.variant === v)
    if (runs.length === 0) return '<td class="na">—</td>'

    const scores: MountScore[] = runs.map((r) => ({
      wroteSomething: r.wroteSomething,
      correctPath: r.correctPath,
      jsonValid: r.jsonValid,
      discoveryViolation: r.discoveryViolation,
      usedRelayMessaging: r.usedRelayMessaging,
      cleanExit: true,
      pass: r.pass,
      filesWritten: r.filesWritten,
      filesAtCorrectPath: [],
    }))
    const stats = mountCellStats(scores)
    const pct = Math.round(stats.passRate * 100)
    const cls = pct === 100 ? 'pass' : pct === 0 ? 'fail' : 'partial'
    const tooltip = [
      `wrote: ${Math.round(stats.wroteSomethingRate * 100)}%`,
      `correct path: ${Math.round(stats.correctPathRate * 100)}%`,
      `discovery violation: ${Math.round(stats.discoveryViolationRate * 100)}%`,
      `used relay: ${Math.round(stats.usedRelayMessagingRate * 100)}%`,
    ].join(' | ')
    return `<td class="${cls}" title="${tooltip}">${stats.passed}/${stats.runs} (${pct}%)</td>`
  }

  const rows = scenarios.map((sid) => {
    const title = entries.find((e) => e.scenarioId === sid)?.scenarioTitle ?? sid
    return `<tr><td class="label">${sid}: ${title}</td>${variants.map((v) => cell(sid, v)).join('')}</tr>`
  })

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pear Mount Evals — ${stamp}</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 2rem; background: #fafafa; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  p.subtitle { color: #666; margin: 0 0 1.5rem; font-size: 0.9rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.5rem 0.75rem; text-align: center; font-size: 0.9rem; }
  th { background: #f0f0f0; font-weight: 600; }
  td.label { text-align: left; font-weight: 500; }
  td.pass { background: #d4edda; color: #155724; }
  td.fail { background: #f8d7da; color: #721c24; }
  td.partial { background: #fff3cd; color: #856404; }
  td.na { color: #aaa; }
</style>
</head>
<body>
<h1>Pear Integration Mount Evals</h1>
<p class="subtitle">Generated ${stamp} · ${entries.length} total runs</p>
<table>
  <thead>
    <tr><th>Scenario</th>${variants.map((v) => `<th>${v}</th>`).join('')}</tr>
  </thead>
  <tbody>
    ${rows.join('\n    ')}
  </tbody>
</table>
<p style="margin-top:1.5rem;font-size:0.8rem;color:#888">
  Hover cells for per-dimension breakdown. Pass = correct path + valid JSON + no discovery violation.
</p>
</body>
</html>`
}
