import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import catalog from '../../src/main/relay/core/variants-manifest.json'
import { verifyCoreExecutable } from '../../src/main/relay/core/resources'
import { readTrustedSmartModel } from '../../src/main/relay/core/smart-models'
import { coreEnvironment, isolatedCoreConfiguration } from '../../src/main/relay/core/configuration'

if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64'))
  throw new Error('This probe requires a supported macOS host.')
const release = catalog.cores.find((core) => core.family === 'smart')
assert.ok(release)
const pin = release.assets[process.arch]
const archive = await readFile(join('.relay-build/variant-reference', `smart-${pin.asset}`))
assert.equal(archive.length, pin.archiveBytes)
assert.equal(createHash('sha256').update(archive).digest('hex'), pin.archiveSHA256)
const home = await realpath(await mkdtemp('/private/tmp/relay-smart-model-probe-'))
const checks: { version: string; asset: string; loaded: boolean }[] = []
try {
  const executable = join(home, 'mihomo-smart')
  await writeFile(executable, gunzipSync(archive, { maxOutputLength: pin.size }), { mode: 0o700 })
  await verifyCoreExecutable(executable, pin)
  const sandbox = join(home, 'offline.sb')
  await writeFile(sandbox, '(version 1) (allow default) (deny network*)', { mode: 0o600 })
  for (const model of catalog.models) {
    const directory = join(home, model.version)
    await mkdir(directory, { mode: 0o700 })
    const bytes = await readTrustedSmartModel(
      join(process.cwd(), '.relay-build/variant-reference', `model-${model.asset}`),
      model
    )
    await writeFile(join(directory, 'Model.bin'), bytes, { mode: 0o600 })
    const configuration = {
      ...isolatedCoreConfiguration(),
      'log-level': 'info',
      'lgbm-auto-update': false,
      'lgbm-url': 'http://127.0.0.1:1/blocked',
      'proxy-groups': [
        {
          name: 'SmartOfflineProbe',
          type: 'smart',
          proxies: ['REJECT'],
          url: 'http://127.0.0.1:1/blocked',
          uselightgbm: true,
          collectdata: false,
          'prefer-asn': false
        }
      ]
    }
    const config = join(directory, 'config.json')
    await writeFile(config, JSON.stringify(configuration), { mode: 0o600 })
    const { stdout, stderr } = await promisify(execFile)(
      '/usr/bin/sandbox-exec',
      ['-f', sandbox, executable, '-t', '-d', directory, '-f', config],
      {
        cwd: directory,
        env: coreEnvironment({ HOME: directory, TMPDIR: directory }),
        timeout: 15000,
        maxBuffer: 65536
      }
    )
    const output = stdout + stderr
    assert.match(output, /Model file loaded successfully/u)
    assert.doesNotMatch(output, /download|invalid|panic|Failed to load/u)
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(directory, 'Model.bin')))
        .digest('hex'),
      model.sha256
    )
    checks.push({ version: model.version, asset: model.asset, loaded: true })
  }
} finally {
  await rm(home, { recursive: true, force: true })
}
const result = {
  verifiedAt: new Date().toISOString(),
  scope: 'network-denied-macos-sandbox-config-check',
  core: release.version,
  architecture: process.arch,
  checks,
  passed: checks.length,
  productionRuntimeEnabled: false,
  smartRoutingAccepted: false,
  currentClashTouched: false,
  systemNetworkChanged: false,
  productAcceptance: 'pending'
}
await writeFile(
  '../evidence/smart-model-semantic-verification.json',
  JSON.stringify(result, null, 2) + '\n'
)
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
