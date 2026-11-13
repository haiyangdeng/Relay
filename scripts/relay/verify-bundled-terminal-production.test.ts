import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { verifyTerminalGuardBundle } = createRequire(import.meta.url)(
  './verify-bundled-terminal-production.cjs'
)

const terminalPath = 'native/guard/terminal/package/manifest.json'
const cliPath = 'native/guard/package/cli-manifest.json'
const releasePath = 'native/RelayGuardRelease.swift'
const appID = 'local.relay.network.preview'
const team = 'FIXTURE123'
const arm64 = 0x0100000c
const x64 = 0x01000007
const bytes = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')

function thin(cpu: number, kind: number) {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf)
  header.writeUInt32LE(cpu, 4)
  header.writeUInt32LE(kind, 12)
  return header
}

function universal(second = x64) {
  const header = Buffer.alloc(48)
  header.writeUInt32BE(0xcafebabe)
  header.writeUInt32BE(2, 4)
  for (const [index, cpu] of [arm64, second].entries()) {
    const start = 8 + 20 * index
    header.writeUInt32BE(cpu, start)
    header.writeUInt32BE(header.length + 32 * index, start + 8)
    header.writeUInt32BE(32, start + 12)
  }
  return Buffer.concat([header, thin(arm64, 2), thin(second, 2)])
}

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-terminal-gate-fixture-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function fixture(ready = true) {
  const project = join(root, 'source')
  const app = join(root, 'Relay.app')
  const resources = join(app, 'Contents/Resources/relay')
  const stage = join(project, 'extra/relay')
  const write = (path: string, value: string | Buffer, mode = 0o600) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, value, { mode })
  }
  const stageHost = (arch: 'arm64' | 'x86_64', addonCPU: number) => {
    const location = 'guard-host/' + arch
    const addon = thin(addonCPU, 8)
    const swift = thin(arch === 'arm64' ? arm64 : x64, 6)
    const manifest = bytes({
      version: 1,
      architecture: arch,
      buildVersion: '3',
      files: { 'RelayGuard.node': hash(addon), 'libRelayGuardHost.dylib': hash(swift) }
    })
    for (const base of [stage, resources]) {
      write(join(base, location, 'manifest.json'), manifest)
      write(join(base, location, 'RelayGuard.node'), addon)
      write(join(base, location, 'libRelayGuardHost.dylib'), swift)
    }
  }
  const disabled = JSON.parse(readFileSync(terminalPath, 'utf8'))
  const launcher = join(resources, 'guard-terminal/RelayTerminalCLI')
  const terminal = (binary: Buffer) => ({
    ...disabled,
    runtimeReady: true,
    publisherTeamID: team,
    launcherPin: { size: binary.length, sha256: hash(binary) }
  })
  const stageLauncher = (binary: Buffer) => {
    const definition = bytes(terminal(binary))
    write(join(project, terminalPath), definition)
    write(join(resources, 'guard-terminal/manifest.json'), definition)
    write(launcher, binary, 0o700)
  }
  const inspect = vi.fn<(request: { team: string; targets: object[] }) => void>()
  const verify = (arch = 'arm64') => verifyTerminalGuardBundle(app, project, arch, inspect)
  if (!ready) {
    write(join(project, terminalPath), readFileSync(terminalPath))
    write(join(project, cliPath), readFileSync(cliPath))
    return { verify, inspect, app, project, resources, launcher, stageHost, stageLauncher, write }
  }

  stageLauncher(universal())
  write(join(app, 'Contents/MacOS/Relay'), thin(arm64, 2), 0o700)
  write(join(app, 'Contents/Info.plist'), 'signed Info is checked by the signature inspector')
  write(
    join(project, releasePath),
    `enum RelayGuardManagementRelease {
    static let buildVersion = "3"
    static let publisherTeamID: String? = "${team}"
    static let scopedCLILaunchSupported = true
    static let terminalCLILaunchSupported = true
    static let systemInstallationSupported = false
    static let runtimeProtectionReady = false
    static let completeClientScopeReady = false
}
`
  )
  const assets = Object.fromEntries(
    Object.entries({ arm64, x64 }).map(([arch, cpu]) => {
      const node = thin(cpu, 2),
        cli = Buffer.from('synthetic CLI text fixture')
      const origin = bytes({
        nodeURL: 'https://fixture.invalid/node',
        cliURL: 'https://fixture.invalid/cli',
        cliVersion: '2.0.0',
        distributionApproved: true
      })
      write(join(resources, 'guard-cli', arch, 'node'), node, 0o700)
      write(join(resources, 'guard-cli', arch, 'cli.js'), cli)
      for (const base of [stage, resources]) {
        write(join(base, 'guard-cli', arch, 'ORIGIN.json'), origin)
        write(join(base, 'guard-cli', arch, 'NODE-LICENSE.txt'), 'fixture Node license')
        write(join(base, 'guard-cli', arch, 'CLI-LICENSE.txt'), 'fixture CLI license')
      }
      return [arch, { nodeVersion: '24.17.0', nodeSHA256: hash(node), cliSHA256: hash(cli) }]
    })
  )
  const scoped = bytes({ schemaVersion: 1, runtimeReady: true, assets })
  write(join(project, cliPath), scoped)
  write(join(resources, 'guard-cli/manifest.json'), scoped)
  stageHost('arm64', arm64)
  stageHost('x86_64', x64)
  for (const base of [stage, resources]) write(join(base, 'RelayNative'), universal(), 0o700)
  return { verify, inspect, app, project, resources, launcher, stageHost, stageLauncher, write }
}

