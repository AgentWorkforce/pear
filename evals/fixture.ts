/**
 * Creates a fresh temp directory with a fake .integrations/ mount structure.
 *
 * Discovery schemas are copied from evals/fixtures/discovery/ so eval agents
 * see consistent, realistic schemas without depending on a live mount.
 * Provider dirs (slack/channels/..., linear/issues/) are empty and writable.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

import { snapshotMount, newMountFiles } from '@agent-relay/evals/scoring/mount'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLED_DISCOVERY = join(__dirname, 'fixtures', 'discovery')

// Stable fake IDs used across all scenarios
export const EVAL_CHANNEL_ID = 'C12345EVAL'
export const EVAL_CHANNEL_SLUG = 'general'
export const EVAL_CHANNEL_DIR = `${EVAL_CHANNEL_ID}__${EVAL_CHANNEL_SLUG}`
export const EVAL_USER_ID = 'U67890EVAL'
export const EVAL_ISSUE_ID = 'ARC-123EVL'

/**
 * Create a fresh temp directory with the fake mount.
 * Returns the absolute path to the temp dir.
 */
export function createFixture({ claudeMd }: { claudeMd?: string | null } = {}): string {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'pear-eval-'))

  // Copy bundled discovery schemas
  const discoveryDest = join(tmpDir, '.integrations', 'discovery')
  mkdirSync(discoveryDest, { recursive: true })
  if (existsSync(BUNDLED_DISCOVERY)) {
    cpSync(BUNDLED_DISCOVERY, discoveryDest, { recursive: true })
  }

  // Writable provider dirs — empty, agent creates files here
  mkdirSync(join(tmpDir, '.integrations', 'slack', 'channels', EVAL_CHANNEL_DIR, 'messages'), { recursive: true })
  mkdirSync(join(tmpDir, '.integrations', 'slack', 'users', EVAL_USER_ID, 'messages'), { recursive: true })
  mkdirSync(join(tmpDir, '.integrations', 'linear', 'issues'), { recursive: true })
  // Pre-create the comment subpath so s05 has a valid target dir
  mkdirSync(join(tmpDir, '.integrations', 'linear', 'issues', EVAL_ISSUE_ID, 'comments'), { recursive: true })

  if (claudeMd) {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), claudeMd)
  }

  return tmpDir
}

// Re-export for convenience so callers don't need to import from two places
export { snapshotMount, newMountFiles }
