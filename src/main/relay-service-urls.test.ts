import { describe, expect, it } from 'vitest'
import {
  RELAYCAST_BASE_URL,
  RELAYFILE_BASE_URL,
  normalizeRelayServiceEnv,
  normalizeRelayWorkspaceInfo,
  normalizeRelaycastBaseUrl,
  normalizeRelayfileBaseUrl
} from './relay-service-urls'

describe('relay service URL normalization', () => {
  it('canonicalizes hosted relayfile and relaycast URLs', () => {
    expect(normalizeRelayfileBaseUrl('https://api.relayfile.dev/')).toBe(RELAYFILE_BASE_URL)
    expect(normalizeRelayfileBaseUrl('https://file.agentrelay.com/v1')).toBe(RELAYFILE_BASE_URL)
    expect(normalizeRelaycastBaseUrl('https://api.relaycast.dev')).toBe(RELAYCAST_BASE_URL)
    expect(normalizeRelaycastBaseUrl('https://cast.agentrelay.com/')).toBe(RELAYCAST_BASE_URL)
  })

  it('leaves custom self-hosted URLs intact', () => {
    expect(normalizeRelayfileBaseUrl('https://relayfile.internal.example/')).toBe('https://relayfile.internal.example')
    expect(normalizeRelaycastBaseUrl('https://relaycast.internal.example/api')).toBe('https://relaycast.internal.example/api')
  })

  it('normalizes relay mount env aliases together', () => {
    expect(normalizeRelayServiceEnv({
      RELAYFILE_BASE_URL: 'https://api.relayfile.dev',
      RELAYCAST_BASE_URL: 'https://api.relaycast.dev'
    })).toMatchObject({
      RELAYFILE_BASE_URL,
      RELAYCAST_BASE_URL,
      RELAY_BASE_URL: RELAYCAST_BASE_URL
    })
  })

  it('normalizes nullish relay mount env to hosted defaults', () => {
    expect(normalizeRelayServiceEnv(null)).toMatchObject({
      RELAYFILE_BASE_URL,
      RELAYCAST_BASE_URL,
      RELAY_BASE_URL: RELAYCAST_BASE_URL
    })
  })

  it('normalizes workspace handle info without mutating the input', () => {
    const handle = {
      info: {
        relayfileUrl: 'https://api.relayfile.dev',
        relaycastBaseUrl: 'https://api.relaycast.dev'
      }
    }

    const normalized = normalizeRelayWorkspaceInfo(handle)

    expect(normalized.info).toEqual({
      relayfileUrl: RELAYFILE_BASE_URL,
      relaycastBaseUrl: RELAYCAST_BASE_URL
    })
    expect(handle.info).toEqual({
      relayfileUrl: 'https://api.relayfile.dev',
      relaycastBaseUrl: 'https://api.relaycast.dev'
    })
    expect(normalized).not.toBe(handle)
  })
})
