import type React from 'react'
import {
  GenericScopePicker,
  metadataText,
  resourceText,
  type ScopePickerProps
} from './GenericScopePicker'

export function LinearAssigneePicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose assignees"
      resourceNoun="assignees"
      baseMountPath="/linear/issues"
      scopeKey="assignees"
      defaultSelectAll={false}
      getResourceLabel={(resource) =>
        resourceText(resource, 'displayName', 'name', 'title', 'key', 'id')
      }
      getResourceDescription={(resource) => metadataText(resource, 'hint', 'email') || resourceText(resource, 'path')}
      getResourceMountSegment={() => ''}
      getResourceScopeId={(resource) => resourceText(resource, 'id', 'slug', 'key', 'name')}
    />
  )
}
