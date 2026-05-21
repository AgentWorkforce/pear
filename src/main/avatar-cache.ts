import { protocol } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { readFile, rename, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  AvatarCacheManifestSchema,
  type AvatarCacheEntry,
  type AvatarCacheManifest
} from './schemas'

const AVATAR_PROTOCOL = 'pear-avatar'
const AVATAR_HOST = 'avatar'
const CACHE_DIR = join(homedir(), '.agentworkforce', 'pear', 'github_avatars')
const MANIFEST_PATH = join(CACHE_DIR, 'avatars.json')
const MAX_AVATAR_BYTES = 1_500_000
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

type AvatarIdentity = {
  sourceUrl?: string
  githubUsername?: string
  email?: string
  name?: string
}

let protocolRegistered = false

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
}

function loadManifest(): AvatarCacheManifest {
  try {
    const parsed = AvatarCacheManifestSchema.safeParse(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')))
    if (parsed.success) return parsed.data
  } catch {
    // Cache metadata is best-effort; corrupt or missing metadata just starts fresh.
  }
  return { version: 1, avatars: {} }
}

function saveManifest(manifest: AvatarCacheManifest): void {
  ensureCacheDir()
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

function normalizeGithubUsername(value?: string): string {
  return (value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/[^A-Za-z0-9-]/g, '')
    .toLowerCase()
}

function normalizeEmail(value?: string): string {
  return (value || '').trim().toLowerCase()
}

function cacheSeed(identity: AvatarIdentity): string {
  const githubUsername = normalizeGithubUsername(identity.githubUsername)
  if (githubUsername) return `github:${githubUsername}`

  const email = normalizeEmail(identity.email)
  if (email) return `email:${email}`

  const sourceUrl = identity.sourceUrl?.trim()
  if (sourceUrl) return `url:${sourceUrl}`

  return `name:${identity.name?.trim().toLowerCase() || 'unknown'}`
}

function isAvatarCacheKey(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value)
}

function protocolUrlForKey(key: string): string {
  return `${AVATAR_PROTOCOL}://${AVATAR_HOST}/${encodeURIComponent(key)}`
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase()
  if (normalized === 'image/jpeg') return 'jpg'
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/gif') return 'gif'
  if (normalized === 'image/webp') return 'webp'
  if (normalized === 'image/avif') return 'avif'
  return 'img'
}

function cachedEntryUrl(entry: AvatarCacheEntry | undefined): string | undefined {
  if (!entry || !isAvatarCacheKey(entry.key)) return undefined
  if (!existsSync(join(CACHE_DIR, entry.fileName))) return undefined
  return protocolUrlForKey(entry.key)
}

export function avatarCacheKey(identity: AvatarIdentity): string {
  return createHash('sha256').update(cacheSeed(identity)).digest('hex').slice(0, 32)
}

export function cachedAvatarUrl(identity: AvatarIdentity): string | undefined {
  const key = avatarCacheKey(identity)
  const manifest = loadManifest()
  return cachedEntryUrl(manifest.avatars[key])
}

export function isRemoteAvatarUrl(value?: string): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

export async function cacheAvatarFromUrl(sourceUrl: string | undefined, identity: AvatarIdentity): Promise<string | undefined> {
  if (!sourceUrl || !isRemoteAvatarUrl(sourceUrl)) return cachedAvatarUrl(identity)

  const key = avatarCacheKey({ ...identity, sourceUrl })
  const manifest = loadManifest()
  const existing = manifest.avatars[key]
  const existingUrl = cachedEntryUrl(existing)
  if (existingUrl && Date.now() - new Date(existing.updatedAt).getTime() < CACHE_TTL_MS) {
    return existingUrl
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1800)

  try {
    const response = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'pear-avatar-cache' }
    })
    if (!response.ok) return existingUrl

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.toLowerCase().startsWith('image/')) return existingUrl

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return existingUrl

    ensureCacheDir()
    const fileName = `${key}.${extensionForContentType(contentType)}`
    const tempPath = join(CACHE_DIR, `${fileName}.tmp`)
    const filePath = join(CACHE_DIR, fileName)
    await writeFile(tempPath, bytes)
    await rename(tempPath, filePath)

    manifest.avatars[key] = {
      key,
      sourceUrl,
      fileName,
      contentType: contentType.split(';')[0]?.trim() || 'image/*',
      byteLength: bytes.length,
      updatedAt: new Date().toISOString()
    }
    saveManifest(manifest)
    return protocolUrlForKey(key)
  } catch {
    return existingUrl
  } finally {
    clearTimeout(timeout)
  }
}

function cacheFileForProtocolUrl(value: string): { filePath: string; contentType: string } | null {
  try {
    const url = new URL(value)
    if (url.protocol !== `${AVATAR_PROTOCOL}:` || url.hostname !== AVATAR_HOST) return null

    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!isAvatarCacheKey(key)) return null

    const entry = loadManifest().avatars[key]
    if (!entry || !isAvatarCacheKey(entry.key)) return null

    const filePath = join(CACHE_DIR, entry.fileName)
    if (!existsSync(filePath)) return null
    return { filePath, contentType: entry.contentType || 'image/*' }
  } catch {
    return null
  }
}

export function registerAvatarCacheProtocol(): void {
  if (protocolRegistered) return
  protocolRegistered = true

  protocol.handle(AVATAR_PROTOCOL, async (request) => {
    const cachedFile = cacheFileForProtocolUrl(request.url)
    if (!cachedFile) return new Response(null, { status: 404 })

    const bytes = await readFile(cachedFile.filePath)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': cachedFile.contentType,
        'cache-control': 'public, max-age=31536000, immutable'
      }
    })
  })
}
