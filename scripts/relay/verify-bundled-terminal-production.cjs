const { spawnSync } = require('node:child_process')
const { lstatSync, mkdtempSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  exact,
  plain,
  sameFile,
  sha,
  verifyBundledScopedCLI,
  verifyBundledTerminalCLI
} = require('./verify-bundled-scoped-cli.cjs')

const appID = 'local.relay.network.preview'
const launcherID = appID + '.guard.terminal-cli'
const maxCodeBytes = 128 * 1024 * 1024
const cpus = { arm64: 0x0100000c, x64: 0x01000007 }
const nativeArch = (arch) => (arch === 'x64' ? 'x86_64' : arch)

function requirePairing(ok, reason) {
  if (!ok) throw new Error('Terminal release pairing refused: ' + reason)
}

function canonical(bytes) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  requirePairing(
    bytes.equals(Buffer.from(JSON.stringify(value, null, 2) + '\n')),
    'noncanonical manifest'
  )
  return value
}

function directory(path, names) {
  const info = lstatSync(path)
  requirePairing(info.isDirectory() && !(info.mode & 0o022), 'unsafe resource directory')
  const entries = readdirSync(path)
  requirePairing(
    entries.length === names.length && names.every((name) => entries.includes(name)),
    'unexpected resource directory contents'
  )
}

function verifyMachO(bytes, expectedCPUs, kind) {
  const thin = (offset) => {
    requirePairing(
      bytes.length - offset >= 32 &&
        bytes.readUInt32LE(offset) === 0xfeedfacf &&
        bytes.readUInt32LE(offset + 12) === kind,
      'unexpected Mach-O type'
    )
    return bytes.readUInt32LE(offset + 4)
  }
  if (expectedCPUs.length === 1) {
    requirePairing(thin(0) === expectedCPUs[0], 'unexpected thin architecture')
    return
  }
  requirePairing(bytes.length >= 8, 'truncated universal header')
  const magic = bytes.readUInt32BE(0),
    count = bytes.readUInt32BE(4)
  requirePairing(
    [0xcafebabe, 0xcafebabf].includes(magic) && count === expectedCPUs.length,
    'unexpected universal architecture count'
  )
  const fat64 = magic === 0xcafebabf,
    stride = fat64 ? 32 : 20,
    tableEnd = 8 + count * stride
  requirePairing(bytes.length >= tableEnd, 'truncated universal architecture table')
  const slices = []
  for (let index = 0; index < count; index++) {
    const row = 8 + index * stride,
      cpu = bytes.readUInt32BE(row)
    const offset = fat64 ? Number(bytes.readBigUInt64BE(row + 8)) : bytes.readUInt32BE(row + 8)
    const size = fat64 ? Number(bytes.readBigUInt64BE(row + 16)) : bytes.readUInt32BE(row + 12)
    requirePairing(
      Number.isSafeInteger(offset) &&
        Number.isSafeInteger(size) &&
        offset >= tableEnd &&
        size >= 32 &&
        size <= bytes.length - offset &&
        expectedCPUs.includes(cpu) &&
        thin(offset) === cpu &&
        slices.every(
          (slice) => slice.cpu !== cpu && (offset + size <= slice.offset || offset >= slice.end)
        ),
      'invalid universal slice'
    )
    slices.push({ cpu, offset, end: offset + size })
  }
}

