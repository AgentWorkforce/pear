import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { homedir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type {
  HotspotsAttributionResult,
  HotspotsBashRow,
  HotspotsBashVerbRow,
  HotspotsFileRow,
  HotspotsMcpServerRow,
  HotspotsSubagentRow
} from '@relayburn/sdk'

export interface BurnAgentInput {
  projectId?: string
  name: string
  cwd?: string
  cli?: string
  force?: boolean
}

export interface BurnModelSummary {
  model: string
  tokens: number
  cost: number
}

export interface BurnToolSummary {
  tool: string
  tokens: number
  cost: number
  count: number
}

export interface BurnSessionRef {
  sessionId: string
  ts?: string
}

export interface BurnAgentSummary {
  projectId?: string
  name: string
  agentKey: string
  totalTokens: number
  totalCost: number
  turnCount: number
  byModel: BurnModelSummary[]
  byTool: BurnToolSummary[]
  sessionIds: BurnSessionRef[]
  updatedAt: number
  status: 'ok' | 'unavailable'
  error?: string
}

export interface BurnHotspotFile {
  path: string
  initialTokens: number
  persistenceTokens: number
  ridingTurns: number
  totalCost: number
}

export interface BurnHotspotBashVerb {
  verb: string
  callCount: number
  distinctCommands: number
  initialTokens: number
  persistenceTokens: number
  avgPersistenceTurns: number
  totalCost: number
  topExamples: string[]
}

export interface BurnHotspotBash {
  command?: string
  callCount: number
  initialTokens: number
  persistenceTokens: number
  totalCost: number
}

export interface BurnHotspotSubagent {
  subagentType: string
  callCount: number
  initialTokens: number
  persistenceTokens: number
  totalCost: number
}

export interface BurnHotspotMcpServer {
  server: string
  callCount: number
  initialTokens: number
  persistenceTokens: number
  ridingTurns: number
  totalCost: number
  topTools: string[]
}

export interface BurnHotspotsBreakdown {
  sessionId?: string
  grandTotal: number
  attributedTotal: number
  unattributedTotal: number
  attributionDegraded: boolean
  files: BurnHotspotFile[]
  bashVerbs: BurnHotspotBashVerb[]
  bash: BurnHotspotBash[]
  subagents: BurnHotspotSubagent[]
  mcpServers: BurnHotspotMcpServer[]
}

export interface BurnHotspotInsight {
  kind: 'file' | 'bash' | 'mcp' | 'subagent'
  label: string
  totalCost: number
  ridingTurns?: number
  detail?: string
}

export interface BurnAgentBreakdown extends BurnAgentSummary {
  primarySessionId?: string
  hotspots?: BurnHotspotsBreakdown
}

export interface BurnSessionBreakdownInput { sessionId: string; force?: boolean }

export interface BurnSessionBreakdown {
  sessionId: string
  agent?: BurnSessionAgentRef
  totalTokens: number
  totalCost: number
  turnCount: number
  models: string[]
  hotspots?: BurnHotspotsBreakdown
  insights: BurnHotspotInsight[]
  updatedAt: number
  status: 'ok' | 'unavailable'
  error?: string
}

export interface BurnFingerprintInput { sessionId?: string; projectId?: string }

export interface BurnProjectOverhead {
  projectId: string
  project?: string
  grandTotal: number
  perSessionTotal: number
  recommendations: Array<{ file: string; heading: string; perSessionUsd: number; tokens: number }>
  updatedAt: number
  status: 'ok' | 'unavailable'
  error?: string
}

export interface BurnSessionAgentRef {
  projectId?: string
  name: string
  agentKey: string
  cli?: string
  cwd?: string
}

export interface BurnSessionLookup {
  sessionId: string
  totalTokens: number
  totalCost: number
  turnCount: number
  agent?: BurnSessionAgentRef
  status: 'ok' | 'unavailable'
  error?: string
}

export interface BurnProjectInput {
  projectId: string
  force?: boolean
}

export interface BurnProjectAgentRollup {
  name: string
  agentKey: string
  totalTokens: number
  totalCost: number
  turnCount: number
  sessionCount: number
  cli?: string
  cwd?: string
  lastTs?: string
}

export interface BurnProjectBreakdown {
  projectId: string
  totalTokens: number
  totalCost: number
  turnCount: number
  byModel: BurnModelSummary[]
  byTool: BurnToolSummary[]
  byAgent: BurnProjectAgentRollup[]
  sessionIds: BurnSessionRef[]
  updatedAt: number
  status: 'ok' | 'unavailable'
  error?: string
}

type BurnSdk = typeof import('@relayburn/sdk')
type BurnSummaryResult = Awaited<ReturnType<BurnSdk['summary']>>
type BurnSummaryTag = NonNullable<BurnSummaryResult['byTag']>[number]

type BurnExportStamp = {
  kind?: string
  ts?: string
  selector?: {
    sessionId?: unknown
  }
  enrichment?: Record<string, unknown>
}

const DEFAULT_LEDGER_HOME = join(homedir(), '.agentworkforce', 'burn')
const INGEST_INTERVAL_MS = 15_000
const SESSION_LOOKUP_CACHE_MS = 60_000
const MAX_SESSIONS_FOR_DETAILS = 12
const MAX_ROWS = 12

let warnedUnavailable = false
const requireForResolve = createRequire(import.meta.url)

const BURN_INGEST_TOOL_RESULT_WARNING_START =
  /^\u26a0(?:\uFE0F)? [^:]+: \d+ sessions logged tool calls without any observed tool_result content \(\d+ tool calls\)\.\r?\n$/
const BURN_INGEST_WARNING_CONTINUATION_LINES = 3

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toNumber(value: number | bigint | undefined): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return 0
}

