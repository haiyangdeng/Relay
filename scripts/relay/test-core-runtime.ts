import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { startIsolatedCore } from '../../src/main/relay/core/isolated-runtime'
import { verifyCoreResource } from '../../src/main/relay/core/resources'

const run = promisify(execFile)
const resourceRoot = resolve('extra/relay/core')
const pins = await Promise.all([
  verifyCoreResource(resourceRoot, 'arm64', 'darwin'),
  verifyCoreResource(resourceRoot, 'x64', 'darwin')
])
const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
check('both official architecture resources verified without execution', pins.length === 2)
let instance: Awaited<ReturnType<typeof startIsolatedCore>> | undefined
try {
  instance = await startIsolatedCore(resourceRoot)
  check('owned core reaches healthy running state', instance.state() === 'running')
  check(
    'pinned version observed through private Unix API',
    (await instance.read('version')).version === pins[0].version
  )
  const config = await instance.read('configs')
  for (const key of ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port'])
    check('no proxy listener: ' + key, config[key] === 0)
  check('LAN listener not enabled', config['allow-lan'] === false)
  check(
    'TUN not enabled',
    !!config.tun &&
      typeof config.tun === 'object' &&
      !Array.isArray(config.tun) &&
      (config.tun as Record<string, unknown>).enable === false
  )
  try {
    const observation = await run(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(instance.pid), '-i'],
      { timeout: 3000 }
    )
    check('no internet socket visible on the owned process', !observation.stdout.trim())
  } catch (error) {
    const value = error as { code?: number; stdout?: string; stderr?: string }
    check(
      'no internet socket visible on the owned process',
      value.code === 1 && !value.stdout?.trim() && !value.stderr?.trim()
    )
  }
  const closing = instance.stop()
  check('stopping is not prematurely presented as stopped', instance.state() === 'stopping')
  await Promise.all([closing, instance.stop()])
  check('stop waits for process closure and cleanup', instance.state() === 'stopped')
  let missing = false
  try {
    await lstat(instance.directory)
  } catch (error) {
    missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  check('only the newly owned runtime directory was removed', missing)
  let refused = false
  try {
    await instance.read('version')
  } catch {
    refused = true
  }
  check('closed controller cannot be read or silently restarted', refused)
} finally {
  await instance?.stop()
}
const report = {
  version: pins[0].version,
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  architectureExecuted: process.arch,
  intelRuntimeVerified: process.arch === 'x64',
  ownIsolatedCoreExecuted: true,
  ownTrafficBackendEnabled: false,
  actualClashStoppedOrRestarted: false,
  actualSystemProxyDNSOrTUNChanged: false,
  actualUserConfigurationImportedOrChanged: false,
  actualBrowserOrClaudeLaunched: false
}
await writeFile('../evidence/core-runtime-contract.json', JSON.stringify(report, null, 2) + '\n')
process.stdout.write(
  JSON.stringify({ checks: report.checks, passed: report.passed, version: report.version }) + '\n'
)
if (report.checks !== report.passed)
  throw new Error('Isolated core runtime checks failed; inspect controlled report.')
