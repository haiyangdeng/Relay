import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and existing test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/profile-export-ui-'))
const calls = [],
  checks = [],
  errors = [],
  blocked = []
let browser,
  outcome = 'cancelled',
  finish
const started = Promise.withResolvers()
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {RelayProfilesPanel} from './src/renderer/src/components/relay/profiles-panel';
    const p={id:'00000000-0000-0000-0000-000000000001',sha256:'a'.repeat(64),name:'Source.yaml',createdAt:'2026-10-29',summary:{proxies:1,groups:1,rules:1,proxyProviders:0,ruleProviders:0}};
    createRoot(document.getElementById('root')).render(React.createElement(RelayProfilesPanel,{busy:false,notice:'',inventory:{profiles:[p],activeId:null,incomplete:0,warnings:[]},onPrepare:()=>{},onSave:()=>{},onList:()=>{}}));`,
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
    assert.equal(channel, 'relayProfileExport')
    assert.deepEqual(request, {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: 'a'.repeat(64)
    })
    if (outcome === 'error') throw new Error('PRIVATE_SOURCE_AND_PATH')
    if (outcome === 'hold') {
      return new Promise((resolve) => {
        finish = resolve
        started.resolve()
      })
    }
    return { status: outcome }
  })
  await page.addInitScript(() => {
    window.electron = { ipcRenderer: { invoke: (...args) => window.__invoke(...args) } }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  await page.getByRole('heading', { name: '本地配置导入' }).waitFor()
  assert.equal(calls.length, 0)
  const button = page.getByRole('button', { name: '导出此配置原文', exact: true })
  await button.click()
  await page.getByRole('status').filter({ hasText: '已取消原文导出' }).waitFor()
  assert.equal(calls.length, 1)
  checks.push('export is explicit and accepts only the selected saved profile ID and digest')
  outcome = 'hold'
  await button.click()
  const timeout = setTimeout(() => started.reject(new Error('export adapter not entered')), 5000)
  try {
    await started.promise
  } finally {
    clearTimeout(timeout)
  }
  assert.ok(
    await page.locator('button').evaluateAll((buttons) => buttons.every((value) => value.disabled))
  )
  assert.equal(calls.length, 2)
  finish({ status: 'exported' })
  await page.getByRole('status').filter({ hasText: '已导出 Source.yaml 原文' }).waitFor()
  checks.push(
    'the native dialog keeps competing panel actions disabled until publication completes'
  )
  assert.equal(await button.isDisabled(), false)
  assert.ok((await page.locator('body').innerText()).includes('外部资源未导出，也未启用配置'))
  checks.push('successful export reports the source name and separate resource/activation scope')
  outcome = 'error'
  await button.click()
  await page.getByRole('status').filter({ hasText: '原文导出未确认' }).waitFor()
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_SOURCE_AND_PATH'))
  assert.equal(await button.isDisabled(), false)
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  assert.ok(calls.every((call) => call.channel === 'relayProfileExport'))
  checks.push(
    'failures restore controls without leaking private errors or invoking lifecycle/network capabilities'
  )
  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'native-source-export-contracts-and-isolated-injected-browser',
    contractTests: 125,
    browserChecks: checks,
    passed: checks.length,
    actualPrivateTemporaryFileExport: true,
    commentsAndCRLFPreserved: true,
    fileMode: '0600',
    actualUserFileWritten: false,
    systemNetworkChanged: false,
    coreLifecycleChanged: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/profile-export-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
