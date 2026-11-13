// Actual React/HeroUI controls + hook, synthetic IPC only. No Native/Core/server.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Explicit private tools required')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href),
  app = process.cwd(),
  require = createRequire(import.meta.url),
  root = await mkdtemp(resolve('.relay-build/active-rule-providers-ui-')),
  checks = [],
  calls = [],
  pageErrors = [],
  external = [],
  releases = new Set(),
  id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  owners = [id(300), id(301), id(302)],
  resource = {
    name: 'Correct cache',
    id: id(1),
    sha256: 'e'.repeat(64),
    kind: 'rule-yaml',
    behavior: 'domain',
    selector: '',
    size: 30,
    createdAt: '2026-11-02T00:00:00Z',
    integrity: 'notChecked'
  },
  resources = [
    resource,
    { ...resource, id: id(2), name: 'Wrong format', kind: 'rule-text' },
    { ...resource, id: id(3), name: 'Wrong behavior', behavior: 'ipcidr' }
  ],
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
let browser,
  context,
  page,
  failure,
  stage = 'setup',
  blocked,
  readStatus = 'snapshot',
  replaceStatus = 'cancelled',
  badGroups = false,
  currentSHA = 'c'.repeat(64),
  generation = 'b'.repeat(64),
  serial = 1
const within = async (promise, milliseconds = 8000) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Private fixture deadline')), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
const snapshot = (owner) => ({
  sessionId: owner,
  configurationRevision: 'a'.repeat(64),
  generationSHA256: generation,
  providers: ['First', 'Alias'].map((name) => ({
    name,
    kind: 'rule-yaml',
    behavior: 'domain',
    fileSHA256: currentSHA,
    bytes: 30,
    ruleCount: 2
  })),
  groups: badGroups ? [['First']] : [['First', 'Alias']]
})
const hold = (channel) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  releases.add(release)
  blocked = { channel, entered, release }
  return { entered: entered.promise, release: () => release.resolve() }
}
const button = (name) => page.getByRole('button', { name, exact: true }),
  status = (text) => page.getByRole('status').filter({ hasText: text }),
  count = (channel) => calls.filter((call) => call.channel === channel).length,
  idle = () => page.getByTestId('owned-busy').filter({ hasText: 'false' }).waitFor(),
  read = async () => {
    await button('读取当前提供者回执').click()
    await status('已读取本地运行文件回执').waitFor()
    await idle()
  },
  choose = async () => {
    await button('选择 First').click()
    await button('读取规则缓存摘要').click()
    await status('已读取私有规则缓存摘要').waitFor()
    await idle()
    await page.getByLabel('匹配规则缓存').selectOption(resource.id)
    await read()
    await button('确认替换运行文件…').waitFor({ state: 'visible' })
    assert.equal(await button('确认替换运行文件…').isEnabled(), true)
  },
  setOwner = async (owner) => {
    await page.evaluate((value) => window.__setOwner(value), owner)
    await page.getByTestId('owner').filter({ hasText: owner }).waitFor()
  }
