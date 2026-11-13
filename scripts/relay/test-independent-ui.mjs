import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Set the existing authorized Playwright module and test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const baseline = JSON.parse(readFileSync('../evidence/preview-fixtures.json', 'utf8'))
const profile = {
  id: '00000000-0000-4000-8000-000000000031',
  name: 'UI fixture',
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-27T00:00:00Z',
  summary: { proxies: 1, groups: 0, rules: 1, proxyProviders: 0, ruleProviders: 0 }
}
const idle = {
  phase: 'idle',
  pending: false,
  owned: false,
  hasRecord: false,
  uncertain: false,
  traffic: 'inactive',
  groups: [],
  systemProxyChanged: false,
  liveGuardEnabled: false,
  warnings: []
}
let local = { ...idle },
  prepared,
  connections = [
    {
      id: 'ui-connection',
      metadata: { host: 'example.invalid', destinationPort: '443', process: 'fixture-app' },
      chains: ['香港 节点 🇭🇰']
    }
  ]
let shell = {
  initialized: true,
  pending: false,
  uncertain: false,
  exists: true,
  revision: 's'.repeat(64),
  warnings: [],
  settings: {
    operationMode: 'standard',
    appTheme: 'light',
    silentStart: false,
    closeToTray: false,
    alwaysOnTop: false,
    showFloatingWindow: false,
    shortcuts: Object.fromEntries(
      [
        'showWindow',
        'showFloatingWindow',
        'ruleMode',
        'globalMode',
        'directMode',
        'copyEnv',
        'quitApp'
      ].map((key) => [key, ''])
    )
  }
}
const calls = [],
  checks = [],
  errors = []
