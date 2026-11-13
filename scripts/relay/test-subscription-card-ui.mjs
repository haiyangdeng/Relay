// Actual card/menu components, synthetic IPC; no real profiles, core or network.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Explicit private browser tools required')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const dir = await mkdtemp(resolve('.relay-build/subscription-card-ui-'))
const id = '00000000-0000-4000-8000-000000000001'
const profile = {
  id,
  name: '本地验收.yaml',
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-09T00:00:00Z',
  summary: { proxies: 1, groups: 1, rules: 2, proxyProviders: 0, ruleProviders: 0 }
}
let profiles = [profile],
  sources = [],
  revision = 'b'.repeat(64),
  importMode = 'cancel',
  browser,
  page
const calls = [],
  errors = [],
  external = [],
  checks = []
const inventory = () => ({ profiles, incomplete: 0, activeId: null, warnings: [] })
try {
  await build({
    stdin: {
      contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{HeroUIProvider}from'@heroui/react';import i18n from'i18next';import{initReactI18next}from'react-i18next';import{RelaySubscriptionsDashboard}from'./src/renderer/src/components/relay/subscriptions-dashboard';function App(){const[busy,setBusy]=useState(false),[inventory,setInventory]=useState(${JSON.stringify(inventory())}),[active,setActive]=useState();return <HeroUIProvider disableAnimation><RelaySubscriptionsDashboard inventory={inventory} busy={busy} activeProfileId={active} onBusy={setBusy} onRefresh={async()=>setInventory(await window.electron.ipcRenderer.invoke('fixtureInventory'))} onChoose={async p=>{await window.electron.ipcRenderer.invoke('fixtureChoose',p);setActive(p.id)}} onBrowse={()=>{}} onAdvanced={()=>{}} /></HeroUIProvider>}i18n.use(initReactI18next).init({lng:'zh',resources:{zh:{translation:{'profiles.local':'本地'}}}}).then(()=>createRoot(document.getElementById('root')).render(<App/>));`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    outfile: join(dir, 'panel.js'),
    bundle: true,
    platform: 'browser',
    tsconfig: 'tsconfig.web.json',
    plugins: [
      {
        name: 'app-preference-fixture',
        setup(b) {
          b.onResolve({ filter: /hooks\/use-app-config$/ }, () => ({
            path: 'prefs',
            namespace: 'fixture'
          }))
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export const useAppConfig=()=>({appConfig:{},patchAppConfig:async()=>{}})'
          }))
        }
      }
    ]
  })
  const builtHTML = await readFile('out/renderer/index.html', 'utf8')
  const cssPath = builtHTML.match(/href="\.\/([^"\s]+\.css)"/)?.[1]
  assert(cssPath, 'Build renderer before checking styled UI')
  await writeFile(join(dir, 'app.css'), await readFile(join('out/renderer', cssPath)))
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html class="dark"><meta charset="utf-8"><link rel="stylesheet" href="app.css"><link rel="stylesheet" href="panel.css"><div id="root"></div><script src="panel.js"></script></html>'
  )
  browser = await chromium.launch({ executablePath: process.env.RELAY_CHROME, headless: true })
  const context = await browser.newContext()
  await context.route('**/*', (route) => {
    if (
      route
        .request()
        .url()
        .startsWith(pathToFileURL(dir).href + '/')
    )
      return route.continue()
    external.push(route.request().url())
    return route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', (e) => errors.push(e.message))
  await page.exposeFunction('__invoke', async (channel, input) => {
    calls.push({ channel, input })
    if (channel === 'fixtureInventory') return inventory()
    if (channel === 'relaySourceList') return { sources, incomplete: 0, warnings: [] }
    if (channel === 'getProfileStr') {
      assert.deepEqual(input, { id, sha256: profile.sha256 })
      return 'proxies: []\nrules: [MATCH,REJECT]'
    }
    if (channel === 'relayLibraryList')
      return {
        revision,
        items: profiles.map((p) => ({
          kind: 'profile',
          id: p.id,
          name: p.name,
          revision,
          hidden: false,
          active: false,
          scheduled: false,
          ownerRevision: revision
        }))
      }
    if (channel === 'relayLibraryChange') {
      assert.equal(input.expectedRevision, revision)
      assert.equal(input.id, id)
      assert.equal(input.kind, 'profile')
      if (input.action === 'rename') profiles = [{ ...profile, name: input.name }]
      else if (input.action === 'hide') profiles = []
      else throw Error('Unexpected library action')
      revision = 'c'.repeat(64)
      return { revision, items: [] }
    }
    if (channel === 'relayProfileExport') return { status: 'cancelled' }
    if (channel === 'relayProfilePrepare')
      return importMode === 'cancel'
        ? undefined
        : {
            evidenceId: id,
            name: profile.name,
            sha256: profile.sha256,
            bytes: 50,
            inspection: {
              structure: importMode === 'bad' ? 'rejected' : 'passed',
              coreCompatibility: 'notVerified',
              active: false,
              issues: importMode === 'bad' ? ['结构错误'] : []
            }
          }
    if (channel === 'relayProfileSave') {
      assert.deepEqual(input, { evidenceId: id })
      profiles = [profile]
      return { status: 'saved', profile, warnings: [] }
    }
    if (channel === 'fixtureChoose') return
    throw Error('Unexpected synthetic IPC ' + channel)
  })
  await page.addInitScript(() => {
    window.electron = { ipcRenderer: { invoke: (c, p) => window.__invoke(c, p) } }
  })
  await page.goto(pathToFileURL(join(dir, 'index.html')).href)
  const button = (name) => page.getByRole('button', { name, exact: true })
  await button('管理配置 本地验收.yaml').waitFor()
  await button('管理配置 本地验收.yaml').click()
  await page.getByRole('menuitem', { name: '查看原文', exact: true }).click()
  await page.getByText('proxies: []', { exact: false }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  assert(!calls.some((c) => c.channel === 'fixtureChoose'))
  checks.push('card menu reads pinned original without activation')
  await button('管理配置 本地验收.yaml').click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  await page.getByRole('textbox', { name: '配置显示名称' }).fill('主要本地节点')
  await button('保存').click()
  await button('管理配置 主要本地节点').waitFor()
  checks.push('rename pins library revision and refreshes card')
  await button('管理配置 主要本地节点').click()
  await page.getByRole('menuitem', { name: '移出列表', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '移出列表', exact: true }).click()
  await page.getByText('添加第一个订阅').waitFor()
  checks.push('hide explicit dialog updates list without deleting original')
  const count = (channel) => calls.filter((c) => c.channel === channel).length
  await button('导入本地配置').click()
  await page.getByRole('status').filter({ hasText: '已取消导入' }).waitFor()
  assert.equal(count('relayProfileSave'), 0)
  importMode = 'bad'
  await button('导入本地配置').click()
  await page.getByRole('status').filter({ hasText: '结构错误' }).waitFor()
  assert.equal(count('relayProfileSave'), 0)
  importMode = 'valid'
  await button('导入本地配置').click()
  await button('管理配置 本地验收.yaml').waitFor()
  assert.equal(count('relayProfileSave'), 1)
  checks.push('local import cancellation/rejection never saves; valid import checks and saves once')
  await button('使用配置 本地验收.yaml').click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="使用配置 本地验收.yaml"]')
        ?.getAttribute('aria-pressed') === 'true'
  )
  assert.equal(count('fixtureChoose'), 1)
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  checks.push('click card uses it once and displays confirmed active state')
  const remote = {
    ...profile,
    id: '00000000-0000-4000-8000-000000000002',
    name: '缺少到期时间的订阅'
  }
  profiles.push(remote)
  sources = [
    {
      id: '00000000-0000-4000-8000-000000000003',
      name: remote.name,
      createdAt: profile.createdAt,
      versions: [{ profile: { id: remote.id, sha256: remote.sha256 } }],
      observation: { checkedAt: profile.createdAt, quota: { upload: 1, download: 3, total: 8 } }
    }
  ]
  await button('刷新订阅与配置').click()
  const remoteCard = page.locator(`[data-relay-profile-card="${remote.id}"]`)
  await remoteCard.getByRole('progressbar').waitFor()
  assert.equal(await remoteCard.getByRole('progressbar').getAttribute('aria-valuenow'), '50')
  assert(!(await remoteCard.innerText()).includes('neverExpire'))
  checks.push('quota remains visible without inventing expiration when metadata omits it')
  const output =
    process.env.RELAY_CARD_UI_OUTPUT ?? '.relay-build/private/r13-subscription-card-ui.json'
  await writeFile(
    output,
    JSON.stringify(
      {
        status: 'passed',
        scope: 'Actual components with synthetic IPC',
        checks,
        errors,
        external,
        calls: calls.map((c) => c.channel)
      },
      null,
      2
    ) + '\n'
  )
  console.log(JSON.stringify({ output, checks: checks.length }))
} catch (error) {
  console.error(
    JSON.stringify({
      error: String(error),
      errors,
      calls: calls.map((c) => c.channel),
      body: await page
        ?.locator('body')
        .innerText()
        .catch(() => null)
    })
  )
  throw error
} finally {
  await browser?.close()
  await rm(dir, { recursive: true, force: true })
}
