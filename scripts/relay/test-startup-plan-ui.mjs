import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Real packaged-app regression. Launches and quits Relay, allowing its own UI
// state; never imports a subscription or applies network/client settings.
if (!process.env.RELAY_PLAYWRIGHT_MODULE)
  throw new Error('Set RELAY_PLAYWRIGHT_MODULE to an installed Playwright module.')
const { _electron } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const [appPath, output = '.relay-build/intel-validation/startup-plan-regression.json'] =
  process.argv.slice(2)
assert(appPath?.endsWith('/Relay.app'), 'Provide an absolute packaged Relay.app path.')
assert.equal(resolve(appPath), appPath)
const report = { startedAt: new Date().toISOString(), appPath, checks: [], errors: [] }
const check = (name, passed) => {
  report.checks.push({ name, passed })
  assert(passed, name)
}
let application
try {
  // The production app can start a saved selection. Admit only the clean state
  // used by this regression, retaining UI/cache files from preceding runs.
  const home = userInfo().homedir
  const stateRoot = join(home, 'Library/Application Support/Relay-Preview')
  const allowed = new Set(['Browser', 'Chromium', 'UI', 'logs'])
  try {
    const info = await lstat(stateRoot)
    assert(info.isDirectory() && !info.isSymbolicLink(), 'Unexpected Relay data root.')
    for (const name of await readdir(stateRoot)) {
      if (allowed.has(name)) continue
      const path = join(stateRoot, name)
      const entry = await lstat(path)
      if (name === 'Configuration' && entry.isDirectory() && !entry.isSymbolicLink()) {
        const children = await readdir(path)
        assert(
          children.every((file) =>
            ['ui-preferences.json', 'app-log-preferences.json'].includes(file)
          ),
          'Refusing to launch with saved Relay configuration.'
        )
        continue
      }
      assert(
        ['Configurations', 'Profiles'].includes(name) &&
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          (await readdir(path)).length === 0,
        'Refusing to launch with existing Relay profiles, core records or non-UI state.'
      )
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  report.cleanStatePreflight = true
  application = await _electron.launch({
    executablePath: join(appPath, 'Contents/MacOS/Relay'),
    args: [],
    timeout: 60000
  })
  application.on('console', (message) => {
    if (message.type() === 'error') report.errors.push(message.text())
  })
  const child = application.process()
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
  report.runtime = await application.evaluate(({ app }) => ({
    architecture: process.arch,
    packaged: app.isPackaged,
    version: app.getVersion()
  }))
  check(
    'packaged application executes on Intel',
    report.runtime.packaged && report.runtime.architecture === 'x64'
  )
  const page = await application.firstWindow({ timeout: 60000 })
  await page.waitForFunction(
    () => document.body.innerText.includes('Relay') && window.electron?.ipcRenderer
  )
  // Main creates the first BrowserWindow hidden and shows it only after the
  // first-content handshake. Merely invoking the IPC after show misses the bug.
  await page.waitForFunction(
    () => {
      const text = document.body.textContent
      return (
        text.includes('启动设置读取失败') ||
        text.includes('已读取保存的启动设置。') ||
        text.includes('尚未保存；启动代理时会保存当前设置。')
      )
    },
    null,
    { timeout: 15000 }
  )
  report.initialHash = await page.evaluate(() => location.hash)
  await page.evaluate(() => {
    location.hash = '#/relay?panel=core'
  })
  await page.waitForFunction(() => document.body.innerText.includes('保存启动设置'))
  const text = await page.locator('body').innerText()
  report.notice = text.includes('启动设置读取失败') ? 'failed' : 'ready'
  check(
    'first visible workspace loads its startup settings without manual retry',
    report.notice === 'ready'
  )
  check(
    'renderer receives current saved or fresh startup plan',
    text.includes('已读取保存的启动设置。') || text.includes('尚未保存；启动代理时会保存当前设置。')
  )
  report.status = await page.evaluate(() => window.electron.ipcRenderer.invoke('relayStatus'))
  check(
    'startup resources available without launching a core',
    report.status.nativeReady && report.status.coreRunning === false
  )
  check(
    'no hidden-window startup-plan rejection',
    !report.errors.some((error) => error.includes("'relayLocalProxyPlanRead'"))
  )
  await application.close({ timeout: 30000 })
  application = undefined
  report.exit = await exited
  check(
    'normal quit closes the owned application',
    report.exit.code === 0 && report.exit.signal === null
  )
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = error.message
  process.exitCode = 1
} finally {
  if (application) {
    try {
      await application.close({ timeout: 30000 })
    } catch (error) {
      report.cleanupFailure = error.message
    }
  }
  report.finishedAt = new Date().toISOString()
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
