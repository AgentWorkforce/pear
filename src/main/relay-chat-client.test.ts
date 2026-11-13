import { describe, expect, it, vi } from 'vitest'
import {
  RelayChatClient,
  RelayChatError,
  RelayChatPoller,
  fromConversationId,
  isServerMessageId,
  parseAgentMachine,
  toChannelId,
  toConversationId,
  toDriveId,
  toRelayAgentId
} from './relay-chat-client'

type RecordedCall = {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function okEnvelope(data: unknown): Record<string, unknown> {
  return { ok: true, data }
}

function errorEnvelope(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } }
}

function makeFetch(handler: (call: RecordedCall, index: number) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (url: unknown, init?: { method?: string; headers?: unknown; body?: unknown }): Promise<Response> => {
    const headers = new Headers()
    const rawHeaders = init?.headers
    if (rawHeaders && typeof rawHeaders === 'object') {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
        headers.set(key, String(value))
      }
    }
    const call: RecordedCall = {
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(headers.entries())
    }
    if (typeof init?.body === 'string') call.body = init.body
    calls.push(call)
    return handler(call, calls.length - 1)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function clientWith(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}): RelayChatClient {
  return new RelayChatClient({
    baseUrl: 'https://cast.agentrelay.com',
    getWorkspaceKey: () => 'rk_live_workspace',
    getAgentToken: () => 'at_live_agent',
    fetchImpl,
    // No waiting in tests: record sleeps instead of sleeping.
    sleepImpl: () => Promise.resolve(),
    ...overrides
  })
}

describe('relay chat client transport', () => {
  it('retries 503 database_overloaded and then succeeds', async () => {
    const { fetchImpl, calls } = makeFetch((_call, index) =>
      index < 2
        ? jsonResponse(errorEnvelope('database_overloaded', 'overloaded'), 503)
        : jsonResponse(okEnvelope([
          { name: 'agent-one', status: 'active', last_seen: '2026-11-12T00:00:00Z' }
        ]))
    )
    const client = clientWith(fetchImpl)
    const agents = await client.listAgents()
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.headers.authorization === 'Bearer rk_live_workspace')).toBe(true)
    expect(agents).toEqual([
      { id: 'relay:agent-one', name: 'agent-one', status: 'active', lastSeen: '2026-11-12T00:00:00Z' }
    ])
  })

  it('gives up after the retry budget on persistent 503s', async () => {
    const sleepMs: number[] = []
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(errorEnvelope('database_overloaded', 'overloaded'), 503)
    )
    const client = clientWith(fetchImpl, {
      maxRetries: 3,
      retryBaseMs: 10,
      sleepImpl: (ms: number) => {
        sleepMs.push(ms)
        return Promise.resolve()
      }
    })
    await expect(client.listNodes()).rejects.toMatchObject({ code: 'database_overloaded' })
    // Initial attempt + 3 retries.
    expect(calls).toHaveLength(4)
    expect(sleepMs).toHaveLength(3)
  })

  it('rotates the workspace key once on 401 and retries', async () => {
    const seenKeys: Array<string | undefined> = []
    const { fetchImpl, calls } = makeFetch((call) => {
      seenKeys.push(call.headers.authorization)
      if (call.headers.authorization === 'Bearer rk_live_stale') {
        return jsonResponse(errorEnvelope('unauthorized', 'bad key'), 401)
      }
      return jsonResponse(okEnvelope([]))
    })
    let current = 'rk_live_stale'
    const client = clientWith(fetchImpl, {
      getWorkspaceKey: () => current,
      setWorkspaceKey: (key: string) => {
        current = key
      },
      rotateWorkspaceKey: () => Promise.resolve('rk_live_fresh')
    })
    await client.listAgents()
    expect(calls).toHaveLength(2)
    expect(seenKeys).toEqual(['Bearer rk_live_stale', 'Bearer rk_live_fresh'])
    expect(current).toBe('rk_live_fresh')
  })

  it('surfaces 401 when rotation is unavailable', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(errorEnvelope('unauthorized', 'bad key'), 401)
    )
    const client = clientWith(fetchImpl, {
      getWorkspaceKey: () => 'rk_live_stale',
      rotateWorkspaceKey: () => Promise.resolve(null)
    })
    const error = await client.listAgents().catch((err: unknown) => err)
    expect(error).toBeInstanceOf(RelayChatError)
    expect((error as RelayChatError).code).toBe('unauthorized')
    expect(calls).toHaveLength(1)
  })

  it('does not retry a non-retryable 400', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(errorEnvelope('bad_request', 'nope'), 400)
    )
    const client = clientWith(fetchImpl)
    await expect(client.sendDM({ kind: 'dm', to: 'agent-two', text: 'hi' })).rejects.toMatchObject({
      code: 'unknown_error'
    })
    expect(calls).toHaveLength(1)
  })
})

