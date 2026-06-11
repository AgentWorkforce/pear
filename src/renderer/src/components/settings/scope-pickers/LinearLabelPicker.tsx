import type React from 'react'
import {
  GenericScopePicker,
  metadataText,
  resourceText,
  type ScopePickerProps
} from './GenericScopePicker'

export function LinearLabelPicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose labels"
      resourceNoun="labels"
      baseMountPath="/linear/issues"
      scopeKey="labels"
      defaultSelectAll={false}
      getResourceLabel={(resource) =>
        resourceText(resource, 'displayName', 'name', 'title', 'key', 'id')
      }
      getResourceDescription={(resource) => metadataText(resource, 'hint', 'color') || resourceText(resource, 'path')}
      getResourceMountSegment={() => ''}
      getResourceScopeId={(resource) => resourceText(resource, 'id', 'slug', 'key', 'name')}
    />
  )
}
