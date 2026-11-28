// Real built renderer and its actual start-button closure; isolated fixture IPC.
// Plan persistence is real. Core/native calls are fixtures, never live services.
// Run: node --import tsx scripts/relay/test-local-proxy-startup-ui.mjs <new-report.json>
// Requires a previously built out/renderer, RELAY_PLAYWRIGHT_MODULE and RELAY_CHROME.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LocalProxyPlanStore } from '../../src/main/relay/core/local-proxy-plan-store.ts'

assert(
  process.env.RELAY_PLAYWRIGHT_MODULE && process.env.RELAY_CHROME,
  'Set the existing Playwright module and isolated test browser executable.'
)
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = join(source, 'out/renderer')
const output = resolve(process.argv[2] ?? '.relay-build/local-proxy-startup-ui.json')
assert.equal(process.argv.length <= 3, true, 'Only a new output report path is accepted.')
await assert.rejects(lstat(output), { code: 'ENOENT' })
await readFile(join(renderer, 'index.html'))
const report = {
  startedAt: new Date().toISOString(),
  scope:
    'Actual built renderer button chain with real temporary LocalProxyPlanStore and fixture Core/native IPC',
  source,
  realElectronOrCoreStarted: false,
  realUserStateAccessed: false,
  externalNetworkAllowed: false,
  scenarios: [],
  passed: false
}
const profile = {
  id: '00000000-0000-4000-8000-000000000031',
  name: '启动按钮回归配置',
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-28T00:00:00Z',
  summary: { proxies: 1, groups: 1, rules: 1, proxyProviders: 0, ruleProviders: 0 }
}
const document = {
  httpPort: 18191,
  resolverMode: 'off',
  ports: { http: 0, socks: 0, mixed: 18191, redir: 0 },
  dedicated: { httpPort: 17890, socksPort: 17891, route: 'fixture-node' }
}
const idle = () => ({
  phase: 'idle',
  pending: false,
  owned: false,
  hasRecord: false,
  uncertain: false,
  traffic: 'inactive',
  groups: [],
  warnings: [],
  systemProxyChanged: false,
  liveGuardEnabled: false
})
const shell = {
  initialized: true,
  pending: false,
  uncertain: false,
  exists: true,
  revision: 'b'.repeat(64),
  warnings: [],
  settings: {
    operationMode: 'standard',
    appTheme: 'light',
    silentStart: false,
    closeToTray: false,
    alwaysOnTop: false,
    showFloatingWindow: false,
    shortcuts: {}
  }
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
let browser
const homes = []

async function scenario(changed) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-start-button-')))
  homes.push(home)
  const store = new LocalProxyPlanStore({
    home,
    stateRoot: join(home, 'Library/Application Support/Relay-Preview')
  })
  await store.save({ document, expectedRevision: '' })
  const beforeBytes = await readFile(store.path),
    beforeStat = await lstat(store.path)
  let local = idle(),
    selected = profile.id,
    preparation,
    guardCalls = 0
  const calls = [],
    pageErrors = [],
    consoleErrors = [],
    blockedRequests = [],
    rejectedAncillaryReads = [],
    unexpectedActions = []
  const result = {
    name: changed ? 'changed-settings-refused' : 'unchanged-settings-start',
    calls,
    checks: [],
    passed: false
  }
  report.scenarios.push(result)
  const check = (name, value) => {
    result.checks.push({ name, passed: !!value })
    assert(value, name)
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    locale: 'zh-CN'
  })
  const allowed = pathToFileURL(renderer).href + '/'
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(allowed) || /^(data|blob):/.test(url)) return route.continue()
    blockedRequests.push(url)
    return route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.exposeFunction('__relayStartTestInvoke', async (channel, ...args) => {
    calls.push({ channel, args })
    const input = args[0]
    if (channel === 'relayLocalProxyPlanRead') return store.read()
    if (channel === 'relayLocalProxyPlanSave')
      return store.save(
        input,
        () => {},
        async () => {
          guardCalls++
          throw new Error('备份恢复状态未确认，请先完成恢复核对。')
        }
      )
    if (channel === 'relayWorkspaceVisible') return true
    if (channel === 'platform') return 'darwin'
    if (channel === 'getVersion') return '1.0.0-ui-fixture'
    if (channel === 'getAppConfig')
      return {
        language: 'zh-CN',
        operationMode: 'standard',
        modeSelected: true,
        appTheme: 'light',
        enableTrafficLogger: false
      }
    if (channel === 'getControledMihomoConfig')
      return { mode: 'rule', 'mixed-port': 18191, tun: { enable: false } }
    if (channel === 'getProfileConfig')
      return { current: selected, items: [{ ...profile, type: 'local' }] }
    if (channel === 'getOverrideConfig' || channel === 'getPluginConfig') return { items: [] }
    if (channel === 'mihomoGroups') return []
    if (channel === 'mihomoRules') return { rules: [] }
    if (channel === 'relayPluginOpenedPending') return false
    if (channel === 'takeDnsOverrideAutoDisabledNotice') return undefined
    if (channel === 'relayProxyPageOwner')
      return local.owned
        ? {
            kind: 'ordinary',
            instanceId: local.instanceId,
            profileId: profile.id,
            configurationRevision: local.configurationRevision,
            mode: 'rule'
          }
        : null
    if (channel === 'relayProfileList')
      return {
        profiles: [profile],
        incomplete: 0,
        activeId: local.owned ? profile.id : null,
        warnings: []
      }
    if (channel === 'relayLocalProxyState' || channel === 'relayCoreState')
      return structuredClone(local)
    if (channel === 'changeCurrentProfile') {
      assert.deepEqual(input, { id: profile.id, sha256: profile.sha256 })
      selected = input.id
      return
    }
    if (channel === 'relayLocalProxyPrepare') {
      assert.equal(selected, profile.id)
      assert.deepEqual(input.profile, { id: profile.id, sha256: profile.sha256 })
      const saved = await store.read()
      for (const key of ['httpPort', 'resolverMode', 'ports', 'dedicated'])
        assert.deepEqual(input[key], saved.document[key])
      preparation = {
        evidenceId: '00000000-0000-4000-8000-000000000032',
        profile,
        ...saved.document,
        canStart: true,
        hasRecord: false,
        warnings: [],
        runtimeSHA256: 'c'.repeat(64),
        version: 'fixture'
      }
      return preparation
    }
    if (channel === 'relayLocalProxyAction') {
      assert.deepEqual(input, { action: 'start', evidenceId: preparation?.evidenceId })
      local = {
        ...idle(),
        phase: 'running',
        owned: true,
        hasRecord: true,
        traffic: 'listening',
        profileId: selected,
        instanceId: preparation.evidenceId,
        configurationRevision: 'c'.repeat(64),
        httpPort: preparation.httpPort,
        ports: preparation.ports,
        dedicated: preparation.dedicated,
        pid: 4321,
        mode: 'rule'
      }
      return { status: 'started', state: structuredClone(local) }
    }
    if (channel === 'relayStatus')
      return {
        name: 'Relay',
        version: 'fixture',
        upstream: 'fixture',
        nativeReady: true,
        coreRunning: local.owned
      }
    if (channel === 'relayReadPreferences')
      return {
        source: 'defaults',
        preferences: { httpPort: 18191, node: 'fixture-node', internalExceptions: '' },
        revision: 'd'.repeat(64),
        warnings: []
      }
    if (channel === 'relayShellState') return shell
    if (channel === 'relayDesktopState') return { host: 'absent', pending: false, uncertain: false }
    if (channel === 'relayConfigEditRead')
      return {
        document: { globalOverrides: [], profileOverrides: [], controlled: {} },
        revision: '',
        exists: false
      }
    if (channel === 'relayConfigEditPreview') {
      assert.deepEqual(input, {
        profile: { id: profile.id, sha256: profile.sha256 },
        globalOverrides: [],
        profileOverrides: [],
        controlled: {}
      })
      return { order: [], configuration: {} }
    }
    if (channel === 'relayTunStatus')
      return {
        helper: 'missing',
        warnings: [],
        session: {
          phase: 'idle',
          pending: false,
          owned: false,
          traffic: 'inactive',
          restorationVerified: false,
          protectionVerified: false,
          warnings: []
        }
      }
    if (channel === 'relaySystemProxyState') return { pending: false, observed: true }
    if (channel === 'relayCoreOwnerState')
      return { phase: 'idle', pending: false, owned: false, uncertain: false, warnings: [] }
    if (channel === 'relayConnections') return { connections: [], download: 0, upload: 0 }
    if (channel === 'relayLogSnapshot') return { sequence: 0, lines: [] }
    if (channel === 'relayRuntimeInfo')
      return {
        process: local,
        interfaces: [],
        traffic: { download: 0, upload: 0 },
        externalIpLookupWired: false,
        remoteLatencyProbeWired: false,
        warnings: []
      }
    if (channel === 'applyTheme' || channel === 'setNativeTheme') return
    // Ancillary panels remain mounted. Refuse their unimplemented read lanes;
    // never fabricate success for an unexpected mutation or a startup action.
    if (
      /^(get|mihomo)/.test(channel) ||
      /(Read|State|List|Status|Inspect|Readiness)$/.test(channel)
    ) {
      rejectedAncillaryReads.push(channel)
      throw new Error('Unimplemented ancillary fixture read: ' + channel)
    }
    unexpectedActions.push(channel)
    throw new Error('Unexpected fixture action: ' + channel)
  })
  await page.addInitScript(() => {
    const listeners = new Map()
    window.electron = {
      process: { platform: 'darwin' },
      ipcRenderer: {
        invoke: (...args) => window.__relayStartTestInvoke(...args),
        send: () => {},
        on: (name, callback) => {
          const callbacks = listeners.get(name) ?? new Set()
          callbacks.add(callback)
          listeners.set(name, callbacks)
          return () => callbacks.delete(callback)
        },
        removeListener: (name, callback) => listeners.get(name)?.delete(callback),
        removeAllListeners: (name) => listeners.delete(name)
      }
    }
    window.api = { webUtils: {} }
  })
  try {
    await page.goto(pathToFileURL(join(renderer, 'index.html')).href + '#/relay?panel=core')
    const panel = page.locator('[data-relay-settings="core"]')
    await panel.getByText('已读取保存的启动设置。', { exact: true }).waitFor()
    const button = panel.getByRole('button', { name: '启动代理', exact: true })
    await button.waitFor()
    if (changed) await panel.getByLabel('本地 混合端口', { exact: true }).fill('18192')
    const startIndex = calls.length
    await button.click()
    if (changed)
      await panel.getByText('配置启用未确认，请核对下方运行状态。', { exact: true }).waitFor()
    else await panel.getByText('运行中 · 127.0.0.1:18191', { exact: true }).waitFor()
    const chain = calls.slice(startIndex).map((call) => call.channel)
    result.buttonIPCChain = chain
    check(
      'button sends exactly one plan save',
      chain.filter((c) => c === 'relayLocalProxyPlanSave').length === 1
    )
    if (changed) {
      check('changed settings reach the existing recovery barrier', guardCalls === 1)
      check(
        'rejected save never selects, prepares or starts a core',
        !chain.some((c) =>
          ['changeCurrentProfile', 'relayLocalProxyPrepare', 'relayLocalProxyAction'].includes(c)
        )
      )
      check(
        'renderer retains the edited draft after refusal',
        (await panel.getByLabel('本地 混合端口', { exact: true }).inputValue()) === '18192'
      )
      check('failed save leaves the fixture core idle', !local.owned)
    } else {
      const expected = [
        'relayLocalProxyPlanSave',
        'changeCurrentProfile',
        'getProfileConfig',
        'relayLocalProxyPrepare',
        'relayLocalProxyAction',
        'relayLocalProxyState'
      ]
      let position = -1
      for (const channel of expected) {
        position = chain.indexOf(channel, position + 1)
        assert(position >= 0, 'Missing ordered startup IPC: ' + channel)
      }
      check('actual button reaches selection, preparation, start and final state readback', true)
      check('unchanged settings never enter the recovery write barrier', guardCalls === 0)
      check(
        'only one fixture core start occurs',
        chain.filter((c) => c === 'relayLocalProxyAction').length === 1
      )
      check(
        'running state refers to the clicked profile',
        local.owned && local.profileId === profile.id
      )
    }
    const afterBytes = await readFile(store.path),
      afterStat = await lstat(store.path)
    check(
      'saved plan bytes and inode are unchanged',
      beforeBytes.equals(afterBytes) &&
        beforeStat.dev === afterStat.dev &&
        beforeStat.ino === afterStat.ino
    )
    check('saved plan permissions remain private', (afterStat.mode & 0o7777) === 0o600)
    check('no unexpected fixture actions', unexpectedActions.length === 0)
    check('no uncaught renderer errors', pageErrors.length === 0)
    result.plan = {
      sha256: sha(afterBytes),
      inodeUnchanged: beforeStat.ino === afterStat.ino,
      bytesUnchanged: beforeBytes.equals(afterBytes)
    }
    result.guardCalls = guardCalls
    result.passed = true
  } catch (error) {
    result.failure = error.stack ?? String(error)
    result.failurePageText = await page
      .locator('body')
      .innerText()
      .catch(() => '')
    throw error
  } finally {
    result.pageErrors = pageErrors
    result.consoleErrors = consoleErrors
    result.blockedExternalRequests = blockedRequests
    result.rejectedAncillaryReads = [...new Set(rejectedAncillaryReads)]
    result.unexpectedActions = unexpectedActions
    await context.close()
  }
}

try {
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    args: [
      '--allow-file-access-from-files',
      '--disable-background-networking',
      '--disable-component-update'
    ]
  })
  await scenario(false)
  await scenario(true)
  report.passed = true
} catch (error) {
  report.failure = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })))
  report.temporaryDataRemoved = true
  report.finishedAt = new Date().toISOString()
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(
    JSON.stringify({
      passed: report.passed,
      output,
      scenarios: report.scenarios.map(({ name, passed, checks }) => ({
        name,
        passed,
        checks: checks.length
      })),
      failure: report.failure
    })
  )
}
