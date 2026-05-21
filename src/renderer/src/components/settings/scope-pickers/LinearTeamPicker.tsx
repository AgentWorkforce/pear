import type React from 'react'
import {
  GenericScopePicker,
  metadataText,
  resourceText,
  type ScopePickerProps
} from './GenericScopePicker'

export function LinearTeamPicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose teams"
      resourceNoun="teams"
      baseMountPath="/integrations/linear/teams"
      scopeKey="teams"
      getResourceLabel={(resource) =>
        resourceText(resource, 'displayName', 'name', 'key', 'id') || metadataText(resource, 'key')
      }
      getResourceDescription={(resource) => metadataText(resource, 'key', 'workspace') || resourceText(resource, 'path')}
      getResourceMountSegment={(resource) =>
        metadataText(resource, 'key') || resourceText(resource, 'key', 'slug', 'name', 'id')
      }
    />
  )
}
