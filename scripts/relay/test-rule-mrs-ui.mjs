import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and existing test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/rule-mrs-ui-'))
const calls = [],
  checks = [],
  errors = [],
  blocked = [],
  profile = { id: '00000000-0000-0000-0000-000000000001', sha256: 'a'.repeat(64) },
  resource = { id: '00000000-0000-0000-0000-000000000002', sha256: 'b'.repeat(64) }
let browser,
  failConversion = false
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {RelayProfileRuleEditor} from './src/renderer/src/components/relay/profile-rule-editor';
    const p={...${JSON.stringify(profile)},name:'Source.yaml',createdAt:'2026-11-01',summary:{proxies:1,groups:1,rules:1,proxyProviders:0,ruleProviders:1}};
    createRoot(document.getElementById('root')).render(React.createElement(RelayProfileRuleEditor,{profile:p,busy:false,onBusy:()=>{},providers:true}));`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    bundle: true,
    tsconfig: resolve('tsconfig.web.json'),
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
    if (channel === 'relayProfileRuleProvidersRead') {
      assert.deepEqual(request, profile)
      return {
        providers: {
          CachedRules: { type: 'http', behavior: 'ipcidr', url: 'https://unused.invalid/rules' }
        }
      }
    }
    if (channel === 'relayResourceList') {
      return {
        incomplete: 0,
        warnings: [],
        resources: [
          { ...resource, name: 'Matching MRS', kind: 'rule-mrs', behavior: 'ipcidr', size: 64 },
          {
            ...resource,
            id: 'oversized',
            name: 'Oversized MRS',
            kind: 'rule-mrs',
            behavior: 'ipcidr',
            size: 2 * 1024 * 1024 + 1
          },
          {
            ...resource,
            id: 'wrong-behavior',
            name: 'Domain MRS',
            kind: 'rule-mrs',
            behavior: 'domain',
            size: 64
          },
          { ...resource, id: 'database', name: 'Database', kind: 'country-mmdb', size: 64 }
        ]
      }
    }
    if (channel === 'relayProfileRuleSnapshotPrepare') {
      assert.deepEqual(request, { profile, provider: 'CachedRules', resource })
      if (failConversion) throw new Error('PRIVATE_CONVERSION_PATH_AND_ERROR')
      return {
        evidenceId: 'snapshot-proof',
        name: 'MRS snapshot fixture',
        bytes: 128,
        sha256: 'c'.repeat(64),
        ruleSnapshot: {
          provider: 'CachedRules',
          behavior: 'ipcidr',
          resourceSHA256: resource.sha256,
          rules: 2
        }
      }
    }
    assert.equal(channel, 'relayProfileSave')
    assert.deepEqual(request, { evidenceId: 'snapshot-proof' })
    return { status: 'cancelled' }
  })
  await page.addInitScript(() => {
    window.electron = {
      ipcRenderer: { invoke: (...args) => window.__invoke(...args), on: () => () => {} }
    }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  await page.getByRole('heading', { name: '配置规则提供者编辑：Source.yaml' }).waitFor()
  assert.equal(calls.length, 0)
  const save = page.getByRole('button', { name: '单独确认另存规则提供者配置', exact: true })
  assert.ok(await save.isDisabled())
  await page.getByRole('button', { name: '读取规则提供者草稿', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已读取规则提供者定义' }).waitFor()
  await page.getByRole('button', { name: '读取已缓存规则资源', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已读取4个缓存候选元数据' }).waitFor()
  const candidates = page.getByLabel('对应规则缓存')
  assert.deepEqual(
    await candidates.locator('option').evaluateAll((items) => items.map((x) => x.value)),
    ['', resource.id]
  )
  await candidates.selectOption(resource.id)
  checks.push('reads are explicit and only a matching MRS within the 2MiB budget is selectable')

  const prepare = page.getByRole('button', { name: '准备固化为内联规则快照', exact: true })
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '内联规则快照已准备' }).waitFor()
  assert.equal(await save.isDisabled(), false)
  assert.equal(calls.filter((call) => call.channel === 'relayProfileSave').length, 0)
  assert.ok((await page.locator('body').innerText()).includes('MRS snapshot fixture'))
  checks.push(
    'snapshot preparation binds the saved profile, provider and resource digest without saving'
  )

  failConversion = true
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '规则提供者操作未通过' }).waitFor()
  assert.ok(await save.isDisabled())
  const failedText = await page.locator('body').innerText()
  assert.ok(!failedText.includes('PRIVATE_CONVERSION_PATH_AND_ERROR'))
  assert.ok(!failedText.includes('MRS snapshot fixture'))
  assert.equal(calls.filter((call) => call.channel === 'relayProfileSave').length, 0)
  checks.push(
    'conversion failure revokes the previous proof and shows no private diagnostics or automatic retry'
  )

  failConversion = false
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '内联规则快照已准备' }).waitFor()
  await save.click()
  await page.getByRole('status').filter({ hasText: '已取消另存' }).waitFor()
  assert.ok(await save.isDisabled())
  assert.equal(calls.filter((call) => call.channel === 'relayProfileSave').length, 1)
  assert.ok(!(await page.locator('body').innerText()).includes('已另存'))
  checks.push(
    'publication is a separate explicit action and native cancellation never claims a save'
  )

  const draft = page.getByLabel('规则提供者高级JSON草稿')
  await draft.fill((await draft.inputValue()) + '\n')
  assert.ok(await prepare.isDisabled())
  await page.getByText('定义草稿已修改，请先另存并选择新配置，或重新读取原配置后固化。').waitFor()
  assert.ok(await save.isDisabled())
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  checks.push('unsaved definition edits disable cache freezing and revoke any pending save proof')

  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-injected-browser-MRS-rule-snapshot-editor',
    browserChecks: checks,
    passed: checks.length,
    nativeElectronWindowAccepted: false,
    actualConversionExecuted: false,
    actualUserFileWritten: false,
    externalRequests: blocked.length,
    systemNetworkChanged: false,
    coreLifecycleChanged: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    process.env.RELAY_UI_VERIFICATION_OUTPUT || '../evidence/rule-mrs-ui-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
