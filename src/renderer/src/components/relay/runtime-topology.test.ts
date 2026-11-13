import { describe, expect, it } from 'vitest'
import { runtimeTopologyConnections } from './runtime-topology'
import { observedConnectionLimit } from './runtime-info'

describe('Observed runtime topology', () => {
  it('adapts actual connection fields and excludes malformed byte counters', () => {
    const connection = {
      metadata: { sourceIP: '127.0.0.1', sourcePort: 1234, token: 'excluded' },
      upload: 32,
      download: 64,
      chains: ['Node', 'PROXY'],
      rule: 'DomainSuffix',
      rulePayload: 'example.com'
    }
    const rows = runtimeTopologyConnections([
      null,
      {},
      { ...connection, upload: -1 },
      { ...connection, download: NaN },
      connection
    ])
    expect(rows).toEqual([
      {
        metadata: { sourceIP: '127.0.0.1', sourcePort: 1234 },
        upload: 32,
        download: 64,
        chains: ['Node', 'PROXY'],
        rule: 'DomainSuffix',
        rulePayload: 'example.com'
      }
    ])
  })
  it('bounds rendering and labels missing route information without inventing DIRECT', () => {
    const row = { metadata: {}, upload: 0, download: 0 }
    const rows = runtimeTopologyConnections(
      Array.from({ length: observedConnectionLimit + 10 }, () => row)
    )
    expect(rows).toHaveLength(observedConnectionLimit)
    expect(rows[0].chains).toEqual(['未知出站'])
    expect(rows[0].rule).toBe('未知规则')
  })
})