const browser = await chromium.launch({
  executablePath: process.env.RELAY_CHROME,
  headless: true,
  args: [
    '--allow-file-access-from-files',
    '--disable-background-networking',
    '--disable-component-update'
  ]
})
const context = await browser.newContext({
  viewport: { width: 1180, height: 1000 },
  locale: 'zh-CN'
})
const root = pathToFileURL(resolve('out/renderer')).href + '/'
await context.route('**/*', (route) =>
  route.request().url().startsWith(root) || /^(data|blob):/u.test(route.request().url())
    ? route.continue()
    : route.abort()
)
const page = await context.newPage()
page.on('pageerror', (error) => errors.push(error.message))
page.on('dialog', (dialog) => dialog.accept())
await page.exposeFunction('__relayTestInvoke', async (channel, ...args) => {
  const input = args[0]
  calls.push([channel, ...args])
  if (channel === 'relayStatus')
    return { name: 'Relay', version: 'fixture', upstream: 'Clash Party v2.0.4', nativeReady: true }
  if (channel === 'relayReadPreferences')
    return {
      source: 'defaults',
      preferences: { httpPort: 7890, node: 'fixture-node', internalExceptions: '' },
      revision: 'p'.repeat(64),
      warnings: []
    }
  if (channel === 'relayConfigEditRead')
    return {
      document: { globalOverrides: [], profileOverrides: [], controlled: {} },
      revision: '',
      exists: false
    }
  if (channel === 'relayConfigEditSave')
    return { document: input.document, revision: 'e'.repeat(64), exists: true }
  if (channel === 'relayCompleteConfigurationCancel') return
  if (channel === 'relayShellState') return shell
  if (channel === 'relayShellSave') {
    shell = { ...shell, settings: input.settings }
    return shell
  }
  if (channel === 'relayDesktopState') return { host: 'absent', pending: false, uncertain: false }
  if (channel === 'relayCoreState') return { ...idle }
  if (channel === 'relayLocalProxyState') return local
  if (channel === 'relayProfileList')
    return { profiles: [profile], incomplete: 0, activeId: null, warnings: [] }
  if (channel === 'relayLocalProxyPrepare') {
    prepared = {
      evidenceId: '00000000-0000-4000-8000-000000000001',
      profile,
      httpPort: input.httpPort,
      canStart: true,
      hasRecord: false,
      warnings: [],
      runtimeSHA256: 'b'.repeat(64),
      version: 'fixture',
      dedicated: { ...input.dedicated, httpName: 'relay-ai-http', socksName: 'relay-ai-socks' }
    }
    return prepared
  }
  if (channel === 'relayLocalProxyAction') {
    local = {
      ...idle,
      phase: 'running',
      owned: true,
      hasRecord: true,
      traffic: 'listening',
      instanceId: '00000000-0000-4000-8000-000000000032',
      configurationRevision: 'b'.repeat(64),
      pid: 4321,
      mode: 'rule',
      httpPort: prepared.httpPort,
      dedicated: prepared.dedicated
    }
    return { status: 'started', state: local }
  }
  if (channel === 'relayDedicatedInspect')
    return {
      owned: { ...local, running: true, httpLive: true, socksLive: true },
      claudeCode: {
        requestedPort: input.claudeCodePort,
        listenerLive: input.claudeCodePort === prepared.dedicated.httpPort,
        refusesIfNotLive: true
      },
      codex: { exists: true, neverWrites: true, followsSystemProxy: true },
      edgeSocks: { requiredPort: 17890, ownedLive: true },
      warnings: []
    }
  if (channel === 'relayConnections') return { connections, download: 1536, upload: 256 }
  if (channel === 'relayLogs') return ['fixture diagnostic output']
  if (channel === 'relayLogSnapshot')
    return { sequence: 1, lines: [{ sequence: 1, text: 'fixture diagnostic output' }] }
  if (channel === 'relayRuntimeInfo')
    return {
      process: local,
      interfaces: [
        { name: 'lo0', addresses: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }
      ],
      traffic: { download: 1536, upload: 256 },
      externalIpLookupWired: false,
      remoteLatencyProbeWired: false,
      warnings: []
    }
  if (channel === 'mihomoCloseConnection') {
    connections = []
    return
  }
  if (channel in baseline) return baseline[channel]
  if (['applyTheme', 'setNativeTheme'].includes(channel)) return
  throw new Error('Fixture refuses untested operation: ' + channel)
})
await page.addInitScript(() => {
  const listeners = new Map()
  window.__relayFire = (channel) => {
    for (const listener of listeners.get(channel) ?? []) listener({})
  }
  window.electron = {
    process: { platform: 'darwin' },
    ipcRenderer: {
      invoke: (...args) => window.__relayTestInvoke(...args),
      send: () => undefined,
      on(channel, listener) {
        const set = listeners.get(channel) ?? new Set()
        listeners.set(channel, set)
        set.add(listener)
        return () => set.delete(listener)
      },
      removeListener: () => undefined,
      removeAllListeners: () => undefined
    }
  }
  window.api = { webUtils: {} }
})
try {
  await page.goto(pathToFileURL(resolve('out/renderer/index.html')).href + '#/relay')
  await page.getByRole('heading', { name: 'Relay', exact: true, level: 1 }).waitFor()
  await page.getByRole('button', { name: '读取已保存配置', exact: true }).click()
  await page.getByLabel('为本次实例开启AI专用监听').check()
  await page.getByLabel('固定节点名称', { exact: true }).fill('香港 节点 🇭🇰')
  await page.getByRole('button', { name: '准备 UI fixture', exact: true }).click()
  await page.getByRole('button', { name: '确认并启动本地HTTP代理…', exact: true }).click()
  assert.equal(
    calls.find(([channel]) => channel === 'relayLocalProxyPrepare')[1].dedicated.route,
    '香港 节点 🇭🇰'
  )
  assert.equal(await page.getByLabel('固定节点名称', { exact: true }).isDisabled(), true)
  checks.push('Dedicated listener draft reaches preparation and locks after owned startup')
  await page.getByRole('button', { name: '检查本次监听与客户端关联', exact: true }).click()
  await page.getByRole('button', { name: '将专用HTTP入口填入Code草稿', exact: true }).click()
  assert.equal(await page.getByLabel('HTTP / 混合端口', { exact: true }).inputValue(), '17891')
  checks.push('Verified dedicated HTTP association updates only the Code draft')
  await page.getByRole('button', { name: '读取当前快照', exact: true }).click()
  await page.getByRole('heading', { name: '实时连接（1）', exact: true }).waitFor()
  assert.equal(await page.getByText('本次核心累计下载：1.5 KiB', { exact: false }).count(), 1)
  await page.getByRole('button', { name: '关闭此连接', exact: true }).click()
  await page.getByRole('button', { name: '读取当前快照', exact: true }).click()
  await page.getByRole('heading', { name: '实时连接（0）', exact: true }).waitFor()
  const close = calls.find(([channel]) => channel === 'mihomoCloseConnection')
  assert.equal(close[1], 'ui-connection')
  assert.equal(close[2].instanceId, local.instanceId)
  assert.equal(close[2].configurationRevision, local.configurationRevision)
  checks.push('Connection snapshot shows nonzero totals and scoped close carries instance revision')
  await page.getByRole('button', { name: '读取保存的编辑与来源', exact: true }).click()
  const edited = {
    globalOverrides: [],
    profileOverrides: [],
    controlled: { sniffer: { enable: true } },
    controlSniff: true
  }
  await page.getByLabel('编辑文档 JSON', { exact: true }).fill(JSON.stringify(edited))
  await page.getByRole('button', { name: '保存编辑', exact: true }).click()
  await page.getByText('已保存版本：eeeeeeeeeeee', { exact: true }).waitFor()
  assert.equal(
    calls.find(([channel]) => channel === 'relayConfigEditSave')[1].document.controlled.sniffer
      .enable,
    true
  )
  assert.equal(calls.filter(([channel]) => channel === 'relayLocalProxyAction').length, 1)
  checks.push(
    'Configuration editor saves the persistent document without restarting or reloading a core'
  )
  await page.getByLabel('预览来源', { exact: true }).selectOption(profile.id)
  await page.getByRole('button', { name: '从草稿读入此来源覆写', exact: true }).click()
  await page
    .getByLabel('所选来源覆写 JSON', { exact: true })
    .fill(
      JSON.stringify([{ id: 'ui-profile-override', kind: 'yaml', content: 'log-level: warning' }])
    )
  assert.equal(await page.getByRole('button', { name: '保存编辑', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '将此来源覆写写入草稿', exact: true }).click()
  await page.getByRole('button', { name: '保存编辑', exact: true }).click()
  await page.getByText('已保存版本：eeeeeeeeeeee', { exact: true }).waitFor()
  const request = calls.filter(([channel]) => channel === 'relayConfigEditSave').at(-1)[1],
    library = request.document
  assert.equal(request.expectedRevision, 'e'.repeat(64))
  assert.equal(library.profileOverrideSets[0].profileId, profile.id)
  assert.equal(library.profileOverrideSets[0].overrides[0].content, 'log-level: warning')
  assert.equal(library.controlled.sniffer.enable, true)
  checks.push(
    'Profile-specific editor requires writing the local draft back before saving its isolated source group'
  )
  await page.getByRole('button', { name: '读取窗口设置', exact: true }).click()
  await page.getByLabel('界面模式', { exact: true }).selectOption('simple')
  await page.getByLabel('主题', { exact: true }).selectOption('dark')
  await page.getByRole('button', { name: '保存并应用窗口设置', exact: true }).click()
  await page.getByText('已读取本次窗口工作流状态。', { exact: false }).waitFor()
  await page.evaluate(() => window.__relayFire('relayShellUpdated'))
  await page.waitForFunction(
    () => document.querySelector('.relay-workspace')?.dataset.shellTheme === 'dark'
  )
  assert.equal(
    await page.getByRole('button', { name: '读取保存的编辑与来源', exact: true }).isVisible(),
    false
  )
  assert.equal(
    await page.getByRole('heading', { name: '连接、日志与网络信息', exact: true }).isVisible(),
    true
  )
  checks.push(
    'Saved shell preferences update the workspace theme and compact mode through the shell event'
  )
  assert.deepEqual(errors, [])
  await page.screenshot({ path: '../evidence/independent-batches-ui-fixture.png', fullPage: true })
  writeFileSync(
    '../evidence/independent-batches-ui-verification.json',
    JSON.stringify(
      {
        passed: true,
        scope: 'built-renderer-with-injected-fixture-ipc',
        checks,
        pageErrors: errors,
        liveNetworkOrClientChanges: false
      },
      null,
      2
    ) + '\n'
  )
} finally {
  await browser.close()
}