export function createBurnIngestDiagnosticFilter(): {
  filter: (chunk: string) => string
  flush: () => string
  suppressedCount: () => number
} {
  let pending = ''
  let suppressedCount = 0
  let suppressContinuationLines = 0

  return {
    filter(chunk: string): string {
      pending += chunk
      let output = ''

      for (;;) {
        const newlineIndex = pending.indexOf('\n')
        if (newlineIndex < 0) break

        const line = pending.slice(0, newlineIndex + 1)
        pending = pending.slice(newlineIndex + 1)

        if (suppressContinuationLines > 0) {
          suppressContinuationLines -= 1
          continue
        }

        if (BURN_INGEST_TOOL_RESULT_WARNING_START.test(line)) {
          suppressedCount += 1
          suppressContinuationLines = BURN_INGEST_WARNING_CONTINUATION_LINES
          continue
        }

        output += line
      }

      return output
    },
    flush(): string {
      const output = suppressContinuationLines > 0 ? '' : pending
      pending = ''
      suppressContinuationLines = 0
      return output
    },
    suppressedCount(): number {
      return suppressedCount
    }
  }
}

function buildBurnIngestChildScript(sdkUrl: string, ledgerHome: string): string {
  return `
const sdkUrl = ${JSON.stringify(sdkUrl)}
const ledgerHome = ${JSON.stringify(ledgerHome)}

try {
  const burn = await import(sdkUrl)
  await burn.ingest({ ledgerHome })
} catch (error) {
  const message = error && typeof error === 'object' && 'stack' in error
    ? error.stack
    : String(error)
  console.error(message)
  process.exitCode = 1
}
`
}

async function runBurnIngest(ledgerHome: string): Promise<void> {
  const sdkUrl = pathToFileURL(requireForResolve.resolve('@relayburn/sdk')).href
  const child = spawn(process.execPath, ['--input-type=module', '--eval', buildBurnIngestChildScript(sdkUrl, ledgerHome)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdoutFilter = createBurnIngestDiagnosticFilter()
  const stderrFilter = createBurnIngestDiagnosticFilter()
  let stdoutOutput = ''
  let stderrOutput = ''

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    const filtered = stdoutFilter.filter(chunk)
    if (!filtered) return
    stdoutOutput += filtered
    process.stdout.write(filtered)
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    const filtered = stderrFilter.filter(chunk)
    if (!filtered) return
    stderrOutput += filtered
    process.stderr.write(filtered)
  })

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      child.removeAllListeners('error')
      const finishOutput = (): void => {
        const stdoutRemainder = stdoutFilter.flush()
        if (stdoutRemainder) {
          stdoutOutput += stdoutRemainder
          process.stdout.write(stdoutRemainder)
        }

        const stderrRemainder = stderrFilter.flush()
        if (stderrRemainder) {
          stderrOutput += stderrRemainder
          process.stderr.write(stderrRemainder)
        }
      }

      finishOutput()

      if (code === 0) {
        resolve()
        return
      }

      const detail = (stderrOutput || stdoutOutput).trim()
      reject(new Error(`RelayBurn ingest exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}${detail ? `: ${detail}` : ''}`))
    })
  })
}

function sortSessionRefs(sessions: BurnSessionRef[]): BurnSessionRef[] {
  return [...sessions].sort((left, right) => {
    const rightMs = right.ts ? Date.parse(right.ts) : 0
    const leftMs = left.ts ? Date.parse(left.ts) : 0
    return rightMs - leftMs
  })
}

function matchesTags(enrichment: Record<string, unknown> | undefined, tags: Record<string, string>): boolean {
  if (!enrichment) return false
  return Object.entries(tags).every(([key, value]) => enrichment[key] === value)
}

