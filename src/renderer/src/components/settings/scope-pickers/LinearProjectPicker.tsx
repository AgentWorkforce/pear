import type React from 'react'
import {
  GenericScopePicker,
  metadataText,
  resourceText,
  type ScopePickerProps
} from './GenericScopePicker'

export function LinearProjectPicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose projects"
      resourceNoun="projects"
      baseMountPath="/linear/issues"
      scopeKey="projects"
      defaultSelectAll={false}
      getResourceLabel={(resource) =>
        resourceText(resource, 'displayName', 'name', 'title', 'key', 'id')
      }
      getResourceDescription={(resource) => metadataText(resource, 'hint', 'state') || resourceText(resource, 'path')}
      getResourceMountSegment={() => ''}
      getResourceScopeId={(resource) => resourceText(resource, 'id', 'slug', 'key', 'name')}
    />
  )
}
