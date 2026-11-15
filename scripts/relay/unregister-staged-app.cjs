const { execFile } = require('node:child_process')
const { lstat, realpath } = require('node:fs/promises')
const { isAbsolute, join, resolve } = require('node:path')
const { promisify } = require('node:util')

const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const run = promisify(execFile)
const bundles = [
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

// A successful complete dump is required before treating exit 1 (not registered)
// as an idempotent result. Never print its unrelated application records.
function registryPaths(text) {
  if (typeof text !== 'string' || !text.endsWith('\n') || text.includes('\0'))
    throw new Error('Launch Services registry read was incomplete.')
  const records = text
    .split(/^-+[ \t]*$/mu)
    .filter((block) => /^[ \t]*bundle id:[ \t]*\S+/mu.test(block))
  if (!records.length) throw new Error('Launch Services registry format was not confirmed.')
  return records.map((block) => {
    const paths = [...block.matchAll(/^[ \t]*path:[ \t]*(.+)$/gmu)]
    // Some legitimate LS bundle rows have no identifier. The six filesystem
    // identities were verified above; absence is decided by exact path only.
    if (paths.length !== 1) throw new Error('Launch Services bundle record was incomplete.')
    const path = paths[0][1].replace(/ \(0x[0-9a-f]+\)$/u, '')
    if (!isAbsolute(path)) throw new Error('Launch Services bundle path was not confirmed.')
    return path
  })
}

// Build-time cleanup only, called after all resource/signature gates pass. Never
// discover other copies or accept an installed App, arbitrary output, or alias.
async function unregisterStagedApp(projectDir, app, execute = run) {
  if (
    !isAbsolute(projectDir) ||
    resolve(projectDir) !== projectDir ||
    (await realpath(projectDir)) !== projectDir ||
    !['mac', 'mac-arm64'].some(
      (arch) => app === join(projectDir, 'release/apps.noindex', arch, 'Relay.app')
    )
  ) {
    throw new Error('Launch Services cleanup accepts only the two fixed noindex staging paths.')
  }
  const options = {
    timeout: 30000,
    maxBuffer: 65536,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
  }
  const paths = []
  async function physical(path, directory) {
    const stat = await lstat(path)
    if (
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      throw new Error('Build bundle cleanup refuses linked or non-physical paths.')
    return {
      path,
      directory,
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs
    }
  }
  async function unchanged(entry) {
    const current = await physical(entry.path, entry.directory)
    if (JSON.stringify(current) !== JSON.stringify(entry))
      throw new Error('Staged App changed during cleanup.')
  }
  // Validate every target before the first Launch Services operation.
  for (const [relative, identifier, executable] of bundles) {
    const target = join(app, relative)
    const metadata = join(target, 'Contents/Info.plist')
    const entries = [
      await physical(target, true),
      await physical(metadata, false),
      await physical(join(target, 'Contents/MacOS', executable), false)
    ]
    const info = JSON.parse(
      (await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', metadata], options)).stdout
    )
    if (
      info.CFBundleIdentifier !== identifier ||
      info.CFBundleExecutable !== executable ||
      info.CFBundlePackageType !== 'APPL'
    )
      throw new Error('Unexpected staged bundle identity; nothing was unregistered.')
    await execute(
      '/usr/bin/codesign',
      ['--verify', '--strict', '-R=identifier "' + identifier + '"', target],
      options
    )
    paths.push({ target, entries })
  }
  for (const { entries } of paths) for (const entry of entries) await unchanged(entry)
  const unregistered = [],
    alreadyAbsent = []
  for (const { target, entries } of paths) {
    for (const entry of entries) await unchanged(entry)
    try {
      await execute(lsregister, ['-u', target], options)
      unregistered.push(target)
    } catch (error) {
      if (error.code !== 1 || error.killed || error.signal) throw error
      const dump = await execute(lsregister, ['-dump', 'Bundle'], {
        ...options,
        maxBuffer: 64 * 1024 * 1024
      }).catch(() => {
        throw new Error('Launch Services registry absence could not be checked.')
      })
      if (registryPaths(dump.stdout).includes(target))
        throw new Error('Staged bundle remains registered after cleanup failed.')
      for (const entry of entries) await unchanged(entry)
      alreadyAbsent.push(target)
    }
  }
  return {
    unregisteredStagingBundles: unregistered,
    alreadyUnregisteredStagingBundles: alreadyAbsent,
    applicationLaunched: false,
    installedApplicationTouched: false
  }
}

module.exports = { unregisterStagedApp }
