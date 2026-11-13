const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, realpathSync } = require('node:fs')
const { join } = require('node:path')

// Verify the single URL-handler resource without opening it or registering it.
function verifyBrowserWrapper(resourcesRoot, sourceRoot) {
  const files = [
    'Contents/Info.plist',
    'Contents/MacOS/RelayBrowser',
    'Contents/_CodeSignature/CodeResources'
  ]
  const inspect = (root) => {
    if (lstatSync(join(root, 'RelayBrowser'), { throwIfNoEntry: false }))
      throw new Error('Obsolete standalone RelayBrowser must not be shipped.')
    const app = join(root, 'RelayBrowser.app')
    if (realpathSync(app) !== app || !lstatSync(app).isDirectory())
      throw new Error('Browser wrapper must be a physical bundle resource.')
    const hashes = {}
    for (const name of files) {
      const file = join(app, name),
        stat = lstatSync(file)
      if (!stat.isFile() || realpathSync(file) !== file || (stat.mode & 0o022) !== 0)
        throw new Error('Browser wrapper contains unsafe resource paths or permissions.')
      hashes[name] = createHash('sha256').update(readFileSync(file)).digest('hex')
    }
    const info = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, files[0])], {
        encoding: 'utf8',
        timeout: 10000
      })
    )
    const schemes = info.CFBundleURLTypes?.flatMap((entry) => entry.CFBundleURLSchemes ?? [])
    if (
      info.CFBundleIdentifier !== 'local.relay.browser' ||
      info.CFBundleExecutable !== 'RelayBrowser' ||
      info.CFBundlePackageType !== 'APPL' ||
      info.LSUIElement !== true ||
      !Array.isArray(schemes) ||
      schemes.length !== 2 ||
      [...schemes].sort().join(',') !== 'http,https'
    )
      throw new Error('Browser wrapper identity or HTTP/HTTPS registration metadata differs.')
    execFileSync(
      '/usr/bin/codesign',
      [
        '--verify',
        '--deep',
        '--strict',
        '--all-architectures',
        '-R=identifier "local.relay.browser"',
        app
      ],
      {
        timeout: 30000
      }
    )
    const architectures = execFileSync(
      '/usr/bin/lipo',
      ['-archs', join(app, 'Contents/MacOS/RelayBrowser')],
      {
        encoding: 'utf8',
        timeout: 10000
      }
    )
      .trim()
      .split(/\s+/u)
      .sort()
    if (architectures.join(',') !== 'arm64,x86_64')
      throw new Error('Browser wrapper must include both supported native architectures.')
    return { app, hashes, bundleVersion: info.CFBundleVersion }
  }
  const source = inspect(sourceRoot),
    packaged = inspect(resourcesRoot)
  if (JSON.stringify(source.hashes) !== JSON.stringify(packaged.hashes))
    throw new Error('Packaged browser wrapper differs from verified native staging.')
  return {
    singleBrowserExecutable: true,
    bundleIdentifier: 'local.relay.browser',
    bundleVersion: packaged.bundleVersion,
    resourceSHA256: packaged.hashes,
    signatureVerified: true,
    appLaunched: false,
    urlHandlerRegistered: false
  }
}
module.exports = { verifyBrowserWrapper }
