import type React from 'react'
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react'

export function HierarchyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition
}: EdgeProps): React.ReactNode {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 18
  })

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: 'var(--pear-border)',
        strokeWidth: 1.25,
        strokeDasharray: '5 5'
      }}
    />
  )
}
