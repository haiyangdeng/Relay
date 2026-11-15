const { execFile } = require('child_process')
const { join, resolve } = require('path')
const { realpath } = require('node:fs/promises')
const { promisify } = require('util')
const { Arch } = require('builder-util')
const { unregisterStagedApp } = require('./unregister-staged-app.cjs')

// afterSign runs after the packager's last nested-code signing pass. Reuse the
// production resource verifier through the already-installed TypeScript runner.
module.exports = async (context) => {
  const projectDir = resolve(__dirname, '../..')
  if (context.packager.projectDir !== projectDir || (await realpath(projectDir)) !== projectDir)
    throw new Error('Build cleanup requires this physical repository root.')
  const app = join(context.appOutDir, context.packager.appInfo.productFilename + '.app')
  const architecture = Arch[context.arch]
  const target = ['arm64', 'x64'].includes(architecture) ? [architecture] : []
  const result = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', join(__dirname, 'verify-bundled-core-pins.ts'), app, ...target],
    { cwd: context.packager.projectDir, timeout: 120000, maxBuffer: 1048576 }
  )
  process.stdout.write(result.stdout)
  const cleanup = await unregisterStagedApp(projectDir, app)
  process.stdout.write(JSON.stringify(cleanup) + '\n')
}
