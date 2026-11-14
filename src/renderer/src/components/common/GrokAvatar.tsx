import type React from 'react'

/**
 * Grok Bot's animated idle avatar, played like Relay Desktop's
 * `AvatarFramesView`: each atlas holds 32 monochrome frames (8 columns by
 * 4 rows of 64px cells, 48px of artwork inset 8px), shown at 8 fps and
 * tinted with the current text color through a mask.
 */
export const GROK_AVATAR_SHAPES = [
  'blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem',
  'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle',
  'clover', 'flower', 'heart', 'house', 'star'
] as const

export type GrokAvatarShape = (typeof GROK_AVATAR_SHAPES)[number]

/** Grok Bot's own shape is not published to Relaycast, so each agent keeps a stable one by name. */
export function grokAvatarShape(seed: string): GrokAvatarShape {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return GROK_AVATAR_SHAPES[hash % GROK_AVATAR_SHAPES.length]
}

function atlasUrl(shape: GrokAvatarShape): string {
  return new URL(`../../assets/grok-avatar/grok-avatar-${shape}.png`, import.meta.url).href
}

export function GrokAvatar({
  seed,
  size,
  className
}: {
  seed: string
  /** Rendered artwork size in px; the atlas cell scales to fit it. */
  size: number
  className?: string
}): React.ReactNode {
  const shape = grokAvatarShape(seed)
  const scale = size / 48
  const url = atlasUrl(shape)
  return (
    <span
      className={`relative block shrink-0 overflow-hidden ${className ?? ''}`}
      style={{ width: size, height: size }}
      data-grok-shape={shape}
      aria-hidden="true"
    >
      <span
        className="grok-avatar-rows absolute block"
        style={{ left: -8 * scale, top: -8 * scale, '--grok-cell': `${64 * scale}px` } as React.CSSProperties}
      >
        <span
          className="grok-avatar-frames block bg-current"
          style={{
            width: 512 * scale,
            height: 256 * scale,
            maskImage: `url(${url})`,
            maskSize: '100% 100%',
            maskRepeat: 'no-repeat',
            WebkitMaskImage: `url(${url})`,
            WebkitMaskSize: '100% 100%',
            WebkitMaskRepeat: 'no-repeat'
          }}
        />
      </span>
    </span>
  )
}
