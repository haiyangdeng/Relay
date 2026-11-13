import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use bundled Playwright and the existing private test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/rule-provider-ui-'))
const output = resolve(
  process.env.RELAY_UI_VERIFICATION_OUTPUT ||
    '../evidence/rule-provider-structured-ui-browser-verification-20261102.json'
)
const failureOutput = resolve(
  process.env.RELAY_UI_FAILURE_OUTPUT || '/private/tmp/relay-rule-provider-ui-failure.json'
)
const calls = [],
  checks = [],
  errors = [],
  blocked = []
const profile = {
  id: '00000000-0000-4000-8000-000000000033',
  sha256: 'a'.repeat(64),
  name: 'Provider source.yaml',
  createdAt: '2026-11-02',
  summary: { proxies: 0, groups: 0, rules: 1, proxyProviders: 0, ruleProviders: 2 }
}
const original = {
  First: {
    type: 'http',
    behavior: 'domain',
    format: 'yaml',
    url: 'https://private.invalid/SECRET',
    interval: 0,
    header: { 'X-Private': ['KEEP'] },
    payload: ['preserved inactive fallback']
  },
  Other: {
    type: 'inline',
    behavior: 'domain',
    payload: [' untouched.invalid '],
    header: { Hidden: ['KEEP'] },
    interval: 0
  }
}
const resource = {
  id: '00000000-0000-4000-8000-000000000034',
  sha256: 'b'.repeat(64),
  name: 'Matching checked cache',
  kind: 'rule-yaml',
  behavior: 'domain',
  size: 40
}
let browser,
  context,
  page,
  failure,
  saved = false,
  cancelSave = true,
  preparedProviders,
  failPrepare = false,
  holdPrepare = false,
  releasePrepare,
  enteredPrepare
