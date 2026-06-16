import { FACTORY_STATE_ROLES, type FactoryStateRole } from '../config/schema'

// Roles the factory cannot operate without; humanReview is optional (the
// terminalState falls back to `done` when it is unset).
const REQUIRED_ROLES: readonly FactoryStateRole[] = [
  'readyForAgent',
  'agentImplementing',
  'inPlanning',
  'done',
]

const STATES_INDEX_PATH = '/linear/states/_index.json'
const stateCanonicalPath = (id: string): string => `/linear/states/${id}.json`

// Minimal read surface so the resolver is decoupled from the full MountClient
// and trivially testable with an in-memory map.
export interface LinearStateReader {
  readFile(path: string): Promise<{ content: unknown }>
}

type RoleNames = Partial<Record<FactoryStateRole, string>>
type RoleIds = Partial<Record<FactoryStateRole, string>>

export interface ResolveFactoryStatesInput {
  // role -> workflow-state name, workspace-wide default
  states?: RoleNames
  // teamKey -> (role -> workflow-state name), per-team overrides
  statesByTeam?: Record<string, RoleNames>
  // role -> explicit UUID, lowest-precedence fallback
  stateIds?: RoleIds
  // teams the factory subscribes to; resolved up front so required-role gaps
  // fail loudly at startup rather than mid-run.
  teams?: readonly string[]
}

export interface FactoryStateResolution {
  // Forward: the UUID a role maps to for an issue's team (throws if a required
  // role is unresolved). Falls back to the global mapping when the team has no
  // override.
  idFor(teamToken: string | undefined, role: FactoryStateRole): string
  optionalIdFor(teamToken: string | undefined, role: FactoryStateRole): string | undefined
  // Reverse: which role (if any) a state UUID fills. UUIDs are globally unique,
  // so reads/filters need no team context.
  roleOf(stateId: string | undefined): FactoryStateRole | undefined
  isRole(stateId: string | undefined, role: FactoryStateRole): boolean
  // True when any team resolves a humanReview state (gates terminalState).
  hasHumanReview(teamToken?: string): boolean
}

// Build a resolution from explicit, already-known UUIDs (no mount reads). Used
// as the back-compat / test path when names aren't configured: the global ids
// apply to every team. Lenient — unresolved roles only throw when used.
export function stateResolutionFromIds(stateIds: RoleIds): FactoryStateResolution {
  const roleById = new Map<string, FactoryStateRole>()
  for (const role of FACTORY_STATE_ROLES) {
    const id = stateIds[role]
    if (id) roleById.set(id, role)
  }
  return {
    idFor(_teamToken, role) {
      const id = stateIds[role]
      if (!id) throw new Error(`No resolved Linear state for role "${role}".`)
      return id
    },
    optionalIdFor(_teamToken, role) {
      return stateIds[role]
    },
    roleOf(stateId) {
      return stateId ? roleById.get(stateId) : undefined
    },
    isRole(stateId, role) {
      return Boolean(stateId) && roleById.get(stateId as string) === role
    },
    hasHumanReview() {
      return Boolean(stateIds.humanReview)
    },
  }
}

interface StateRecord {
  id: string
  name?: string
  teamKey?: string
  teamName?: string
}

const norm = (value: string | undefined): string => (value ?? '').trim().toLowerCase()

const asArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['entries', 'rows', 'items', 'payload']) {
      if (Array.isArray(record[key])) return record[key] as unknown[]
    }
  }
  return []
}

const unwrap = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  return record.payload && typeof record.payload === 'object'
    ? (record.payload as Record<string, unknown>)
    : record
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

// Lazily load and cache the /linear/states catalog. Only invoked when at least
// one role is configured by name, so explicit-UUID setups never read it.
class StateCatalog {
  #records: StateRecord[] | undefined
  constructor(private readonly reader: LinearStateReader) {}

