import type React from 'react'
import {
  GenericScopePicker,
  metadataText,
  resourceText,
  type ScopePickerProps
} from './GenericScopePicker'

function channelName(resource: Parameters<typeof resourceText>[0]): string {
  return resourceText(resource, 'displayName', 'name', 'slug', 'id').replace(/^#/, '')
}

function slackPathSlug(value: string): string {
  return value
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function channelMountSegment(resource: Parameters<typeof resourceText>[0]): string {
  const id = resourceText(resource, 'id')
  const slug = slackPathSlug(channelName(resource))
  if (!id) return slug
  return slug ? `${id}__${slug}` : id
}

export function SlackChannelPicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose channels"
      resourceNoun="channels"
      baseMountPath="/slack/channels"
      scopeKey="channels"
      getResourceLabel={(resource) => {
        const name = channelName(resource)
        return name ? `#${name}` : resourceText(resource, 'id')
      }}
      getResourceDescription={(resource) => metadataText(resource, 'workspace', 'team') || resourceText(resource, 'path')}
      getResourceMountSegment={channelMountSegment}
      getResourceScopeId={(resource) => resourceText(resource, 'id', 'slug', 'name')}
    />
  )
}
