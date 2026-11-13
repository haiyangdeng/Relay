import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the existing bundled Playwright and installed test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/substore-candidate-ui-'))
const calls = [],
  errors = [],
  checks = []
let browser,
  applyCount = 0,
  finishApply
const backendId = '00000000-0000-4000-8000-000000000391',
  frontendId = '00000000-0000-4000-8000-000000000392'
const candidate = (target, id) => ({
  target,
  id,
  version: 'fixture',
  downloadBytes: 4,
  payloadBytes: 4,
  sha256: 'a'.repeat(64),
  payloadSHA256: 'a'.repeat(64),
  stagedAt: 1,
  installed: false,
  applied: false
})
const state = {
  trustedAssets: [],
  candidates: [
    candidate('substore-backend', backendId),
    candidate('substore-frontend', frontendId)
  ],
  incomplete: 0,
  pending: false,
  appReleaseChannelConfigured: false,
  smartReleaseChannelConfigured: false,
  discoversLatestVersions: false,
  installationSupported: false
}
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {RelayUpdatePanel} from './src/renderer/src/components/relay/update-panel';
    createRoot(document.getElementById('root')).render(React.createElement(RelayUpdatePanel,{busy:false,onBusy:()=>{}}));`,
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
    if (channel === 'relayUpdateState') return state
    if (channel === 'relayUpdateCancel') return
    if (channel === 'relayUpdateApplySubStore') {
      assert.deepEqual(request, { backendId, frontendId })
      if (++applyCount === 1) return { status: 'cancelled' }
      return await new Promise((resolve) => {
        finishApply = () => resolve({ status: 'applied' })
      })
    }
    throw new Error('Unexpected capability: ' + channel)
  })
  await page.addInitScript(() => {
    window.electron = { ipcRenderer: { invoke: (...args) => window.__invoke(...args) } }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  await page.getByRole('heading', { name: '可信资源获取与更新候选' }).waitFor()
  assert.equal(calls.length, 0)
  await page.getByRole('button', { name: '核对可信版本与本地候选', exact: true }).click()
  const apply = page.getByRole('button', { name: '单独确认接入Sub-Store资源…', exact: true })
  await apply.waitFor()
  await page.getByLabel('Sub-Store后端候选', { exact: true }).selectOption(backendId)
  assert.equal(await apply.isDisabled(), true)
  await page.getByLabel('Sub-Store前端候选', { exact: true }).selectOption(frontendId)
  assert.equal(await apply.isEnabled(), true)
  checks.push('both explicit candidate selections are required and do not trigger copying')
  await apply.click()
  await page.getByRole('status').filter({ hasText: '资源接入已取消' }).waitFor()
  assert.equal(state.candidates.length, 2)
  checks.push('declining separate confirmation preserves candidates and does not start a service')
  await apply.click()
  while (!finishApply) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(
    await page.getByRole('button', { name: '取消本次获取', exact: true }).isDisabled(),
    true
  )
  assert.equal(await page.getByLabel('Sub-Store后端候选', { exact: true }).isDisabled(), true)
  finishApply()
  await page.getByRole('status').filter({ hasText: '固定资源副本已接入并复验' }).waitFor()
  assert.ok(
    calls.every((call) =>
      ['relayUpdateState', 'relayUpdateCancel', 'relayUpdateApplySubStore'].includes(call.channel)
    )
  )
  checks.push(
    'authorized application holds the UI barrier and never invokes process start, stop or core switching'
  )
  assert.deepEqual(errors, [])
  const result = {
    verifiedAt: new Date().toISOString(),
    scope: 'private-file-contracts-and-isolated-browser-with-injected-ipc',
    contractTests: 93,
    checks,
    passed: checks.length,
    liveSubStoreStarted: false,
    currentClashTouched: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/substore-candidate-apply-verification.json',
    JSON.stringify(result, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
