import { describe, expect, it, vi } from 'vitest'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import type { RuntimeInfoSnapshot } from '../../../../shared/relay/observability'
import {
  displayedConnections,
  displayedLogs,
  formatTraffic,
  observedClosedConnections,
  observedConnection,
  observedConnectionRates,
  observedLog,
  observedTrafficRate,
  readRuntimeObservation,
  runtimeLogCursor,
  runtimeLogLines,
  type RuntimeInfoChannel,
  type RuntimeObservation
} from './runtime-info'

function fixture() {
  const state: LocalProxyState = {
    phase: 'running',
    pending: false,
    owned: true,
    hasRecord: true,
    uncertain: false,
    instanceId: '00000000-0000-0000-0000-000000000032',
    configurationRevision: 'a'.repeat(64),
    pid: 123,
    httpPort: 18191,
    mode: 'rule',
    traffic: 'listening',
    groups: [],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: []
  }
  const info: RuntimeInfoSnapshot = {
    process: { ...state },
    interfaces: [],
    traffic: { download: 1024, upload: 512 },
    externalIpLookupWired: false,
    remoteLatencyProbeWired: false,
    warnings: []
  }
  const connections = { connections: [{ id: 'one' }], download: 1024, upload: 512 }
  const invoke = vi.fn(async (channel: RuntimeInfoChannel): Promise<unknown> => {
    if (channel === 'relayLocalProxyState') return structuredClone(state)
    if (channel === 'relayConnections') return structuredClone(connections)
    if (channel === 'relayLogSnapshot')
      return { sequence: 1, lines: [{ sequence: 1, text: 'actual core output' }] }
    return structuredClone(info)
  })
  const observation: RuntimeObservation = {
    state,
    info,
    connections,
    logs: { sequence: 0, lines: [] },
    sampledAt: 1000
  }
  return { state, info, connections, invoke, observation }
}