  async records(): Promise<StateRecord[]> {
    if (this.#records) return this.#records
    let index: unknown
    try {
      index = (await this.reader.readFile(STATES_INDEX_PATH)).content
    } catch (error) {
      throw new Error(
        `Cannot resolve Linear state names: ${STATES_INDEX_PATH} is unavailable ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Deploy the workflow-states resource or pin stateIds (UUIDs) in config.`,
      )
    }
    const ids = asArray(index)
      .map((row) => str((row as Record<string, unknown>)?.id))
      .filter((id): id is string => Boolean(id))
    const records = await Promise.all(ids.map(async (id): Promise<StateRecord> => {
      try {
        const rec = unwrap((await this.reader.readFile(stateCanonicalPath(id))).content)
        return { id, name: str(rec.name), teamKey: str(rec.team_key), teamName: str(rec.team_name) }
      } catch {
        return { id }
      }
    }))
    this.#records = records
    return records
  }

  // Resolve a state NAME to a UUID, optionally scoped to a team token (matched
  // against team_key or team_name). Throws on no match or ambiguity.
  async resolve(name: string, teamToken: string | undefined): Promise<string> {
    const records = await this.records()
    let matches = records.filter((rec) => norm(rec.name) === norm(name))
    if (teamToken) {
      const scoped = matches.filter((rec) => norm(rec.teamKey) === norm(teamToken) || norm(rec.teamName) === norm(teamToken))
      if (scoped.length > 0) matches = scoped
    }
    if (matches.length === 0) {
      throw new Error(`No Linear workflow state named "${name}"${teamToken ? ` for team "${teamToken}"` : ''}.`)
    }
    if (matches.length > 1) {
      throw new Error(
        `Linear workflow state "${name}" is ambiguous (${matches.length} matches)` +
        `${teamToken ? ` for team "${teamToken}"` : ''}; scope it with linear.statesByTeam.`,
      )
    }
    return matches[0].id
  }
}

// Resolve every configured role for every known team to concrete UUIDs, building
// the forward (team,role)->id map and the reverse id->role map. Throws if a
// required role cannot be resolved for any team.
export async function resolveFactoryStates(
  reader: LinearStateReader,
  input: ResolveFactoryStatesInput,
): Promise<FactoryStateResolution> {
  const catalog = new StateCatalog(reader)
  const globalNames = input.states ?? {}
  const explicitIds = input.stateIds ?? {}
  const byTeamNames = input.statesByTeam ?? {}

  // Resolve one role for one team token, applying precedence:
  // per-team name > global name > explicit UUID.
  const resolveRole = async (teamToken: string | undefined, role: FactoryStateRole): Promise<string | undefined> => {
    const perTeamName = teamToken ? byTeamNames[teamToken]?.[role] : undefined
    const name = perTeamName ?? globalNames[role]
    if (name) return catalog.resolve(name, teamToken)
    return explicitIds[role]
  }

  const teamTokens = new Set<string>([...Object.keys(byTeamNames), ...(input.teams ?? [])])
  const byTeam = new Map<string, RoleIds>()

  const resolveAllRoles = async (teamToken: string | undefined): Promise<RoleIds> => {
    const resolved: RoleIds = {}
    for (const role of FACTORY_STATE_ROLES) {
      const id = await resolveRole(teamToken, role)
      if (id) resolved[role] = id
    }
    const missing = REQUIRED_ROLES.filter((role) => !resolved[role])
    if (missing.length > 0) {
      throw new Error(
        `Linear state resolution incomplete${teamToken ? ` for team "${teamToken}"` : ''}: ` +
        `missing [${missing.join(', ')}]. Set linear.states / linear.statesByTeam (by name) or stateIds (UUIDs).`,
      )
    }
    return resolved
  }

  const defaultIds = await resolveAllRoles(undefined)
  for (const team of teamTokens) {
    byTeam.set(norm(team), await resolveAllRoles(team))
  }

  const idsFor = (teamToken: string | undefined): RoleIds =>
    (teamToken ? byTeam.get(norm(teamToken)) : undefined) ?? defaultIds

  // Reverse map across the default + every team mapping.
  const roleById = new Map<string, FactoryStateRole>()
  for (const ids of [defaultIds, ...byTeam.values()]) {
    for (const role of FACTORY_STATE_ROLES) {
      const id = ids[role]
      if (id) roleById.set(id, role)
    }
  }

  return {
    idFor(teamToken, role) {
      const id = idsFor(teamToken)[role]
      if (!id) throw new Error(`No resolved Linear state for role "${role}"${teamToken ? ` (team "${teamToken}")` : ''}.`)
      return id
    },
    optionalIdFor(teamToken, role) {
      return idsFor(teamToken)[role]
    },
    roleOf(stateId) {
      return stateId ? roleById.get(stateId) : undefined
    },
    isRole(stateId, role) {
      return Boolean(stateId) && roleById.get(stateId as string) === role
    },
    hasHumanReview(teamToken) {
      return Boolean(idsFor(teamToken).humanReview)
    },
  }
}
