// Wait for the given font family to load before xterm measures the cell box.
//
// xterm computes cell width/height from a measured glyph. If we open the
// terminal before JetBrains Mono (or whatever custom face) has actually
// loaded, xterm measures the fallback (system monospace) and rows/cols are
// off by ~10–20%, producing "smeared" text that only resolves on the next
// resize. `document.fonts.load(...)` returns a promise that resolves once
// the requested face is ready; we race it against a timeout so we never
// block terminal init on a font that fails to load.

export async function awaitFontSettle(
  fontFamily: string,
  timeoutMs = 1500
): Promise<void> {
  const fonts = (typeof document !== 'undefined' ? document.fonts : undefined) as
    | FontFaceSet
    | undefined
  if (!fonts || typeof fonts.load !== 'function') return

  // `document.fonts.load` expects a CSS shorthand; the size doesn't matter
  // for our purposes since we just want the face installed.
  const familyToken = primaryFamily(fontFamily)
  const spec = `13px ${familyToken}`

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })

  try {
    await Promise.race([
      fonts.load(spec).then(() => undefined).catch(() => undefined),
      timeout
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// `fontFamily` may be a CSS list like "'JetBrains Mono', 'Fira Code', Menlo".
// `document.fonts.load` accepts a list, but quoting/escaping has historically
// been finicky across engines. Take the first family token (preserving
// existing quotes if present) to keep the load request unambiguous.
function primaryFamily(fontFamily: string): string {
  const first = fontFamily.split(',')[0]?.trim()
  if (!first) return fontFamily
  return first
}
