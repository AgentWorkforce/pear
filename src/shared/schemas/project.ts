import { z } from 'zod'

export function normalizeChannelName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function defaultRootName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

const trimmedString = z.string().transform((value) => value.trim())

const stringArray = z
  .unknown()
  .transform((value): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  )

const channelsSchema = stringArray.transform((values) => {
  const deduped = Array.from(new Set(values.map(normalizeChannelName).filter(Boolean)))
  return deduped.length > 0 ? deduped : ['general']
})

const peopleListSchema = stringArray.transform((values) => {
  const trimmed = values.map((entry) => entry.trim()).filter(Boolean)
  return Array.from(new Map(trimmed.map((name) => [name.toLowerCase(), name])).values())
})

const channelPeopleSchema = z
  .unknown()
  .transform((value): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  )

function buildChannelPeople(raw: Record<string, unknown>, channels: string[]): Record<string, string[]> {
  const channelSet = new Set(channels)
  const result: Record<string, string[]> = {}
  for (const [rawChannel, rawPeople] of Object.entries(raw)) {
    const channel = normalizeChannelName(rawChannel)
    if (!channel || !channelSet.has(channel)) continue
    const people = peopleListSchema.parse(rawPeople)
    if (people.length > 0) result[channel] = people
  }
  return result
}

function dedupeRoots<T extends { path: string }>(roots: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const root of roots) {
    if (seen.has(root.path)) continue
    seen.add(root.path)
    out.push(root)
  }
  return out
}

export const ProjectRootSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    path: z.string().min(1)
  })
  .passthrough()
  .transform((value) => ({
    id: value.id?.trim() || value.path,
    name: value.name?.trim() || defaultRootName(value.path),
    path: value.path
  }))

export const ProjectIntegrationSchema = z
  .object({
    id: z.string().optional(),
    name: trimmedString,
    type: z.string().optional()
  })
  .passthrough()
  .refine((value) => value.name.length > 0, { message: 'integration name is required' })
  .transform((value) => ({
    ...value,
    id: value.id?.trim() || crypto.randomUUID(),
    name: value.name,
    type: value.type?.trim() || 'custom'
  }))

/**
 * Build a project schema parameterized by the per-process root shape.
 *
 * Main stores `{ id, name, path }` on disk. Renderer adds `pathExists`
 * computed at IPC time.
 */
export function makeProjectSchema<R extends { id: string; name: string; path: string }>(
  rootSchema: z.ZodType<R, z.ZodTypeDef, unknown>
) {
  return z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      relayWorkspaceId: z.string().optional(),
      rootPath: z.string().optional(),
      roots: z.array(z.unknown()).optional(),
      channels: z.unknown().optional(),
      channelPeople: z.unknown().optional(),
      integrations: z.array(z.unknown()).optional()
    })
    .passthrough()
    .transform((value, ctx) => {
      const roots = dedupeRoots(
        (value.roots ?? []).flatMap((entry) => {
          const parsed = rootSchema.safeParse(entry)
          return parsed.success ? [parsed.data] : []
        })
      )
      const rootPath = value.rootPath?.trim() || roots[0]?.path || ''
      if (!rootPath || roots.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'project has no usable root' })
        return z.NEVER
      }
      const channels = channelsSchema.parse(value.channels)
      const integrations = (value.integrations ?? []).flatMap((entry) => {
        const parsed = ProjectIntegrationSchema.safeParse(entry)
        return parsed.success ? [parsed.data] : []
      })
      const channelPeople = buildChannelPeople(channelPeopleSchema.parse(value.channelPeople), channels)
      return {
        ...value,
        id: value.id,
        name: value.name,
        relayWorkspaceId: value.relayWorkspaceId?.trim() || value.id,
        rootPath,
        roots,
        channels,
        channelPeople,
        integrations
      }
    })
}

export const StoreDataSchema = <P>(projectSchema: z.ZodType<P, z.ZodTypeDef, unknown>) =>
  z
    .object({
      projects: z.array(z.unknown()).optional(),
      activeProjectId: z.union([z.string(), z.null()]).optional()
    })
    .passthrough()
    .transform((value) => ({
      ...value,
      projects: (value.projects ?? []).flatMap((entry) => {
        const parsed = projectSchema.safeParse(entry)
        return parsed.success ? [parsed.data] : []
      }),
      activeProjectId: typeof value.activeProjectId === 'string' ? value.activeProjectId : null
    }))

export const PeopleListSchema = peopleListSchema