function normalizeSummary(summary: BurnSummaryResult): {
  totalTokens: number
  totalCost: number
  turnCount: number
  byModel: BurnModelSummary[]
  byTool: BurnToolSummary[]
} {
  return {
    totalTokens: toNumber(summary.totalTokens),
    totalCost: summary.totalCost,
    turnCount: toNumber(summary.turnCount),
    byModel: summary.byModel.map((entry) => ({
      model: entry.model,
      tokens: toNumber(entry.tokens),
      cost: entry.cost
    })),
    byTool: summary.byTool.map((entry) => ({
      tool: entry.tool,
      tokens: toNumber(entry.tokens),
      cost: entry.cost,
      count: entry.count
    }))
  }
}

function tagTotalsByValue(rows: BurnSummaryTag[] | undefined): Map<string, {
  totalTokens: number
  totalCost: number
  turnCount: number
}> {
  const totals = new Map<string, { totalTokens: number; totalCost: number; turnCount: number }>()
  for (const row of rows ?? []) {
    if (!row.value) continue
    totals.set(row.value, {
      totalTokens: toNumber(row.tokens),
      totalCost: row.cost,
      turnCount: toNumber(row.turnCount)
    })
  }
  return totals
}

function sessionRefsForTags(stamps: BurnExportStamp[], tags: Record<string, string>): BurnSessionRef[] {
  const bySessionId = new Map<string, BurnSessionRef>()

  for (const stamp of stamps) {
    if (stamp.kind !== 'stamp' || !matchesTags(stamp.enrichment, tags)) continue
    const sessionId = stamp.selector?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) continue
    const existing = bySessionId.get(sessionId)
    if (!existing || (stamp.ts && (!existing.ts || Date.parse(stamp.ts) > Date.parse(existing.ts)))) {
      bySessionId.set(sessionId, { sessionId, ts: stamp.ts })
    }
  }

  return sortSessionRefs(Array.from(bySessionId.values())).slice(0, MAX_SESSIONS_FOR_DETAILS)
}

function normalizeFileHotspots(rows: HotspotsFileRow[]): BurnHotspotFile[] {
  return rows.slice(0, MAX_ROWS).map((row) => ({
    path: row.path,
    initialTokens: toNumber(row.initialTokens),
    persistenceTokens: toNumber(row.persistenceTokens),
    ridingTurns: row.ridingTurns,
    totalCost: row.totalCost
  }))
}

function normalizeBashVerbHotspots(rows: HotspotsBashVerbRow[]): BurnHotspotBashVerb[] {
  return rows.slice(0, MAX_ROWS).map((row) => ({
    verb: row.verb,
    callCount: row.callCount,
    distinctCommands: row.distinctCommands,
    initialTokens: toNumber(row.initialTokens),
    persistenceTokens: toNumber(row.persistenceTokens),
    avgPersistenceTurns: row.avgPersistenceTurns,
    totalCost: row.totalCost,
    topExamples: row.topExamples.slice(0, 3)
  }))
}

function normalizeBashHotspots(rows: HotspotsBashRow[]): BurnHotspotBash[] {
  return rows.slice(0, MAX_ROWS).map((row) => ({
    command: row.command,
    callCount: row.callCount,
    initialTokens: toNumber(row.initialTokens),
    persistenceTokens: toNumber(row.persistenceTokens),
    totalCost: row.totalCost
  }))
}

function normalizeSubagentHotspots(rows: HotspotsSubagentRow[]): BurnHotspotSubagent[] {
  return rows.slice(0, MAX_ROWS).map((row) => ({
    subagentType: row.subagentType,
    callCount: row.callCount,
    initialTokens: toNumber(row.initialTokens),
    persistenceTokens: toNumber(row.persistenceTokens),
    totalCost: row.totalCost
  }))
}

function normalizeMcpServerHotspots(rows: HotspotsMcpServerRow[]): BurnHotspotMcpServer[] {
  return rows.slice(0, MAX_ROWS).map((row) => ({
    server: row.server,
    callCount: row.callCount,
    initialTokens: toNumber(row.initialTokens),
    persistenceTokens: toNumber(row.persistenceTokens),
    ridingTurns: row.ridingTurns,
    totalCost: row.totalCost,
    topTools: row.topTools.slice(0, 3)
  }))
}

