import type React from 'react'
import { useState } from 'react'
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react'

interface MessageEdgeData {
  count: number
  lastBody: string
  lastTimestamp?: number
  [key: string]: unknown
}

export function MessageEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data
}: EdgeProps): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  const { count, lastBody, lastTimestamp } = (data || { count: 0, lastBody: '' }) as MessageEdgeData

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: 'var(--pear-accent-dim)', strokeWidth: 1.8 }}
      />
      {lastTimestamp && (
        <circle
          key={`${id}:${lastTimestamp}:${count}`}
          r={4}
          fill="var(--pear-accent-bright)"
          opacity={0.95}
          pointerEvents="none"
        >
          <animateMotion dur="900ms" repeatCount="1" path={edgePath} />
          <animate attributeName="opacity" values="0;1;1;0" dur="900ms" repeatCount="1" />
          <animate attributeName="r" values="3;5;4;2" dur="900ms" repeatCount="1" />
        </circle>
      )}
      {/* Invisible wider path for hover */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {/* Badge */}
      <g transform={`translate(${labelX}, ${labelY})`}>
        <circle r={10} fill="var(--pear-bg-overlay)" stroke="var(--pear-text-faint)" strokeWidth={1} />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--pear-text)"
          fontSize={10}
          fontWeight="bold"
        >
          {count}
        </text>
      </g>
      {/* Tooltip */}
      {hovered && lastBody && (
        <foreignObject x={labelX + 15} y={labelY - 20} width={200} height={60}>
          <div className="rounded border border-[var(--pear-bg-overlay)] bg-[var(--pear-bg-surface)] px-2 py-1 text-xs text-[var(--pear-text)] shadow-lg">
            {lastBody.length > 100 ? lastBody.slice(0, 100) + '...' : lastBody}
          </div>
        </foreignObject>
      )}
    </>
  )
}
