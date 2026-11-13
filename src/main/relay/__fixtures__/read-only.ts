import type { RelayReadOnlyReport } from '../../../shared/relay/protocol'

// Test-only data, never imported by the production entry or renderer.
export function readOnlyFixture(): RelayReadOnlyReport {
  const ids = [
    'ports',
    'clients',
    'routing',
    'dns-policy',
    'browser-config',
    'egress',
    'dns-exit',
    'webrtc',
    'callback',
    'request',
    'guard'
  ]
  return {
    snapshot: {
      checkedAt: '2026-10-23T08:00:00Z',
      summary: 'fixture configuration only',
      httpReady: true,
      socksReady: true,
      systemProxy: true,
      cliConfigured: true,
      browserIntegrated: false,
      controllerConnected: true,
      edgePolicyCount: 4,
      nodeNames: ['fixture-node'],
      proxyTypes: { 'fixture-node': 'Shadowsocks', group: 'Selector' },
      details: ['fixture observation']
    },
    checks: ids.map((id, index) => ({
      id,
      title: id,
      state: index < 5 ? 'verifiedConfiguration' : 'pending',
      value: 'fixture',
      evidence: 'configuration only',
      nextStep: 'runtime check required'
    })),
    edgePolicies: [
      'DnsOverHttpsMode',
      'NetworkPredictionOptions',
      'ProxySettings',
      'WebRtcLocalhostIpHandling'
    ].map((key) => ({ key, forced: true, matches: true, valid: true })),
    edgePolicyReviewKeys: [],
    timezone: 'Asia/Taipei',
    preferredLanguages: ['en-US'],
    readOnly: true,
    guardEnabled: false,
    warnings: ['Fixture only; runtime evidence remains pending.']
  }
}