describe('Terminal final package static release verification', () => {
  it('leaves the disabled branch offline and rejects a bundled development launcher', () => {
    const f = fixture(false)
    expect(f.verify()).toEqual({ available: false })
    f.write(join(f.resources, 'guard-terminal/manifest.json'), readFileSync(terminalPath))
    expect(f.verify()).toEqual({ available: false })
    f.write(f.launcher, universal(), 0o700)
    expect(() => f.verify()).toThrow('outside the disabled release definition')
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it.each([
    'Contents/Resources/relay/guard-host/arm64/RelayGuard.node',
    'Contents/Library/SystemExtensions/local.relay.network.preview.guard.systemextension/Contents/Info.plist'
  ])('refuses unverified native Guard resources in the disabled package: %s', (path) => {
    const f = fixture(false)
    f.write(join(f.app, path), 'unverified native component')
    expect(() => f.verify()).toThrow('native Guard resources are outside the disabled release')
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it('requires the fixed Developer ID inputs for both native host architectures and the universal launcher', () => {
    const f = fixture()
    expect(f.verify()).toMatchObject({ available: true, architecture: 'arm64', team, build: '3' })
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith({
      team,
      targets: [
        {
          path: f.launcher,
          identifier: appID + '.guard.terminal-cli',
          architectures: ['arm64', 'x86_64']
        },
        ...['arm64', 'x86_64'].flatMap((arch) => [
          {
            path: join(f.resources, 'guard-host', arch, 'RelayGuard.node'),
            identifier: appID + '.guard-host.node',
            architectures: [arch]
          },
          {
            path: join(f.resources, 'guard-host', arch, 'libRelayGuardHost.dylib'),
            identifier: appID + '.guard-host.swift',
            architectures: [arch]
          }
        ]),
        {
          path: join(f.resources, 'RelayNative'),
          identifier: 'RelayNative',
          architectures: ['arm64', 'x86_64']
        },
        { path: f.app, identifier: appID, architectures: ['arm64'], appBuild: '3' }
      ]
    })
    f.write(join(f.app, 'Contents/MacOS/Relay'), thin(x64, 2))
    expect(f.verify('x64')).toMatchObject({ available: true, architecture: 'x64' })
    expect(() => f.verify('arm64')).toThrow('packager target')
  })

  it('rejects the wrong compiled publisher and fails on the signature inspector refusal', () => {
    const f = fixture()
    const release = join(f.project, releasePath)
    f.write(release, readFileSync(release, 'utf8').replace(team, 'WRONGTEAM1'))
    expect(() => f.verify()).toThrow('source release authority')
    expect(f.inspect).not.toHaveBeenCalled()
    f.write(release, readFileSync(release, 'utf8').replace('WRONGTEAM1', team))
    f.inspect.mockImplementationOnce(() => {
      throw new Error('Developer ID verification failed')
    })
    expect(() => f.verify()).toThrow('Developer ID verification failed')
  })

  it('rejects changed launcher bytes and malformed architecture even when those bytes are pinned', () => {
    const f = fixture()
    f.write(f.launcher, thin(arm64, 2))
    expect(() => f.verify()).toThrow('approved bytes')
    f.stageLauncher(universal(arm64))
    expect(() => f.verify()).toThrow('invalid universal slice')
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it('rejects changes to scoped CLI provenance and to the host pair', () => {
    const f = fixture()
    const license = join(f.resources, 'guard-cli/x64/CLI-LICENSE.txt')
    f.write(license, 'wrong fixture license')
    expect(() => f.verify()).toThrow('provenance or license changed')
    f.write(license, 'fixture CLI license')
    f.write(join(f.resources, 'guard-host/x86_64/libRelayGuardHost.dylib'), thin(arm64, 6))
    expect(() => f.verify()).toThrow('approved bytes')
    f.stageHost('x86_64', arm64)
    expect(() => f.verify()).toThrow('unexpected thin architecture')
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it('refuses unverified ES and NE inputs and rejects a change during signing readback', () => {
    const f = fixture()
    const extensions = join(f.app, 'Contents/Library/SystemExtensions')
    mkdirSync(extensions, { recursive: true })
    expect(() => f.verify()).toThrow('ES/NE require their own release verification')
    rmSync(extensions, { recursive: true })
    f.inspect.mockImplementationOnce(() => f.write(f.launcher, thin(arm64, 2)))
    expect(() => f.verify()).toThrow('release inputs changed')
  })
})
