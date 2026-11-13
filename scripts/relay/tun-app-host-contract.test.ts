import { describe, expect, it } from 'vitest'
import coreManifest from '../../src/main/relay/core/manifest.json'
import {
  archive,
  abortedCheckpoint,
  baseline,
  candidate,
  clientPath,
  expectedPaths,
  fencePath,
  helperPath,
  hostArguments,
  installRoot,
  intentPath,
  lockPath,
  parentPaths,
  plistPath,
  receiptID,
  recoveryPath,
  scratchPrefix,
  service,
  terminalCheckpoint
} from './tun-app-host-contract'
const hash = 'a'.repeat(64),
  uid = 501,
  project = '/private/work/Relay',
  id = '11111111-1111-4111-8111-111111111111'
function metadata() {
  return {
    role: 'network-executor-v1',
    manifestVersion: 2,
    packageVersion: '0.30.1',
    clientUID: uid,
    service,
    receiptID,
    installedOrMachAuthenticated: false,
    actualSystemConfigurationChanged: false,
    executorAvailable: true,
    runAtLoad: false,
    keepAlive: false,
    protectionVerified: false,
    manifestPath: installRoot + '/installation.json',
    launchDaemonPath: plistPath,
    transientUninstallIntentPath: intentPath,
    knownRetainedAuditNamespace: recoveryPath,
    manifestSHA256: hash,
    packageSHA256: hash,
    launchDaemonSHA256: hash,
    packagePath:
      project +
      '/app/.relay-build/tun-network-candidate-20261027T031501Z-5063beeb/RelayTun-NetworkExecutor-v1.pkg',
    installedPaths: [...expectedPaths],
    temporaryPrefixes: [scratchPrefix],
    dynamicRuntimePaths: [
      installRoot + '/NetworkJournal',
      installRoot + '/DeviceJournal',
      lockPath,
      fencePath
    ],
    binaryPins: {
      helper: { path: helperPath, sha256: hash },
      client: { path: clientPath, sha256: hash },
      uninstaller: { path: helperPath + '.uninstall', sha256: hash }
    },
    corePins: {
      arm64: {
        path: installRoot + '/Core/' + coreManifest.assets.arm64.path,
        sha256: coreManifest.assets.arm64.sha256
      },
      x86_64: {
        path: installRoot + '/Core/' + coreManifest.assets.x64.path,
        sha256: coreManifest.assets.x64.sha256
      }
    },
    sharedParentMetadata: Object.fromEntries(
      parentPaths.map((path) => [path, { uid: 0, gid: 0, mode: '755' }])
    )
  }
}
const empty = () => archive({ exists: false, revision: hash, plans: [], files: [] })
const terminal = () =>
  archive({
    exists: true,
    revision: hash,
    plans: [
      {
        planID: id,
        sessionID: id,
        clientUID: uid,
        installationRevision: hash,
        phase: 'restored',
        acquisition: 'acquired'
      }
    ],
    files: [{ path: id + '/retirement.json', sha256: hash, bytes: 123 }]
  })
