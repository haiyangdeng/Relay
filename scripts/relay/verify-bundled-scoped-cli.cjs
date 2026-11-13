const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync
} = require('fs')
const { createHash } = require('crypto')
const { dirname, join } = require('path')
const { isDeepStrictEqual } = require('util')

const fail = () => {
  throw new Error('Bundled scoped CLI resource pairing is not approved.')
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const sameFile = (left, right) =>
  ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(
    (key) => left[key] === right[key]
  )
function plain(path, limit) {
  let cursor = path
  while (true) {
    if (lstatSync(cursor).isSymbolicLink()) fail()
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const linked = lstatSync(path)
  if (
    !linked.isFile() ||
    linked.nlink !== 1 ||
    linked.mode & 0o022 ||
    linked.size < 1 ||
    linked.size > limit
  )
    fail()
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const before = fstatSync(descriptor)
    if (!sameFile(linked, before)) fail()
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (!count) fail()
      offset += count
    }
    if (!sameFile(before, fstatSync(descriptor)) || !sameFile(before, lstatSync(path))) fail()
    return bytes
  } finally {
    closeSync(descriptor)
  }
}
function definition(value) {
  if (
    !exact(value, ['schemaVersion', 'runtimeReady', 'assets']) ||
    value.schemaVersion !== 1 ||
    typeof value.runtimeReady !== 'boolean' ||
    !exact(value.assets, ['arm64', 'x64'])
  )
    fail()
  for (const arch of ['arm64', 'x64']) {
    const pin = value.assets[arch]
    if (!value.runtimeReady) {
      if (pin !== null) fail()
      continue
    }
    if (
      !exact(pin, ['nodeVersion', 'nodeSHA256', 'cliSHA256']) ||
      typeof pin.nodeVersion !== 'string' ||
      !/^24\.(?:[5-9]|[1-9][0-9]+)\.[0-9]+$/u.test(pin.nodeVersion) ||
      [pin.nodeSHA256, pin.cliSHA256].some(
        (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)
      )
    )
      fail()
  }
  return value
}
// Called after the last signing pass. This function never invokes a bundled
// executable, crypto factory, CLI, system manager or network operation.
function verifyBundledScopedCLI(app, sourceDefinition) {
  const expected = definition(JSON.parse(plain(sourceDefinition, 8192).toString('utf8')))
  const root = join(app, 'Contents/Resources/relay/guard-cli')
  let directory
  try {
    directory = lstatSync(root)
  } catch (error) {
    if (error.code === 'ENOENT' && !expected.runtimeReady) return { available: false }
    throw error
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail()
  const manifestBytes = plain(join(root, 'manifest.json'), 8192),
    manifest = definition(JSON.parse(manifestBytes.toString('utf8')))
  if (!isDeepStrictEqual(expected, manifest)) fail()
  if (!manifest.runtimeReady) {
    if (readdirSync(root).some((name) => name !== 'manifest.json')) fail()
    return { available: false }
  }
  if (
    readdirSync(root).some(
      (name) => !['manifest.json', 'resource-report.json', 'arm64', 'x64'].includes(name)
    )
  )
    fail()
  for (const [arch, cpu] of [
    ['arm64', 0x100000c],
    ['x64', 0x1000007]
  ]) {
    const directory = join(root, arch),
      pin = manifest.assets[arch]
    if (
      readdirSync(directory).sort().join(',') !==
      ['node', 'cli.js', 'ORIGIN.json', 'NODE-LICENSE.txt', 'CLI-LICENSE.txt'].sort().join(',')
    )
      fail()
    const node = plain(join(directory, 'node'), 128 * 1024 * 1024),
      cli = plain(join(directory, 'cli.js'), 128 * 1024 * 1024)
    if (
      node.length < 32 ||
      node.readUInt32LE(0) !== 0xfeedfacf ||
      node.readUInt32LE(4) !== cpu ||
      node.readUInt32LE(12) !== 2 ||
      !(lstatSync(join(directory, 'node')).mode & 0o100) ||
      sha(node) !== pin.nodeSHA256 ||
      sha(cli) !== pin.cliSHA256
    )
      fail()
    const origin = JSON.parse(plain(join(directory, 'ORIGIN.json'), 8192).toString('utf8'))
    if (
      !exact(origin, ['nodeURL', 'cliURL', 'cliVersion', 'distributionApproved']) ||
      origin.distributionApproved !== true ||
      typeof origin.cliVersion !== 'string' ||
      !origin.cliVersion ||
      [origin.nodeURL, origin.cliURL].some(
        (url) => typeof url !== 'string' || !url.startsWith('https://') || url.includes('\0')
      )
    )
      fail()
    plain(join(directory, 'NODE-LICENSE.txt'), 1024 * 1024)
    plain(join(directory, 'CLI-LICENSE.txt'), 1024 * 1024)
  }
  if (!plain(join(root, 'manifest.json'), 8192).equals(manifestBytes)) fail()
  return { available: true }
}
// Development release authority deliberately admits only absent resources or
// the exact disabled definition. Raw launchers and test fixtures stay private.
function verifyBundledTerminalCLI(app, sourceDefinition) {
  const approved = {
    schemaVersion: 1,
    contractRevision: 'relay-guard-terminal-v1',
    applicationID: 'local.relay.network.preview',
    buildVersion: '3',
    minimumMacOS: '13.0',
    launcherName: 'RelayTerminalCLI',
    launcherID: 'local.relay.network.preview.guard.terminal-cli',
    publisherTeamID: null,
    runtimeReady: false,
    launcherPin: null
  }
  const sourceBytes = plain(sourceDefinition, 8192)
  if (!sourceBytes.equals(Buffer.from(JSON.stringify(approved, null, 2) + '\n')))
    throw new Error('The Terminal CLI release definition must remain disabled.')
  const root = join(app, 'Contents/Resources/relay/guard-terminal')
  let directory
  try {
    directory = lstatSync(root)
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false }
    throw error
  }
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.mode & 0o022 ||
    readdirSync(root).join(',') !== 'manifest.json' ||
    !plain(join(root, 'manifest.json'), 8192).equals(sourceBytes)
  )
    throw new Error('Bundled Terminal CLI resources are outside the disabled release definition.')
  return { available: false }
}
module.exports = { exact, plain, sameFile, sha, verifyBundledScopedCLI, verifyBundledTerminalCLI }