try {
  await writeFile(
    join(root, 'fixture.tsx'),
    `import React,{StrictMode,useState} from 'react';import{createRoot}from'react-dom/client';import{HeroUIProvider}from'@heroui/react';import{RelayResourcesPanel}from ${JSON.stringify(join(app, 'src/renderer/src/components/relay/resources-panel'))};function App(){const[owner,setOwner]=useState(${JSON.stringify(owners[0])}),[busy,setBusy]=useState(false),[foreign,setForeign]=useState(false),[key,setKey]=useState(0),[shown,setShown]=useState(true);window.__setOwner=setOwner;window.__foreign=setForeign;window.__remount=()=>setKey(v=>v+1);window.__shown=setShown;return <HeroUIProvider><div data-testid="owner">{owner}</div><div data-testid="owned-busy">{String(busy)}</div><div data-testid="generation">{key}</div><div data-testid="foreign">{String(foreign)}</div>{shown&&<RelayResourcesPanel key={key} tunSessionId={owner} busy={busy||foreign||!!owner} activeBusy={busy||foreign} onBusy={v=>{window.__busyTrace.push(v);setBusy(v);if(v&&window.__invalidateOnBusy){window.__invalidateOnBusy=false;window.__emit('relayBackupPreparationsInvalidated')}}}/>}</HeroUIProvider>};createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);`
  )
  const bundled = await build({
    entryPoints: [join(root, 'fixture.tsx')],
    outfile: join(root, 'bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    metafile: true,
    loader: { '.ttf': 'file' },
    plugins: [
      {
        name: 'existing-private-raw-and-forbidden-legacy',
        setup(builder) {
          builder.onResolve({ filter: /^@renderer\/utils\/ipc$/ }, () => ({
            path: 'forbidden-legacy',
            namespace: 'private-fixture'
          }))
          builder.onLoad({ filter: /.*/, namespace: 'private-fixture' }, () => ({
            loader: 'js',
            contents:
              "const forbidden=()=>{window.__legacyCalls=(window.__legacyCalls||0)+1;throw Error('Legacy IPC forbidden')};export{forbidden as getFileStr,forbidden as setFileStr,forbidden as convertMrsRuleset,forbidden as getRuntimeConfig}"
          }))
          builder.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: require.resolve(args.path.slice(0, -4)),
            namespace: 'raw-file'
          }))
          builder.onLoad({ filter: /.*/, namespace: 'raw-file' }, async (args) => ({
            contents: 'export default ' + JSON.stringify(await readFile(args.path, 'utf8')),
            loader: 'js'
          }))
        }
      }
    ],
    alias: { '@renderer': join(app, 'src/renderer/src') },
    define: { 'process.env.NODE_ENV': '"development"' }
  })
  assert.ok(
    Object.keys(bundled.metafile.inputs).some((path) =>
      path.endsWith('components/relay/resources-panel.tsx')
    )
  )
  assert.ok(
    !Object.keys(bundled.metafile.inputs).some((path) =>
      path.endsWith('components/relay/resources-panel.js')
    )
  )
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;margin:24px;max-width:1000px}button,input,select{margin:5px;padding:6px}button:disabled{opacity:.5}.relay-action,.flex{display:flex;align-items:center;gap:8px}.flex-1{flex:1}.py-3{padding:10px}.border-b{border-bottom:1px solid #ddd}code{overflow-wrap:anywhere}</style><div id="root"></div><script src="bundle.js"></script>'
  )
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    timeout: 15000,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--no-default-browser-check',
      '--disable-sync'
    ]
  })
  context = await within(browser.newContext({ viewport: { width: 1280, height: 1000 } }))
  await context.route(/^https?:/u, async (route) => {
    external.push(route.request().url())
    await route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.exposeFunction('__invoke', async (channel, request) => {
    calls.push({ channel, request: structuredClone(request) })
    let response
    if (channel === 'relayResourceState') response = { phase: 'idle', pending: false }
    else if (channel === 'relayResourceList')
      response = { resources: structuredClone(resources), incomplete: 0, warnings: [] }
    else if (channel === 'relayTunRuleProvidersRead')
      response =
        readStatus === 'snapshot'
          ? {
              status: 'snapshot',
              sessionId: request.sessionId,
              snapshot: snapshot(request.sessionId)
            }
          : { status: readStatus, sessionId: request.sessionId }
    else if (channel === 'relayTunRuleProviderReplace') {
      assert.deepEqual(request, {
        sessionId: request.sessionId,
        configurationRevision: 'a'.repeat(64),
        expectedGenerationSHA256: generation,
        provider: 'First',
        resource: { id: resource.id, sha256: resource.sha256 }
      })
      if (replaceStatus === 'updated') {
        currentSHA = resource.sha256
        generation = sha('generation-' + serial++)
      }
      response = ['updated', 'unchanged'].includes(replaceStatus)
        ? {
            status: replaceStatus,
            sessionId: request.sessionId,
            snapshot: snapshot(request.sessionId)
          }
        : { status: replaceStatus, sessionId: request.sessionId }
    } else throw new Error('Unapproved/legacy IPC: ' + channel)
    const gate = blocked?.channel === channel ? blocked : undefined
    if (gate) {
      blocked = undefined
      gate.entered.resolve()
      await gate.release.promise
    }
    return structuredClone(response)
  })
  await page.addInitScript(() => {
    window.__busyTrace = []
    window.__listeners = {}
    window.__emit = (name) => {
      for (const listener of window.__listeners[name] ?? []) listener()
    }
    window.electron = {
      ipcRenderer: {
        invoke: (...args) => window.__invoke(...args),
        on: (name, listener) => {
          ;(window.__listeners[name] ??= []).push(listener)
          return () => {
            window.__listeners[name] = window.__listeners[name].filter((item) => item !== listener)
          }
        }
      }
    }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  await page.getByRole('heading', { name: '当前自有TUN · 规则提供者运行文件' }).waitFor()
  assert.equal(calls.filter((call) => call.channel !== 'relayResourceState').length, 0)
  assert.equal(await button('准备资源获取').isDisabled(), true)
  assert.equal(await button('读取当前提供者回执').isEnabled(), true)
  assert.equal(await button('确认替换运行文件…').isDisabled(), true)
  checks.push(
    'actual ResourcesPanel/StrictMode + stableTUN props use only inherited resourceState reads; zero new active/cache IPC, old acquisition locked and new explicit read enabled'
  )

  stage = 'read/select'
  await read()
  assert.equal(await page.getByLabel('匹配规则缓存').count(), 0)
  await choose()
  const options = await page.getByLabel('匹配规则缓存').locator('option').allTextContents()
  assert.equal(options.length, 2)
  assert.ok(options[1].includes('Correct cache'))
  await page.getByText('同组所有名称：First、Alias', { exact: false }).waitFor()
  await page.getByText('本地运行文件SHA256（不是Core内存摘要）', { exact: false }).waitFor()
  checks.push(
    'explicit read, full compact alias group, and only matching kind/behavior cache selection; no memory-SHA claim'
  )

  stage = 'cancel/update'
  const beforeCancel = count('relayTunRuleProviderReplace')
  await button('确认替换运行文件…').click()
  await status('cancelled').waitFor()
  await idle()
  assert.equal(count('relayTunRuleProviderReplace'), beforeCancel + 1)
  assert.equal(await button('确认替换运行文件…').isDisabled(), true)
  checks.push(
    'Native cancellation yields no usable ACK, no automatic read/write or permission reuse'
  )
  replaceStatus = 'updated'
  await read()
  await button('确认替换运行文件…').click()
  await status('已收到本地运行文件操作回执').waitFor()
  await idle()
  assert.ok((await page.locator('body').innerText()).includes(currentSHA))
  checks.push(
    'explicit replacement sends only current owner/config/head/provider/resource ID+SHA and displays verified local-file result'
  )

  stage = 'cache-epoch'
  await page.getByLabel('匹配规则缓存').selectOption('')
  assert.equal(await button('确认替换运行文件…').isDisabled(), true)
  await page.getByLabel('匹配规则缓存').selectOption(resource.id)
  await read()
  badGroups = true
  await button('读取当前提供者回执').click()
  await status('元数据读取未确认').waitFor()
  await idle()
  assert.equal(await button('确认替换运行文件…').isDisabled(), true)
  badGroups = false
  checks.push(
    'cache selection revokes prior action snapshot; malformed group ACK cannot mix a new revision with stale controls'
  )

  stage = 'owner-late'
  const heldRead = hold('relayTunRuleProvidersRead')
  await button('读取当前提供者回执').click()
  await within(heldRead.entered)
  await setOwner(owners[1])
  assert.equal(await page.getByTestId('owned-busy').innerText(), 'true')
  heldRead.release()
  await idle()
  assert.equal(await button('选择 First').count(), 0)
  checks.push(
    'changed session rejects held old read and retains parent busy until the RPC actually settles'
  )

  stage = 'foreign/reentrant'
  await page.evaluate(() => window.__foreign(true))
  await page.getByTestId('foreign').filter({ hasText: 'true' }).waitFor()
  const foreignTrace = await page.evaluate(() => window.__busyTrace.slice())
  assert.equal(await button('读取当前提供者回执').isDisabled(), true)
  assert.equal(await button('读取规则缓存摘要').isDisabled(), true)
  assert.deepEqual(await page.evaluate(() => window.__busyTrace), foreignTrace)
  await page.evaluate(() => window.__foreign(false))
  await page.getByTestId('foreign').filter({ hasText: 'false' }).waitFor()
  const reentrantCount = calls.length
  await page.evaluate(() => {
    window.__invalidateOnBusy = true
  })
  await button('读取当前提供者回执').click()
  await idle()
  assert.equal(calls.length, reentrantCount)
  checks.push(
    'foreign busy never releases another owner; synchronous parent busy callback invalidation prevents any new IPC'
  )

  stage = 'hide-late'
  const hiddenRead = hold('relayTunRuleProvidersRead')
  await button('读取当前提供者回执').click()
  await within(hiddenRead.entered)
  await page.evaluate(() => window.__emit('relayBackupPreparationsInvalidated'))
  assert.equal(await page.getByTestId('owned-busy').innerText(), 'true')
  hiddenRead.release()
  await idle()
  assert.equal(await button('选择 First').count(), 0)
  checks.push(
    'hide invalidation clears observations without cancel RPC or premature busy release; late read cannot refill'
  )

  stage = 'unknown/remount'
  await read()
  await choose()
  replaceStatus = 'uncertain'
  const unknown = hold('relayTunRuleProviderReplace')
  await button('确认替换运行文件…').click()
  await within(unknown.entered)
  await page.evaluate(() => window.__emit('relayBackupPreparationsInvalidated'))
  unknown.release()
  await idle()
  await page.getByRole('alert').filter({ hasText: '已隔离' }).waitFor()
  const isolatedCount = calls.filter((call) => call.channel !== 'relayResourceState').length
  await page.evaluate(() => window.__remount())
  await page.getByTestId('generation').filter({ hasText: '1' }).waitFor()
  assert.equal(await button('读取当前提供者回执').isDisabled(), true)
  assert.equal(calls.filter((call) => call.channel !== 'relayResourceState').length, isolatedCount)
  checks.push(
    'late uncertain result latches the old session across hide/remount with zero read-adopt/retry'
  )

  stage = 'new-session/unsupported'
  await setOwner(owners[2])
  readStatus = 'unsupported'
  await button('读取当前提供者回执').click()
  await status('当前会话尚不支持提供者刷新').waitFor()
  await idle()
  assert.equal(await button('确认替换运行文件…').isDisabled(), true)
  readStatus = 'snapshot'
  await read()
  checks.push(
    'new session may explicitly read, unsupported capability does not fall back to legacy updater or localProxy'
  )

  stage = 'navigation/restore'
  for (const event of ['hashchange', 'relayDataRestored']) {
    const before = calls.length
    await page.evaluate((name) => {
      if (name === 'hashchange') window.dispatchEvent(new HashChangeEvent(name))
      else window.__emit(name)
    }, event)
    await button('选择 First').waitFor({ state: 'detached' })
    assert.equal(calls.length, before)
    assert.equal(await button('确认替换运行文件…').isDisabled(), true)
    await read()
  }
  checks.push(
    'navigation and restored-data invalidation clear action state with no automatic read, retry or adoption'
  )

  stage = 'unmount/drain'
  const unmounted = hold('relayTunRuleProvidersRead')
  await button('读取当前提供者回执').click()
  await within(unmounted.entered)
  await page.evaluate(() => window.__shown(false))
  await page
    .getByRole('heading', { name: '当前自有TUN · 规则提供者运行文件' })
    .waitFor({ state: 'detached' })
  assert.equal(await page.getByTestId('owned-busy').innerText(), 'true')
  unmounted.release()
  await idle()
  checks.push(
    'unmount retains the owned pending lane until real settlement and makes no cancellation or background calls'
  )
  assert.equal(await page.evaluate(() => window.__legacyCalls || 0), 0)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(external, [])
} catch (error) {
  failure = error
  const path =
    process.env.RELAY_UI_FAILURE_OUTPUT ??
    '/private/tmp/relay-active-rule-providers-ui-failure.json'
  await writeFile(
    path,
    JSON.stringify(
      {
        stage,
        error: String(error),
        root,
        calls,
        checks,
        pageErrors,
        external,
        body: await page
          ?.locator('body')
          .innerText()
          .catch(() => '')
      },
      null,
      2
    ) + '\n'
  ).catch(() => {})
} finally {
  blocked?.release.resolve()
  for (const release of releases) release.resolve()
}
const cleanup = await Promise.allSettled([
    context && within(context.close()),
    browser && within(browser.close())
  ]),
  errors = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason)
if (failure || errors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...errors],
    'Private active provider UI fixture failed; source home retained'
  )
await rm(root, { recursive: true, force: true })
const source = await Promise.all(
  [
    'src/renderer/src/hooks/use-relay-active-rule-providers.tsx',
    'src/renderer/src/components/relay/active-rule-providers-panel.tsx',
    'src/renderer/src/components/relay/resources-panel.tsx',
    'scripts/relay/test-active-rule-providers-ui.mjs'
  ].map(async (path) => ({ path, sha256: sha(await readFile(path)) }))
)
const output =
  process.env.RELAY_UI_VERIFICATION_OUTPUT ??
  '../evidence/active-rule-providers-ui-browser-verification-20261102.json'
await writeFile(
  output,
  JSON.stringify(
    {
      scope:
        'Actual ResourcesPanel -> active provider hook/React/HeroUI with workspace-equivalent stableTUN props; inherited resourceState reads disclosed, synthetic IPC only; no Native/Core/business network',
      source,
      checks,
      count: checks.length,
      external,
      pageErrors,
      calls,
      ownedCleanup: 'context/browser closed and generated fixture removed before proof'
    },
    null,
    2
  ) + '\n'
)
console.log(JSON.stringify({ passed: checks.length, output }))