describe('read-only network-executor App host acceptance contracts', () => {
  it('selects a new candidate only explicitly and keeps every original evidence prefix unchanged', () => {
    for (const mode of [
      '--preflight-only',
      '--verify-installed',
      '--verify-restored',
      '--verify-aborted-before-uninstall',
      '--verify-aborted-restored'
    ]) {
      expect(hostArguments([mode])).toEqual({
        mode,
        routeBaselineCandidate: false,
        metadataName: 'tun-helper-transport-candidate.json',
        evidencePrefix: 'tun-app-host'
      })
      const selected = {
        mode,
        routeBaselineCandidate: true,
        metadataName: 'tun-helper-route-baseline-candidate-v2.json',
        evidencePrefix: 'tun-app-route-baseline-host'
      }
      expect(hostArguments([mode, '--route-baseline-candidate'])).toEqual(selected)
      expect(hostArguments(['--route-baseline-candidate', mode])).toEqual(selected)
      expect(hostArguments(['--native-fixes-candidate', mode])).toEqual({
        mode,
        routeBaselineCandidate: false,
        metadataName: 'tun-helper-native-fixes-candidate-20261028.json',
        evidencePrefix: 'tun-app-native-fixes-host-20261028'
      })
      expect(hostArguments(['--declared-device-candidate', mode])).toEqual({
        mode,
        routeBaselineCandidate: false,
        metadataName: 'tun-helper-declared-device-candidate-20261028.json',
        evidencePrefix: 'tun-app-declared-device-host-20261028'
      })
      expect(hostArguments(['--core-stage-candidate', mode])).toEqual({
        mode,
        routeBaselineCandidate: false,
        metadataName: 'tun-helper-core-stage-candidate-20261028.json',
        evidencePrefix: 'tun-app-core-stage-host-20261028'
      })
      expect(hostArguments(['--peer-eof-candidate', mode])).toEqual({
        mode,
        routeBaselineCandidate: false,
        metadataName: 'tun-helper-peer-eof-candidate-20261028.json',
        evidencePrefix: 'tun-app-peer-eof-host-20261028'
      })
      const kernelRoute = {
        mode,
        routeBaselineCandidate: false,
        metadataName: 'tun-helper-kernel-route-candidate-20261028.json',
        evidencePrefix: 'tun-app-kernel-route-host-20261028'
      }
      expect(hostArguments(['--kernel-route-candidate', mode])).toEqual(kernelRoute)
      expect(hostArguments([mode, '--kernel-route-candidate'])).toEqual(kernelRoute)
      const retiredClose = {
        mode,
        routeBaselineCandidate: false,
        metadataName: 'tun-helper-retired-close-candidate-20261029.json',
        evidencePrefix: 'tun-app-retired-close-host-20261029'
      }
      expect(hostArguments(['--retired-close-candidate', mode])).toEqual(retiredClose)
      expect(hostArguments([mode, '--retired-close-candidate'])).toEqual(retiredClose)
      const dnsProof = {
        mode,
        routeBaselineCandidate: false,
        metadataName: 'tun-helper-dns-proof-candidate-20261029.json',
        evidencePrefix: 'tun-dns-proof'
      }
      expect(hostArguments(['--dns-proof-candidate', mode])).toEqual(dnsProof)
      expect(hostArguments([mode, '--dns-proof-candidate'])).toEqual(dnsProof)
      for (const other of [
        '--native-fixes-candidate',
        '--route-baseline-candidate',
        '--declared-device-candidate',
        '--core-stage-candidate',
        '--peer-eof-candidate',
        '--kernel-route-candidate',
        '--retired-close-candidate',
        '--dns-proof-candidate'
      ])
        expect(() => hostArguments(['--dns-proof-candidate', other, mode])).toThrow()
      for (const other of [
        '--native-fixes-candidate',
        '--route-baseline-candidate',
        '--declared-device-candidate',
        '--core-stage-candidate',
        '--peer-eof-candidate',
        '--kernel-route-candidate',
        '--retired-close-candidate'
      ])
        expect(() => hostArguments(['--retired-close-candidate', other, mode])).toThrow()
      for (const other of [
        '--native-fixes-candidate',
        '--route-baseline-candidate',
        '--declared-device-candidate',
        '--core-stage-candidate',
        '--peer-eof-candidate',
        '--kernel-route-candidate'
      ])
        expect(() => hostArguments(['--kernel-route-candidate', other, mode])).toThrow()
      for (const other of [
        '--native-fixes-candidate',
        '--route-baseline-candidate',
        '--declared-device-candidate',
        '--core-stage-candidate',
        '--peer-eof-candidate'
      ])
        expect(() => hostArguments(['--peer-eof-candidate', other, mode])).toThrow()
      for (const other of [
        '--native-fixes-candidate',
        '--route-baseline-candidate',
        '--declared-device-candidate',
        '--core-stage-candidate'
      ])
        expect(() => hostArguments(['--core-stage-candidate', other, mode])).toThrow()
      for (const other of [
        '--native-fixes-candidate',
        '--route-baseline-candidate',
        '--declared-device-candidate'
      ])
        expect(() => hostArguments(['--declared-device-candidate', other, mode])).toThrow()
      expect(() =>
        hostArguments(['--native-fixes-candidate', '--route-baseline-candidate', mode])
      ).toThrow()
      expect(() =>
        hostArguments(['--native-fixes-candidate', '--native-fixes-candidate', mode])
      ).toThrow()
    }
    for (const args of [
      [],
      ['--route-baseline-candidate'],
      ['--kernel-route-candidate'],
      ['--kernel-route-candidate', '--unknown-mode'],
      ['--retired-close-candidate'],
      ['--retired-close-candidate', '--unknown-mode'],
      ['--dns-proof-candidate'],
      ['--dns-proof-candidate', '--unknown-mode'],
      ['--preflight-only', '--other'],
      ['--preflight-only', '--preflight-only'],
      ['--preflight-only', '--route-baseline-candidate', '--route-baseline-candidate'],
      ['--verify-restored', '--candidate', '/tmp/metadata.json']
    ])
      expect(() => hostArguments(args)).toThrow('no other arguments')
  })
  it('accepts an unchanged aborted inventory without fabricating a successful TUN terminal', () => {
    expect(() => abortedCheckpoint(empty(), empty())).not.toThrow()
    expect(() =>
      terminalCheckpoint(empty(), empty(), candidate(metadata(), project, uid))
    ).toThrow()
    expect(() => abortedCheckpoint(empty(), terminal())).toThrow('original audit inventory')
    const prior = terminal()
    expect(() => abortedCheckpoint(prior, structuredClone(prior))).not.toThrow()
    expect(() =>
      abortedCheckpoint(prior, { ...prior, files: [{ ...prior.files[0], sha256: 'b'.repeat(64) }] })
    ).toThrow()
    expect(() =>
      abortedCheckpoint(prior, { ...prior, plans: [{ ...prior.plans[0], clientUID: uid + 1 }] })
    ).toThrow()
  })
  it('accepts only current UID, role, package and fixed pinned namespaces', () => {
    expect(candidate(metadata(), project, uid).role).toBe('network-executor-v1')
    for (const patch of [
      { role: 'authentication-only' },
      { clientUID: 0 },
      { packageVersion: '0.30.0' },
      { knownRetainedAuditNamespace: '/tmp/recovery' },
      {
        packagePath:
          project +
          '/app/.relay-build/tun-network-candidate-20261027T031501Z-5063beeb/../../outside.pkg'
      },
      {
        packagePath:
          project +
          '/app/.relay-build/tun-transport-candidate-20261027T031501Z-5063beeb/RelayTun-NetworkExecutor-v1.pkg'
      },
      {
        packagePath:
          project + '/app/.relay-build/tun-network-candidate-20261027T031501Z-5063beeb/Other.pkg'
      },
      {
        packagePath:
          project + '/app/.relay-build/tun-network-candidate-test/RelayTun-NetworkExecutor-v1.pkg'
      },
      { receiptID: service + '.feasibility' },
      { installedPaths: [...expectedPaths, '/tmp/extra'] },
      { executorAvailable: false }
    ])
      expect(() => candidate({ ...metadata(), ...patch }, project, uid)).toThrow()
  })
  it('does not accept absent or unreadable evidence as an empty terminal inventory', () => {
    expect(empty().exists).toBe(false)
    for (const raw of [
      undefined,
      {},
      { exists: true, plans: [], files: [] },
      { ...terminal(), exists: false },
      { ...terminal(), plans: [{ ...terminal().plans[0], phase: 'active' }] }
    ])
      expect(() => archive(raw)).toThrow()
  })
  it('requires a current candidate acquired terminal checkpoint before removal', () => {
    const c = candidate(metadata(), project, uid)
    expect(() => terminalCheckpoint(empty(), terminal(), c)).not.toThrow()
    expect(() => terminalCheckpoint(empty(), empty(), c)).toThrow()
    for (const patch of [
      { clientUID: uid + 1 },
      { installationRevision: 'b'.repeat(64) },
      { phase: 'closed_external_change' },
      { phase: 'unacquired', acquisition: 'none' }
    ])
      expect(() =>
        terminalCheckpoint(
          empty(),
          { ...terminal(), plans: [{ ...terminal().plans[0], ...patch }] },
          c
        )
      ).toThrow()
    const before = terminal(),
      after = { ...terminal(), files: [{ ...terminal().files[0], sha256: 'b'.repeat(64) }] }
    expect(() => terminalCheckpoint(before, after, c)).toThrow('history changed')
  })
  it('rejects authentication-only/stale baseline and incomplete transport evidence', () => {
    const raw = {
      version: 1,
      role: 'network-executor-v1-app-host',
      candidateSHA256: hash,
      clientUID: uid,
      archive: empty(),
      observation: {
        protection: { revision: hash, entries: [] },
        runtime: { effectiveProxyRevision: hash, effectiveDnsRevision: hash },
        topology: { interfacesSHA256: hash, routesSHA256: hash },
        transport: [
          { endpoint: 'anthropic-api', status: 200, tlsResponse: true },
          { endpoint: 'claude-web', status: 403, tlsResponse: true }
        ]
      }
    }
    expect(baseline(raw, hash, uid).clientUID).toBe(uid)
    expect(() => baseline({ ...raw, role: 'authentication-only' }, hash, uid)).toThrow()
    expect(() => baseline(raw, 'b'.repeat(64), uid)).toThrow()
    expect(() =>
      baseline({ ...raw, observation: { ...raw.observation, transport: [] } }, hash, uid)
    ).toThrow()
  })
})
