#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = dirname(__dirname)
const outputPath = join(repoRoot, 'src/main/integrations.catalog.ts')
const adaptersPackagesPath = join(repoRoot, '../relayfile-adapters/packages')
const isDryRun = process.argv.includes('--dry-run')
const isCheck = process.argv.includes('--check')

const SKIPPED_PACKAGES = new Set(['core', 'webhook-server', 'github-compat', 'linear-compat'])

const REQUIRED_PROVIDERS = [
  'github',
  'gitlab',
  'linear',
  'slack',
  'notion',
  'jira',
  'confluence',
  'gmail',
  'google-calendar',
  'google-drive',
  'dropbox',
  's3',
  'gcs',
  'stripe',
  'salesforce',
  'hubspot',
]

const ACTIVE_PROVIDER_CATALOG_IDS = [
  'github',
  'gitlab',
  'slack',
  'notion',
  'linear',
  'jira',
  'confluence',
  'gmail',
  'google-calendar',
]

const PROVIDER_META = {
  github: {
    displayName: 'GitHub',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/github/repos'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  linear: {
    displayName: 'Linear',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/linear/teams'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  slack: {
    displayName: 'Slack',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/slack/channels', '/integrations/slack/dms'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  notion: {
    displayName: 'Notion',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/notion/databases', '/integrations/notion/pages'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  jira: {
    displayName: 'Jira',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/jira/projects'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  confluence: {
    displayName: 'Confluence',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/confluence/spaces'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  'google-drive': {
    displayName: 'Google Drive',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/google-drive/files'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  dropbox: {
    displayName: 'Dropbox',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/dropbox/files'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  s3: {
    displayName: 'Amazon S3',
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/s3/buckets'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  gcs: {
    displayName: 'Google Cloud Storage',
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/gcs/buckets'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  stripe: {
    displayName: 'Stripe',
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/stripe'],
    capabilities: { webhook: true, poll: true, writeback: false },
  },
  salesforce: {
    displayName: 'Salesforce',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/salesforce/objects'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  hubspot: {
    displayName: 'HubSpot',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/hubspot'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  asana: {
    displayName: 'Asana',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/asana/projects'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  airtable: {
    displayName: 'Airtable',
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/airtable/bases'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  'azure-blob': {
    displayName: 'Azure Blob Storage',
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/azure-blob/containers'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  box: {
    displayName: 'Box',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/box/files'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  calendly: {
    displayName: 'Calendly',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/calendly/events'],
    capabilities: { webhook: true, poll: true, writeback: false },
  },
  clickup: {
    displayName: 'ClickUp',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/clickup/spaces'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  gitlab: {
    displayName: 'GitLab',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/gitlab/projects'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  gmail: {
    displayName: 'Gmail',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/gmail/threads'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  'google-calendar': {
    displayName: 'Google Calendar',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/google-calendar/calendars'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  intercom: {
    displayName: 'Intercom',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/intercom/conversations'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  mailgun: {
    displayName: 'Mailgun',
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/mailgun'],
    capabilities: { webhook: true, poll: true, writeback: false },
  },
  mixpanel: {
    displayName: 'Mixpanel',
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/mixpanel/projects'],
    capabilities: { webhook: false, poll: true, writeback: false },
  },
  onedrive: {
    displayName: 'OneDrive',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/onedrive/files'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  pipedrive: {
    displayName: 'Pipedrive',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/pipedrive/deals'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  postgres: {
    displayName: 'PostgreSQL',
    authMethod: 'token',
    defaultMountPaths: ['/integrations/postgres/databases'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  redis: {
    displayName: 'Redis',
    authMethod: 'token',
    defaultMountPaths: ['/integrations/redis'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  segment: {
    displayName: 'Segment',
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/segment/sources'],
    capabilities: { webhook: true, poll: true, writeback: false },
  },
  sendgrid: {
    displayName: 'SendGrid',
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/sendgrid'],
    capabilities: { webhook: true, poll: true, writeback: false },
  },
  sharepoint: {
    displayName: 'SharePoint',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/sharepoint/sites'],
    capabilities: { webhook: false, poll: true, writeback: true },
  },
  shopify: {
    displayName: 'Shopify',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/shopify'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  teams: {
    displayName: 'Microsoft Teams',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/teams/channels'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
  x: {
    displayName: 'X (Twitter)',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/x/timeline'],
    capabilities: { webhook: false, poll: true, writeback: false },
  },
  zendesk: {
    displayName: 'Zendesk',
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/zendesk/tickets'],
    capabilities: { webhook: true, poll: true, writeback: true },
  },
}

// Nango hosts a logo SVG per provider template at a predictable CDN path
// (e.g. https://app.nango.dev/images/template-logos/github.svg). Pear's provider
// ids match the Nango template slug for the vast majority of integrations; the
// map below overrides the few where they differ. Providers without a Nango logo
// (storage/db backends like s3, gcs, postgres) still get a URL — the renderer
// falls back to a generic icon when the image 404s.
const NANGO_LOGO_BASE = 'https://app.nango.dev/images/template-logos'

// Keep provider slug overrides aligned with toRelayfileProvider in
// src/main/integrations.ts: differing Nango slugs need entries here for icons
// and there for connect-session bodies.
const NANGO_LOGO_SLUG = {
  gmail: 'google-mail',
  teams: 'microsoft-teams',
  x: 'twitter',
}

function nangoLogoUrl(provider) {
  const slug = NANGO_LOGO_SLUG[provider] ?? provider
  return `${NANGO_LOGO_BASE}/${slug}.svg`
}

function titleCaseSlug(slug) {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function genericMeta(provider) {
  const displayName = titleCaseSlug(provider)
  return {
    displayName,
    authMethod: 'oauth',
    defaultMountPaths: [`/integrations/${provider}`],
    capabilities: { webhook: true, poll: true, writeback: true },
    description: `Auto-generated entry for ${provider}; review and edit metadata.`,
  }
}

function getProviderMeta(provider) {
  return PROVIDER_META[provider] ?? genericMeta(provider)
}

function readAdapterPackages(packagesPath) {
  if (!existsSync(packagesPath)) {
    console.error(`[warn] adapter packages directory not found: ${packagesPath}`)
    return []
  }

  return readdirSync(packagesPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((provider) => !SKIPPED_PACKAGES.has(provider))
    .sort()
    .flatMap((provider) => {
      const packageJsonPath = join(packagesPath, provider, 'package.json')
      if (!existsSync(packageJsonPath)) {
        return []
      }

      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
        return [
          {
            provider,
            version: typeof packageJson.version === 'string' ? packageJson.version : undefined,
            description:
              typeof packageJson.description === 'string' ? packageJson.description : undefined,
          },
        ]
      } catch (error) {
        console.error(`[warn] unable to read ${packageJsonPath}: ${error.message}`)
        return []
      }
    })
}

function buildCatalog(packageAdapters) {
  const adaptersByProvider = new Map()

  for (const adapterPackage of packageAdapters) {
    adaptersByProvider.set(adapterPackage.provider, adapterPackage)
  }

  for (const provider of REQUIRED_PROVIDERS) {
    if (!adaptersByProvider.has(provider)) {
      adaptersByProvider.set(provider, { provider })
    }
  }

  return Array.from(adaptersByProvider.values())
    .map(({ provider, version, description }) => {
      const meta = getProviderMeta(provider)
      return {
        provider,
        displayName: meta.displayName,
        iconUrl: nangoLogoUrl(provider),
        version: version ?? '1.0.0',
        capabilities: meta.capabilities,
        authMethod: meta.authMethod,
        defaultMountPaths: meta.defaultMountPaths,
        description: description ?? meta.description ?? `Relayfile adapter for ${meta.displayName}.`,
      }
    })
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

function quoteString(value) {
  return `'${value.replace(/[\\'\r\n\t]|[^\x20-\x7e]/gu, (character) => {
    switch (character) {
      case '\\':
        return '\\\\'
      case "'":
        return "\\'"
      case '\r':
        return '\\r'
      case '\n':
        return '\\n'
      case '\t':
        return '\\t'
      default:
        return `\\u{${character.codePointAt(0).toString(16)}}`
    }
  })}'`
}

function renderStringArray(values) {
  return `[${values.map((value) => quoteString(value)).join(', ')}]`
}

function renderAdapter(adapter, isLast) {
  const comma = isLast ? '' : ','
  return [
    '  {',
    `    provider: ${quoteString(adapter.provider)},`,
    `    displayName: ${quoteString(adapter.displayName)},`,
    `    iconUrl: ${quoteString(adapter.iconUrl)},`,
    `    version: ${quoteString(adapter.version)},`,
    `    capabilities: { webhook: ${adapter.capabilities.webhook}, poll: ${adapter.capabilities.poll}, writeback: ${adapter.capabilities.writeback} },`,
    `    authMethod: ${quoteString(adapter.authMethod)},`,
    `    defaultMountPaths: ${renderStringArray(adapter.defaultMountPaths)},`,
    `    description: ${quoteString(adapter.description)}`,
    `  }${comma}`,
  ].join('\n')
}

function renderCatalog(catalog) {
  return `${[
    '// THIS FILE IS AUTO-GENERATED - do not edit by hand.',
    '// Run `node scripts/build-integrations-catalog.mjs` to regenerate.',
    "import type { IntegrationAdapter } from './integrations.types'",
    '',
    'export const INTEGRATIONS_CATALOG: IntegrationAdapter[] = [',
    catalog.map((adapter, index) => renderAdapter(adapter, index === catalog.length - 1)).join('\n'),
    ']',
    '',
  ].join('\n')}`
}

function assertActiveProvidersPresent(catalog) {
  const catalogProviders = new Set(catalog.map((adapter) => adapter.provider))
  const missingProviders = ACTIVE_PROVIDER_CATALOG_IDS.filter((provider) => !catalogProviders.has(provider))

  if (missingProviders.length > 0) {
    console.error(
      `[error] generated integrations catalog is missing active providers: ${missingProviders.join(', ')}`
    )
    process.exit(1)
  }
}

function writeCatalog(filePath, source) {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  writeFileSync(temporaryPath, source, 'utf8')
  renameSync(temporaryPath, filePath)
}

const catalog = buildCatalog(readAdapterPackages(adaptersPackagesPath))
assertActiveProvidersPresent(catalog)
const source = renderCatalog(catalog)
const outputLabel = relative(repoRoot, outputPath)

if (isCheck) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
  if (current !== source) {
    console.error(`${outputLabel} is out of date. Run node scripts/build-integrations-catalog.mjs`)
    process.exitCode = 1
  } else {
    console.log(`${outputLabel} is up to date with ${catalog.length} adapters`)
  }
} else if (isDryRun) {
  console.log(`would write ${catalog.length} adapters to ${outputLabel}`)
} else {
  writeCatalog(outputPath, source)
  console.log(`wrote ${catalog.length} adapters to ${outputLabel}`)
}