function buildHotspotInsights(normalized: {
  files: BurnHotspotFile[]
  bashVerbs: BurnHotspotBashVerb[]
  mcpServers: BurnHotspotMcpServer[]
  subagents: BurnHotspotSubagent[]
}): BurnHotspotInsight[] {
  const items: BurnHotspotInsight[] = [
    ...normalized.files.map((f) => ({ kind: 'file' as const, label: f.path, totalCost: f.totalCost, ridingTurns: f.ridingTurns })),
    ...normalized.bashVerbs.map((v) => ({ kind: 'bash' as const, label: v.verb, totalCost: v.totalCost, detail: `${v.callCount} calls` })),
    ...normalized.mcpServers.map((m) => ({ kind: 'mcp' as const, label: m.server, totalCost: m.totalCost, ridingTurns: m.ridingTurns, detail: m.topTools.slice(0, 3).join(', ') })),
    ...normalized.subagents.map((s) => ({ kind: 'subagent' as const, label: s.subagentType, totalCost: s.totalCost, detail: `${s.callCount} calls` }))
  ]
  return items.filter((i) => i.totalCost > 0).sort((a, b) => b.totalCost - a.totalCost).slice(0, 8)
}

export function getBurnLedgerHome(): string {
  return process.env.RELAYBURN_HOME?.trim() || DEFAULT_LEDGER_HOME
}

export function getPearBurnAgentKey(projectId: string | undefined, name: string): string {
  return `${projectId || 'unknown'}:${name.trim()}`
}

export function getPearBurnAgentTags(projectId: string | undefined, name: string): Record<string, string> {
  return {
    spawner: 'pear',
    pear_agent_key: getPearBurnAgentKey(projectId, name)
  }
}

export function getPearBurnProjectTags(projectId: string): Record<string, string> {
  return {
    spawner: 'pear',
    pear_project_id: projectId
  }
}

class BurnManager {
  private sdkPromise: Promise<BurnSdk> | null = null
  private ingestPromise: Promise<void> | null = null
  private lastIngestAt = 0
  private sessionLookupCache = new Map<string, { lookup: BurnSessionLookup; updatedAt: number }>()

  async listAgentSummaries(agents: BurnAgentInput[]): Promise<BurnAgentSummary[]> {
    await this.refreshLedger(false)
    if (agents.length <= 1) return Promise.all(agents.map((agent) => this.getAgentSummary(agent)))

    const byProject = new Map<string, Array<{ agent: BurnAgentInput; index: number }>>()
    const fallback: Array<{ agent: BurnAgentInput; index: number }> = []
    agents.forEach((agent, index) => {
      if (!agent.projectId) {
        fallback.push({ agent, index })
        return
      }
      const group = byProject.get(agent.projectId) ?? []
      group.push({ agent, index })
      byProject.set(agent.projectId, group)
    })

    const results = new Map<number, BurnAgentSummary>()
    await Promise.all([
      ...Array.from(byProject.entries()).map(async ([projectId, entries]) => {
        const summaries = await this.listProjectAgentSummaries(projectId, entries.map((entry) => entry.agent))
        summaries.forEach((summary, summaryIndex) => {
          const entry = entries[summaryIndex]
          if (entry) results.set(entry.index, summary)
        })
      }),
      ...fallback.map(async ({ agent, index }) => {
        results.set(index, await this.getAgentSummary(agent))
      })
    ])

    return agents.map((agent, index) => results.get(index) ?? this.emptyAgentSummary(agent))
  }

  async lookupSessions(sessionIds: string[]): Promise<Record<string, BurnSessionLookup>> {
    const deduped = Array.from(new Set(sessionIds.filter((id) => typeof id === 'string' && id.trim())))
    const result: Record<string, BurnSessionLookup> = {}
    if (deduped.length === 0) return result

    const now = Date.now()
    const uncached: string[] = []
    for (const sessionId of deduped) {
      const cached = this.sessionLookupCache.get(sessionId)
      if (cached && now - cached.updatedAt < SESSION_LOOKUP_CACHE_MS) {
        result[sessionId] = cached.lookup
      } else {
        uncached.push(sessionId)
      }
    }
    if (uncached.length === 0) return result

    await this.refreshLedger(false)
    const wanted = new Set(uncached)
    const agentBySession = new Map<string, BurnSessionAgentRef>()

    try {
      const burn = await this.loadSdk()
      const stamps = await burn.exportStamps({ ledgerHome: getBurnLedgerHome() }) as BurnExportStamp[]
      for (const sessionId of wanted) {
        const ref = this.agentRefForSession(stamps, sessionId)
        if (ref) agentBySession.set(sessionId, ref)
      }

      await Promise.all(uncached.map(async (sessionId) => {
        try {
          const cost = await burn.sessionCost({ session: sessionId, ledgerHome: getBurnLedgerHome() })
          const tokens = toNumber(cost.totalTokens)
          const totalCost = cost.totalUSD ?? 0
          if (tokens === 0 && totalCost === 0 && cost.turnCount === 0 && !agentBySession.has(sessionId)) {
            return
          }
          result[sessionId] = {
            sessionId,
            totalTokens: tokens,
            totalCost,
            turnCount: cost.turnCount ?? 0,
            agent: agentBySession.get(sessionId),
            status: 'ok'
          }
          this.sessionLookupCache.set(sessionId, { lookup: result[sessionId], updatedAt: Date.now() })
        } catch (error) {
          result[sessionId] = {
            sessionId,
            totalTokens: 0,
            totalCost: 0,
            turnCount: 0,
            agent: agentBySession.get(sessionId),
            status: 'unavailable',
            error: toErrorMessage(error)
          }
          this.sessionLookupCache.set(sessionId, { lookup: result[sessionId], updatedAt: Date.now() })
        }
      }))
    } catch (error) {
      const message = toErrorMessage(error)
      for (const sessionId of uncached) {
        result[sessionId] = {
          sessionId,
          totalTokens: 0,
          totalCost: 0,
          turnCount: 0,
          status: 'unavailable',
          error: message
        }
        this.sessionLookupCache.set(sessionId, { lookup: result[sessionId], updatedAt: Date.now() })
      }
    }

    return result
  }

