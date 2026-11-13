import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the existing bundled Playwright and installed test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/theme-ui-'))
const calls = [],
  errors = [],
  checks = []
let browser
const { defaultShellSettings } = await import(
  pathToFileURL(resolve('src/shared/relay/shell.ts')).href
)
let state = {
  initialized: true,
  pending: false,
  uncertain: false,
  exists: false,
  revision: '',
  warnings: [],
  settings: defaultShellSettings()
}
const onlineReceipt = {
  status: 'ready',
  acquisitionId: 'mock-acquisition',
  sourceURL: 'https://github.com/mihomo-party-org/theme-hub/releases/download/latest/themes.zip',
  archiveSHA256: 'a'.repeat(64),
  archiveSize: 300,
  candidates: [{ path: 'Online.css', name: 'Online Ocean', size: 20, sha256: 'b'.repeat(64) }],
  unsupported: [
    {
      path: 'Big.css',
      declaredSize: 9000,
      reason: 'css-too-large',
      crcAndLengthVerified: false,
      utf8AndCSSVerified: false
    }
  ]
}
const onlineTheme = {
  id: '00000000-0000-4000-8000-000000000099',
  name: 'Online Ocean',
  css: 'body{color:teal}'
}
let restartReply = { status: 'cancelled' }
let reply = onlineReceipt,
  failDraft = false
let pendingAcquire, pendingDraft

