import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  [source, sdk, cache] = process.argv.slice(2)
assert(
  source.endsWith('/mihomo-3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8') &&
    sdk.startsWith('/private/tmp/') &&
    cache.startsWith('/private/tmp/')
)
const { geositeFixture } = await import(
  pathToFileURL(join(app, 'scripts/relay/fixtures/rule-resources.ts')).href
)
const root = await mkdtemp('/private/tmp/relay-geodata-integration-units-'),
  extension = join(app, 'core-extensions/mihomo-geodata-v1'),
  replace = {}
async function collect(dir) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, name.name)
    if (name.isDirectory()) await collect(path)
    else replace[join(source, relative(join(extension, 'overlay'), path))] = path
  }
}
await collect(join(extension, 'overlay'))
for (const [file, target] of [
  ['relay_mmdb_generation_test.go', 'component/mmdb'],
  ['relay_local_geo_test.go', 'component/updater'],
  ['relay_geo_route_test.go', ''],
  ['relay_init_test.go', 'component/geodata']
])
  replace[join(source, target, file)] = join(extension, 'tests', file)
await writeFile(join(root, 'main_test_stub.go'), 'package main\n', { flag: 'wx', mode: 0o600 })
replace[join(source, 'main.go')] = join(root, 'main_test_stub.go')
await writeFile(join(root, 'GeoSite.dat'), geositeFixture(), { flag: 'wx', mode: 0o600 })
await writeFile(join(root, 'overlay.json'), JSON.stringify({ Replace: replace }, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600
})
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
  GOMAXPROCS: '2',
  CGO_ENABLED: '1',
  GOOS: 'darwin',
  GOARCH: 'arm64',
  GOARM64: 'v8.0',
  GOEXPERIMENT: '',
  RELAY_GEO_FIXTURES: join(app, 'scripts/relay/fixtures/assets'),
  RELAY_GEO_DAT_FIXTURE: join(root, 'GeoSite.dat')
}
delete env.HOME
const results = []
for (const mode of ['1', '0']) {
  env.RELAY_LOCAL_GEODATA_V1 = mode
  const command = [
    '/usr/bin/sandbox-exec',
    '-p',
    '(version 1) (allow default) (deny network*)',
    join(sdk, 'bin/go'),
    'test',
    '-race',
    '-mod=readonly',
    '-p=2',
    '-overlay',
    join(root, 'overlay.json'),
    '-tags',
    'relay_local_geodata',
    '-count=1',
    '-v',
    '-run',
    mode === '1'
      ? 'TestCountryImmutableGeneration|TestASNConcurrentGeneration|TestASNMissingIPInfoRecordDoesNotPanic|TestControlledUpdaterEntrypoints|TestControlledInitialization|TestLocalGeo'
      : 'TestNonControlledKeepsUpstream|TestControlledUpdaterEntrypoints',
    './component/mmdb',
    './component/updater',
    './component/geodata',
    '.'
  ]
  let stdout = '',
    stderr = '',
    spawnError,
    timedOut = false
  const child = spawn(command[0], command.slice(1), {
    cwd: source,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (b) => (stdout += b))
  child.stderr.on('data', (b) => (stderr += b))
  child.once('error', (e) => (spawnError = String(e)))
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, 180000)
  const exitCode = await new Promise((resolve) => child.once('close', resolve))
  clearTimeout(timer)
  await writeFile(join(root, `stdout-${mode}.log`), stdout, { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, `stderr-${mode}.log`), stderr, { flag: 'wx', mode: 0o600 })
  results.push({ mode, command, exitCode, timedOut, spawnError })
  if (exitCode !== 0 || timedOut || spawnError) process.exitCode = 1
}
const result = {
  root,
  status: results.every((x) => x.exitCode === 0 && !x.timedOut && !x.spawnError)
    ? 'passed'
    : 'failed',
  networkPolicy: 'deny network* for compile/test children; GOPROXYoff/original locks',
  results
}
await writeFile(join(root, 'results.json'), JSON.stringify(result, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600
})
console.log(JSON.stringify(result))