  async getProjectBreakdown(input: BurnProjectInput): Promise<BurnProjectBreakdown> {
    await this.refreshLedger(input.force === true)
    const tags = getPearBurnProjectTags(input.projectId)
    const base = {
      projectId: input.projectId,
      updatedAt: Date.now()
    }

    try {
      const burn = await this.loadSdk()
      const summary = await burn.summary({
        tags,
        groupByTag: 'pear_agent_key',
        ledgerHome: getBurnLedgerHome()
      })
      const stamps = await burn.exportStamps({ ledgerHome: getBurnLedgerHome() }) as BurnExportStamp[]
      const { sessions, byAgent } = this.collectProjectStamps(input.projectId, stamps, summary.byTag)
      const normalized = normalizeSummary(summary)

      return {
        ...base,
        ...normalized,
        byAgent,
        sessionIds: sessions,
        status: 'ok'
      }
    } catch (error) {
      return {
        ...base,
        totalTokens: 0,
        totalCost: 0,
        turnCount: 0,
        byModel: [],
        byTool: [],
        byAgent: [],
        sessionIds: [],
        status: 'unavailable',
        error: toErrorMessage(error)
      }
    }
  }

  async getAgentBreakdown(agent: BurnAgentInput): Promise<BurnAgentBreakdown> {
    await this.refreshLedger(agent.force === true)
    const summary = await this.getAgentSummary(agent, true)
    if (summary.status !== 'ok') return summary

    const primarySessionId = summary.sessionIds[0]?.sessionId
    if (!primarySessionId) {
      return summary
    }

    try {
      const burn = await this.loadSdk()
      const hotspots = await burn.hotspots({
        session: primarySessionId,
        groupBy: 'attribution',
        ledgerHome: getBurnLedgerHome()
      })

      if (hotspots.kind !== 'attribution') {
        return {
          ...summary,
          primarySessionId
        }
      }

      const attribution = hotspots as HotspotsAttributionResult
      return {
        ...summary,
        primarySessionId,
        hotspots: {
          sessionId: primarySessionId,
          grandTotal: attribution.grandTotal,
          attributedTotal: attribution.attributedTotal,
          unattributedTotal: attribution.unattributedTotal,
          attributionDegraded: attribution.attributionDegraded,
          files: normalizeFileHotspots(attribution.files),
          bashVerbs: normalizeBashVerbHotspots(attribution.bashVerbs),
          bash: normalizeBashHotspots(attribution.bash),
          subagents: normalizeSubagentHotspots(attribution.subagents),
          mcpServers: normalizeMcpServerHotspots(attribution.mcpServers ?? [])
        }
      }
    } catch (error) {
      return {
        ...summary,
        primarySessionId,
        error: toErrorMessage(error)
      }
    }
  }

