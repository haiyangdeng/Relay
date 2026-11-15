const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const source = readFileSync(join(__dirname, 'verify-bundled-core-pins.cjs'), 'utf8')

function fixture(failVerification = false, failCleanup = false) {
  const calls = [],
    module = { exports: {} }
  runInNewContext(source, {
    module,
    __dirname: '/fixture/scripts/relay',
    process: { execPath: '/fixture/node', stdout: { write: () => {} } },
    require: (name) => {
      if (name === 'child_process') return { execFile: 'fixture-verify' }
      if (name === 'path') return require('node:path')
      if (name === 'node:fs/promises') return { realpath: async (path) => path }
      if (name === 'util')
        return {
          promisify:
            () =>
            async (...args) => {
              calls.push(['verify', ...args])
              if (failVerification) throw new Error('verification refused')
              return { stdout: '' }
            }
        }
      if (name === 'builder-util') return { Arch: { 0: 'x64', 1: 'arm64' } }
      if (name === './unregister-staged-app.cjs')
        return {
          unregisterStagedApp: async (...args) => {
            calls.push(['cleanup', ...args])
            if (failCleanup) throw new Error('cleanup refused')
            return { unregisteredStagingBundles: [] }
          }
        }
      throw new Error('Unexpected require: ' + name)
    }
  })
  return { calls, hook: module.exports }
}
for (const [arch, directory] of [
  [0, 'mac'],
  [1, 'mac-arm64']
])
  test(`afterSign shares verification then targeted cleanup for ${directory}`, async () => {
    const f = fixture(),
      context = {
        arch,
        appOutDir: '/fixture/release/apps.noindex/' + directory,
        packager: { projectDir: '/fixture', appInfo: { productFilename: 'Relay' } }
      }
    await f.hook(context)
    assert.deepEqual(
      f.calls.map(([operation]) => operation),
      ['verify', 'cleanup']
    )
    assert.equal(f.calls[0][2].at(-1), arch === 0 ? 'x64' : 'arm64')
    assert.deepEqual(f.calls[1], ['cleanup', '/fixture', context.appOutDir + '/Relay.app'])
  })
test('failed resource/signature verification invokes no cleanup', async () => {
  const f = fixture(true)
  await assert.rejects(
    f.hook({
      arch: 0,
      appOutDir: '/fixture/release/apps.noindex/mac',
      packager: { projectDir: '/fixture', appInfo: { productFilename: 'Relay' } }
    }),
    /verification refused/
  )
  assert.deepEqual(
    f.calls.map(([operation]) => operation),
    ['verify']
  )
})
test('rejects a foreign project root before verification or cleanup', async () => {
  const f = fixture()
  await assert.rejects(
    f.hook({
      arch: 0,
      appOutDir: '/foreign/release/apps.noindex/mac',
      packager: { projectDir: '/foreign', appInfo: { productFilename: 'Relay' } }
    }),
    /physical repository/
  )
  assert.equal(f.calls.length, 0)
})
test('cleanup failure propagates to the build', async () => {
  const f = fixture(false, true)
  await assert.rejects(
    f.hook({
      arch: 0,
      appOutDir: '/fixture/release/apps.noindex/mac',
      packager: { projectDir: '/fixture', appInfo: { productFilename: 'Relay' } }
    }),
    /cleanup refused/
  )
})
