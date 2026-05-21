import type React from 'react'
import {
  GenericScopePicker,
  metadataText,
  resourceText,
  type ScopePickerProps
} from './GenericScopePicker'

export function GitHubRepoPicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose repositories"
      resourceNoun="repositories"
      baseMountPath="/integrations/github/repos"
      scopeKey="repositories"
      getResourceLabel={(resource) =>
        metadataText(resource, 'full_name', 'fullName') || resourceText(resource, 'displayName', 'name', 'path', 'id')
      }
      getResourceDescription={(resource) => metadataText(resource, 'owner') || resourceText(resource, 'path', 'type')}
      getResourceMountSegment={(resource) =>
        metadataText(resource, 'full_name', 'fullName') || resourceText(resource, 'path', 'slug', 'name', 'id')
      }
    />
  )
}
