// STRESS TEST — agent-store
//
// Drives the agent-store at the "1000s of agents communicating" scale the
// product spec assumes. Exercises the message dedupe, cap, and reference-
// stability invariants under realistic relay_inbound + reconcile load.
//
// Invariants exercised:
//   1. No duplicate message IDs in state.messages — the id-based dedup never
//      lets the same id appear twice across relay_inbound + reconcile paths.
//   2. Optimistic human sends never get lost to the isCanonicalEchoOfLocalHuman
//      guard — repeated identical human messages all produce final records.
//   3. The agent dedupe guard does NOT false-positive on cross-project sends:
//      identical (agent, body, target) in different projects survive distinct.
//   4. The agent dedupe guard does NOT false-positive on legitimate distinct
//      sends outside the 2s window — two identical agent messages 3s apart
//      both survive.
//   5. The agent dedupe guard DOES catch the broker-replay case — the same
//      agent+body+target+project within 2s with different event_ids appears
//      exactly once.
//   6. The MAX_CHAT_MESSAGES cap (5000) holds even after a 60k-message burst.
//   7. reconcileMessages returns the SAME messages array reference when
//      called twice with the same canonical input — downstream selectors
//      must not see a spurious change.
//   8. The replay guard handles the 1000-agent/50-message duplicate case
//      without regressing to a full-buffer scan per incoming event.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// @/lib/ipc evaluates `window.pear` at module init (renderer-only). The
// vitest node env has no `window`, so stub the module before the agent-store
// import chain pulls in project-store -> @/lib/ipc.
vi.mock('@/lib/ipc', () => ({ pear: {} }))

import { useAgentStore } from './agent-store'
import type { BrokerReconciledChatMessage } from '@shared/types/ipc'

const MAX_CHAT_MESSAGES = 5_000

function monotonicMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000
}

// Matches the shape `agent-store.handleBrokerEvent` expects for relay_inbound;
// the index signature aligns with the internal BrokerEvent discriminated
// union that requires `[key: string]: unknown`.
interface RelayInboundEvent {
  kind: 'relay_inbound'
  from: string
  target: string
  body: string
  projectId?: string
  event_id?: string
  [key: string]: unknown
}

function relayInbound(opts: {
  from: string
  target: string
  body: string
  projectId?: string
  event_id?: string
}): RelayInboundEvent {
  return { kind: 'relay_inbound', ...opts }
}

