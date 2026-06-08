---
name: lifecycle-decoupling
description: Use when terminal duplicate-text-on-tab-switch or mount/dispose races appear — the module-level runtime registry plus token-based mount ownership pattern that decouples xterm/WebGL/PTY from the React component lifecycle.
---

# react-lifecycle-decoupling-and-token-ownership

The architecture pattern that takes "duplicate text on tab switch" off the table as an entire bug class. xterm + WebGL + PTY subscription must NOT be torn down and rebuilt on React component lifecycle changes.

## The bad shape (what NOT to do)

```tsx
function TerminalView({ agentName }: { agentName: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    const term = new Terminal()
    term.loadAddon(new WebglAddon())
    term.open(containerRef.current!)
    
    const unsub = subscribePtyBuffer(agentName, (chunks) => {
      chunks.forEach(c => term.write(c))
    })
    
    return () => {
      unsub()
      term.dispose()
    }
  }, [agentName])
  
  return <div ref={containerRef} />
}
```

What goes wrong:

- Every tab switch triggers unmount → cleanup → mount of a new instance.
- The new instance calls `attachTerminal` → broker returns snapshot.
- Snapshot is written; subscriber catches up against the buffer.
- Between snapshot capture and subscriber attach, new chunks landed. They get replayed on top of the snapshot → **duplicate text**.
- WebGL canvas is created + destroyed each cycle → GPU resource churn.
- Predictive echo state lost → predictions don't reconcile.

## The right shape

A module-level runtime registry keyed by agent. React mounts and detaches DOM hosts; the runtime itself survives across React lifecycle changes. Disposal happens only when the agent is fully released.

```ts
// terminal-runtime-registry.ts

interface TerminalRuntime {
  readonly key: string
  readonly term: Terminal
  readonly host: HTMLDivElement
  mount(container: HTMLElement): symbol     // returns token
  detach(token: symbol): void               // takes token, stale = no-op
  dispose(): void                            // only on agent release
  isMounted(): boolean
  setOnData(handler: ((data: string) => void) | null): void
  clearOnDataIf(handler: (data: string) => void): void  // identity-checked
  refreshOnShow(): void                      // for display: none return
  fitAndSync(): { rows: number; cols: number } | null
  setInputSrttGetter(fn: () => number | null): void
}

const runtimes = new Map<string, TerminalRuntime>()

export function acquireTerminalRuntime(opts: {...}): TerminalRuntime {
  const key = getAgentKey(opts.projectId, opts.agentName)
  const existing = runtimes.get(key)
  if (existing) {
    existing.setTheme(opts.theme)
    existing.setTerminalMode(opts.terminalMode)
    return existing  // SAME instance
  }
  const runtime = createRuntime(key, opts)
  runtimes.set(key, runtime)
  return runtime
}

export function disposeTerminalRuntime(key: string): void {
  const runtime = runtimes.get(key)
  if (!runtime) return
  runtimes.delete(key)
  runtime.dispose()
}
```

The React side becomes a thin shim:

```tsx
function TerminalView({ agentName }: { agentName: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    const runtime = acquireTerminalRuntime({ agentName, ... })
    const token = runtime.mount(containerRef.current!)
    
    return () => {
      runtime.detach(token)  // host parks; runtime stays alive
    }
  }, [agentName])
  
  return <div ref={containerRef} className="h-full w-full" />
}
```

Tab switch → unmount → `detach()` → host moves to parked container (`document.body` invisible div). Tab switch back → new effect → mount → reparent host into new container. xterm + WebGL + buffer subscription all survive. No re-attach. No snapshot replay. **The bug class is gone.**

## Token-based mount ownership

Required because of React's cross-tree commit ordering. Consider this scenario:

1. User clicks split mode while tab mode is active.
2. React commits the new (split) tree.
3. The order can be:
   - Naive expectation: `componentA.cleanup → componentB.mount`
   - Actual React 18 behavior in some cases: `componentB.mount → componentA.cleanup`

If B's mount runs first into container B, then A's cleanup runs and naively parks the host, B's container is now empty — its mount silently lost.

The token pattern fixes this without needing to predict React's order:

```ts
let currentToken: symbol | null = null
let lastMountedContainer: HTMLElement | null = null

return {
  mount(container: HTMLElement): symbol {
    if (disposed || !term) return Symbol('disposed')
    if (host.parentElement !== container) {
      container.appendChild(host)  // silently reparent
    }
    const token = Symbol('mount')
    currentToken = token
    lastMountedContainer = container
    void initIfReady(container)
    return token
  },
  detach(token: symbol): void {
    if (disposed) return
    if (token !== currentToken) return  // stale token, no-op
    currentToken = null
    cancelPendingInit()
    const park = getParkedContainer()
    if (host.parentElement !== park) {
      park.appendChild(host)
    }
  },
}
```