describe('Runtime snapshots and real sampled rates', () => {
  it('reads real channels between two matching instance checks', async () => {
    const f = fixture(),
      next = await readRuntimeObservation(f.invoke, () => 5000)
    expect(next.sampledAt).toBe(5000)
    expect(runtimeLogLines(next, undefined)).toEqual(['actual core output'])
    expect(next.connections?.connections).toEqual([{ id: 'one' }])
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayLocalProxyState',
      'relayRuntimeInfo',
      'relayConnections',
      'relayLogSnapshot',
      'relayLocalProxyState'
    ])
  })
  it('keeps cleared lines hidden across refreshes for the same process and admits a new owner', () => {
    const f = fixture()
    const before: RuntimeObservation = {
      ...f.observation,
      logs: { sequence: 1, lines: [{ sequence: 1, text: 'repeat' }] }
    }
    const cursor = runtimeLogCursor(before)
    expect(runtimeLogLines(before, cursor)).toEqual([])
    const after: RuntimeObservation = {
      ...before,
      logs: { sequence: 2, lines: [...before.logs.lines, { sequence: 2, text: 'repeat' }] }
    }
    expect(runtimeLogLines(after, cursor)).toEqual(['repeat'])
    expect(runtimeLogLines({ ...after, state: { ...after.state, pid: 999 } }, cursor)).toEqual([
      'repeat',
      'repeat'
    ])
  })
  it.each(['instanceId', 'configurationRevision', 'pid'] as const)(
    'rejects a %s change during a snapshot',
    async (key) => {
      const f = fixture()
      const invoke = async (channel: RuntimeInfoChannel): Promise<unknown> => {
        const result = await f.invoke(channel)
        if (channel === 'relayConnections') {
          if (key === 'pid') f.state.pid = 456
          else f.state[key] = 'changed'
        }
        return result
      }
      await expect(readRuntimeObservation(invoke)).rejects.toThrow('已变化')
    }
  )
  it('fails the observation when a connection read fails rather than retaining old traffic', async () => {
    const f = fixture()
    await expect(
      readRuntimeObservation(async (channel) => {
        if (channel === 'relayConnections') throw new Error('lost')
        return f.invoke(channel)
      })
    ).rejects.toThrow('lost')
  })
  it('computes bytes per elapsed second only for consecutive matching snapshots', () => {
    const f = fixture(),
      previous = structuredClone(f.observation),
      current = structuredClone(previous)
    current.sampledAt += 2000
    if (!current.connections) throw new Error('missing fixture')
    current.connections.download += 2048
    current.connections.upload += 1024
    expect(observedTrafficRate(previous, current)).toEqual({ download: 1024, upload: 512 })
    expect(observedTrafficRate(undefined, current)).toBeUndefined()
    current.state.configurationRevision = 'b'.repeat(64)
    expect(observedTrafficRate(previous, current)).toBeUndefined()
  })
  it('does not show negative rates after counters reset or time moves backwards', () => {
    const f = fixture(),
      current = structuredClone(f.observation)
    expect(observedTrafficRate(f.observation, current)).toBeUndefined()
    current.sampledAt += 1000
    if (!current.connections) throw new Error('missing fixture')
    current.connections.download = 0
    expect(observedTrafficRate(f.observation, current)).toBeUndefined()
  })
  it('measures only unique, continuing connections in two matching owned snapshots', () => {
    const first = fixture(),
      second = fixture()
    const start = '2026-11-08T01:00:00Z'
    const sample = (id: string, upload: number, download: number, startedAt = start) => ({
      id,
      start: startedAt,
      upload,
      download
    })
    first.connections.connections = [
      sample('continues', 100, 10),
      sample('resets', 5, 10),
      sample('reused', 1, 1),
      sample('duplicate', 1, 1),
      sample('duplicate', 2, 2),
      ...Array.from({ length: 195 }, () => sample('', 0, 0)),
      sample('outside', 10, 10)
    ]
    second.connections.connections = [
      sample('continues', 600, 10),
      sample('resets', 4, 15),
      sample('reused', 50, 50, '2026-11-08T01:00:01Z'),
      sample('duplicate', 20, 20),
      sample('new', 10, 10),
      ...Array.from({ length: 195 }, () => sample('', 0, 0)),
      sample('outside', 20, 20)
    ]
    second.observation.sampledAt += 2500
    const rates = observedConnectionRates(first.observation, second.observation)
    expect([...rates]).toEqual([
      ['continues', { uploadRate: 200, downloadRate: 0 }],
      ['resets', { uploadRate: undefined, downloadRate: 2 }]
    ])
    expect(
      displayedConnections(second.connections.connections, '', 'downloadRate', true, rates)
        .slice(0, 2)
        .map(({ id }) => id)
    ).toEqual(['resets', 'continues'])
    expect(observedConnectionRates(undefined, second.observation).size).toBe(0)
    second.state.configurationRevision = 'b'.repeat(64)
    expect(observedConnectionRates(first.observation, second.observation).size).toBe(0)
  })

  it('retains only bounded disappearances from consecutive snapshots of the same owner', () => {
    const first = fixture(),
      second = fixture(),
      third = fixture()
    const sample = (id: string) => ({ id, start: '2026-11-08T01:00:00Z', download: 42 })
    const incoming = Array.from({ length: 200 }, (_, index) => sample(`new-${index}`))
    first.connections.connections = [sample('moved'), sample('closed')]
    second.connections.connections = [...incoming, sample('moved')]
    second.observation.sampledAt = 2000
    third.observation.sampledAt = 3000
    const retained = observedClosedConnections(first.observation, second.observation, [])
    expect(retained.map(({ id }) => id)).toEqual(['closed'])

    third.connections.connections = [sample('closed'), ...second.connections.connections]
    expect(observedClosedConnections(second.observation, third.observation, retained)).toEqual([])

    third.connections.connections = []
    expect(
      observedClosedConnections(second.observation, third.observation, retained).map(({ id }) => id)
    ).toEqual(incoming.map(({ id }) => id))
    third.connections.connections = [sample('')]
    expect(observedClosedConnections(second.observation, third.observation, retained)).toEqual([])

    third.connections.connections = []
    third.state.configurationRevision = 'b'.repeat(64)
    expect(observedClosedConnections(second.observation, third.observation, retained)).toEqual([])
  })
  it('normalizes connection display without rendering arbitrary metadata values', () => {
    expect(
      observedConnection({
        id: 'safe-id',
        metadata: { host: 'example.test', destinationPort: 443, process: 'App' },
        chains: ['A', {}]
      })
    ).toMatchObject({ id: 'safe-id', target: 'example.test:443', process: 'App', route: 'A' })
    expect(observedConnection({ id: 'bad\nkey', metadata: { host: {} } }).id).toBe('')
    expect(formatTraffic(undefined)).toBe('未读取')
    expect(formatTraffic(1024)).toBe('1.0 KiB')
    expect(formatTraffic(0)).toBe('0 B')
  })

  it('filters and sorts only the owner-bound prefix without mutating the original snapshot', () => {
    const values = [
      { id: 'a', metadata: { host: 'A.example' }, upload: 2, start: '2026-11-07T20:00:00Z' },
      { id: 'b', metadata: { process: 'WORKER' }, chains: ['Fixed'], upload: 8 },
      { id: 'c', metadata: { host: 'C.example' }, upload: -1, start: 'invalid' },
      ...Array.from({ length: 197 }, () => ({})),
      { id: 'outside', metadata: { host: 'private.example' }, upload: 100 }
    ]
    const original = structuredClone(values)
    expect(
      displayedConnections(values, ' EXAMPLE ', 'upload', true).map((entry) => entry.id)
    ).toEqual(['a', 'c'])
    expect(displayedConnections(values, 'worker', 'snapshot', true)[0]?.position).toBe(1)
    expect(displayedConnections(values, 'fixed', 'snapshot', true)[0]?.id).toBe('b')
    expect(
      displayedConnections(values, '', 'upload', true)
        .slice(0, 3)
        .map((entry) => entry.id)
    ).toEqual(['b', 'a', 'c'])
    expect(
      displayedConnections(values, '', 'upload', false)
        .slice(0, 3)
        .map((entry) => entry.id)
    ).toEqual(['a', 'b', 'c'])
    expect(displayedConnections(values, 'private', 'upload', true)).toEqual([])
    expect(values).toEqual(original)
  })

  it('uses the actual fixed log prefix for threshold filtering without interpreting message text', () => {
    const prefix = 'time="2026-11-08T03:00:00+08:00"',
      error = `${prefix} level=error msg="Connection failed"`,
      warning = `${prefix} level=warn msg="Connection warning"`,
      info = `${prefix} level=info msg="contains level=error"`,
      unclassified = 'raw stderr with level=error'
    const lines = [error, warning, info, unclassified]
    expect(displayedLogs(lines, ' CONNECTION ', 'warning')).toEqual([error, warning])
    expect(displayedLogs(lines, '', 'error')).toEqual([error])
    expect(displayedLogs(lines, 'LEVEL=ERROR', 'all')).toEqual([error, info, unclassified])
  })
})

