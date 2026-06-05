// THIS FILE IS AUTO-GENERATED - do not edit by hand.
// Run `node scripts/build-integrations-catalog.mjs` to regenerate.
import type { IntegrationAdapter } from './integrations.types'

export const INTEGRATIONS_CATALOG: IntegrationAdapter[] = [
  {
    provider: 'airtable',
    displayName: 'Airtable',
    iconUrl: 'https://app.nango.dev/images/template-logos/airtable.svg',
    version: '0.2.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/airtable/bases'],
    description: 'Airtable adapter package for Relayfile'
  },
  {
    provider: 'asana',
    displayName: 'Asana',
    iconUrl: 'https://app.nango.dev/images/template-logos/asana.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/asana/projects'],
    description: 'Asana adapter package for Relayfile'
  },
  {
    provider: 'azure-blob',
    displayName: 'Azure Blob Storage',
    iconUrl: 'https://app.nango.dev/images/template-logos/azure-blob.svg',
    version: '0.1.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/azure-blob/containers'],
    description: 'Azure Blob Storage storage bridge adapter for Relayfile'
  },
  {
    provider: 'box',
    displayName: 'Box',
    iconUrl: 'https://app.nango.dev/images/template-logos/box.svg',
    version: '0.1.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/box/files'],
    description: 'Box storage bridge adapter for Relayfile'
  },
  {
    provider: 'calendly',
    displayName: 'Calendly',
    iconUrl: 'https://app.nango.dev/images/template-logos/calendly.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: false },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/calendly/events'],
    description: 'Calendly adapter bootstrap package for Relayfile'
  },
  {
    provider: 'clickup',
    displayName: 'ClickUp',
    iconUrl: 'https://app.nango.dev/images/template-logos/clickup.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/clickup/spaces'],
    description: 'ClickUp adapter package for Relayfile'
  },
  {
    provider: 'confluence',
    displayName: 'Confluence',
    iconUrl: 'https://app.nango.dev/images/template-logos/confluence.svg',
    version: '0.1.11',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/confluence/spaces'],
    description: 'Confluence adapter package for Relayfile'
  },
  {
    provider: 'dropbox',
    displayName: 'Dropbox',
    iconUrl: 'https://app.nango.dev/images/template-logos/dropbox.svg',
    version: '0.1.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/dropbox/files'],
    description: 'Dropbox storage bridge adapter for Relayfile'
  },
  {
    provider: 'gcs',
    displayName: 'Google Cloud Storage',
    iconUrl: 'https://app.nango.dev/images/template-logos/gcs.svg',
    version: '0.1.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/gcs/buckets'],
    description: 'Google Cloud Storage storage bridge adapter for Relayfile'
  },
  {
    provider: 'github',
    displayName: 'GitHub',
    iconUrl: 'https://app.nango.dev/images/template-logos/github.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/github/repos'],
    description: 'GitHub adapter scaffold for Relayfile'
  },
  {
    provider: 'gitlab',
    displayName: 'GitLab',
    iconUrl: 'https://app.nango.dev/images/template-logos/gitlab.svg',
    version: '0.2.10',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/gitlab/projects'],
    description: 'GitLab adapter for relayfile \u{2014} maps GitLab merge requests, issues, pipelines, jobs, commits, and webhooks to relayfile VFS paths'
  },
  {
    provider: 'gmail',
    displayName: 'Gmail',
    iconUrl: 'https://app.nango.dev/images/template-logos/google-mail.svg',
    version: '0.1.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/gmail/threads'],
    description: 'Gmail storage bridge adapter for Relayfile'
  },
  {
    provider: 'google-calendar',
    displayName: 'Google Calendar',
    iconUrl: 'https://app.nango.dev/images/template-logos/google-calendar.svg',
    version: '0.1.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/google-calendar/calendars'],
    description: 'Google Calendar adapter for relayfile'
  },
  {
    provider: 'google-drive',
    displayName: 'Google Drive',
    iconUrl: 'https://app.nango.dev/images/template-logos/google-drive.svg',
    version: '0.1.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/google-drive/files'],
    description: 'Google Drive storage bridge adapter for Relayfile'
  },
  {
    provider: 'hubspot',
    displayName: 'HubSpot',
    iconUrl: 'https://app.nango.dev/images/template-logos/hubspot.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/hubspot'],
    description: 'HubSpot adapter package for Relayfile'
  },
  {
    provider: 'intercom',
    displayName: 'Intercom',
    iconUrl: 'https://app.nango.dev/images/template-logos/intercom.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/intercom/conversations'],
    description: 'Intercom adapter bootstrap package for Relayfile'
  },
  {
    provider: 'jira',
    displayName: 'Jira',
    iconUrl: 'https://app.nango.dev/images/template-logos/jira.svg',
    version: '0.2.12',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/jira/projects'],
    description: 'Jira adapter package for Relayfile'
  },
  {
    provider: 'linear',
    displayName: 'Linear',
    iconUrl: 'https://app.nango.dev/images/template-logos/linear.svg',
    version: '0.2.10',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/linear/teams'],
    description: 'Linear adapter bootstrap package for Relayfile'
  },
  {
    provider: 'mailgun',
    displayName: 'Mailgun',
    iconUrl: 'https://app.nango.dev/images/template-logos/mailgun.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: false },
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/mailgun'],
    description: 'Mailgun adapter package for Relayfile'
  },
  {
    provider: 'mixpanel',
    displayName: 'Mixpanel',
    iconUrl: 'https://app.nango.dev/images/template-logos/mixpanel.svg',
    version: '0.2.9',
    capabilities: { webhook: false, poll: true, writeback: false },
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/mixpanel/projects'],
    description: 'Mixpanel adapter bootstrap package for Relayfile'
  },
  {
    provider: 'notion',
    displayName: 'Notion',
    iconUrl: 'https://app.nango.dev/images/template-logos/notion.svg',
    version: '0.2.12',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/notion/databases', '/integrations/notion/pages'],
    description: 'Notion adapter for relayfile \u{2014} maps Notion databases, pages, blocks, and comments to relayfile VFS paths'
  },
  {
    provider: 'onedrive',
    displayName: 'OneDrive',
    iconUrl: 'https://app.nango.dev/images/template-logos/onedrive.svg',
    version: '0.1.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/onedrive/files'],
    description: 'OneDrive storage bridge adapter for Relayfile'
  },
  {
    provider: 'pipedrive',
    displayName: 'Pipedrive',
    iconUrl: 'https://app.nango.dev/images/template-logos/pipedrive.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/pipedrive/deals'],
    description: 'Pipedrive adapter package for Relayfile'
  },
  {
    provider: 'postgres',
    displayName: 'PostgreSQL',
    iconUrl: 'https://app.nango.dev/images/template-logos/postgres.svg',
    version: '0.1.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'token',
    defaultMountPaths: ['/integrations/postgres/databases'],
    description: 'Postgres storage bridge adapter for Relayfile'
  },
  {
    provider: 'redis',
    displayName: 'Redis',
    iconUrl: 'https://app.nango.dev/images/template-logos/redis.svg',
    version: '0.1.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'token',
    defaultMountPaths: ['/integrations/redis'],
    description: 'Redis storage bridge adapter for Relayfile'
  },
  {
    provider: 's3',
    displayName: 'Amazon S3',
    iconUrl: 'https://app.nango.dev/images/template-logos/s3.svg',
    version: '0.1.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/s3/buckets'],
    description: 'Amazon S3 storage bridge adapter for Relayfile'
  },
  {
    provider: 'salesforce',
    displayName: 'Salesforce',
    iconUrl: 'https://app.nango.dev/images/template-logos/salesforce.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/salesforce/objects'],
    description: 'Salesforce adapter package for Relayfile'
  },
  {
    provider: 'segment',
    displayName: 'Segment',
    iconUrl: 'https://app.nango.dev/images/template-logos/segment.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: false },
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/segment/sources'],
    description: 'Segment adapter package for Relayfile'
  },
  {
    provider: 'sendgrid',
    displayName: 'SendGrid',
    iconUrl: 'https://app.nango.dev/images/template-logos/sendgrid.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: false },
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/sendgrid'],
    description: 'SendGrid adapter package for Relayfile'
  },
  {
    provider: 'sharepoint',
    displayName: 'SharePoint',
    iconUrl: 'https://app.nango.dev/images/template-logos/sharepoint.svg',
    version: '0.1.9',
    capabilities: { webhook: false, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/sharepoint/sites'],
    description: 'SharePoint storage bridge adapter for Relayfile'
  },
  {
    provider: 'shopify',
    displayName: 'Shopify',
    iconUrl: 'https://app.nango.dev/images/template-logos/shopify.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/shopify'],
    description: 'Shopify adapter package for Relayfile'
  },
  {
    provider: 'slack',
    displayName: 'Slack',
    iconUrl: 'https://app.nango.dev/images/template-logos/slack.svg',
    version: '0.2.12',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/slack/channels'],
    description: 'Slack adapter scaffolding for Relayfile'
  },
  {
    provider: 'stripe',
    displayName: 'Stripe',
    iconUrl: 'https://app.nango.dev/images/template-logos/stripe.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: false },
    authMethod: 'apikey',
    defaultMountPaths: ['/integrations/stripe'],
    description: 'Stripe adapter package for Relayfile'
  },
  {
    provider: 'teams',
    displayName: 'Microsoft Teams',
    iconUrl: 'https://app.nango.dev/images/template-logos/microsoft-teams.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/teams/channels'],
    description: 'Microsoft Teams adapter for relayfile \u{2014} maps Teams channels, messages, and change notifications to relayfile VFS paths'
  },
  {
    provider: 'x',
    displayName: 'X (Twitter)',
    iconUrl: 'https://app.nango.dev/images/template-logos/twitter.svg',
    version: '0.1.0',
    capabilities: { webhook: false, poll: true, writeback: false },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/x/timeline'],
    description: 'X social search adapter package for Relayfile'
  },
  {
    provider: 'zendesk',
    displayName: 'Zendesk',
    iconUrl: 'https://app.nango.dev/images/template-logos/zendesk.svg',
    version: '0.2.9',
    capabilities: { webhook: true, poll: true, writeback: true },
    authMethod: 'oauth',
    defaultMountPaths: ['/integrations/zendesk/tickets'],
    description: 'Zendesk adapter package for Relayfile'
  }
]
