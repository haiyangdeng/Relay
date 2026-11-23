const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')
const asar = require('@electron/asar')
const {
  inspectAdmission,
  verifyBundledTunAdmission
} = require('./verify-bundled-tun-admission.cjs')

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const client = Buffer.from('fixture client, never executable')
const cores = { arm64: Buffer.from('fixture arm core'), x64: Buffer.from('fixture intel core') }
const expected = {
  execution: { version: 1, capability: 'execution-v2', clientSHA256: hash(client) },
  workDirectory: {
    version: 1,
    capability: 'runtime-work-directory-v1',
    clientSHA256: hash(client)
  },
  geodata: {
    version: 'fixture',
    capability: 'local-geodata-v1',
    implementationRevision: 2,
    assets: Object.fromEntries(
      Object.entries(cores).map(([arch, bytes]) => [
        arch,
        {
          path: 'darwin-' + arch + '/mihomo',
          sha256: hash(bytes),
          size: bytes.length
        }
      ])
    )
  }
}
function source(pins = expected) {
  // Aliases reflect Vite JSON compilation. This must never be evaluated.
  return `throw new Error('App execution forbidden');
const digest = ${JSON.stringify(pins.execution.clientSHA256)};
const clientPin = { version: 1, capability: 'execution-v2', clientSHA256: digest };
const workDirectoryClient = ${JSON.stringify(pins.workDirectory)};
const assets = ${JSON.stringify(pins.geodata.assets)};
const geodata = { ...untrusted };
const geodataCoreManifest = ${JSON.stringify(pins.geodata).replace(JSON.stringify(pins.geodata.assets), 'assets')};
function matchesRuntimeWorkDirectoryClient(digest, pin = workDirectoryClient) { return pin.clientSHA256 === digest; }
function compiledExecutionCoreV2(profile, architecture) {
  if (architecture !== 'arm64' && architecture !== 'x64') throw Error();
  if (profile === 'local-geodata-v1') {
    const pin = geodataCoreManifest.assets[architecture];
    return Object.freeze({ profile, architecture, version: geodataCoreManifest.version, sha256: pin.sha256, size: pin.size });
  }
  throw Error();
}
function decodeExecutionInstallationV2(bytes, architecture, currentUID, capability = clientPin, workDirectoryCapability) {
  const raw = parseTunHostFrame(bytes, 16384);
  if (raw.client.sha256 !== capability.clientSHA256 && !matchesRuntimeWorkDirectoryClient(raw.client.sha256, workDirectoryCapability)) throw Error();
  for (const arch of ['arm64', 'x64']) compiledExecutionCoreV2(bytes.coreProfile, arch);
  return compiledExecutionCoreV2(bytes.coreProfile, architecture);
}
async function readTunInstallation(execution) {
  const bytes = await readBinaryResource(installedManifest);
  const raw = JSON.parse(bytes.toString('utf8'));
  if (execution && object(raw) && (raw.version === 2 || raw.role === 'core-managed-v2')) {
    const admitted = decodeExecutionInstallationV2(bytes, process.arch, process.getuid?.() ?? 0);
    const clientBytes = await readBinaryResource(installedClient);
    if (resourceHash(clientBytes) !== admitted.clientSHA256) throw Error();
    return { execution, executionCore: admitted.core, revision: admitted.revision, helperSHA256: admitted.clientSHA256, coreSHA256: admitted.core.sha256, clientSHA256: admitted.clientSHA256 };
  }
}`
}