Walkthrough of the cross-tree case:

1. `tokenA = runtime.mount(A)` → currentToken = tokenA.
2. `tokenB = runtime.mount(B)` → host moves from A to B. currentToken = tokenB.
3. A's cleanup runs: `runtime.detach(tokenA)`. `tokenA !== currentToken` → return. **Host stays in B.**
4. B's cleanup eventually runs: `runtime.detach(tokenB)`. Match → park.

Both standard order and cross-tree order are handled by the same code path. **No `lastMountedContainer` heuristic needed in the detach guard.** (Earlier versions of pear had both `mounted` and `lastMountedContainer` checks; they interacted destructively. The token model subsumes them.)

## Parked host container

A singleton `<div>` appended to `document.body` with `display: none` (or `position: absolute; left: -9999px`). The runtime parks its host there between mounts.

```ts
let parkedContainer: HTMLDivElement | null = null
function getParkedContainer(): HTMLDivElement {
  if (parkedContainer && parkedContainer.isConnected) return parkedContainer
  const div = document.createElement('div')
  div.setAttribute('data-pear-terminal-park', 'true')
  div.style.cssText = 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden'
  document.body.appendChild(div)
  parkedContainer = div
  return div
}
```

While parked, the WebGL canvas is invisible but xterm continues to process incoming chunks (the buffer subscription is alive). When the host is reparented into a visible container, the canvas paints from the current buffer state. Call `term.refresh(0, term.rows - 1)` once on un-park (via `runtime.refreshOnShow()`) so the WebGL renderer flushes a frame.

## clearOnDataIf — companion identity-checked clear for onData

The runtime exposes a single `onData` handler slot:

```ts
let onDataHandler: ((data: string) => void) | null = null
term.onData((data) => onDataHandler?.(data))

return {
  setOnData(handler) { onDataHandler = handler },
  clearOnDataIf(handler) {
    if (onDataHandler === handler) onDataHandler = null
  },
}
```

The hook captures its own handler ref:

```ts
const onDataHandler = (data: string) => sendInput(data)
runtime.setOnData(onDataHandler)
// ...
return () => {
  runtime.clearOnDataIf(onDataHandler)  // only clears if it's still ours
}
```

The identity check protects against the same cross-tree case the token model protects the host: if a newer hook has already installed its own handler, the older cleanup is a no-op. Without this, the older cleanup would `setOnData(null)` and silently kill input forwarding for the live mount.

## Disposal contract

`runtime.dispose()` is called ONLY when the agent itself is released (closed, removed). Never on React unmount. The store drives disposal:

```ts
// somewhere in agent-store reaction to `agent_released` broker event:
disposeTerminalRuntime(getAgentKey(projectId, agentName))
```

Inside dispose, order matters:

```ts
dispose(): void {
  if (disposed) return
  cancelPendingInit()        // 1. Cancel any pending rAF
  clearPtyBuffer(key)        // 2. Drain buffer + notify with [] tail
  disposed = true            // 3. Flip flag (after subscribers settled)
  currentToken = null
  unsubBuffer?.()
  unsubBuffer = null
  disposePredictiveEcho?.()
  predictiveEcho = null
  try { webglAddon?.dispose() } catch {}
  webglAddon = null
  try { term?.dispose() } catch {}
  term = null
  if (host.parentElement) host.parentElement.removeChild(host)
}
```

`clearPtyBuffer(key)` before `disposed = true` so the synchronously-fired empty-tail notification still sees a live runtime (subscribers can check `disposed` at the top of their handler to short-circuit). After `disposed = true`, queued rAFs from `pty-buffer-store` will fire but the handler returns early — safe.

## Antipatterns

- **Reference counting per acquire/release**: tempting but unused in practice. The hook never calls a paired `release` (because tab switches don't conceptually "release" the agent). Disposal goes through the store-driven path. If you ship `refCount` it grows monotonically and `releaseTerminalRuntime` becomes dead code. Drop it.

- **`refuse second concurrent mount` guards** without the token model: produces the bug they're trying to prevent. With the token model, a second mount silently reparents and the older detach is a no-op. Both safe.

- **`display: none` over the WebGL canvas during animation**: the canvas keeps a backing texture, the compositor re-presents it during transform animations → ghost trails. Use `display: none/block` (paired with `term.refresh()`) or `opacity` fade. Never `transform`.

## Companion reading

- `xterm-internals.md` — what survives in the runtime
- `pty-broker-pipeline.md` — the subscription lifecycle the runtime owns
- `bug-class-triage.md` — symptoms this pattern eliminates
