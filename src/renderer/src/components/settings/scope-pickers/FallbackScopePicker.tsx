import type React from 'react'
import { GenericScopePicker, type ScopePickerProps } from './GenericScopePicker'

export function FallbackScopePicker(props: ScopePickerProps): React.ReactNode {
  return (
    <GenericScopePicker
      {...props}
      title="Choose resources"
      resourceNoun="resources"
      baseMountPath={`/integrations/${props.provider}`}
      scopeKey="resources"
    />
  )
}