  async getSessionBreakdown(input: BurnSessionBreakdownInput): Promise<BurnSessionBreakdown> {
    await this.refreshLedger(input.force === true)
    const base = {
      sessionId: input.sessionId,
      totalTokens: 0,
      totalCost: 0,
      turnCount: 0,
      models: [] as string[],
      insights: [] as BurnHotspotInsight[],
      updatedAt: Date.now()
    }

    try {
      const burn = await this.loadSdk()
      const ledgerHome = getBurnLedgerHome()
      const cost = await burn.sessionCost({ session: input.sessionId, ledgerHome })
      const hs = await burn.hotspots({ session: input.sessionId, groupBy: 'attribution', ledgerHome })
      const stamps = await burn.exportStamps({ ledgerHome }) as BurnExportStamp[]

      let hotspots: BurnHotspotsBreakdown | undefined
      let insights: BurnHotspotInsight[] = []

      if (hs.kind === 'attribution') {
        const attribution = hs as HotspotsAttributionResult
        const normalizedFiles = normalizeFileHotspots(attribution.files)
        const normalizedBashVerbs = normalizeBashVerbHotspots(attribution.bashVerbs)
        const normalizedBash = normalizeBashHotspots(attribution.bash)
        const normalizedSubagents = normalizeSubagentHotspots(attribution.subagents)
        const normalizedMcpServers = normalizeMcpServerHotspots(attribution.mcpServers ?? [])
        hotspots = {
          sessionId: input.sessionId,
          grandTotal: attribution.grandTotal,
          attributedTotal: attribution.attributedTotal,
          unattributedTotal: attribution.unattributedTotal,
          attributionDegraded: attribution.attributionDegraded,
          files: normalizedFiles,
          bashVerbs: normalizedBashVerbs,
          bash: normalizedBash,
          subagents: normalizedSubagents,
          mcpServers: normalizedMcpServers
        }
        insights = buildHotspotInsights({
          files: normalizedFiles,
          bashVerbs: normalizedBashVerbs,
          mcpServers: normalizedMcpServers,
          subagents: normalizedSubagents
        })
      }

      const agent = this.agentRefForSession(stamps, input.sessionId)

      return {
        sessionId: input.sessionId,
        agent,
        totalTokens: toNumber(cost.totalTokens),
        totalCost: cost.totalUSD ?? 0,
        turnCount: cost.turnCount ?? 0,
        models: cost.models ?? [],
        hotspots,
        insights,
        updatedAt: Date.now(),
        status: 'ok'
      }
    } catch (err) {
      return {
        ...base,
        status: 'unavailable',
        error: toErrorMessage(err)
      }
    }
  }

  async getFingerprint(input: BurnFingerprintInput): Promise<{ fingerprint: string }> {
    try {
      const burn = await this.loadSdk()
      const ledgerHome = getBurnLedgerHome()
      const res = input.sessionId
        ? await burn.fingerprint({ session: input.sessionId, ledgerHome })
        : await burn.fingerprint({ ledgerHome })
      return { fingerprint: res.fingerprint }
    } catch {
      return { fingerprint: '' }
    }
  }

  async getProjectOverhead(input: { projectId: string }): Promise<BurnProjectOverhead> {
    await this.refreshLedger(false)
    const base = {
      projectId: input.projectId,
      grandTotal: 0,
      perSessionTotal: 0,
      recommendations: [] as Array<{ file: string; heading: string; perSessionUsd: number; tokens: number }>,
      updatedAt: Date.now()
    }

    let cwd: string | undefined
    try {
      const burn = await this.loadSdk()
      const stamps = await burn.exportStamps({ ledgerHome: getBurnLedgerHome() }) as BurnExportStamp[]
      const cwdCounts = new Map<string, number>()
      for (const stamp of stamps) {
        if (stamp.kind !== 'stamp') continue
        const enrichment = stamp.enrichment as Record<string, unknown> | undefined
        if (!enrichment || enrichment.spawner !== 'pear' || enrichment.pear_project_id !== input.projectId) continue
        const stampCwd = typeof enrichment.pear_cwd === 'string' ? enrichment.pear_cwd : undefined
        if (!stampCwd) continue
        cwdCounts.set(stampCwd, (cwdCounts.get(stampCwd) ?? 0) + 1)
      }
      let maxCount = 0
      for (const [c, count] of cwdCounts.entries()) {
        if (count > maxCount) {
          maxCount = count
          cwd = c
        }
      }
    } catch (err) {
      return { ...base, status: 'unavailable', error: toErrorMessage(err) }
    }

    if (!cwd) {
      return { ...base, status: 'unavailable', error: 'no cwd' }
    }

    try {
      const burn = await this.loadSdk()
      const ledgerHome = getBurnLedgerHome()
      const ov = await burn.overhead({ project: cwd, ledgerHome })
      const trim = await burn.overheadTrim({ project: cwd, top: 5, ledgerHome })
      const recommendations = (trim.recommendations ?? []).map((r) => ({
        file: r.file,
        heading: r.section.heading,
        perSessionUsd: r.projectedSavings.perSessionUsd,
        tokens: toNumber(r.projectedSavings.tokens)
      }))
      return {
        projectId: input.projectId,
        project: cwd,
        grandTotal: ov.grandTotal,
        perSessionTotal: trim.summary?.totalProjectedSavingsPerSession ?? 0,
        recommendations,
        updatedAt: Date.now(),
        status: 'ok'
      }
    } catch (err) {
      return { ...base, project: cwd, status: 'unavailable', error: toErrorMessage(err) }
    }
  }

