// Development-only builder. Never writes shipping Core locations or pins.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const extension = join(app, 'core-extensions/mihomo-geodata-v1')
const [source, sdk, cache, output] = process.argv.slice(2)
const options = process.argv.slice(6),
  architectures = options.filter((value) => value.startsWith('--arch='))
assert(
  options.every(
    (value) =>
      value === '--verify-only' ||
      value === '--provider-serialization' ||
      value === '--arch=arm64' ||
      value === '--arch=amd64'
  )
)
assert(
  architectures.length <= 1 &&
    options.filter((value) => value === '--verify-only').length <= 1 &&
    options.filter((value) => value === '--provider-serialization').length <= 1
)
const architecture = architectures.length ? architectures[0].slice(7) : 'arm64'
const providerSerialization = options.includes('--provider-serialization')

for (const path of [source, sdk, cache, output]) assert(path && isAbsolute(path))
assert(source.endsWith('/mihomo-3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8'))
assert(
  output.startsWith('/private/tmp/relay-geodata-integration-') && dirname(output) === '/private/tmp'
)
assert(!relative(app, output).startsWith('extra/'))
const hash = (b) => createHash('sha256').update(b).digest('hex')
const baseManifestBytes = await readFile(join(extension, 'manifest.json'))
assert.equal(
  hash(baseManifestBytes),
  '37a2d8bffa9de94997f14c29654d60746d4724b6f03b34369a2eb8566f5da398'
)
const baseManifest = JSON.parse(baseManifestBytes)
const pins = {
  'go.mod': '444c571a66165f4cc86143314e6791d06528513b7b0f546e656155310c172964',
  'go.sum': '05418c19815978fa837f17749909a66a6834c4087ceb7d13901f29a9ee11dbce'
}
for (const [name, sha] of Object.entries(pins))
  assert.equal(hash(await readFile(join(source, name))), sha)
const sourceManifestBytes = await readFile(join(extension, 'upstream-source-files.json'))
assert.equal(hash(sourceManifestBytes), baseManifest.upstream.sourceInventorySHA256)
const sourceManifest = JSON.parse(sourceManifestBytes)
const sourceEntries = sourceManifest.files ?? sourceManifest
for (const [name, pin] of Object.entries(sourceEntries))
  assert.equal(hash(await readFile(join(source, name))), typeof pin === 'string' ? pin : pin.sha256)
const actualSourceFiles = []
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await inventory(path)
    else {
      assert(entry.isFile(), 'fixed source cannot contain links/special files')
      actualSourceFiles.push(relative(source, path))
    }
  }
}
await inventory(source)
assert.deepEqual(
  actualSourceFiles.sort(),
  Object.keys(sourceEntries).sort(),
  'unknown/missing fixed source file'
)
let supplement
if (providerSerialization) {
  const root = join(app, 'core-extensions/mihomo-provider-file-v1'),
    manifestBytes = await readFile(join(root, 'manifest.json')),
    manifest = JSON.parse(manifestBytes),
    target = 'component/resource/fetcher.go',
    pin = manifest.overlays?.[target]
  assert.equal(
    hash(manifestBytes),
    '853ef5ffc7c59f05a7f3d7ecb5454c54e0fbd05931c7d16ab2f8fab5d6b5390d'
  )
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.name, 'mihomo-provider-file-v1')
  assert.equal(manifest.source?.commit, '3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8')
  assert.equal(manifest.requires?.extension, '../mihomo-geodata-v1')
  assert.equal(
    manifest.requires.manifestSHA256,
    hash(await readFile(join(extension, 'manifest.json')))
  )
  assert.equal(manifest.coreVersion, 'relay-geodata-v1p1-3f27')
  assert.deepEqual(Object.keys(manifest.overlays), [target])
  assert.equal(pin.path, 'overlay/' + target)
  assert.equal(pin.originalSHA256, hash(await readFile(join(source, target))))
  assert.equal(pin.sha256, hash(await readFile(join(root, pin.path))))
  assert.equal(manifest.patch?.path, 'patches/0001-serialize-local-file-updates.patch')
  assert.equal(manifest.patch.sha256, hash(await readFile(join(root, manifest.patch.path))))
  supplement = { root, manifest, manifestSHA256: hash(manifestBytes), target, pin }
}
const replace = {},
  overlayHashes = {},
  overlaySources = {}
