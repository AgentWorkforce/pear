import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type {
  HotspotsAttributionResult,
  HotspotsBashRow,
  HotspotsBashVerbRow,
  HotspotsFileRow,
  HotspotsSubagentRow
} from '@relayburn/sdk'

export interface BurnAgentInput {
  projectId?: string
  name: string
  cwd?: string
  cli?: string
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
}

export interface BurnAgentBreakdown extends BurnAgentSummary {
  primarySessionId?: string
  hotspots?: BurnHotspotsBreakdown
}

type BurnSdk = typeof import('@relayburn/sdk')

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
const MAX_SESSIONS_FOR_DETAILS = 12
const MAX_ROWS = 12

let warnedUnavailable = false

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toNumber(value: number | bigint | undefined): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return 0
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

class BurnManager {
  private sdkPromise: Promise<BurnSdk> | null = null
  private ingestPromise: Promise<void> | null = null
  private lastIngestAt = 0

  async listAgentSummaries(agents: BurnAgentInput[]): Promise<BurnAgentSummary[]> {
    await this.ingestRecent()
    return Promise.all(agents.map((agent) => this.getAgentSummary(agent)))
  }

  async getAgentBreakdown(agent: BurnAgentInput): Promise<BurnAgentBreakdown> {
    await this.ingestRecent(true)
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
          subagents: normalizeSubagentHotspots(attribution.subagents)
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

  private async getAgentSummary(agent: BurnAgentInput, includeSessionIds = false): Promise<BurnAgentSummary> {
    const tags = getPearBurnAgentTags(agent.projectId, agent.name)
    const base = {
      projectId: agent.projectId,
      name: agent.name,
      agentKey: tags.pear_agent_key,
      updatedAt: Date.now()
    }

    try {
      const burn = await this.loadSdk()
      const summary = await burn.summary({ tags, ledgerHome: getBurnLedgerHome() })
      const sessionIds = includeSessionIds ? await this.listSessionIdsForTags(tags) : []

      return {
        ...base,
        totalTokens: toNumber(summary.totalTokens),
        totalCost: summary.totalCost,
        turnCount: summary.turnCount,
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
        })),
        sessionIds,
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
        sessionIds: [],
        status: 'unavailable',
        error: toErrorMessage(error)
      }
    }
  }

  private async listSessionIdsForTags(tags: Record<string, string>): Promise<BurnSessionRef[]> {
    const burn = await this.loadSdk()
    const stamps = await burn.exportStamps({ ledgerHome: getBurnLedgerHome() }) as BurnExportStamp[]
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

  private async ingestRecent(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - this.lastIngestAt < INGEST_INTERVAL_MS) return
    if (this.ingestPromise) return this.ingestPromise
    if (!existsSync(getBurnLedgerHome())) return

    this.ingestPromise = (async () => {
      try {
        const burn = await this.loadSdk()
        await burn.ingest({ ledgerHome: getBurnLedgerHome() })
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
