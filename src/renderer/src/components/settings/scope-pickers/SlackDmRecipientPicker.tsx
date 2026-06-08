import type React from 'react'
import { GenericScopePicker, metadataText, resourceText, type ScopePickerProps } from './GenericScopePicker'
import { slackDmMountSegment, slackDmUserId } from '../slack-scope'

export function SlackDmRecipientPicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose DM recipients"
      resourceNoun="people"
      baseMountPath="/slack/users"
      scopeKey="dmUsers"
      defaultSelectAll={false}
      getResourceLabel={(resource) => {
        const name = resourceText(resource, 'displayName', 'name', 'title')
        if (!name) return slackDmUserId(resource)
        return name.startsWith('@') ? name : `@${name}`
      }}
      getResourceDescription={(resource) =>
        metadataText(resource, 'realName', 'email', 'workspace', 'team') || slackDmUserId(resource)
      }
      getResourceMountSegment={slackDmMountSegment}
      getResourceScopeId={slackDmUserId}
    />
  )
}
