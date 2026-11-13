import { execFile } from 'child_process'
import { promisify } from 'util'
import { dirname, isAbsolute, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { realpath } from 'fs/promises'
import { createRequire } from 'node:module'
import manifest from '../../src/main/relay/core/manifest.json'
import geodataManifest from '../../src/main/relay/core/geodata-manifest.json'
import { verifyCoreResource } from '../../src/main/relay/core/resources'

const run = promisify(execFile),
  app = process.argv[2],
  architecture = process.argv[3],
  projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  sourceRoot = join(projectDir, 'extra/relay')
if (
  ![3, 4].includes(process.argv.length) ||
  process.platform !== 'darwin' ||
  (architecture !== undefined && !['arm64', 'x64'].includes(architecture)) ||
  !isAbsolute(app) ||
  !app.endsWith('/Relay.app') ||
  (await realpath(app)) !== app
)
  throw new Error(
    'Provide one physical, absolute packaged Relay.app path; this gate never launches it.'
  )

const { verifyTerminalGuardBundle } = createRequire(import.meta.url)(
  './verify-bundled-terminal-production.cjs'
)
const { verifyBrowserWrapper } = createRequire(import.meta.url)('./verify-bundled-browser.cjs')

async function signature(path: string): Promise<{ state: 'signed' | 'unsigned'; cdhash?: string }> {
  try {
    const result = await run('/usr/bin/codesign', ['--display', '--verbose=4', path], {
      timeout: 30000,
      maxBuffer: 16384,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
    })
    const cdhash = /^CDHash=([a-f0-9]{40})$/mu.exec(result.stderr)?.[1]
    if (!cdhash) throw new Error('Original core signature identity was not confirmed.')
    await run('/usr/bin/codesign', ['--verify', '--strict', path], { timeout: 30000 })
    return { state: 'signed', cdhash }
  } catch (error) {
    const result = error as { code?: number; stderr?: string }
    if (result.code === 1 && result.stderr?.trim() === path + ': code object is not signed at all')
      return { state: 'unsigned' }
    throw error
  }
}

const cores: Record<string, unknown> = {},
  geodataCores: Record<string, unknown> = {}
for (const [directory, profile, results] of [
  ['core', manifest, cores],
  ['core-geodata-v1', geodataManifest, geodataCores]
] as const) {
  const source = join(sourceRoot, directory),
    root = join(app, 'Contents/Resources/relay', directory)
  for (const architecture of ['arm64', 'x64'] as const) {
    // Neither signing nor a changed digest is accepted as a replacement for the
    // fixed release. Both production architecture/Mach-O/hash/size gates run.
    await verifyCoreResource(source, architecture, 'darwin')
    const verified = await verifyCoreResource(root, architecture, 'darwin'),
      pin = profile.assets[architecture],
      originalSignature = await signature(join(source, pin.path)),
      packagedSignature = await signature(verified.executable)
    if (JSON.stringify(originalSignature) !== JSON.stringify(packagedSignature))
      throw new Error('Packaged core signature state differs from its exact pinned release.')
    if (directory === 'core-geodata-v1' && originalSignature.state !== 'signed')
      throw new Error('Thin Core must retain its paired development signature.')
    results[architecture] = {
      sha256: verified.sha256,
      size: pin.size,
      cpuType: pin.cpuType,
      originalSignature,
      packagedSignature
    }
  }
}
// The original unsigned Intel release remains a sealed resource. Acceptance of
// that resource by the outer bundle signature is independently mandatory.
const terminal = verifyTerminalGuardBundle(app, projectDir, architecture)
const browser = verifyBrowserWrapper(join(app, 'Contents/Resources/relay'), sourceRoot)
if (!terminal.available)
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 60000 })

// An older native helper can have a valid ad-hoc signature but lack the
// current host inspection entry point. The inspection itself is read-only.
const relayNative = join(app, 'Contents/Resources/relay/RelayNative')
const hostInspection = await run(relayNative, ['--guard-host-resource-inspect'], {
  timeout: 15000,
  maxBuffer: 8192,
  env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
}).catch((error: unknown) => {
  throw new Error('Packaged RelayNative lacks the current read-only Guard host inspection.', {
    cause: error
  })
})
const host = JSON.parse(hostInspection.stdout)
if (
  host?.version !== 1 ||
  (host.trusted === true
    ? typeof host.path !== 'string' ||
      !host.path.endsWith('/RelayGuard.node') ||
      typeof host.resourceSHA256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(host.resourceSHA256)
    : host.trusted !== false || host.reason !== 'packageIdentityUnconfirmed')
)
  throw new Error('Packaged RelayNative did not return the current Guard host inspection format.')

process.stdout.write(
  JSON.stringify({
    passed: true,
    cores,
    geodataCores,
    terminal,
    browser,
    nativeGuardHostInspectionVerified: true,
    outerDeepStrictSignatureVerified: true,
    appLaunched: false
  }) + '\n'
)
