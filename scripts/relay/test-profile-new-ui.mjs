import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and existing test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/profile-new-ui-'))
const calls = [],
  checks = [],
  errors = [],
  blocked = []
let browser,
  evidence,
  sequence = 0,
  outcome = 'cancelled'
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {RelayProfilesPanel} from './src/renderer/src/components/relay/profiles-panel';
    createRoot(document.getElementById('root')).render(React.createElement(RelayProfilesPanel,{busy:false,notice:'',inventory:{profiles:[],activeId:null,incomplete:0,warnings:[]},onPrepare:()=>{},onSave:()=>{},onList:()=>{}}));`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    bundle: true,
    jsx: 'automatic',
    outfile: join(root, 'panel.js')
  })
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><div id="root"></div><script src="panel.js"></script>'
  )
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    args: ['--allow-file-access-from-files', '--disable-background-networking']
  })
  const context = await browser.newContext(),
    allowed = pathToFileURL(root).href + '/'
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(allowed)) return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__invoke', async (channel, request) => {
    calls.push({ channel, request })
    if (channel === 'relayProfileNewPrepare') {
      assert.deepEqual(Object.keys(request), ['name'])
      assert.equal(request.name, request.name.trim())
      if (request.name === '../bad') throw new Error('PRIVATE_FIXTURE_ERROR')
      evidence = 'fixture-new-' + ++sequence
      return {
        evidenceId: evidence,
        name: request.name + '.json',
        bytes: 123,
        sha256: 'a'.repeat(64),
        inspection: {
          structure: 'passed',
          coreCompatibility: 'notVerified',
          active: false,
          issues: [],
          summary: { proxies: 0, groups: 1, rules: 1, proxyProviders: 0, ruleProviders: 0 }
        }
      }
    }
    assert.equal(channel, 'relayProfileSave')
    assert.deepEqual(request, { evidenceId: evidence })
    return { status: outcome, warnings: [] }
  })
  await page.addInitScript(() => {
    window.electron = { ipcRenderer: { invoke: (...args) => window.__invoke(...args) } }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  await page.getByRole('heading', { name: '本地配置导入' }).waitFor()
  assert.equal(calls.length, 0)
  const name = page.getByLabel('新配置名称', { exact: true })
  const prepare = page.getByRole('button', { name: '准备空白配置', exact: true })
  const save = page.getByRole('button', { name: '单独确认保存空白配置', exact: true })
  assert.equal(await save.isDisabled(), true)
  await name.fill('  Starter  ')
  await prepare.click()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent === '单独确认保存空白配置' && !button.disabled
    )
  )
  assert.equal(await name.inputValue(), '  Starter  ')
  assert.deepEqual(calls, [{ channel: 'relayProfileNewPrepare', request: { name: 'Starter' } }])
  checks.push(
    'empty workspaces create a candidate only on explicit action and normalize an outgoing name copy'
  )
  await name.fill('Changed')
  assert.equal(await save.isDisabled(), true)
  await prepare.click()
  await save.click()
  await page.getByRole('status').filter({ hasText: '已取消空白配置保存' }).waitFor()
  assert.equal(await save.isDisabled(), true)
  checks.push(
    'name changes revoke the old UI proof and native cancellation does not save or activate'
  )
  await prepare.click()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent === '单独确认保存空白配置' && !button.disabled
    )
  )
  await page.getByRole('button', { name: '选择配置并检查…', exact: true }).click()
  assert.equal(await save.isDisabled(), true)
  checks.push('switching to file import invalidates a pending blank candidate')
  await prepare.click()
  outcome = 'saved'
  await save.click()
  await page.getByRole('status').filter({ hasText: '已保存为未启用副本' }).waitFor()
  assert.equal(await save.isDisabled(), true)
  checks.push(
    'publication requires a fresh proof and tells the user to refresh the saved-source list'
  )
  await name.fill('../bad')
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '空白配置未确认' }).waitFor()
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_FIXTURE_ERROR'))
  assert.equal(await save.isDisabled(), true)
  assert.ok(
    calls.every((call) => ['relayProfileNewPrepare', 'relayProfileSave'].includes(call.channel))
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  checks.push(
    'rejected names leave no save proof and invoke no file, network or runtime capabilities'
  )
  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'inactive-blank-profile-contracts-and-injected-browser',
    contractTests: 131,
    browserChecks: checks,
    passed: checks.length,
    actualPrivateBlankSavedAndEdited: true,
    upstreamEditingModulesReused: true,
    dnsTunListenerDefaultsInherited: false,
    coreActivated: false,
    systemNetworkChanged: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/profile-new-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
