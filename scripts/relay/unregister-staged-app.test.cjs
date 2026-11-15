const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } = require('node:fs/promises')
const { join, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const { unregisterStagedApp } = require('./unregister-staged-app.cjs')

const definitions = [
  ['Contents/Resources/relay/RelayBrowser.app', 'local.relay.browser', 'RelayBrowser'],
  ['Contents/Frameworks/Relay Helper.app', 'local.relay.network.preview.helper', 'Relay Helper'],
  [
    'Contents/Frameworks/Relay Helper (GPU).app',
    'local.relay.network.preview.helper.GPU',
    'Relay Helper (GPU)'
  ],
  [
    'Contents/Frameworks/Relay Helper (Plugin).app',
    'local.relay.network.preview.helper.Plugin',
    'Relay Helper (Plugin)'
  ],
  [
    'Contents/Frameworks/Relay Helper (Renderer).app',
    'local.relay.network.preview.helper.Renderer',
    'Relay Helper (Renderer)'
  ],
  ['', 'local.relay.network.preview', 'Relay']
]
async function fixture(t, arch = 'mac') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'relay-staging-cleanup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'release/apps.noindex', arch, 'Relay.app')
  for (const [relative, id, executable] of definitions) {
    const path = join(app, relative)
    await mkdir(join(path, 'Contents/MacOS'), { recursive: true })
    await writeFile(join(path, 'Contents/MacOS', executable), 'inert test fixture')
    await writeFile(
      join(path, 'Contents/Info.plist'),
      JSON.stringify({
        CFBundleIdentifier: id,
        CFBundleExecutable: executable,
        CFBundlePackageType: 'APPL'
      })
    )
  }
  const calls = []
  const execute = async (command, args) => {
    calls.push([command, args])
    if (command === '/usr/bin/plutil') return { stdout: await readFile(args[4], 'utf8') }
    if (command === '/usr/bin/codesign' || command.endsWith('/lsregister')) return { stdout: '' }
    throw new Error('Unexpected command')
  }
  return {
    root,
    app,
    calls,
    execute,
    unregisters: () =>
      calls.filter(([command, args]) => command.endsWith('/lsregister') && args[0] === '-u')
  }
}
for (const arch of ['mac', 'mac-arm64'])
  test(`only unregisters six fixed physical ${arch} staging bundles, children first`, async (t) => {
    const f = await fixture(t, arch)
    const result = await unregisterStagedApp(f.root, f.app, f.execute)
    const paths = definitions.map(([relative]) => join(f.app, relative))
    assert.deepEqual(
      f.unregisters().map(([, args]) => args),
      paths.map((path) => ['-u', path])
    )
    assert.equal(
      f.calls.slice(0, 12).every(([command]) => !command.endsWith('/lsregister')),
      true
    )
    assert.equal(f.calls.filter(([command]) => command === '/usr/bin/codesign').length, 6)
    assert.deepEqual(result.unregisteredStagingBundles, paths)
    assert.equal(result.installedApplicationTouched, false)
  })
for (const path of [
  '/Applications/Relay.app',
  '/Applications/../Applications/Relay.app',
  'relative/Relay.app',
  'release/mac/Relay.app',
  'release/apps.noindex/foreign/Relay.app'
])
  test(`refuses non-staging path ${path}`, async (t) => {
    const f = await fixture(t)
    await assert.rejects(
      unregisterStagedApp(f.root, path.startsWith('/') ? path : join(f.root, path), f.execute),
      /fixed noindex staging/
    )
    assert.equal(f.calls.length, 0)
  })
for (const which of ['app', 'parent', 'nested', 'plist', 'executable'])
  test(`refuses ${which} symlink before any unregister`, async (t) => {
    const f = await fixture(t)
    const target =
      which === 'app'
        ? f.app
        : which === 'parent'
          ? dirname(f.app)
          : which === 'nested'
            ? join(f.app, definitions[0][0])
            : which === 'plist'
              ? join(f.app, 'Contents/Info.plist')
              : join(f.app, 'Contents/MacOS/Relay')
    await rm(target, { recursive: true, force: true })
    await symlink(f.root, target)
    await assert.rejects(unregisterStagedApp(f.root, f.app, f.execute))
    assert.equal(f.unregisters().length, 0)
  })
