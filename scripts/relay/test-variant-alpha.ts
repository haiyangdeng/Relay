import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import catalog from '../../src/main/relay/core/variants-manifest.json'
import { VariantStore } from '../../src/main/relay/core/variant-store'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { coreEnvironment } from '../../src/main/relay/core/configuration'
import { startIsolatedCore } from '../../src/main/relay/core/isolated-runtime'

if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64'))
  throw new Error('This probe requires a supported macOS host.')
const architecture = process.arch,
  release = catalog.cores.find((core) => core.family === 'alpha')
assert.ok(release, 'A trusted Alpha release must be present.')
const pin = release.assets[architecture]
const archive = await readFile(join('.relay-build/variant-reference', `alpha-${pin.asset}`))
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
assert.equal(archive.length, pin.archiveBytes)
assert.equal(sha(archive), pin.archiveSHA256)
const bytes = gunzipSync(archive, { maxOutputLength: pin.size })
assert.equal(bytes.length, pin.size)
assert.equal(sha(bytes), pin.sha256)
const home = await realpath(await mkdtemp('/private/tmp/relay-alpha-probe-'))
const checks: string[] = []
let versionOutput = ''
let cleanup: (() => Promise<void>) | undefined
try {
  const sourcePath = join(home, 'alpha-source'),
    stateRoot = join(home, 'state'),
    defaultRoot = join(home, 'default')
  await writeFile(sourcePath, bytes, { mode: 0o600 })
  const store = new VariantStore({ stateRoot })
  const record = await store.acquire({
    kind: 'core',
    sourcePath,
    architecture,
    version: release.version,
    size: pin.size,
    sha256: pin.sha256
  })
  await store.select({ id: record.id })
  const selectedRoot = await store.resolveCoreRoot(defaultRoot)
  const resource = await verifyCoreResource(selectedRoot)
  assert.equal(resource.version, release.version)
  assert.equal(resource.sha256, pin.sha256)
  checks.push('exact archive and payload pins, private import, selection and version resolution')
  const receiptPath = join(selectedRoot, 'relay-core.json'),
    receipt = await readFile(receiptPath)
  await rm(receiptPath)
  await assert.rejects(store.resolveCoreRoot(defaultRoot))
  await writeFile(receiptPath, receipt, { mode: 0o600 })
  checks.push('Alpha bytes without a trusted receipt cannot masquerade as the stable default')
  const changed = JSON.parse(receipt.toString('utf8'))
  changed.sha256 = 'a'.repeat(64)
  await writeFile(receiptPath, JSON.stringify(changed), { mode: 0o600 })
  await assert.rejects(store.resolveCoreRoot(defaultRoot))
  await writeFile(receiptPath, receipt, { mode: 0o600 })
  checks.push('tampered receipt rejected before any execution')
  await mkdir(join(defaultRoot, `darwin-${architecture}`), { recursive: true, mode: 0o700 })
  const fakeDefault = join(defaultRoot, pin.path)
  await copyFile(resource.executable, fakeDefault)
  await chmod(fakeDefault, 0o700)
  await writeFile(join(defaultRoot, 'relay-core.json'), receipt, { mode: 0o600 })
  await assert.rejects(verifyCoreResource(defaultRoot))
  checks.push('default resource root ignores extra receipts and retains the original fixed pin')
  const { stdout, stderr } = await promisify(execFile)(resource.executable, ['-v'], {
    env: coreEnvironment({ HOME: home }),
    cwd: home,
    timeout: 10000,
    maxBuffer: 16384
  })
  versionOutput = (stdout + stderr).trim()
  assert.ok(versionOutput.includes(release.version.replace(/^alpha-/u, '')))
  checks.push(
    'verified host architecture executable reports the pinned Alpha commit with version-only invocation'
  )
  const runtime = await startIsolatedCore(selectedRoot, 'rule', (stop) => {
    cleanup = stop
  })
  assert.equal((await runtime.read('version')).version, release.version)
  assert.equal((await runtime.read('configs')).port, 0)
  await runtime.stop()
  cleanup = undefined
  checks.push(
    'Alpha runs as a newly owned inert child with a private controller and no HTTP listener'
  )
  await store.restore('core')
  assert.equal(await store.resolveCoreRoot(defaultRoot), defaultRoot)
  checks.push('restoration clears the selection without starting or stopping a runtime')
} finally {
  await cleanup?.()
  await rm(home, { recursive: true, force: true })
}
const result = {
  verifiedAt: new Date().toISOString(),
  scope: 'private-temporary-directory-version-query-and-inert-owned-child',
  architecture,
  version: release.version,
  payloadSHA256: pin.sha256,
  versionOutput,
  checks,
  passed: checks.length,
  smartRuntimeAccepted: false,
  productAcceptance: 'pending',
  currentClashTouched: false,
  systemNetworkChanged: false,
  intelRuntimeAccepted: architecture === 'x64'
}
await writeFile(
  '../evidence/alpha-variant-runtime-verification.json',
  JSON.stringify(result, null, 2) + '\n'
)
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
