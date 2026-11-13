import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and an isolated test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/configuration-edit-revision-ui-')),
  calls = [],
  checks = [],
  errors = [],
  blocked = [],
  empty = { globalOverrides: [], profileOverrides: [], controlled: {} },
  profileId = '00000000-0000-0000-0000-000000000001',
  inheritedId = '00000000-0000-0000-0000-000000000002'
let record = { document: structuredClone(empty), revision: '', exists: false },
  browser
const publish = (document) => {
  record = {
    document: structuredClone(document),
    revision: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    exists: true
  }
}
publish({
  ...empty,
  profileRulePatchSets: [{ profileId, rulePatch: { prepend: ['DOMAIN,original.test,DIRECT'] } }]
})
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {RelayConfigurationEditPanel} from './src/renderer/src/components/relay/configuration-edit-panel';
createRoot(document.getElementById('root')).render(React.createElement(RelayConfigurationEditPanel,{busy:false,onBusy:()=>{}}));`,
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
    if (channel === 'relayConfigEditRead') return structuredClone(record)
    if (channel === 'relayProfileList')
      return { profiles: [], incomplete: 0, activeId: null, warnings: [] }
    if (channel === 'relayCompleteConfigurationCancel') return
    assert.ok(['relayConfigEditSave', 'relayConfigEditClear'].includes(channel))
    assert.equal(typeof request.expectedRevision, 'string')
    if (request.expectedRevision !== record.revision) throw new Error('PRIVATE-stale-edit-revision')
    if (channel === 'relayConfigEditSave') {
      assert.deepEqual(Object.keys(request).sort(), ['document', 'expectedRevision'])
      publish(request.document)
      return structuredClone(record)
    }
    assert.deepEqual(Object.keys(request), ['expectedRevision'])
    record = { document: structuredClone(empty), revision: '', exists: false }
  })
  await page.addInitScript(() => {
    window.electron = { ipcRenderer: { invoke: (...args) => window.__invoke(...args) } }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  const read = page.getByRole('button', { name: '读取保存的编辑与来源', exact: true }),
    save = page.getByRole('button', { name: '保存编辑', exact: true }),
    clear = page.getByRole('button', { name: '清除保存的编辑', exact: true }),
    draft = page.getByLabel('编辑文档 JSON', { exact: true })
  await read.waitFor()
  assert.equal(calls.length, 0)
  assert.ok(await save.isDisabled())
  await read.click()
  await page.getByRole('status').filter({ hasText: '已读取保存的编辑' }).waitFor()
  const beforeInvalid = record.revision,
    savesBeforeInvalid = calls.filter((call) => call.channel === 'relayConfigEditSave').length
  await draft.fill('{invalid JSON')
  await save.click()
  await page.getByRole('status').filter({ hasText: '草稿保留，可修正后重试' }).waitFor()
  assert.equal(
    calls.filter((call) => call.channel === 'relayConfigEditSave').length,
    savesBeforeInvalid
  )
  assert.equal(await save.isDisabled(), false)
  await draft.fill(JSON.stringify({ ...record.document, controlSniff: true }))
  await save.click()
  await page.getByRole('status').filter({ hasText: '已保存。' }).waitFor()
  assert.equal(
    calls.filter((call) => call.channel === 'relayConfigEditSave').at(-1).request.expectedRevision,
    beforeInvalid
  )
  checks.push(
    'invalid local JSON sends no write and retains the read revision so correcting the draft can save without a destructive reread'
  )
  const oldRevision = record.revision,
    changed = { ...record.document, controlSniff: false }
  await draft.fill(JSON.stringify(changed))
  publish({
    ...record.document,
    profileRulePatchSets: [
      ...record.document.profileRulePatchSets,
      { profileId: inheritedId, rulePatch: { prepend: ['DOMAIN,inherited.test,DIRECT'] } }
    ]
  })
  const inherited = structuredClone(record)
  await save.click()
  await page.getByRole('status').filter({ hasText: '草稿保留，请重新读取' }).waitFor()
  assert.equal(
    calls.filter((call) => call.channel === 'relayConfigEditSave').at(-1).request.expectedRevision,
    oldRevision
  )
  assert.deepEqual(record, inherited)
  assert.deepEqual(JSON.parse(await draft.inputValue()), changed)
  assert.ok(await save.isDisabled())
  checks.push(
    'a draft keeps its read revision after typing; a concurrent inherited scope makes the old save fail without changing current data or discarding the draft'
  )

  await read.click()
  await page.getByRole('status').filter({ hasText: '已读取保存的编辑' }).waitFor()
  await draft.fill(JSON.stringify({ ...record.document, controlSniff: true }))
  await save.click()
  await page.getByRole('status').filter({ hasText: '已保存。' }).waitFor()
  assert.equal(record.document.profileRulePatchSets.length, 2)
  assert.equal(record.document.controlSniff, true)
  assert.equal(
    calls.filter((call) => call.channel === 'relayConfigEditSave').at(-1).request.expectedRevision,
    inherited.revision
  )
  checks.push(
    're-reading supplies the new revision and scopes; a subsequent explicit save preserves both old and newly inherited entries'
  )

  publish({ ...record.document, controlDns: false })
  const beforeClear = structuredClone(record)
  await clear.click()
  await page.getByRole('status').filter({ hasText: '草稿保留，请重新读取' }).waitFor()
  assert.deepEqual(record, beforeClear)
  assert.ok(await save.isDisabled())
  await read.click()
  await page.getByRole('status').filter({ hasText: '已读取保存的编辑' }).waitFor()
  await clear.click()
  await page.getByRole('status').filter({ hasText: '已清除保存的编辑' }).waitFor()
  assert.equal(record.exists, false)
  assert.equal(
    calls.filter((call) => call.channel === 'relayConfigEditClear').at(-1).request.expectedRevision,
    beforeClear.revision
  )
  await save.click()
  await page.getByRole('status').filter({ hasText: '已保存。' }).waitFor()
  assert.equal(
    calls.filter((call) => call.channel === 'relayConfigEditSave').at(-1).request.expectedRevision,
    ''
  )
  checks.push(
    'clear also rejects a stale revision; after a fresh read it can clear and explicitly recreate a document from the absent revision'
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-'))
  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-injected-configuration-edit-revision-ui',
    checks,
    passed: checks.length,
    actualUserFileWritten: false,
    externalRequests: 0,
    systemNetworkChanged: false,
    coreLifecycleChanged: false,
    nativeElectronWindowAccepted: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/configuration-edit-revision-ui-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