test('resolves only the literal pins referenced by compiled admission; never executes main', () => {
  assert.equal(inspectAdmission(source(), expected).executionClientSHA256, hash(client))
})
test('rejects stale live client despite a current decoy constant', () => {
  const stale = structuredClone(expected)
  stale.execution.clientSHA256 = 'a'.repeat(64)
  assert.throws(
    () =>
      inspectAdmission(
        source(stale) + '\nconst decoy = ' + JSON.stringify(expected.execution),
        expected
      ),
    /execution client differs/
  )
})
test('rejects stale live core despite a current decoy manifest', () => {
  const stale = structuredClone(expected)
  stale.geodata.assets.arm64.sha256 = 'b'.repeat(64)
  assert.throws(
    () =>
      inspectAdmission(
        source(stale) + '\nconst decoy = ' + JSON.stringify(expected.geodata),
        expected
      ),
    /geodata manifest differs/
  )
})
test('rejects stale work directory capability', () => {
  const stale = structuredClone(expected)
  stale.workDirectory.clientSHA256 = 'c'.repeat(64)
  assert.throws(() => inspectAdmission(source(stale), expected), /work-directory client differs/)
})
test('rejects executable pin initializer and ambiguous function', () => {
  assert.throws(
    () =>
      inspectAdmission(
        source().replace('capability = clientPin', 'capability = getPin()'),
        expected
      ),
    /executable initializer/
  )
  assert.throws(
    () => inspectAdmission(source() + '\nfunction compiledExecutionCoreV2() {}', expected),
    /duplicate function/
  )
})
test('rejects disconnected core return or removed decoder call', () => {
  assert.throws(
    () => inspectAdmission(source().replace('sha256: pin.sha256', "sha256: 'other'"), expected),
    /not tied to its manifest/
  )
  assert.throws(
    () =>
      inspectAdmission(
        source().replace(
          'return compiledExecutionCoreV2(bytes.coreProfile, architecture);',
          'return bytes;'
        ),
        expected
      ),
    /both compiled core/
  )
})
test('rejects dead admission functions behind an old real installation entry', () => {
  assert.throws(
    () =>
      inspectAdmission(
        source().replace(
          'const admitted = decodeExecutionInstallationV2(',
          'const admitted = oldDecoder('
        ),
        expected
      ),
    /live installation/
  )
})
test('rejects overriding the default pin at the real call site', () => {
  assert.throws(
    () =>
      inspectAdmission(
        source().replace('process.getuid?.() ?? 0);', 'process.getuid?.() ?? 0, oldPin);'),
        expected
      ),
    /default pinned decoder/
  )
})
test('rejects new default pin with stale or bypassed actual hash guard', () => {
  assert.throws(
    () =>
      inspectAdmission(
        source().replace(
          'raw.client.sha256 !== capability.clientSHA256',
          'raw.client.sha256 !== oldPin.clientSHA256'
        ),
        expected
      ),
    /direct rejecting guard/
  )
  assert.throws(
    () =>
      inspectAdmission(
        source().replace('if (raw.client.sha256', 'if (false && raw.client.sha256'),
        expected
      ),
    /direct rejecting guard/
  )
  assert.throws(
    () =>
      inspectAdmission(
        source().replace('return pin.clientSHA256 === digest;', 'return false;'),
        expected
      ),
    /returned predicate/
  )
})
test('rejects stale return override and live client guard removal', () => {
  assert.throws(
    () =>
      inspectAdmission(
        source().replace('size: pin.size });', 'size: pin.size, ...stale });'),
        expected
      ),
    /unexpected properties/
  )
  assert.throws(
    () =>
      inspectAdmission(
        source().replace(
          'if (resourceHash(clientBytes) !== admitted.clientSHA256) throw Error();',
          ''
        ),
        expected
      ),
    /live client bytes/
  )
})

async function archiveFixture(run, options) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-sealed-admission-')))
  const app = join(root, 'Relay.app'),
    input = join(root, 'input'),
    native = join(root, 'RelayTunClient')
  const write = (path, contents) => {
    mkdirSync(require('node:path').dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  try {
    write(join(input, 'package.json'), JSON.stringify({ main: './out/main/index.js' }))
    write(join(input, 'out/main/index.js'), source())
    write(native, client)
    write(
      join(root, 'src/main/relay/tun/execution-client.json'),
      JSON.stringify(expected.execution)
    )
    write(
      join(root, 'src/main/relay/tun/runtime-work-directory-client.json'),
      JSON.stringify(expected.workDirectory)
    )
    write(join(root, 'src/main/relay/core/geodata-manifest.json'), JSON.stringify(expected.geodata))
    for (const [arch, bytes] of Object.entries(cores))
      write(join(app, 'Contents/Resources/relay/core-geodata-v1/darwin-' + arch + '/mihomo'), bytes)
    await asar.createPackageWithOptions(
      input,
      join(app, 'Contents/Resources/app.asar'),
      options ?? {}
    )
    await run({ root, app, native, write })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
test('sealed archive verifies both architectures and actual client with immutable receipt', async () => {
  await archiveFixture(({ root, app, native }) => {
    const receipt = verifyBundledTunAdmission(app, native, root)
    assert.equal(receipt.passed, true)
    assert.equal(receipt.applicationCodeExecuted, false)
    assert.equal(receipt.clientSHA256, hash(client))
    assert.equal(receipt.cores.arm64.sha256, hash(cores.arm64))
    assert.equal(receipt.cores.x86_64.sha256, hash(cores.x64))
    assert.match(receipt.appASARSHA256, /^[a-f0-9]{64}$/)
  })
})
test('rejects packaged native client and Core mismatches', async () => {
  await archiveFixture(({ root, app, native, write }) => {
    write(native, 'different client')
    assert.throws(
      () => verifyBundledTunAdmission(app, native, root),
      /actual client is not admitted/
    )
    write(native, client)
    write(join(app, 'Contents/Resources/relay/core-geodata-v1/darwin-x64/mihomo'), 'different core')
    assert.throws(() => verifyBundledTunAdmission(app, native, root), /bundled x64 core/)
  })
})
test('rejects a main entry stored outside sealed asar', async () => {
  await archiveFixture(
    ({ root, app, native }) => {
      assert.throws(() => verifyBundledTunAdmission(app, native, root), /entry must be sealed/)
    },
    { unpack: '**/index.js' }
  )
})
