import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import catalog from '../../src/main/relay/core/variants-manifest.json'
import { VariantStore } from '../../src/main/relay/core/variant-store'
import { isolatedCoreConfiguration } from '../../src/main/relay/core/configuration'
import { SMART_MODEL_CONTROLS } from '../../src/main/relay/profiles/groups'
import { compileProfileRuntime } from '../../src/main/relay/profiles/runtime'
import { bindRuntimeResources } from '../../src/main/relay/configuration/bindings'
import { checkCompleteConfiguration } from '../../src/main/relay/configuration/checker'
import { ResourceStore } from '../../src/main/relay/resources/store'
import { resourceHash } from '../../src/main/relay/resources/source'
import fixtureManifest from './fixtures/assets/manifest.json'

// The production checker runs its ASN probe and complete parser as separate
// deny-network workers. Do not wrap this script in another sandbox-exec profile:
// macOS rejects applying a nested profile. No listener or TUN is created here.
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
  throw new Error('This probe requires a supported macOS host.')
const architecture = process.arch as 'arm64' | 'x64'
const release = catalog.cores.find((item) => item.family === 'smart')
assert.ok(release)
const pin = release.assets[architecture],
  model = catalog.models[0],
  asnPin = fixtureManifest.files.find((item) => item.path.endsWith('GeoLite2-ASN-Test.mmdb'))
assert.ok(asnPin)
const home = await realpath(await mkdtemp('/private/tmp/relay-smart-asn-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
  checks: string[] = []
try {
  const archive = await readFile(join('.relay-build/variant-reference', `smart-${pin.asset}`)),
    modelBytes = await readFile(join('.relay-build/variant-reference', `model-${model.asset}`))
  assert.equal(resourceHash(archive), pin.archiveSHA256)
  assert.equal(resourceHash(modelBytes), model.sha256)
  const coreSource = join(home, 'core-source'),
    modelSource = join(home, 'model-source')
  await writeFile(coreSource, gunzipSync(archive, { maxOutputLength: pin.size }), { mode: 0o600 })
  await writeFile(modelSource, modelBytes, { mode: 0o600 })
  const variants = new VariantStore(context)
  const core = await variants.acquire({
    kind: 'core',
    sourcePath: coreSource,
    architecture,
    version: release.version,
    sha256: pin.sha256,
    size: pin.size
  })
  const importedModel = await variants.acquire({
    kind: 'smart',
    sourcePath: modelSource,
    version: model.version,
    sha256: model.sha256,
    size: model.size
  })
  await variants.select({ id: importedModel.id })
  await variants.select({ id: core.id })
  const root = await variants.resolveCoreRoot('/default/not-used'),
    resources = new ResourceStore({ ...context, home }),
    bytes = await readFile(asnPin.path)
  assert.equal(bytes.length, asnPin.size)
  assert.equal(resourceHash(bytes), asnPin.sha256)
  const saved = await resources.save(
    {
      name: 'Official artificial ASN fixture',
      kind: 'asn-mmdb',
      behavior: null,
      selector: '13335'
    },
    bytes
  )
  const source = JSON.stringify({
    ...isolatedCoreConfiguration(),
    ...SMART_MODEL_CONTROLS,
    'proxy-groups': [
      {
        name: 'SmartASNProbe',
        type: 'smart',
        proxies: ['REJECT'],
        url: 'http://127.0.0.1:1/health',
        uselightgbm: true,
        collectdata: false,
        'prefer-asn': true
      }
    ]
  })
  assert.equal(compileProfileRuntime(source).configuration, undefined)
  checks.push('the HTTP projection still refuses Smart ASN without a bound asset workflow')
  const adapters = {
    resources,
    providers: {
      read: async () => {
        throw new Error('unexpected provider read')
      }
    }
  }
  const missing = await bindRuntimeResources(source, [], adapters)
  assert.equal(missing.unresolved.length, 1)
  assert.equal(missing.unresolved[0].kind, 'asn-mmdb')
  await assert.rejects(checkCompleteConfiguration(root, JSON.stringify(missing.configuration), []))
  checks.push('missing ASN remains unresolved and is refused before executing the parser')
  const bound = await bindRuntimeResources(
    source,
    [{ dependencyId: missing.unresolved[0].id, selection: { id: saved.id, sha256: saved.sha256 } }],
    adapters
  )
  assert.equal(bound.unresolved.length, 0)
  assert.equal(bound.assets.length, 1)
  assert.equal(bound.assets[0].path, 'ASN.mmdb')
  await bound.recheck()
  const checked = await checkCompleteConfiguration(
    root,
    JSON.stringify(bound.configuration),
    bound.assets
  )
  assert.equal(checked.status, 'passed')
  assert.equal(checked.coreVersion, release.version)
  checks.push(
    'the fixed Smart parser accepts prefer-asn with the exact private ASN asset and trusted model'
  )
  const invalidBytes = Buffer.from('not an ASN database')
  const invalid = await checkCompleteConfiguration(root, JSON.stringify(bound.configuration), [
    { path: 'ASN.mmdb', bytes: invalidBytes, sha256: resourceHash(invalidBytes) }
  ])
  assert.equal(invalid.status, 'rejected')
  checks.push(
    'a digest-correct but invalid ASN database is rejected rather than accepted after a warning'
  )
  assert.equal(
    resourceHash((await resources.read({ id: saved.id, sha256: saved.sha256 })).bytes),
    asnPin.sha256
  )
  bound.assets[0].bytes[0] ^= 1
  await assert.rejects(bound.recheck())
  await assert.rejects(
    checkCompleteConfiguration(root, JSON.stringify(bound.configuration), bound.assets)
  )
  checks.push('asset mutation is refused by both bundle recheck and parser admission')
  process.stdout.write(
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        scope: 'private-smart-asn-probe-and-complete-parser-with-production-deny-network-workers',
        architecture,
        core: release.version,
        asnFixtureSHA256: asnPin.sha256,
        checks,
        passed: checks.length,
        runtimeAccepted: false,
        asnRoutingAccepted: false,
        systemNetworkChanged: false,
        currentClashTouched: false,
        productAcceptance: 'pending'
      },
      null,
      2
    ) + '\n'
  )
} finally {
  await rm(home, { recursive: true, force: true })
}