const deadline = setTimeout(() => {
  void browser?.close().catch(() => {})
}, 60000)
try {
  await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{RelayProfileRuleEditor}from'./src/renderer/src/components/relay/profile-rule-editor';function App(){const[busy,setBusy]=React.useState(false);const[current,setCurrent]=React.useState(${JSON.stringify(profile)});window.__setBusy=setBusy;window.__setProfile=setCurrent;return <RelayProfileRuleEditor profile={current} busy={busy} onBusy={v=>window.__busyTrace.push(v)} providers/>}createRoot(document.getElementById('root')).render(<App/>);`,
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
    '<!doctype html><style>body{margin:20px;font:14px sans-serif}button{margin:5px;padding:7px}textarea{width:95%}section[role=dialog]{position:fixed;inset:20px;background:white;overflow:auto;z-index:20}input{min-height:26px}label{display:block}fieldset{margin:8px}</style><div id="root"></div><script src="panel.js"></script>'
  )
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    timeout: 15000,
    args: [
      '--allow-file-access-from-files',
      '--disable-background-networking',
      '--disable-component-update'
    ]
  })
  context = await browser.newContext()
  const allowed = pathToFileURL(root).href + '/'
  await context.route('**/*', (route) => {
    if (
      route.request().url().startsWith(allowed) ||
      route.request().url().startsWith('data:') ||
      route.request().url().startsWith('blob:')
    )
      return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__invoke', async (channel, request) => {
    calls.push({ channel, request })
    if (channel === 'relayProfileRuleProvidersRead') {
      assert.deepEqual(request, { id: profile.id, sha256: profile.sha256 })
      return { profile, providers: structuredClone(original) }
    }
    if (channel === 'relayProfileRulesRead')
      return {
        profile,
        rules: ['RULE-SET,First,REJECT'],
        providers: ['First', 'Other'],
        subRules: [],
        targets: ['DIRECT', 'REJECT', 'Private target']
      }
    if (channel === 'relayProfileRuleProvidersPrepare') {
      assert.equal(request.profile.id, profile.id)
      if (holdPrepare) {
        enteredPrepare?.()
        await new Promise((resolve) => {
          releasePrepare = resolve
        })
      }
      if (failPrepare || !request.providers.First) throw new Error('PRIVATE_REFERENCE_ERROR')
      preparedProviders = structuredClone(request.providers)
      return {
        evidenceId: '00000000-0000-4000-8000-000000000035',
        name: 'Provider new copy.json',
        sha256: 'c'.repeat(64),
        bytes: 400
      }
    }
    if (channel === 'relayProfileSave') {
      if (!cancelSave) saved = true
      return cancelSave
        ? { status: 'cancelled' }
        : {
            status: 'saved',
            profile: {
              ...profile,
              id: '00000000-0000-4000-8000-000000000036',
              name: 'Provider new copy.json'
            }
          }
    }
    if (channel === 'relayResourceList')
      return {
        resources: [resource, { ...resource, id: 'wrong', behavior: 'ipcidr' }],
        incomplete: 0,
        warnings: []
      }
    if (channel === 'relayProfileRuleSnapshotPrepare') {
      assert.deepEqual(request, {
        profile: { id: profile.id, sha256: profile.sha256 },
        provider: 'First',
        resource: { id: resource.id, sha256: resource.sha256 }
      })
      return {
        evidenceId: '00000000-0000-4000-8000-000000000037',
        name: 'Frozen new copy.json',
        sha256: 'd'.repeat(64),
        bytes: 600,
        ruleSnapshot: {
          provider: 'First',
          behavior: 'domain',
          resourceSHA256: resource.sha256,
          rules: 1
        }
      }
    }
    throw new Error('Unexpected legacy or unapproved channel ' + channel)
  })
  await page.addInitScript(() => {
    window.__busyTrace = []
    window.__listeners = {}
    window.__emit = (name) => {
      for (const fn of window.__listeners[name] || []) fn()
    }
    window.electron = {
      ipcRenderer: {
        invoke: (...args) => window.__invoke(...args),
        on: (name, fn) => {
          ;(window.__listeners[name] ??= []).push(fn)
          return () => (window.__listeners[name] = window.__listeners[name].filter((f) => f !== fn))
        }
      }
    }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  await page.getByRole('heading', { name: '配置规则提供者编辑：Provider source.yaml' }).waitFor()
  assert.equal(calls.length, 0)
  await page.getByRole('button', { name: '读取规则提供者草稿', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已读取规则提供者定义' }).waitFor()
  const draft = page.getByLabel('规则提供者高级JSON草稿')
  assert.deepEqual(JSON.parse(await draft.inputValue()), original)
  checks.push(
    'initial render is inert; explicit read shows saved definitions with no runtime count or updater request'
  )
  await page.getByRole('button', { name: '编辑规则集 First', exact: true }).click()
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '应用到草稿', exact: true }) })
  await dialog.getByLabel('URL', { exact: true }).fill('https://changed.invalid/rules')
  await dialog.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已应用到本地草稿' }).waitFor()
  const changed = JSON.parse(await draft.inputValue())
  assert.equal(changed.First.url, 'https://changed.invalid/rules')
  assert.equal(changed.First.interval, 0)
  assert.deepEqual(changed.First.header, original.First.header)
  assert.deepEqual(changed.First.payload, original.First.payload)
  assert.deepEqual(changed.Other, original.Other)
  assert.equal(
    calls.filter(
      (c) => c.channel === 'relayProfileRuleProvidersPrepare' || c.channel === 'relayProfileSave'
    ).length,
    0
  )
  checks.push(
    'the actual original provider Modal edits only its draft and preserves private headers, zero and other raw inline entries'
  )
  await page.getByRole('button', { name: '检查规则提供者并准备副本', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已准备规则提供者定义' }).waitFor()
  assert.deepEqual(preparedProviders, changed)
  await page.getByRole('button', { name: '单独确认另存规则提供者配置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已取消另存' }).waitFor()
  assert.equal(saved, false)
  checks.push(
    'prepare submits the complete draft; independent native cancellation never reports a save'
  )
  cancelSave = false
  await page.getByRole('button', { name: '检查规则提供者并准备副本', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已准备规则提供者定义' }).waitFor()
  await page.getByRole('button', { name: '单独确认另存规则提供者配置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已另存Provider new copy.json' }).waitFor()
  assert.equal(saved, true)
  checks.push(
    'a separate positive save acknowledgement names a new UUID copy without changing the original or claiming active provider replacement'
  )
  await page
    .getByRole('button', { name: '重新读取并放弃未另存规则提供者草稿', exact: true })
    .click()
  await page.getByRole('status').filter({ hasText: '已读取规则提供者定义' }).waitFor()
  await page.getByRole('button', { name: '读取已缓存规则资源', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已读取2个缓存候选元数据' }).waitFor()
  assert.deepEqual(
    await page
      .getByLabel('对应规则缓存')
      .locator('option')
      .evaluateAll((xs) => xs.map((x) => x.value)),
    ['', resource.id]
  )
  await page.getByLabel('对应规则缓存').selectOption(resource.id)
  await page.getByRole('button', { name: '准备固化为内联规则快照', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '内联规则快照已准备' }).waitFor()
  checks.push(
    'the existing cache-freeze path binds exact original profile/provider and matching cache digest; incompatible behavior is excluded'
  )
  await page.getByRole('button', { name: '编辑规则集 Other', exact: true }).click()
  const inline = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '应用到草稿', exact: true }) })
  assert.equal(
    await inline.getByLabel('规则 1 内容', { exact: true }).inputValue(),
    ' untouched.invalid '
  )
  await inline.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await inline.waitFor({ state: 'detached' })
  assert.deepEqual(JSON.parse(await draft.inputValue()).Other, original.Other)
  checks.push(
    'unchanged inline entries retain their exact whitespace and hidden recognized fields when applied from the real form'
  )
  await page.getByRole('button', { name: '新增规则提供者草稿', exact: true }).click()
  let modal = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '应用到草稿', exact: true }) })
  await modal.getByLabel('名称', { exact: true }).fill('Added')
  await modal.getByLabel('URL', { exact: true }).fill('https://new.invalid/rules')
  await modal.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await modal.waitFor({ state: 'detached' })
  assert.equal(JSON.parse(await draft.inputValue()).Added.interval, 3600)
  await page.getByLabel('筛选规则提供者定义').fill('Added')
  assert.equal(await page.getByRole('button', { name: '编辑规则集 First', exact: true }).count(), 0)
  assert.equal(Object.keys(JSON.parse(await draft.inputValue())).length, 3)
  await page.getByLabel('筛选规则提供者定义').fill('')
  checks.push(
    'new providers use the actual original form; filtering never truncates the complete draft map'
  )
  await page.getByRole('button', { name: '编辑规则集 First', exact: true }).click()
  modal = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '应用到草稿', exact: true }) })
  await modal.getByLabel('名称', { exact: true }).fill('Other')
  assert.ok(await modal.getByRole('button', { name: '应用到草稿', exact: true }).isDisabled())
  await modal.getByLabel('名称', { exact: true }).fill('Renamed')
  await modal.getByRole('button', { name: '应用到草稿', exact: true }).click()
  await modal.waitFor({ state: 'detached' })
  const renamed = await draft.inputValue()
  const savesBefore = calls.filter((c) => c.channel === 'relayProfileSave').length
  await page.getByRole('button', { name: '检查规则提供者并准备副本', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '规则提供者操作未通过' }).waitFor()
  assert.equal(await draft.inputValue(), renamed)
  assert.ok(
    await page.getByRole('button', { name: '单独确认另存规则提供者配置', exact: true }).isDisabled()
  )
  assert.equal(calls.filter((c) => c.channel === 'relayProfileSave').length, savesBefore)
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_REFERENCE_ERROR'))
  checks.push(
    'duplicate names cannot apply; rename remains a local draft and backend reference rejection preserves it with no save or rewritten rules'
  )
  await page.getByRole('button', { name: '删除规则集 Other', exact: true }).click()
  const removing = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '删除', exact: true }) })
  await removing.getByRole('button', { name: '删除', exact: true }).click()
  await removing.waitFor({ state: 'detached' })
  assert.equal(Object.hasOwn(JSON.parse(await draft.inputValue()), 'Other'), false)
  assert.equal(Object.hasOwn(JSON.parse(await draft.inputValue()), 'Renamed'), true)
  checks.push(
    'the real confirmation removes only the requested local draft entry without updating runtime state'
  )
  await draft.fill('{invalid PRIVATE_DRAFT')
  await page.getByRole('alert').filter({ hasText: '高级JSON无效' }).waitFor()
  assert.ok(
    await page.getByRole('button', { name: '新增规则提供者草稿', exact: true }).isDisabled()
  )
  const preparesBefore = calls.filter(
    (c) => c.channel === 'relayProfileRuleProvidersPrepare'
  ).length
  await page.getByRole('button', { name: '检查规则提供者并准备副本', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '规则提供者操作未通过' }).waitFor()
  assert.equal(
    calls.filter((c) => c.channel === 'relayProfileRuleProvidersPrepare').length,
    preparesBefore
  )
  assert.equal(await draft.inputValue(), '{invalid PRIVATE_DRAFT')
  checks.push(
    'invalid advanced JSON preserves its exact draft, blocks structural edits and sends no prepare request'
  )
  const opaque = { ...original, Opaque: { type: { toString: null }, behavior: 'domain' } }
  await draft.fill(JSON.stringify(opaque))
  await page.getByRole('button', { name: '编辑规则集 Opaque', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '无法无损投影' }).waitFor()
  assert.deepEqual(JSON.parse(await draft.inputValue()), opaque)
  assert.equal(await page.getByRole('button', { name: '应用到草稿', exact: true }).count(), 0)
  checks.push(
    'unprojectable advanced values remain visible as drafts without coercion, blank fallback, a broken render or a misleading modal'
  )
  await page
    .getByRole('button', { name: '重新读取并放弃未另存规则提供者草稿', exact: true })
    .click()
  await page.getByRole('status').filter({ hasText: '已读取规则提供者定义' }).waitFor()
  failPrepare = true
  await page.getByRole('button', { name: '检查规则提供者并准备副本', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '规则提供者操作未通过' }).waitFor()
  assert.deepEqual(JSON.parse(await draft.inputValue()), original)
  assert.ok(
    await page.getByRole('button', { name: '单独确认另存规则提供者配置', exact: true }).isDisabled()
  )
  failPrepare = false
  checks.push(
    'failed prepare does not reuse an old cache or definition proof and leaves the full source draft intact'
  )
  holdPrepare = true
  const entered = new Promise((resolve) => {
    enteredPrepare = resolve
  })
  await page.getByRole('button', { name: '检查规则提供者并准备副本', exact: true }).click()
  let gateTimer
  try {
    await Promise.race([
      entered,
      new Promise((_, reject) => {
        gateTimer = setTimeout(() => reject(new Error('Held prepare never entered')), 6000)
      })
    ])
  } finally {
    clearTimeout(gateTimer)
  }
  await page.evaluate(() => window.__emit('relayBackupPreparationsInvalidated'))
  await draft.waitFor({ state: 'detached' })
  assert.equal(await draft.count(), 0)
  assert.equal(await page.evaluate(() => window.__busyTrace.at(-1)), true)
  releasePrepare()
  await page.waitForFunction(() => window.__busyTrace.at(-1) === false)
  assert.equal(await draft.count(), 0)
  assert.ok(
    await page.getByRole('button', { name: '单独确认另存规则提供者配置', exact: true }).isDisabled()
  )
  holdPrepare = false
  checks.push(
    'hidden-view invalidation clears private drafts and late proofs while owned busy remains held until the original prepare settles'
  )
  await page.getByRole('button', { name: '读取规则提供者草稿', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已读取规则提供者定义' }).waitFor()
  const countBeforeSourceChange = calls.length
  await page.evaluate((next) => window.__setProfile(next), {
    ...profile,
    id: '00000000-0000-4000-8000-000000000038',
    sha256: 'e'.repeat(64),
    name: 'Changed profile.yaml'
  })
  await page.getByRole('heading', { name: '配置规则提供者编辑：Changed profile.yaml' }).waitFor()
  assert.equal(await draft.count(), 0)
  assert.equal(calls.length, countBeforeSourceChange)
  assert.ok(
    await page.getByRole('button', { name: '单独确认另存规则提供者配置', exact: true }).isDisabled()
  )
  checks.push(
    'changing the saved profile identity mounts an unread context with no inherited provider draft, proof or automatic IO'
  )
  await page.evaluate(() => window.__setBusy(true))
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('button')).find(
        (x) => x.textContent === '读取规则提供者草稿'
      )?.disabled
  )
  assert.equal(await page.evaluate(() => window.__busyTrace.at(-1)), false)
  checks.push('foreign busy disables new work without claiming or clearing its ownership')
  assert.deepEqual(blocked, [])
  assert.deepEqual(errors, [])
} catch (error) {
  failure = error
  try {
    await writeFile(
      failureOutput,
      JSON.stringify(
        {
          error: String(error),
          calls,
          checks,
          errors,
          blocked,
          body: await page
            ?.locator('body')
            .innerText()
            .catch(() => ''),
          root
        },
        null,
        2
      ) + '\n'
    )
    await page
      ?.screenshot({ path: failureOutput.replace(/\.json$/u, '.png'), fullPage: true })
      .catch(() => {})
  } catch (diagnosticError) {
    failure = new AggregateError([error, diagnosticError], 'Failure diagnostics were not saved')
  }
}
const cleanup = await Promise.allSettled([context?.close(), browser?.close()])
clearTimeout(deadline)
const cleanupErrors = cleanup.filter((r) => r.status === 'rejected').map((r) => String(r.reason))
if (failure || cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors],
    'Provider UI fixture failed; private evidence retained'
  )
const sources = [
  'src/renderer/src/components/resources/rule-provider-editor-modal.tsx',
  'src/renderer/src/components/resources/rule-provider-definition-list.tsx',
  'src/renderer/src/components/relay/profile-rule-editor.tsx',
  'src/renderer/src/utils/relay-rule-providers.ts'
]
const proof = {
  recordedAt: new Date().toISOString(),
  scope:
    'private injected IPC browser with actual HeroUI provider Modal/list; no real Native, persistence or Core invoked',
  checks,
  passed: checks.length,
  externalRequests: blocked.length,
  pageErrors: errors,
  sourcesSHA256: Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [
        p,
        createHash('sha256')
          .update(await readFile(p))
          .digest('hex')
      ])
    )
  ),
  fixtureRoot: root,
  browserClosed: true,
  productAcceptance: 'pending'
}
await writeFile(output, JSON.stringify(proof, null, 2) + '\n')
process.stdout.write(JSON.stringify({ output, passed: checks.length }) + '\n')