function verifySignatures(request) {
  const scratch = mkdtempSync(join(tmpdir(), 'relay-release-signature-'))
  try {
    const result = spawnSync(
      '/usr/bin/xcrun',
      [
        '--sdk',
        'macosx',
        'swift',
        '-module-cache-path',
        scratch,
        join(__dirname, 'verify-guard-signatures.swift')
      ],
      {
        input: JSON.stringify(request),
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 65536,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: scratch }
      }
    )
    requirePairing(
      result.status === 0,
      result.stderr?.trim() || 'offline Developer ID inspection failed'
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function verifyTerminalGuardBundle(
  app,
  projectDir,
  expectedArchitecture,
  inspect = verifySignatures
) {
  const terminalSource = join(projectDir, 'native/guard/terminal/package/manifest.json')
  const scopedSource = join(projectDir, 'native/guard/package/cli-manifest.json')
  const systemExtensions = join(app, 'Contents/Library/SystemExtensions')
  if (JSON.parse(plain(terminalSource, 8192).toString('utf8'))?.runtimeReady !== true) {
    const scoped = verifyBundledScopedCLI(app, scopedSource)
    requirePairing(
      !lstatSync(systemExtensions, { throwIfNoEntry: false }) &&
        (scoped.available ||
          !lstatSync(join(app, 'Contents/Resources/relay/guard-host'), { throwIfNoEntry: false })),
      'native Guard resources are outside the disabled release definition'
    )
    return verifyBundledTerminalCLI(app, terminalSource)
  }

  const stamps = new Map()
  const track = (path) => {
    stamps.set(path, lstatSync(path))
  }
  const read = (path, limit) => {
    track(path)
    return plain(path, limit)
  }
  const terminalBytes = read(terminalSource, 8192),
    terminal = canonical(terminalBytes)
  const { publisherTeamID: team, buildVersion: build, launcherPin: pin } = terminal
  requirePairing(
    exact(terminal, [
      'schemaVersion',
      'contractRevision',
      'applicationID',
      'buildVersion',
      'minimumMacOS',
      'launcherName',
      'launcherID',
      'publisherTeamID',
      'runtimeReady',
      'launcherPin'
    ]) &&
      terminal.schemaVersion === 1 &&
      terminal.contractRevision === 'relay-guard-terminal-v1' &&
      terminal.applicationID === appID &&
      terminal.minimumMacOS === '13.0' &&
      terminal.launcherName === 'RelayTerminalCLI' &&
      terminal.launcherID === launcherID &&
      terminal.runtimeReady === true &&
      typeof build === 'string' &&
      /^[1-9][0-9]{0,8}$/u.test(build) &&
      typeof team === 'string' &&
      /^[A-Z0-9]{10}$/u.test(team) &&
      exact(pin, ['size', 'sha256']) &&
      Number.isSafeInteger(pin.size) &&
      pin.size > 0 &&
      pin.size <= maxCodeBytes &&
      typeof pin.sha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(pin.sha256),
    'invalid published Terminal definition'
  )

  const swift = read(join(projectDir, 'native/RelayGuardRelease.swift'), 8192).toString('utf8')
  const scope = /^enum RelayGuardManagementRelease \{\n([\s\S]*?)^\}$/mu.exec(swift)?.[1]
  const declarations = scope?.split('\n').map((line) => line.trim()) ?? []
  for (const [key, expected] of Object.entries({
    buildVersion: `buildVersion = "${build}"`,
    publisherTeamID: `publisherTeamID: String? = "${team}"`,
    scopedCLILaunchSupported: 'scopedCLILaunchSupported = true',
    terminalCLILaunchSupported: 'terminalCLILaunchSupported = true',
    systemInstallationSupported: 'systemInstallationSupported = false',
    runtimeProtectionReady: 'runtimeProtectionReady = false',
    completeClientScopeReady: 'completeClientScopeReady = false'
  })) {
    const matching = declarations.filter((line) =>
      new RegExp('^static let ' + key + '\\b', 'u').test(line)
    )
    requirePairing(
      !scope?.includes('/*') && matching.length === 1 && matching[0] === 'static let ' + expected,
      'source release authority differs from published inputs'
    )
  }

  const resource = join(app, 'Contents/Resources/relay'),
    stage = join(projectDir, 'extra/relay')
  const terminalDir = join(resource, 'guard-terminal'),
    launcher = join(terminalDir, 'RelayTerminalCLI')
  const appBinary = join(app, 'Contents/MacOS/Relay')
  const targets = []
  const checkCode = (path, identifier, architectures, kind, sha256, size) => {
    const bytes = read(path, maxCodeBytes)
    requirePairing(
      (!sha256 || sha(bytes) === sha256) &&
        (size === undefined || bytes.length === size) &&
        (kind !== 2 || (stamps.get(path).mode & 0o100) !== 0),
      'signed code differs from the approved bytes'
    )
    verifyMachO(bytes, architectures, kind)
    targets.push({
      path,
      identifier,
      architectures: architectures.map((cpu) => (cpu === cpus.arm64 ? 'arm64' : 'x86_64'))
    })
  }

  track(app)
  track(terminalDir)
  // This verifier is for the isolated Terminal release, not a system extension
  // deployment. A future ES/NE publisher lane must verify its own component pair.
  requirePairing(
    !lstatSync(systemExtensions, { throwIfNoEntry: false }),
    'ES/NE require their own release verification'
  )
  directory(terminalDir, ['manifest.json', 'RelayTerminalCLI'])
  requirePairing(
    read(join(terminalDir, 'manifest.json'), 8192).equals(terminalBytes),
    'Terminal definition changed'
  )
  checkCode(launcher, launcherID, Object.values(cpus), 2, pin.sha256, pin.size)
  const appBytes = read(appBinary, maxCodeBytes)
  requirePairing(appBytes.length >= 32, 'missing App Mach-O header')
  const architecture = Object.keys(cpus).find((arch) => cpus[arch] === appBytes.readUInt32LE(4))
  requirePairing(
    architecture && (expectedArchitecture === undefined || expectedArchitecture === architecture),
    'App architecture differs from the packager target'
  )
  verifyMachO(appBytes, [cpus[architecture]], 2)

  const scopedBytes = read(scopedSource, 8192)
  requirePairing(
    read(join(resource, 'guard-cli/manifest.json'), 8192).equals(scopedBytes),
    'scoped CLI definition changed'
  )
  canonical(scopedBytes)
  for (const arch of Object.keys(cpus)) {
    const relative = 'guard-cli/' + arch
    track(join(resource, relative))
    for (const name of ['node', 'cli.js']) track(join(resource, relative, name))
    for (const name of ['ORIGIN.json', 'NODE-LICENSE.txt', 'CLI-LICENSE.txt']) {
      requirePairing(
        read(join(resource, relative, name), 1024 * 1024).equals(
          read(join(stage, relative, name), 1024 * 1024)
        ),
        'scoped CLI provenance or license changed'
      )
    }
  }
  requirePairing(
    verifyBundledScopedCLI(app, scopedSource).available,
    'scoped CLI resources are not ready'
  )

  const hostNames = {
    'RelayGuard.node': { kind: 8, suffix: 'node' },
    'libRelayGuardHost.dylib': { kind: 6, suffix: 'swift' }
  }
  for (const [arch, cpu] of Object.entries(cpus)) {
    const helperArch = nativeArch(arch)
    const relative = 'guard-host/' + helperArch,
      host = join(resource, relative)
    track(host)
    directory(host, ['manifest.json', ...Object.keys(hostNames)])
    const stagedManifest = read(join(stage, relative, 'manifest.json'), 8192)
    requirePairing(
      read(join(host, 'manifest.json'), 8192).equals(stagedManifest),
      'Guard host manifest changed'
    )
    const manifest = canonical(stagedManifest)
    requirePairing(
      exact(manifest, ['version', 'architecture', 'buildVersion', 'files']) &&
        manifest.version === 1 &&
        manifest.architecture === helperArch &&
        manifest.buildVersion === build &&
        exact(manifest.files, Object.keys(hostNames)),
      'Guard host architecture or build pairing changed'
    )
    for (const [name, role] of Object.entries(hostNames)) {
      const hash = manifest.files[name]
      requirePairing(
        typeof hash === 'string' &&
          /^[a-f0-9]{64}$/u.test(hash) &&
          sha(read(join(stage, relative, name), maxCodeBytes)) === hash,
        'Guard host signed input is missing or changed'
      )
      checkCode(join(host, name), appID + '.guard-host.' + role.suffix, [cpu], role.kind, hash)
    }
  }
  const native = read(join(stage, 'RelayNative'), maxCodeBytes)
  checkCode(
    join(resource, 'RelayNative'),
    'RelayNative',
    Object.values(cpus),
    2,
    sha(native),
    native.length
  )
  track(join(app, 'Contents/Info.plist'))
  targets.push({
    path: app,
    identifier: appID,
    architectures: [nativeArch(architecture)],
    appBuild: build
  })
  inspect({ team, targets })
  requirePairing(
    !lstatSync(systemExtensions, { throwIfNoEntry: false }) &&
      [...stamps].every(([path, before]) => sameFile(before, lstatSync(path))),
    'release inputs changed during signature inspection'
  )
  return { available: true, architecture, team, build, offlineDeveloperIDVerified: true }
}

module.exports = { verifyTerminalGuardBundle }