  private agentRefForSession(stamps: BurnExportStamp[], sessionId: string): BurnSessionAgentRef | undefined {
    for (const stamp of stamps) {
      if (stamp.kind !== 'stamp') continue
      const sid = stamp.selector?.sessionId
      if (sid !== sessionId) continue
      const enrichment = stamp.enrichment as Record<string, unknown> | undefined
      if (!enrichment || enrichment.spawner !== 'pear') continue
      const agentName = typeof enrichment.pear_agent_name === 'string' ? enrichment.pear_agent_name : null
      if (!agentName) continue
      const projectId = typeof enrichment.pear_project_id === 'string' ? enrichment.pear_project_id : undefined
      const agentKey = typeof enrichment.pear_agent_key === 'string'
        ? enrichment.pear_agent_key
        : getPearBurnAgentKey(projectId, agentName)
      return {
        projectId,
        name: agentName,
        agentKey,
        cli: typeof enrichment.pear_cli === 'string' ? enrichment.pear_cli : undefined,
        cwd: typeof enrichment.pear_cwd === 'string' ? enrichment.pear_cwd : undefined
      }
    }
    return undefined
  }

  private emptyAgentSummary(agent: BurnAgentInput, error?: string): BurnAgentSummary {
    const tags = getPearBurnAgentTags(agent.projectId, agent.name)
    return {
      projectId: agent.projectId,
      name: agent.name,
      agentKey: tags.pear_agent_key,
      totalTokens: 0,
      totalCost: 0,
      turnCount: 0,
      byModel: [],
      byTool: [],
      sessionIds: [],
      updatedAt: Date.now(),
      status: error ? 'unavailable' : 'ok',
      error
    }
  }

  private async listProjectAgentSummaries(projectId: string, agents: BurnAgentInput[]): Promise<BurnAgentSummary[]> {
    const tags = getPearBurnProjectTags(projectId)

    try {
      const burn = await this.loadSdk()
      const summary = await burn.summary({
        tags,
        groupByTag: 'pear_agent_key',
        ledgerHome: getBurnLedgerHome()
      })
      const byAgentKey = tagTotalsByValue(summary.byTag)

      return agents.map((agent) => {
        const base = this.emptyAgentSummary(agent)
        const totals = byAgentKey.get(base.agentKey)
        if (!totals) return base
        return {
          ...base,
          totalTokens: totals.totalTokens,
          totalCost: totals.totalCost,
          turnCount: totals.turnCount
        }
      })
    } catch {
      return Promise.all(agents.map((agent) => this.getAgentSummary(agent)))
    }
  }

  private async getAgentSummary(agent: BurnAgentInput, includeSessionIds = false): Promise<BurnAgentSummary> {
    const tags = getPearBurnAgentTags(agent.projectId, agent.name)
    const base = this.emptyAgentSummary(agent)

    try {
      const burn = await this.loadSdk()
      const summary = await burn.summary({ tags, ledgerHome: getBurnLedgerHome() })
      const sessionIds = includeSessionIds ? await this.listSessionIdsForTags(tags) : []
      const normalized = normalizeSummary(summary)

      return {
        ...base,
        ...normalized,
        sessionIds,
        status: 'ok'
      }
    } catch (error) {
      return {
        ...base,
        status: 'unavailable',
        error: toErrorMessage(error)
      }
    }
  }