describe('Screenshot connection and log presentation', () => {
  it('retains actual source, transport and rule fields and searches them', () => {
    const raw = {
      id: 'row',
      metadata: { host: 'example.test', sourceIP: '127.0.0.1', type: 'Socks5', network: 'tcp' },
      rule: 'DomainSuffix',
      rulePayload: 'example.test'
    }
    expect(observedConnection(raw)).toMatchObject({
      source: '127.0.0.1',
      protocol: 'Socks5 · TCP',
      rule: 'DomainSuffix: example.test'
    })
    expect(displayedConnections([raw], '127.0.0.1', 'snapshot', false)).toHaveLength(1)
    expect(displayedConnections([raw], 'Socks5', 'snapshot', false)).toHaveLength(1)
    expect(observedConnection({}).protocol).toBeUndefined()
  })
  it('parses severity, original time and quoted messages without losing extra fields', () => {
    const message = 'message with "quoted" text and level=error'
    expect(
      observedLog(
        `time="2026-11-09T10:20:30Z" level=warn msg=${JSON.stringify(message)} source=core`
      )
    ).toEqual({ type: 'warning', time: '2026-11-09T10:20:30Z', payload: `${message} source=core` })
  })
  it('keeps malformed or unstructured output raw instead of inventing severity or time', () => {
    expect(observedLog('unstructured level=error output')).toBeUndefined()
    expect(observedLog('time="now" level=info msg="unclosed')).toBeUndefined()
    expect(observedLog('time="now" level=unknown msg="text"')).toBeUndefined()
  })
})