try {
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {RelayShellPanel} from './src/renderer/src/components/relay/shell-panel';
    createRoot(document.getElementById('root')).render(React.createElement(RelayShellPanel,{busy:false,onBusy:()=>{}}));`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    bundle: true,
    jsx: 'automatic',
    outfile: join(root, 'panel.js')
  })
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script src="panel.js"></script></body></html>'
  )
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    args: ['--allow-file-access-from-files', '--disable-background-networking']
  })
  const context = await browser.newContext(),
    allowed = pathToFileURL(root).href + '/'
  await context.route('**/*', (route) =>
    route.request().url().startsWith(allowed) ? route.continue() : route.abort()
  )
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__invoke', async (channel, request) => {
    calls.push({ channel, request })
    if (channel === 'relayShellState') return state
    if (channel === 'relayShellAction') {
      assert.equal(request, 'restartApp')
      return restartReply
    }
    if (channel === 'relayShellThemesAcquire') {
      if (pendingAcquire) return pendingAcquire
      return reply
    }
    if (channel === 'relayShellThemesCancel') return undefined
    if (channel === 'relayShellThemesDraft') {
      if (failDraft) throw new Error('synthetic draft rejection')
      if (pendingDraft) return pendingDraft
      assert.equal(request.acquisitionId, onlineReceipt.acquisitionId)
      assert.equal(request.path, 'Online.css')
      return [...request.themes, onlineTheme]
    }
    if (channel === 'relayShellSave') {
      assert.equal(request.revision, state.revision)
      state = { ...state, settings: request.settings, revision: 'saved', exists: true }
      return state
    }
    throw new Error('Unexpected capability: ' + channel)
  })
  await page.addInitScript(() => {
    window.__listeners = {}
    window.electron = {
      ipcRenderer: {
        invoke: (...args) => window.__invoke(...args),
        on: (channel, callback) => {
          window.__listeners[channel] = callback
          return () => {
            delete window.__listeners[channel]
          }
        }
      }
    }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  await page.getByRole('heading', { name: '主题方案库', exact: true }).waitFor()
  assert.equal(calls.length, 0)
  await page.getByRole('button', { name: '读取窗口设置', exact: true }).click()
  const css = page.getByLabel('自定义界面CSS', { exact: true }),
    name = page.getByLabel('主题方案名称', { exact: true })
  const select = page.getByLabel('已保存主题方案', { exact: true })
  await css.fill('body{color:navy}')
  await name.fill('Ocean')
  await page.getByRole('button', { name: '另存为新主题方案', exact: true }).click()
  const ocean = await select.inputValue()
  await page.getByRole('button', { name: '另存为新主题方案', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '主题库未更改' }).waitFor()
  assert.equal(await select.locator('option').count(), 2)
  checks.push('adding a theme changes only the draft and duplicate names are refused')
  await css.fill('body{color:black}')
  await name.fill('Night')
  await page.getByRole('button', { name: '另存为新主题方案', exact: true }).click()
  const night = await select.inputValue()
  await name.fill('Midnight')
  await css.fill('body{color:purple}')
  await page.getByRole('button', { name: '更新所选方案', exact: true }).click()
  assert.equal(await select.locator(`option[value="${night}"]`).textContent(), 'Midnight')
  checks.push('updating or renaming retains the selected theme ID')
  await select.selectOption(ocean)
  assert.equal(await css.inputValue(), 'body{color:navy}')
  await page.getByRole('button', { name: '移除所选方案', exact: true }).click()
  assert.equal(await css.inputValue(), 'body{color:navy}')
  assert.equal(await select.locator('option').count(), 2)
  assert.equal(calls.filter((call) => call.channel === 'relayShellSave').length, 0)
  checks.push(
    'selection fills CSS without applying it; removing a template preserves the current CSS'
  )
  await page.getByRole('button', { name: '保存并应用窗口设置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已读取本次窗口工作流状态' }).waitFor()
  assert.equal(state.settings.themes.length, 1)
  assert.deepEqual(state.settings.themes[0], {
    id: night,
    name: 'Midnight',
    css: 'body{color:purple}'
  })
  assert.equal(state.settings.customCSS, 'body{color:navy}')
  await page.getByRole('button', { name: '读取窗口设置', exact: true }).click()
  assert.equal(await select.locator(`option[value="${night}"]`).textContent(), 'Midnight')
  checks.push('only explicit save persists the library and the current stylesheet independently')
  const fetch = page.getByRole('button', { name: '获取官方主题候选…', exact: true }),
    choices = page.getByLabel('在线主题候选', { exact: true }),
    add = page.getByRole('button', { name: '将所选主题加入库草稿', exact: true })
  await fetch.click()
  await choices.waitFor()
  await page.getByText('Big.css（超过8KiB，正文未展开校验）', { exact: false }).waitFor()
  await choices.selectOption('Online.css')
  await add.click()
  await page.getByRole('status').filter({ hasText: '所选主题已加入库草稿' }).waitFor()
  assert.equal(await css.inputValue(), 'body{color:navy}')
  assert.equal(await select.locator('option').count(), 3)
  assert.equal(state.settings.themes.length, 1)
  checks.push(
    'online acquisition and explicit candidate merge affect only the library draft, keeping current CSS and saved state'
  )
  await page.getByRole('button', { name: '保存并应用窗口设置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已读取本次窗口工作流状态' }).waitFor()
  assert.equal(state.settings.themes.length, 2)
  assert.equal(state.settings.customCSS, 'body{color:navy}')
  failDraft = true
  await choices.selectOption('Online.css')
  await add.click()
  await page.getByRole('status').filter({ hasText: '主题获取或合并未确认' }).waitFor()
  assert.equal(await select.locator('option').count(), 3)
  assert.equal(await css.inputValue(), 'body{color:navy}')
  failDraft = false
  reply = { status: 'cancelled' }
  await fetch.click()
  await page.getByRole('status').filter({ hasText: '主题获取已取消' }).waitFor()
  assert.equal(await choices.count(), 0)
  checks.push(
    'cancelled acquisition and rejected merge preserve both the working draft and saved library'
  )
  reply = onlineReceipt
  let releaseAcquire
  pendingAcquire = new Promise((resolve) => {
    releaseAcquire = resolve
  })
  await fetch.click()
  const cancel = page.getByRole('button', { name: '取消主题获取', exact: true })
  await cancel.waitFor()
  await cancel.click()
  releaseAcquire(onlineReceipt)
  await fetch.waitFor({ state: 'visible' })
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')].find(
        (button) => button.textContent === '获取官方主题候选…'
      )?.disabled
  )
  pendingAcquire = undefined
  assert.equal(await choices.count(), 0)
  checks.push('late acquisition after explicit cancel cannot repopulate candidates')
  await fetch.click()
  await choices.waitFor()
  await choices.selectOption('Online.css')
  let releaseDraft
  pendingDraft = new Promise((resolve) => {
    releaseDraft = resolve
  })
  await add.click()
  await page.evaluate(() => window.__listeners.relayShellThemesInvalidated())
  releaseDraft([
    ...state.settings.themes,
    { ...onlineTheme, id: '00000000-0000-4000-8000-000000000098', name: 'Late' }
  ])
  await page.getByRole('status').filter({ hasText: '迟到结果未合并' }).waitFor()
  pendingDraft = undefined
  assert.equal(await select.locator('option').count(), 3)
  assert.equal(await css.inputValue(), 'body{color:navy}')
  assert.equal(await choices.count(), 0)
  checks.push(
    'invalidation during an in-flight draft merge rejects its late response without resetting edits'
  )
  const restart = page.getByRole('button', { name: '重启Relay…', exact: true })
  const savedBeforeRestart = JSON.stringify(state)
  await restart.click()
  await page.getByRole('status').filter({ hasText: '已取消重启，未安排重新打开' }).waitFor()
  assert.equal(JSON.stringify(state), savedBeforeRestart)
  assert.equal(await css.inputValue(), 'body{color:navy}')
  restartReply = { status: 'requested' }
  await restart.click()
  await page.getByRole('status').filter({ hasText: '仍需完成现有恢复与退出确认' }).waitFor()
  assert.equal(JSON.stringify(state), savedBeforeRestart)
  restartReply = { status: 'unexpected' }
  await restart.click()
  await page.getByRole('status').filter({ hasText: '操作未确认，当前编辑草稿已保留' }).waitFor()
  assert.equal(JSON.stringify(state), savedBeforeRestart)
  assert.equal(await css.inputValue(), 'body{color:navy}')
  checks.push(
    'restart cancellation is reported as cancelled, acceptance remains a pending request, and malformed receipts preserve edits'
  )
  assert.deepEqual(errors, [])
  const result = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-browser-with-injected-shell-ipc',
    checks,
    passed: checks.length,
    actualDesktopThemeChanged: false,
    actualDesktopRestarted: false,
    actualCoreStopped: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    process.env.RELAY_UI_RESULT ?? '../evidence/p38-restart-ui-verification-20261103-r2.json',
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 }
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
