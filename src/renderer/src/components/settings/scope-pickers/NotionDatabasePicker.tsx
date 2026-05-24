import type React from 'react'
import {
  GenericScopePicker,
  metadataText,
  resourceText,
  type ScopePickerProps
} from './GenericScopePicker'

export function NotionDatabasePicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose databases"
      resourceNoun="databases"
      baseMountPath="/integrations/notion/databases"
      scopeKey="databases"
      getResourceLabel={(resource) =>
        resourceText(resource, 'title', 'displayName', 'name', 'id') || metadataText(resource, 'title')
      }
      getResourceDescription={(resource) => metadataText(resource, 'workspace', 'url') || resourceText(resource, 'path')}
      getResourceMountSegment={(resource) =>
        resourceText(resource, 'title', 'slug', 'name', 'id') || metadataText(resource, 'title')
      }
    />
  )
}