for (const failure of ['identity', 'missing', 'signature'])
  test(`a ${failure} failure prevents all unregister calls`, async (t) => {
    const f = await fixture(t)
    if (failure === 'identity')
      await writeFile(
        join(f.app, 'Contents/Info.plist'),
        JSON.stringify({
          CFBundleIdentifier: 'foreign',
          CFBundleExecutable: 'Relay',
          CFBundlePackageType: 'APPL'
        })
      )
    if (failure === 'missing') await rm(join(f.app, definitions[3][0]), { recursive: true })
    const execute = async (command, args) => {
      if (failure === 'signature' && command === '/usr/bin/codesign' && args.at(-1) === f.app)
        throw new Error('invalid signature')
      return f.execute(command, args)
    }
    await assert.rejects(unregisterStagedApp(f.root, f.app, execute))
    assert.equal(f.unregisters().length, 0)
  })
test('detects replaced bundle metadata between verification and cleanup', async (t) => {
  const f = await fixture(t)
  const execute = async (command, args) => {
    if (command === '/usr/bin/codesign' && args.at(-1) === f.app)
      await writeFile(join(f.app, definitions[0][0], 'Contents/Info.plist'), 'changed')
    return f.execute(command, args)
  }
  await assert.rejects(unregisterStagedApp(f.root, f.app, execute), /changed/)
  assert.equal(f.unregisters().length, 0)
})
const dump = (path = '/Applications/Unrelated.app') =>
  `--------------------------------------------------------------------------------\nbundle id:                  Fixture Name (0x123)\npath: ${path} (0xabc)\n--------------------------------------------------------------------------------\n`
test('exit 1 for unregistered noindex bundles succeeds only after a complete read-only absence check', async (t) => {
  const f = await fixture(t)
  const execute = async (command, args, options) => {
    if (command.endsWith('/lsregister')) {
      f.calls.push([command, args])
      if (args[0] === '-u') throw Object.assign(new Error('not registered'), { code: 1 })
      assert.deepEqual(args, ['-dump', 'Bundle'])
      assert.equal(options.maxBuffer, 64 * 1024 * 1024)
      return { stdout: dump() }
    }
    return f.execute(command, args)
  }
  const result = await unregisterStagedApp(f.root, f.app, execute)
  assert.equal(result.unregisteredStagingBundles.length, 0)
  assert.deepEqual(
    result.alreadyUnregisteredStagingBundles,
    definitions.map(([relative]) => join(f.app, relative))
  )
  assert.equal(f.unregisters().length, 6)
})
for (const reason of ['still-present', 'empty', 'malformed', 'dump-failed', 'non-exit-one'])
  test(`unregister failure is not hidden when ${reason}`, async (t) => {
    const f = await fixture(t)
    const execute = async (command, args) => {
      if (command.endsWith('/lsregister')) {
        f.calls.push([command, args])
        if (args[0] === '-u')
          throw Object.assign(new Error('unregister failed'), {
            code: reason === 'non-exit-one' ? 2 : 1
          })
        if (reason === 'dump-failed') throw new Error('dump failed')
        return {
          stdout:
            reason === 'still-present'
              ? dump(join(f.app, definitions[0][0]))
              : reason === 'empty'
                ? ''
                : 'bundle id:                  Incomplete Fixture (0x123)\n'
        }
      }
      return f.execute(command, args)
    }
    await assert.rejects(unregisterStagedApp(f.root, f.app, execute))
    assert.equal(f.unregisters().length, 1)
    if (reason === 'non-exit-one')
      assert.equal(
        f.calls.some(([, args]) => args[0] === '-dump'),
        false
      )
  })
test('a Launch Services failure is surfaced without reset or broad cleanup', async (t) => {
  const f = await fixture(t)
  const execute = async (command, args) => {
    if (command.endsWith('/lsregister')) {
      f.calls.push([command, args])
      throw new Error('fixture LS failed')
    }
    return f.execute(command, args)
  }
  await assert.rejects(unregisterStagedApp(f.root, f.app, execute), /fixture LS failed/)
  assert.deepEqual(
    f.unregisters().map(([, args]) => args),
    [['-u', join(f.app, definitions[0][0])]]
  )
})
