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

export function SlackChannelPicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose channels"
      resourceNoun="channels"
      baseMountPath="/integrations/slack/channels"
      scopeKey="channels"
      getResourceLabel={(resource) => {
        const name = channelName(resource)
        return name ? `#${name}` : resourceText(resource, 'id')
      }}
      getResourceDescription={(resource) => metadataText(resource, 'workspace', 'team') || resourceText(resource, 'path')}
      getResourceMountSegment={(resource) => channelName(resource) || resourceText(resource, 'id')}
      getResourceScopeId={(resource) => resourceText(resource, 'id', 'slug', 'name')}
    />
  )
}
