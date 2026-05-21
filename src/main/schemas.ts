import { z } from 'zod'

/**
 * Schemas for data the main process loads from external sources:
 * - JSON files on disk it wrote itself but that a user may have edited
 * - JSON responses from cloud APIs
 *
 * All schemas accept unknown input and coerce / drop unrecognized fields.
 */

const trimmedString = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1))

const optionalTrimmedString = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined)

/* ----------------------------- Auth ----------------------------- */

export const UserInfoSchema = z
  .object({
    name: optionalTrimmedString,
    email: optionalTrimmedString,
    githubUsername: optionalTrimmedString,
    avatarUrl: optionalTrimmedString,
    cachedAvatarUrl: optionalTrimmedString,
    organizationName: optionalTrimmedString,
    projectName: optionalTrimmedString
  })
  .strip()

export type UserInfo = z.infer<typeof UserInfoSchema>

export const StoredTokensSchema = z
  .object({
    accessToken: trimmedString,
    refreshToken: trimmedString,
    apiUrl: trimmedString,
    expiresAt: z.string().optional(),
    user: UserInfoSchema.optional()
  })
  .strip()

export type StoredTokens = z.infer<typeof StoredTokensSchema>

export const AuthMetaSchema = z
  .object({
    apiUrl: z.string().optional(),
    user: UserInfoSchema.optional()
  })
  .strip()

/* --------------------- Broker connection.json ------------------- */

export const BrokerConnectionFileSchema = z
  .object({
    url: z.string().optional(),
    pid: z.number().int().optional(),
    api_key: z.string().optional()
  })
  .passthrough()
  .transform((value) => ({
    url: value.url?.trim() || undefined,
    pid: value.pid,
    apiKey: value.api_key?.trim() || undefined
  }))

/* ------------------ Generated commit draft JSON ----------------- */

export const GeneratedCommitDraftSchema = z
  .object({
    title: trimmedString,
    body: z.string().optional()
  })
  .passthrough()
  .transform((value) => ({
    title: value.title,
    body: value.body?.trim() || ''
  }))

export type GeneratedCommitDraft = z.infer<typeof GeneratedCommitDraftSchema>

/* --------------------- Avatar cache manifest -------------------- */

export const AvatarCacheEntrySchema = z.object({
  key: z.string(),
  sourceUrl: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  byteLength: z.number().int().nonnegative(),
  updatedAt: z.string()
})

export const AvatarCacheManifestSchema = z.object({
  version: z.literal(1),
  avatars: z.record(AvatarCacheEntrySchema)
})

export type AvatarCacheManifest = z.infer<typeof AvatarCacheManifestSchema>
export type AvatarCacheEntry = z.infer<typeof AvatarCacheEntrySchema>
