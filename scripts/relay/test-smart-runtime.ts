import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, get as httpGet } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import catalog from '../../src/main/relay/core/variants-manifest.json'
import { VariantStore } from '../../src/main/relay/core/variant-store'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import { checkCompleteConfiguration } from '../../src/main/relay/configuration/checker'
import { isolatedCoreConfiguration } from '../../src/main/relay/core/configuration'
import { SMART_MODEL_CONTROLS } from '../../src/main/relay/profiles/groups'

if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64'))
  throw new Error('This probe requires a supported macOS host.')
const release = catalog.cores.find((core) => core.family === 'smart')
assert.ok(release)
const architecture = process.arch,
  pin = release.assets[architecture],
  model = catalog.models[0]
const home = await realpath(await mkdtemp('/private/tmp/relay-smart-runtime-probe-'))
const checks: string[] = []
let cleanup: (() => Promise<void>) | undefined
let payloadRequests = 0
const fixture = createServer((request, response) => {
  if (request.url === '/payload') {
    payloadRequests++
    response.end('smart-loopback-only')
  } else {
    response.writeHead(204)
    response.end()
  }
})
const listen = (
  server: ReturnType<typeof createServer> | ReturnType<typeof createNetServer>
): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('No fixture port.'))
      else resolve(address.port)
    })
  })
try {
  const targetPort = await listen(fixture),
    portProbe = createNetServer(),
    port = await listen(portProbe)
  await new Promise<void>((resolve, reject) =>
    portProbe.close((error) => (error ? reject(error) : resolve()))
  )
  const archive = await readFile(join('.relay-build/variant-reference', `smart-${pin.asset}`))
  assert.equal(createHash('sha256').update(archive).digest('hex'), pin.archiveSHA256)
  const coreSource = join(home, 'core-source'),
    modelSource = join(home, 'model-source')
  await writeFile(coreSource, gunzipSync(archive, { maxOutputLength: pin.size }), { mode: 0o600 })
  const modelBytes = await readFile(join('.relay-build/variant-reference', `model-${model.asset}`))
  await writeFile(modelSource, modelBytes, { mode: 0o600 })
  const store = new VariantStore({ stateRoot: join(home, 'state') })
  const core = await store.acquire({
    kind: 'core',
    sourcePath: coreSource,
    architecture,
    version: release.version,
    sha256: pin.sha256,
    size: pin.size
  })
  await assert.rejects(store.select({ id: core.id }), /请先导入/u)
  checks.push('Smart selection without a trusted selected model is refused')
  const importedModel = await store.acquire({
    kind: 'smart',
    sourcePath: modelSource,
    version: model.version,
    sha256: model.sha256,
    size: model.size
  })
  await store.select({ id: importedModel.id })
  await store.select({ id: core.id })
  const root = await store.resolveCoreRoot('/default/not-used')
  assert.equal((await verifyCoreResource(root)).version, release.version)
  checks.push('selected model and core are copied into a verified private snapshot')
  await writeFile(join(root, 'Model.bin'), Buffer.from('tampered'), { mode: 0o600 })
  await assert.rejects(store.resolveCoreRoot('/default/not-used'))
  await writeFile(join(root, 'Model.bin'), modelBytes, { mode: 0o600 })
  checks.push('model snapshot tampering blocks resolution without falling back')
  const completeSource = JSON.stringify({
    ...isolatedCoreConfiguration(),
    ...SMART_MODEL_CONTROLS,
    'geox-url': {},
    'proxy-groups': [
      {
        name: 'SmartCompleteProbe',
        type: 'smart',
        proxies: ['REJECT'],
        url: `http://127.0.0.1:${targetPort}/health`,
        uselightgbm: true
      }
    ]
  })
  const checked = await checkCompleteConfiguration(root, completeSource, [])
  assert.equal(checked.status, 'passed')
  assert.equal(checked.coreVersion, release.version)
  checks.push(
    'complete configuration parser stages the trusted model before the real Smart -t process'
  )
  const source = JSON.stringify({
    proxies: [],
    'proxy-groups': [
      {
        name: 'SmartProbe',
        type: 'smart',
        proxies: ['REJECT', 'DIRECT'],
        url: `http://127.0.0.1:${targetPort}/health`,
        interval: 3600,
        uselightgbm: true,
        collectdata: false,
        'prefer-asn': false
      }
    ],
    rules: ['MATCH,SmartProbe']
  })
  const runtime = await startLocalProxyCore(root, source, port, (stop) => {
    cleanup = stop
  })
  assert.equal(runtime.version, release.version)
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(runtime.directory, 'Model.bin')))
      .digest('hex'),
    model.sha256
  )
  const runtimeConfig = JSON.parse(await readFile(join(runtime.directory, 'config.yaml'), 'utf8'))
  assert.equal(runtimeConfig['lgbm-auto-update'], false)
  assert.equal(runtimeConfig['lgbm-url'], 'http://127.0.0.1:1/relay-model-download-disabled')
  checks.push('owned Smart child starts with exact model bytes and fixed no-download controls')
  const group = await runtime.group('SmartProbe')
  assert.equal(group.type, 'Smart')
  assert.equal(group.useLightGBM, true)
  assert.deepEqual(group.all, ['REJECT', 'DIRECT'])
  await runtime.select('SmartProbe', 'REJECT')
  assert.equal((await runtime.group('SmartProbe')).now, 'REJECT')
  const throughProxy = (): Promise<{ status?: number; body: string }> =>
    new Promise((resolve, reject) => {
      const request = httpGet(
        {
          hostname: '127.0.0.1',
          port,
          path: `http://127.0.0.1:${targetPort}/payload`,
          headers: { Host: `127.0.0.1:${targetPort}` },
          timeout: 3000
        },
        (response) => {
          let body = ''
          response.on('data', (chunk) => {
            body += chunk.toString()
          })
          response.on('end', () => resolve({ status: response.statusCode, body }))
        }
      )
      request.once('error', reject)
      request.once('timeout', () => request.destroy(new Error('Fixture timeout.')))
    })
  const rejected = await throughProxy().catch(() => ({ status: 0, body: '' }))
  assert.notEqual(rejected.status, 200)
  assert.equal(payloadRequests, 0)
  await runtime.select('SmartProbe', 'DIRECT')
  assert.equal((await runtime.group('SmartProbe')).now, 'DIRECT')
  assert.deepEqual(await throughProxy(), { status: 200, body: 'smart-loopback-only' })
  assert.equal(payloadRequests, 1)
  checks.push(
    'real Smart group selection enforces REJECT and routes only the explicit loopback fixture after DIRECT selection'
  )
  await runtime.automatic?.('SmartProbe')
  assert.equal((await runtime.group('SmartProbe')).fixed, '')
  checks.push('real Smart group supports clearing the manual selection back to automatic')
  await runtime.stop()
  cleanup = undefined
  await store.restore('core')
  assert.equal(await store.resolveCoreRoot('/default/not-used'), '/default/not-used')
  checks.push('only this newly owned child is stopped and the fixed default selection is restored')
} finally {
  await cleanup?.()
  if (fixture.listening) await new Promise<void>((resolve) => fixture.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
}
const result = {
  verifiedAt: new Date().toISOString(),
  scope: 'private-owned-smart-child-and-loopback-only-fixture',
  architecture,
  core: release.version,
  model: model.version,
  checks,
  passed: checks.length,
  externalProxyOrClientAccepted: false,
  currentClashTouched: false,
  systemNetworkChanged: false,
  productAcceptance: 'pending'
}
await writeFile(
  '../evidence/smart-runtime-verification.json',
  JSON.stringify(result, null, 2) + '\n'
)
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