async function overlays(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name),
      info = await lstat(path)
    assert(!info.isSymbolicLink())
    if (info.isDirectory()) await overlays(path)
    else {
      assert(info.isFile())
      const target = relative(join(extension, 'overlay'), path),
        pin = baseManifest.overlays[target]
      assert(pin && Object.hasOwn(baseManifest.overlays, target), 'unknown base overlay')
      assert.equal(hash(await readFile(path)), pin.sha256, 'base overlay changed')
      if (pin.upstreamSHA256 !== null)
        assert.equal(hash(await readFile(join(source, target))), pin.upstreamSHA256)
      replace[join(source, target)] = path
      overlayHashes[target] = pin.sha256
      overlaySources[target] = path
    }
  }
}
await overlays(join(extension, 'overlay'))
assert.deepEqual(Object.keys(overlayHashes).sort(), Object.keys(baseManifest.overlays).sort())
if (supplement) {
  const { target, root, pin } = supplement
  assert(!Object.hasOwn(overlayHashes, target))
  replace[join(source, target)] = join(root, pin.path)
  overlayHashes[target] = pin.sha256
  overlaySources[target] = join(root, pin.path)
}
const version = supplement?.manifest.coreVersion ?? 'relay-geodata-v1-3f27'
if (process.argv.includes('--verify-only')) {
  console.log(
    JSON.stringify({
      status: 'source-verified-only',
      originalSourceFilesVerified: actualSourceFiles.length,
      overlayFilesVerified: Object.keys(overlayHashes).length,
      modulePins: pins,
      source,
      ...(supplement ? { providerSupplementSHA256: supplement.manifestSHA256, version } : {}),
      compiled: false
    })
  )
  process.exit(0)
}
await mkdir(output, { mode: 0o700 })
const overlay = join(output, 'overlay.json')
await writeFile(overlay, JSON.stringify({ Replace: replace }, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600
})
const binary = join(output, `mihomo-relay-geodata-${supplement ? 'v1p1' : 'v1'}-${architecture}`)
const env = {
  ...process.env,
  GOENV: 'off',
  GOROOT: sdk,
  GOTOOLCHAIN: 'local',
  GOTELEMETRY: 'off',
  GOPATH: join(cache, 'gopath'),
  GOCACHE: join(cache, 'gocache'),
  GOMODCACHE: join(cache, 'gomodcache'),
  GOPROXY: 'off',
  GOSUMDB: 'sum.golang.org',
  GOPRIVATE: '',
  GONOPROXY: '',
  GONOSUMDB: '',
  GOVCS: '*:off',
  GOAUTH: 'off',
  GOFLAGS: '-mod=readonly',
  CGO_ENABLED: '0',
  GOOS: 'darwin',
  GOARCH: architecture,
  GOARM64: 'v8.0',
  GOAMD64: 'v1',
  GOEXPERIMENT: '',
  GOMAXPROCS: '2'
}
delete env.HOME
const command = [
  join(sdk, 'bin/go'),
  'build',
  '-mod=readonly',
  '-p=2',
  '-buildvcs=false',
  '-overlay',
  overlay,
  '-tags',
  'relay_local_geodata',
  '-ldflags',
  `-X github.com/metacubex/mihomo/constant.Version=${version}`,
  '-o',
  binary,
  '.'
]
let stdout = '',
  stderr = '',
  timedOut = false,
  spawnError
const child = spawn(command[0], command.slice(1), {
  cwd: source,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', (b) => {
  stdout += b
})
child.stderr.on('data', (b) => {
  stderr += b
})
child.once('error', (e) => {
  spawnError = e
})
const timer = setTimeout(() => {
  timedOut = true
  child.kill('SIGTERM')
}, 180000)
const exitCode = await new Promise((resolve) => child.once('close', resolve))
clearTimeout(timer)
assert.equal(hash(await readFile(join(extension, 'manifest.json'))), hash(baseManifestBytes))
assert.equal(
  hash(await readFile(join(extension, 'upstream-source-files.json'))),
  hash(sourceManifestBytes)
)
for (const [name, sha] of Object.entries(pins))
  assert.equal(hash(await readFile(join(source, name))), sha)
for (const [name, sha] of Object.entries(overlayHashes))
  assert.equal(
    hash(await readFile(overlaySources[name])),
    sha,
    'overlay changed during compilation'
  )
if (supplement) {
  assert.equal(
    hash(await readFile(join(supplement.root, 'manifest.json'))),
    supplement.manifestSHA256
  )
  assert.equal(
    hash(await readFile(join(supplement.root, supplement.manifest.patch.path))),
    supplement.manifest.patch.sha256
  )
}
for (const [name, pin] of Object.entries(sourceEntries))
  assert.equal(
    hash(await readFile(join(source, name))),
    typeof pin === 'string' ? pin : pin.sha256,
    'fixed source changed during compilation'
  )
await writeFile(join(output, 'build.stdout'), stdout, { flag: 'wx', mode: 0o600 })
await writeFile(join(output, 'build.stderr'), stderr, { flag: 'wx', mode: 0o600 })
const result = {
  architecture,
  command,
  source,
  overlayHashes,
  modulePins: pins,
  GOPROXY: env.GOPROXY,
  SDK: sdk,
  originalSourceFilesVerified: Object.keys(sourceEntries).length,
  timedOut,
  exitCode,
  spawnError: spawnError && String(spawnError),
  binarySHA256: exitCode === 0 ? hash(await readFile(binary)) : null,
  ...(supplement
    ? {
        version,
        providerSupplementSHA256: supplement.manifestSHA256,
        providerPatchSHA256: supplement.manifest.patch.sha256
      }
    : {}),
  shippingOrPinsWritten: false
}
await writeFile(join(output, 'build-result.json'), JSON.stringify(result, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600
})
console.log(JSON.stringify(result))
if (exitCode !== 0 || timedOut || spawnError) process.exitCode = 1