describe('agent-store stress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    // The store reads `localStorage.getItem('pear-broker-debug')` from a
    // debug helper. Vitest's node env exposes a partial localStorage shim
    // whose getItem isn't callable, so we replace it with a real stub.
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0
    })
    useAgentStore.getState().clearAll()
  })

  afterEach(() => {
    useAgentStore.getState().clearAll()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // 50k relay_inbound events each spread a 5000-cap immutable buffer; the
  // raw work is ~250M element copies and the test runs in ~6–8s on a laptop.
  // Bumped from the 5s default so CI doesn't flake on slower runners.
  it('1000 agents × 50 messages + 100 human sends + 5 reconciles satisfies every invariant', () => {
    const store = useAgentStore.getState()
    const projectCount = 5
    const agentsPerProject = 200
    const messagesPerAgent = 50
    const totalAgentEvents = projectCount * agentsPerProject * messagesPerAgent

    // Drive relay_inbound at scale. Bodies vary per (round, agent) so dedupe
    // doesn't suppress legitimate distinct messages. The timestamp moves
    // 10ms per outer round so the 2s dedupe window is exercised but not
    // monopolised.
    let eventCounter = 0
    for (let m = 0; m < messagesPerAgent; m++) {
      for (let p = 0; p < projectCount; p++) {
        for (let a = 0; a < agentsPerProject; a++) {
          const agentName = `agent-${a}`
          const projectId = `project-${p}`
          // Half of the events target a channel, half target a DM. The DM
          // target is the human (cross-stream replay shape that the guard
          // is specifically designed to dedupe).
          const target = (a % 2 === 0) ? '#general' : 'human'
          store.handleBrokerEvent(relayInbound({
            from: agentName,
            target,
            body: `m${m}-${agentName}`,
            projectId,
            event_id: `evt-${eventCounter++}`
          }))
        }
      }
      vi.advanceTimersByTime(10)
    }
    expect(eventCounter).toBe(totalAgentEvents)

    // 100 optimistic human sends with the SAME body — verifies that the
    // isCanonicalEchoOfLocalHuman guard never causes a local addHumanMessage
    // to be dropped (the guard is only applied to incoming canonical echoes).
    for (let h = 0; h < 100; h++) {
      store.addHumanMessage('#general', 'hello-world', 'project-0')
    }

    // 5 reconcileMessages syncs interleaved with the rest of the load.
    for (let r = 0; r < 5; r++) {
      const canonicalBatch: BrokerReconciledChatMessage[] = Array.from({ length: 20 }, (_, j) => ({
        id: `canonical-${r}-${j}`,
        from: `canon-agent-${j}`,
        to: '#general',
        body: `canon-body-${r}-${j}`,
        timestamp: Date.now() + r * 1000 + j,
        isHuman: false,
        projectId: 'project-0'
      }))
      store.reconcileMessages(canonicalBatch)
      vi.advanceTimersByTime(5)
    }

    const messages = useAgentStore.getState().messages

    // Invariant 1 — no duplicate ids.
    const ids = new Set(messages.map((m) => m.id))
    expect(ids.size).toBe(messages.length)

    // Invariant 6 — MAX_CHAT_MESSAGES cap holds.
    expect(messages.length).toBeLessThanOrEqual(MAX_CHAT_MESSAGES)

    // Sanity — buffer is non-trivially populated (the cap actually clamped).
    expect(messages.length).toBe(MAX_CHAT_MESSAGES)
  }, 60_000)

  it('1000 agents × 50 replay echoes stay bounded by indexed duplicate lookups', () => {
    const store = useAgentStore.getState()
    const agentCount = 1_000
    const replayCount = 50

    for (let agentIndex = 0; agentIndex < agentCount; agentIndex += 1) {
      const agentName = `replay-agent-${agentIndex}`
      store.handleBrokerEvent(relayInbound({
        from: agentName,
        target: agentIndex % 2 === 0 ? '#general' : 'human',
        body: `stable-replay-body-${agentName}`,
        projectId: 'replay-project',
        event_id: `replay-seed-${agentIndex}`
      }))
    }

    vi.advanceTimersByTime(250)
    const startedAt = monotonicMs()
    for (let replay = 0; replay < replayCount; replay += 1) {
      for (let agentIndex = 0; agentIndex < agentCount; agentIndex += 1) {
        const agentName = `replay-agent-${agentIndex}`
        store.handleBrokerEvent(relayInbound({
          from: agentName,
          target: agentIndex % 2 === 0 ? '#general' : 'human',
          body: `stable-replay-body-${agentName}`,
          projectId: 'replay-project',
          event_id: `replay-echo-${replay}-${agentIndex}`
        }))
      }
      vi.advanceTimersByTime(1)
    }
    const elapsedMs = monotonicMs() - startedAt

    const messages = useAgentStore.getState().messages.filter((message) =>
      message.projectId === 'replay-project'
    )
    expect(messages.length).toBe(agentCount)
    expect(new Set(messages.map((message) => message.id)).size).toBe(agentCount)
    expect(elapsedMs).toBeLessThan(5_000)
  }, 10_000)

  it('addHumanMessage never drops repeated identical sends', () => {
    // Invariant 2 — the optimistic path is local-only; repeats must survive.
    // (Even with capByCount, 100 sends are well under MAX_CHAT_MESSAGES.)
    const store = useAgentStore.getState()
    for (let i = 0; i < 100; i++) {
      store.addHumanMessage('#general', 'identical-body', 'p1')
    }
    const messages = useAgentStore.getState().messages
    const humanLocal = messages.filter((m) =>
      m.isHuman === true &&
      m.local === true &&
      m.body === 'identical-body'
    )
    expect(humanLocal.length).toBe(100)
    const ids = new Set(humanLocal.map((m) => m.id))
    expect(ids.size).toBe(100)
  })

  it('addHumanMessage does not duplicate when the canonical echo wins the race and arrives first', () => {
    // Regression: on the very first send to a channel, relay_inbound can
    // beat the optimistic addHumanMessage append (e.g. while the channel/
    // broker is still spinning up). isCanonicalEchoOfLocalHuman only
    // guards the opposite ordering (optimistic-then-canonical), so without
    // isCanonicalAlreadyPresent, addHumanMessage would append a second,
    // permanently-stuck copy — reconcileMessages can't clean it up because
    // the canonical id is already present, short-circuiting the id-match
    // branch before it ever reaches content-based optimistic matching.
    const store = useAgentStore.getState()
    store.handleBrokerEvent(relayInbound({
      from: 'human',
      target: '#general',
      body: 'race-body',
      projectId: 'p1',
      event_id: 'evt-race-canonical'
    }))
    store.addHumanMessage('#general', 'race-body', 'p1')

    const messages = useAgentStore.getState().messages.filter(
      (m) => m.body === 'race-body'
    )
    expect(messages.length).toBe(1)
    expect(messages[0]!.id).toBe('evt-race-canonical')
    expect(messages[0]!.local).not.toBe(true)
  })

  it('addHumanMessage does not drop a second identical send shortly after the first was reconciled', () => {
    // Regression for review feedback on the race guard above: matching
    // isCanonicalAlreadyPresent against ANY non-local record (including
    // local: false, set by reconcileChatMessages once an earlier optimistic
    // send is confirmed) would falsely suppress a later, legitimately
    // repeated send within the 10s human dedupe window. The guard must only
    // match a still-unclaimed standalone canonical record (local ===
    // undefined) within a tight race window, not confirmed history.
    const store = useAgentStore.getState()
    store.addHumanMessage('#general', 'repeat-body', 'p1')
    const firstLocal = useAgentStore.getState().messages.find(
      (m) => m.body === 'repeat-body' && m.local === true
    )
    expect(firstLocal).toBeTruthy()

    store.reconcileMessages([{
      id: 'canonical-repeat-1',
      from: 'human',
      to: '#general',
      body: 'repeat-body',
      timestamp: firstLocal!.timestamp,
      isHuman: true,
      projectId: 'p1'
    }])
    expect(
      useAgentStore.getState().messages.find((m) => m.id === 'canonical-repeat-1')?.local
    ).toBe(false)

    vi.advanceTimersByTime(3_000)
    store.addHumanMessage('#general', 'repeat-body', 'p1')

    const repeatMessages = useAgentStore.getState().messages.filter(
      (m) => m.body === 'repeat-body'
    )
    expect(repeatMessages.length).toBe(2)
    expect(repeatMessages.filter((m) => m.local === true).length).toBe(1)
  })

  it('cross-project agent dedupe does not false-positive — identical body, different projectId survives twice', () => {
    // Invariant 3 — projectId mismatch must NEVER collapse two distinct sends.
    const store = useAgentStore.getState()
    store.handleBrokerEvent(relayInbound({
      from: 'agent-x',
      target: '#general',
      body: 'cross-project-body',
      projectId: 'project-a',
      event_id: 'evt-a'
    }))
    store.handleBrokerEvent(relayInbound({
      from: 'agent-x',
      target: '#general',
      body: 'cross-project-body',
      projectId: 'project-b',
      event_id: 'evt-b'
    }))
    const messages = useAgentStore.getState().messages.filter(
      (m) => m.body === 'cross-project-body'
    )
    expect(messages.length).toBe(2)
    expect(new Set(messages.map((m) => m.projectId))).toEqual(
      new Set(['project-a', 'project-b'])
    )
  })

  it('legitimate identical agent sends 3s apart both survive the 2s dedupe window', () => {
    // Invariant 4 — outside the AGENT_MESSAGE_DEDUPE_WINDOW_MS (2000ms),
    // identical messages are distinct sends, not replays.
    const store = useAgentStore.getState()
    store.handleBrokerEvent(relayInbound({
      from: 'agent-y',
      target: '#general',
      body: 'spaced-body',
      projectId: 'p1',
      event_id: 'evt-spaced-1'
    }))
    vi.advanceTimersByTime(3_000)
    store.handleBrokerEvent(relayInbound({
      from: 'agent-y',
      target: '#general',
      body: 'spaced-body',
      projectId: 'p1',
      event_id: 'evt-spaced-2'
    }))
    const messages = useAgentStore.getState().messages.filter(
      (m) => m.body === 'spaced-body'
    )
    expect(messages.length).toBe(2)
    expect(messages[0]!.timestamp).toBeLessThan(messages[1]!.timestamp)
  })

  it('agent dedupe collapses broker-replay — same agent+body+target+project within 2s, different event_ids → one record', () => {
    // Invariant 5 — the explicit case the guardrail was built for: the broker
    // emits the same logical message twice with different event_ids (one via
    // relay_inbound, one via a reconcile snapshot, or two relay_inbound
    // streams racing). Both arrive within 2s. Renderer must show one.
    const store = useAgentStore.getState()
    store.handleBrokerEvent(relayInbound({
      from: 'agent-z',
      target: '#general',
      body: 'replayed-body',
      projectId: 'p1',
      event_id: 'evt-A'
    }))
    vi.advanceTimersByTime(500)
    store.handleBrokerEvent(relayInbound({
      from: 'agent-z',
      target: '#general',
      body: 'replayed-body',
      projectId: 'p1',
      event_id: 'evt-B'
    }))
    const messages = useAgentStore.getState().messages.filter(
      (m) => m.body === 'replayed-body'
    )
    expect(messages.length).toBe(1)
    // The first (evt-A) wins — it was already in the buffer when evt-B arrived.
    expect(messages[0]!.id).toBe('evt-A')
  })

  it('agent dedupe keeps the 2s boundary exclusive', () => {
    const store = useAgentStore.getState()
    store.handleBrokerEvent(relayInbound({
      from: 'agent-boundary',
      target: '#general',
      body: 'boundary-body',
      projectId: 'p1',
      event_id: 'evt-boundary-1'
    }))
    vi.advanceTimersByTime(2_000)
    store.handleBrokerEvent(relayInbound({
      from: 'agent-boundary',
      target: '#general',
      body: 'boundary-body',
      projectId: 'p1',
      event_id: 'evt-boundary-2'
    }))

    const messages = useAgentStore.getState().messages.filter(
      (m) => m.body === 'boundary-body'
    )
    expect(messages.map((m) => m.id)).toEqual(['evt-boundary-1', 'evt-boundary-2'])
  })

  it('agent dedupe matches trimmed case-insensitive senders and hashless channel targets', () => {
    const store = useAgentStore.getState()
    store.handleBrokerEvent(relayInbound({
      from: ' Agent-Normalized ',
      target: '#general',
      body: 'normalized-body',
      projectId: 'p1',
      event_id: 'evt-normalized-1'
    }))
    vi.advanceTimersByTime(250)
    store.handleBrokerEvent(relayInbound({
      from: 'agent-normalized',
      target: 'general',
      body: 'normalized-body',
      projectId: 'p1',
      event_id: 'evt-normalized-2'
    }))

    const messages = useAgentStore.getState().messages.filter(
      (m) => m.body === 'normalized-body'
    )
    expect(messages.map((m) => m.id)).toEqual(['evt-normalized-1'])
  })

  it('agent dedupe treats target case and undefined projectId exactly like the scan path', () => {
    const store = useAgentStore.getState()
    store.handleBrokerEvent(relayInbound({
      from: 'agent-exact',
      target: '#General',
      body: 'exact-target-body',
      projectId: 'p1',
      event_id: 'evt-exact-target-1'
    }))
    vi.advanceTimersByTime(250)
    store.handleBrokerEvent(relayInbound({
      from: 'agent-exact',
      target: '#general',
      body: 'exact-target-body',
      projectId: 'p1',
      event_id: 'evt-exact-target-2'
    }))

    store.handleBrokerEvent(relayInbound({
      from: 'agent-exact',
      target: '#general',
      body: 'exact-project-body',
      event_id: 'evt-exact-project-1'
    }))
    vi.advanceTimersByTime(250)
    store.handleBrokerEvent(relayInbound({
      from: 'agent-exact',
      target: '#general',
      body: 'exact-project-body',
      projectId: 'p1',
      event_id: 'evt-exact-project-2'
    }))

    expect(useAgentStore.getState().messages.filter(
      (m) => m.body === 'exact-target-body'
    ).map((m) => m.id)).toEqual(['evt-exact-target-1', 'evt-exact-target-2'])
    expect(useAgentStore.getState().messages.filter(
      (m) => m.body === 'exact-project-body'
    ).map((m) => m.id)).toEqual(['evt-exact-project-1', 'evt-exact-project-2'])
  })

  it('reconcile agent dedupe sees earlier messages in the same batch', () => {
    const store = useAgentStore.getState()
    const now = Date.now()
    store.reconcileMessages([
      {
        id: 'reconcile-batch-first',
        from: 'agent-batch',
        to: '#general',
        body: 'batch-body',
        timestamp: now,
        isHuman: false,
        projectId: 'p1'
      },
      {
        id: 'reconcile-batch-second',
        from: 'agent-batch',
        to: 'general',
        body: 'batch-body',
        timestamp: now + 250,
        isHuman: false,
        projectId: 'p1'
      }
    ])

    const messages = useAgentStore.getState().messages.filter(
      (m) => m.body === 'batch-body'
    )
    expect(messages.map((m) => m.id)).toEqual(['reconcile-batch-first'])
  })

  it('reconcile agent dedupe uses updated records, not stale pre-merge identity', () => {
    const store = useAgentStore.getState()
    const now = Date.now()
    store.reconcileMessages([{
      id: 'reconcile-update-seed',
      from: 'agent-update',
      to: '#general',
      body: 'old-body',
      timestamp: now,
      isHuman: false,
      projectId: 'p1'
    }])

    store.reconcileMessages([
      {
        id: 'reconcile-update-seed',
        from: 'agent-update',
        to: '#general',
        body: 'new-body',
        timestamp: now + 100,
        isHuman: false,
        projectId: 'p1'
      },
      {
        id: 'reconcile-update-duplicate-new',
        from: 'agent-update',
        to: '#general',
        body: 'new-body',
        timestamp: now + 200,
        isHuman: false,
        projectId: 'p1'
      },
      {
        id: 'reconcile-update-distinct-old',
        from: 'agent-update',
        to: '#general',
        body: 'old-body',
        timestamp: now + 300,
        isHuman: false,
        projectId: 'p1'
      }
    ])

    const messages = useAgentStore.getState().messages
    expect(messages.filter((m) => m.body === 'new-body').map((m) => m.id)).toEqual([
      'reconcile-update-seed'
    ])
    expect(messages.filter((m) => m.body === 'old-body').map((m) => m.id)).toEqual([
      'reconcile-update-distinct-old'
    ])
  })

  it('reconcileMessages with the same canonical input twice returns the same messages array reference', () => {
    // Invariant 7 — selectors that compare by reference must NOT see a change
    // when the broker reconciles the same canonical snapshot.
    const store = useAgentStore.getState()
    const canonical: BrokerReconciledChatMessage[] = [
      {
        id: 'canon-stable-1',
        from: 'agent-a',
        to: '#general',
        body: 'canonical body 1',
        timestamp: Date.now(),
        isHuman: false,
        projectId: 'p1'
      },
      {
        id: 'canon-stable-2',
        from: 'agent-b',
        to: '#general',
        body: 'canonical body 2',
        timestamp: Date.now() + 100,
        isHuman: false,
        projectId: 'p1'
      }
    ]
    store.reconcileMessages(canonical)
    const firstRef = useAgentStore.getState().messages
    expect(firstRef.length).toBe(2)

    // Second call with identical canonical input — must short-circuit to the
    // same array reference (no spurious state mutation).
    store.reconcileMessages(canonical)
    const secondRef = useAgentStore.getState().messages
    expect(secondRef).toBe(firstRef)

    // Even an empty canonical batch must not change the reference.
    store.reconcileMessages([])
    expect(useAgentStore.getState().messages).toBe(firstRef)
  })

  it('reconcile + relay_inbound interaction does not create duplicate ids when broker echoes canonical msg via both streams', () => {
    // Stress the cross-stream case: a canonical message arrives via
    // reconcileMessages AND the same logical message arrives via
    // relay_inbound under a different event_id. The id-dedupe must run
    // and the agent-replay guard must run — never both copies survive.
    const store = useAgentStore.getState()
    const now = Date.now()
    store.reconcileMessages([{
      id: 'canonical-id-1',
      from: 'agent-q',
      to: '#general',
      body: 'cross-stream-body',
      timestamp: now,
      isHuman: false,
      projectId: 'p1'
    }])
    // Same logical message via relay_inbound with a different event_id — the
    // 2s window catches this as a duplicate.
    store.handleBrokerEvent(relayInbound({
      from: 'agent-q',
      target: '#general',
      body: 'cross-stream-body',
      projectId: 'p1',
      event_id: 'relay-id-1'
    }))
    const messages = useAgentStore.getState().messages.filter(
      (m) => m.body === 'cross-stream-body'
    )
    expect(messages.length).toBe(1)
    expect(messages[0]!.id).toBe('canonical-id-1')
  })
})