  private collectProjectStamps(projectId: string, stamps: BurnExportStamp[], tagRows: BurnSummaryTag[] | undefined): {
    sessions: BurnSessionRef[]
    byAgent: BurnProjectAgentRollup[]
  } {
    const totalsByAgentKey = tagTotalsByValue(tagRows)
    const bySession = new Map<string, BurnSessionRef>()
    const agentBuckets = new Map<string, {
      name: string
      agentKey: string
      sessionCount: number
      cli?: string
      cwd?: string
      lastTs?: string
    }>()
    const agentSessionIds = new Map<string, Set<string>>()

    for (const stamp of stamps) {
      if (stamp.kind !== 'stamp') continue
      const enrichment = stamp.enrichment as Record<string, unknown> | undefined
      if (!enrichment || enrichment.spawner !== 'pear' || enrichment.pear_project_id !== projectId) continue
      const sessionId = stamp.selector?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) continue

      const existing = bySession.get(sessionId)
      if (!existing || (stamp.ts && (!existing.ts || Date.parse(stamp.ts) > Date.parse(existing.ts)))) {
        bySession.set(sessionId, { sessionId, ts: stamp.ts })
      }

      const agentName = typeof enrichment.pear_agent_name === 'string'
        ? enrichment.pear_agent_name
        : null
      if (!agentName) continue

      const agentKey = typeof enrichment.pear_agent_key === 'string'
        ? enrichment.pear_agent_key
        : getPearBurnAgentKey(projectId, agentName)

      let sessions = agentSessionIds.get(agentKey)
      if (!sessions) {
        sessions = new Set()
        agentSessionIds.set(agentKey, sessions)
      }
      sessions.add(sessionId)

      const cli = typeof enrichment.pear_cli === 'string' ? enrichment.pear_cli : undefined
      const cwd = typeof enrichment.pear_cwd === 'string' ? enrichment.pear_cwd : undefined
      const bucket = agentBuckets.get(agentKey)
      if (!bucket) {
        agentBuckets.set(agentKey, {
          name: agentName,
          agentKey,
          sessionCount: 0,
          cli,
          cwd,
          lastTs: stamp.ts
        })
      } else {
        if (cli && !bucket.cli) bucket.cli = cli
        if (cwd && !bucket.cwd) bucket.cwd = cwd
        if (stamp.ts && (!bucket.lastTs || Date.parse(stamp.ts) > Date.parse(bucket.lastTs))) {
          bucket.lastTs = stamp.ts
        }
      }
    }

    for (const [agentKey, sessions] of Array.from(agentSessionIds.entries())) {
      const bucket = agentBuckets.get(agentKey)
      if (bucket) bucket.sessionCount = sessions.size
    }

    const sessions = sortSessionRefs(Array.from(bySession.values())).slice(0, MAX_SESSIONS_FOR_DETAILS)

    for (const agentKey of totalsByAgentKey.keys()) {
      if (agentBuckets.has(agentKey)) continue
      const prefix = `${projectId}:`
      agentBuckets.set(agentKey, {
        name: agentKey.startsWith(prefix) ? agentKey.slice(prefix.length) : agentKey,
        agentKey,
        sessionCount: 0
      })
    }

    const byAgent = Array.from(agentBuckets.values()).map((bucket) => {
      const totals = totalsByAgentKey.get(bucket.agentKey)
      return {
        name: bucket.name,
        agentKey: bucket.agentKey,
        totalTokens: totals?.totalTokens ?? 0,
        totalCost: totals?.totalCost ?? 0,
        turnCount: totals?.turnCount ?? 0,
        sessionCount: bucket.sessionCount,
        cli: bucket.cli,
        cwd: bucket.cwd,
        lastTs: bucket.lastTs
      } satisfies BurnProjectAgentRollup
    })

    byAgent.sort((left, right) => right.totalCost - left.totalCost)
    return { sessions, byAgent }
  }

  private async listSessionIdsForTags(tags: Record<string, string>): Promise<BurnSessionRef[]> {
    const burn = await this.loadSdk()
    const stamps = await burn.exportStamps({ ledgerHome: getBurnLedgerHome() }) as BurnExportStamp[]
    return sessionRefsForTags(stamps, tags)
  }

  /**
   * Pay the one-time native-binding load + DB-open cost (~1.3s) and prime the
   * ledger once at startup — off the user's critical path — so the first burn
   * view queries a warm, recently-ingested ledger instead of stalling on it.
   */
  warmUp(): void {
    void this.ingestRecent()
  }

  /**
   * Keep the ledger fresh without blocking reads on it. A manual refresh
   * (`force`) awaits a fresh ingest; otherwise ingest runs in the background
   * (throttled + deduped) while the caller queries the current ledger
   * immediately. `ingest()` costs ~1.5s even incrementally, so awaiting it on
   * every read is what made burn views feel slow.
   */
  private async refreshLedger(force: boolean): Promise<void> {
    if (force) {
      await this.ingestRecent(true)
    } else {
      void this.ingestRecent()
    }
  }

  private async ingestRecent(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - this.lastIngestAt < INGEST_INTERVAL_MS) return
    if (this.ingestPromise) return this.ingestPromise
    if (!existsSync(getBurnLedgerHome())) return

    this.ingestPromise = (async () => {
      try {
        await runBurnIngest(getBurnLedgerHome())
        this.lastIngestAt = Date.now()
      } catch (error) {
        this.lastIngestAt = Date.now()
        if (!warnedUnavailable) {
          warnedUnavailable = true
          console.warn('[burn] Failed to ingest recent sessions:', error)
        }
      } finally {
        this.ingestPromise = null
      }
    })()

    return this.ingestPromise
  }

  private async loadSdk(): Promise<BurnSdk> {
    if (!this.sdkPromise) {
      this.sdkPromise = import('@relayburn/sdk')
    }
    return this.sdkPromise
  }
}

export const burnManager = new BurnManager()