describe('relay chat client models', () => {
  it('parses name@host machine names and prefixes roster ids', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(
        okEnvelope([
          { name: 'worker@mbp-2', status: 'online' },
          { name: 'plain', status: 'idle', created_at: '2026-11-01T00:00:00Z' },
          { name: 'ghost', status: 'weird-status' }
        ])
      )
    )
    const agents = await clientWith(fetchImpl).listAgents('all')
    expect(agents[0]).toMatchObject({ id: 'relay:worker@mbp-2', name: 'worker', host: 'mbp-2', status: 'online' })
    expect(agents[1]).toMatchObject({ id: 'relay:plain', name: 'plain', status: 'idle' })
    // Unknown statuses degrade to offline, never throw.
    expect(agents[2]).toMatchObject({ status: 'offline' })
    expect(parseAgentMachine('a@b@c')).toEqual({ name: 'a@b', host: 'c' })
    expect(parseAgentMachine('solo')).toEqual({ name: 'solo' })
    expect(toRelayAgentId('relay:x')).toBe('relay:x')
    expect(toConversationId('conversation:abc')).toBe('conversation:abc')
    expect(toConversationId('abc')).toBe('conversation:abc')
    expect(toChannelId('#general')).toBe('channel:general')
    expect(toDriveId('file_1')).toBe('drive:file_1')
    expect(fromConversationId('conversation:abc')).toBe('abc')
  })

  it('marks server ids and optimistic local rows', () => {
    expect(isServerMessageId('msg_123')).toBe(true)
    expect(isServerMessageId('local:9f3a')).toBe(false)
    expect(isServerMessageId('')).toBe(false)
  })

  it('reverses newest-first history to oldest-first with limit=100', async () => {
    const newestFirst = [
      { id: 'm3', agent_name: 'bob', text: 'third', created_at: '2026-11-12T00:03:00Z' },
      { id: 'm2', agent_name: 'alice', text: 'second', created_at: '2026-11-12T00:02:00Z' },
      { id: 'm1', agent_name: 'bob', text: 'first', created_at: '2026-11-12T00:01:00Z' }
    ]
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(okEnvelope(newestFirst)))
    const messages = await clientWith(fetchImpl).getChannelMessages('#general')
    expect(messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm3'])
    expect(messages[0]).toMatchObject({
      channelName: 'general',
      from: 'bob',
      text: 'first',
      hasServerID: true,
      attachments: []
    })
    expect(calls[0].url).toContain('/v1/channels/general/messages')
    expect(calls[0].url).toContain('limit=100')
    expect(calls[0].headers.authorization).toBe('Bearer at_live_agent')
  })

  it('computes delivery from non-sender readers', async () => {
    const { fetchImpl, calls } = makeFetch((_call, index) => {
      // First call: sender + another reader. Second call: only the sender.
      const readers =
        index === 0
          ? [
              { agent_name: 'alice', agent_id: 'a1', read_at: '2026-11-12T00:01:00Z' },
              { agent_name: 'bob', agent_id: 'b1', read_at: '2026-11-12T00:02:00Z' }
            ]
          : [{ agent_name: 'bob', agent_id: 'b1', read_at: '2026-11-12T00:02:00Z' }]
      return jsonResponse(okEnvelope(readers))
    })
    const client = clientWith(fetchImpl)
    // A reader other than the sender counts as delivered.
    await expect(client.getMessageReaders('m1', 'alice')).resolves.toEqual({
      readers: ['alice', 'bob'],
      delivered: true
    })
    // Only the sender has read: not delivered.
    await expect(client.getMessageReaders('m1', 'bob')).resolves.toEqual({
      readers: ['bob'],
      delivered: false
    })
    expect(calls).toHaveLength(2)
  })

  it('treats channel join 409 as already-a-member', async () => {
    const join409 = makeFetch(() => jsonResponse(errorEnvelope('already_member', 'member'), 409))
    await expect(clientWith(join409.fetchImpl).joinChannel('#general')).resolves.toEqual({
      alreadyMember: true
    })
    const join200 = makeFetch(() =>
      jsonResponse(okEnvelope({ channel: { name: 'general' } }))
    )
    await expect(clientWith(join200.fetchImpl).joinChannel('general')).resolves.toEqual({
      alreadyMember: false
    })
    expect(join200.calls[0].url).toContain('/v1/channels/general/join')
  })

  it('runs the 3-step attachment upload in order', async () => {
    const puts: Array<{ url: string; contentType: string; bytes: string }> = []
    const { fetchImpl, calls } = makeFetch(async (call) => {
      if (call.url.endsWith('/v1/files/upload')) {
        expect(JSON.parse(call.body ?? '{}')).toEqual({
          filename: 'notes.txt',
          content_type: 'text/plain',
          size_bytes: 5
        })
        return jsonResponse(okEnvelope({ id: 'file_7', upload_url: 'https://uploads.example/put-7' }))
      }
      if (call.url.includes('/v1/files/file_7/complete')) {
        return jsonResponse(
          okEnvelope({ id: 'file_7', filename: 'notes.txt', content_type: 'text/plain', size_bytes: 5 })
        )
      }
      throw new Error(`unexpected ${call.method} ${call.url}`)
    })
    const uploadFetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      if (String(url) === 'https://uploads.example/put-7') {
        const bytes = new Uint8Array((init?.body as Uint8Array).buffer.slice(0))
        puts.push({
          url: String(url),
          contentType: (init?.headers as Record<string, string>)['Content-Type'],
          bytes: Buffer.from(bytes).toString('utf8')
        })
        return new Response(null, { status: 200 })
      }
      return fetchImpl(String(url), init)
    }) as typeof fetch

    const attachment = await clientWith(uploadFetch).uploadFile({
      filename: 'notes.txt',
      contentType: 'text/plain',
      bytes: new Uint8Array(Buffer.from('hello'))
    })
    expect(attachment).toEqual({
      file_id: 'file_7',
      filename: 'notes.txt',
      content_type: 'text/plain',
      size_bytes: 5
    })
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining('/v1/files/upload'),
      expect.stringContaining('/v1/files/file_7/complete')
    ])
    expect(puts).toEqual([{ url: 'https://uploads.example/put-7', contentType: 'text/plain', bytes: 'hello' }])
  })

  it('registers, then rotates on name conflict (register-or-rotate)', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.method === 'POST' && call.url.endsWith('/v1/agents')) {
        return jsonResponse(errorEnvelope('agent_already_exists', 'taken'), 409)
      }
      if (call.url.endsWith('/v1/agents/pear-chat-x')) {
        return jsonResponse(okEnvelope({ name: 'pear-chat-x' }))
      }
      if (call.url.endsWith('/rotate-token')) {
        return jsonResponse(okEnvelope({ token: 'at_live_rotated' }))
      }
      throw new Error(`unexpected ${call.method} ${call.url}`)
    })
    await expect(clientWith(fetchImpl).ensureAgent('pear-chat-x')).resolves.toEqual({
      name: 'pear-chat-x',
      token: 'at_live_rotated'
    })
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /v1/agents',
      'GET /v1/agents/pear-chat-x',
      'POST /v1/agents/pear-chat-x/rotate-token'
    ])
  })

  it('rejects optimistic sends loudly so the renderer can roll back', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(errorEnvelope('mailbox_full', 'recipient mailbox full'), 503)
    )
    const client = clientWith(fetchImpl, { maxRetries: 0 })
    const error = await client
      .sendDM({ kind: 'dm', to: 'offline-agent', text: 'hello' })
      .catch((err: unknown) => err)
    // The failure path returns no message object — the caller must surface
    // the error, never a fabricated echo.
    expect(error).toBeInstanceOf(RelayChatError)
    expect((error as RelayChatError).retryable).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe('relay chat poller', () => {
  it('ticks roster+messages+channels but never channel history', async () => {
    const seen: string[] = []
    const tick = vi.fn()
    const poller = new RelayChatPoller(
      {
        pollRoster: () => {
          seen.push('roster')
          return Promise.resolve()
        },
        pollMessages: () => {
          seen.push('messages')
          return Promise.resolve()
        },
        pollChannels: () => {
          seen.push('channels')
          return Promise.resolve()
        },
        loadOpenChannelHistory: () => {
          seen.push('history')
          return Promise.resolve()
        },
        onRefreshed: () => tick()
      },
      {
        setIntervalImpl: (fn) => {
          ;(poller as unknown as { __tick: () => void }).__tick = fn
          return 'timer'
        },
        clearIntervalImpl: () => undefined
      }
    )
    poller.setOpenChannel('general')
    poller.start()
    expect(poller.running).toBe(true)
    ;(poller as unknown as { __tick: () => void }).__tick()
    // Let the background tick finish (it never loads channel history),
    // then run a manual refresh which does.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await poller.refreshNow('manual')
    expect(seen.filter((step) => step === 'history')).toHaveLength(1)
    poller.stop()
    expect(poller.running).toBe(false)
    expect(tick).toHaveBeenCalled()
  })

  it('foreground refresh reloads open history; interval does not', async () => {
    const seen: string[] = []
    const poller = new RelayChatPoller({
      pollRoster: () => {
        seen.push('roster')
        return Promise.resolve()
      },
      loadOpenChannelHistory: () => {
        seen.push('history')
        return Promise.resolve()
      }
    })
    poller.setOpenChannel('general')
    await poller.refreshNow('interval')
    expect(seen).toEqual(['roster'])
    await poller.refreshNow('foreground')
    expect(seen).toEqual(['roster', 'roster', 'history'])
  })
})
