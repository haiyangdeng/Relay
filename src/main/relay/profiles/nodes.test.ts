import { describe, expect, it } from 'vitest'
import { protocolFixtures } from '../../../../scripts/relay/fixtures/node-protocols'
import { inspectNode, nodeDependencies, projectNode, supportedNodeTypes } from './nodes'
import { compileProfileRuntime } from './runtime'

describe('Pinned node schemas, transports and file dependency boundary', () => {
  it('preserves the TUIC udp flag accepted and ignored by the fixed upstream parser', () => {
    const node = { name: 'TUIC', type: 'tuic', server: '127.0.0.1', port: 443, udp: true }
    expect(inspectNode(node).supported).toBe(true)
    expect(projectNode(node)).toEqual(node)
    expect(inspectNode({ ...node, udp: 'invalid' }).supported).toBe(false)
    expect(inspectNode({ ...node, executable: '/PRIVATE' }).supported).toBe(false)
  })
  it('covers all 28 fixed parser types and keeps credentials out of the catalogue', () => {
    const fixtures = protocolFixtures(
      '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----'
    )
    expect([...supportedNodeTypes].sort()).toEqual(fixtures.map((n) => n.type).sort())
    const source = JSON.stringify({ proxies: fixtures, rules: ['MATCH,REJECT'] })
    const built = compileProfileRuntime(source)
    expect(built.issues).toEqual([])
    expect(JSON.stringify(built.catalogue)).not.toContain('password')
    expect(JSON.parse(built.configuration ?? '{}').proxies).toHaveLength(28)
  })
  it('matches fixed underscore/case aliases but rejects ambiguous duplicates and unknown fields', () => {
    const node = {
      name: 'N',
      type: 'vless',
      SERVER: '127.0.0.1',
      PORT: 443,
      UUID: 'fixture',
      SKIP_CERT_VERIFY: true,
      WS_OPTS: { HEADERS: { Host: 'fixture.invalid' }, PATH: '/ws' }
    }
    expect(inspectNode(node)).toEqual({ supported: true, requiresResources: false })
    expect(projectNode(node)).toMatchObject({
      server: '127.0.0.1',
      port: 443,
      uuid: 'fixture',
      'skip-cert-verify': true,
      'ws-opts': { headers: { Host: 'fixture.invalid' }, path: '/ws' }
    })
    expect(inspectNode({ ...node, server: 'ambiguous' }).supported).toBe(false)
    expect(inspectNode({ ...node, 'ws-opts': { command: '/PRIVATE' } }).supported).toBe(false)
    expect(inspectNode({ name: 'S', type: 'ss', plugin: 'external-command' }).supported).toBe(false)
  })
  it('recognizes aliased file dependencies before any core can read a path', () => {
    for (const [type, field] of [
      ['ssh', 'PRIVATE_KEY'],
      ['vless', 'Certificate'],
      ['zerotier', 'Planet'],
      ['tailscale', 'STATE_DIR']
    ]) {
      const node = { name: 'N', type, [field]: '/PRIVATE/never-read' }
      expect(inspectNode(node)).toEqual({ supported: true, requiresResources: true })
      expect(nodeDependencies(node).join(',')).not.toContain('PRIVATE')
      expect(
        compileProfileRuntime(JSON.stringify({ proxies: [node] })).configuration
      ).toBeUndefined()
    }
  })
  it('bounds stateful paths by name hash and preserves the original input and idempotent compilation', () => {
    for (const type of ['tailscale', 'zerotier', 'easytier']) {
      const node = { name: '../../PRIVATE', type }
      const projected = projectNode(node)
      expect(projected['state-dir']).toMatch(/^relay-node-state\/[a-f0-9]{64}$/u)
      expect(projected['state-dir']).not.toContain('PRIVATE')
      expect(node).not.toHaveProperty('state-dir')
      expect(projectNode(projected)).toEqual(projected)
      expect(inspectNode(projected).requiresResources).toBe(false)
    }
  })
  it('validates nested transport shape, integer bounds, opaque plugin schemas and byte arrays', () => {
    const node = { name: 'N', type: 'wireguard', reserved: [0, 1, 255] }
    expect(inspectNode(node).supported).toBe(true)
    expect(inspectNode({ ...node, reserved: [256] }).supported).toBe(false)
    expect(inspectNode({ ...node, reserved: 'AAH/' }).supported).toBe(true)
    expect(inspectNode({ ...node, reserved: 'PRIVATE?' }).supported).toBe(false)
    expect(
      inspectNode({ name: 'N', type: 'zerotier', 'remote-trace-level': '18446744073709551615' })
        .supported
    ).toBe(true)
    expect(
      inspectNode({ name: 'N', type: 'zerotier', 'remote-trace-level': '18446744073709551616' })
        .supported
    ).toBe(false)
    expect(
      nodeDependencies({ name: 'N', type: 'http', headers: { 'private-key': 'ordinary header' } })
    ).toEqual([])
    expect(
      nodeDependencies({ name: 'N', type: 'ssh', 'private-key': '/PRIVATE KEY/never-read' })
    ).toEqual(['private-key'])
    expect(inspectNode({ name: 'N', type: 'vmess', network: 'unknown-transport' }).supported).toBe(
      false
    )
    expect(
      inspectNode({ name: 'N', type: 'vless', 'ws-opts': { headers: { Host: { bad: true } } } })
        .supported
    ).toBe(false)
    expect(
      inspectNode({
        name: 'N',
        type: 'ss',
        plugin: 'v2ray-plugin',
        'plugin-opts': { mode: 'websocket', tls: true, 'ech-opts': { enable: false } }
      }).supported
    ).toBe(true)
    expect(
      inspectNode({
        name: 'N',
        type: 'ss',
        plugin: 'v2ray-plugin',
        'plugin-opts': { executable: '/PRIVATE' }
      }).supported
    ).toBe(false)
  })
})
