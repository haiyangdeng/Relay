// Real passive Viewer/Monaco/YAML worker + injected readonly cache IPC only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, lstat, rm } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, stop } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Explicit private Playwright and Chrome paths required')
const require = createRequire(import.meta.url),
  app = process.cwd(),
  root = await mkdtemp(resolve('.relay-build/rule-resource-preview-ui-')),
  sha = (value) => createHash('sha256').update(value).digest('hex'),
  id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
  kinds = ['rule-yaml', 'rule-text', 'rule-mrs', 'geoip-dat', 'runtime-file'],
  resources = kinds.map((kind, index) => ({
    id: id(index + 1),
    sha256: String(index + 1).repeat(64),
    kind,
    name: 'Selected ' + kind,
    behavior: kind.startsWith('rule-') ? 'domain' : null,
    selector: kind === 'geoip-dat' ? 'CN' : '',
    size: 100,
    createdAt: '2026-11-02T00:00:00Z',
    integrity: 'notChecked'
  })),
  checks = [],
  calls = [],
  errors = [],
  blocked = [],
  cleanup = { context: false, browser: false, server: false, privateBundle: false },
  { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const sources = [
  'src/renderer/src/components/resources/viewer.tsx',
  'src/renderer/src/components/relay/rule-resource-preview-modal.tsx',
  'src/renderer/src/components/relay/resources-panel.tsx',
  'src/renderer/src/components/relay/resources-panel.test.ts',
  'src/renderer/src/components/base/base-editor.tsx',
  'src/shared/relay/resources.ts',
  'scripts/relay/test-rule-resource-preview-ui.mjs'
]
const hashes = async () =>
  Object.fromEntries(await Promise.all(sources.map(async (p) => [p, sha(await readFile(p))])))
const sourceSHA256 = await hashes(),
  output = resolve(
    process.env.RELAY_UI_VERIFICATION_OUTPUT ||
      '../evidence/rule-resource-preview-ui-browser-verification-20261102.json'
  )
let server, browser, context, page, origin, failure, held, failNext, wrongNext, oversizeNext
const previewCalls = () => calls.filter((call) => call.channel === 'relayResourcePreview')
const responseFor = (selected) => {
  const resource = resources.find((item) => item.id === selected.id)
  assert(resource)
  return {
    resource: { id: resource.id, sha256: resource.sha256 },
    kind: resource.kind,
    text:
      resource.kind === 'rule-yaml'
        ? '# yaml-language-server: $schema=https://preview-schema-fixture.invalid/model.json\npayload:\n  - synthetic.invalid\n'
        : resource.kind === 'rule-mrs'
          ? 'payload:\n  - converted.invalid\n'
          : 'text-preview.invalid\n',
    language: resource.kind === 'rule-text' ? 'text' : 'yaml',
    sourceBytes: resource.kind === 'rule-mrs' ? 400 : 100,
    converted: resource.kind === 'rule-mrs',
    ...(resource.kind === 'rule-mrs' ? { sourceRules: 1 } : {})
  }
}
const holdNext = () => {
  let enter, release
  const entered = new Promise((resolveEntered) => (enter = resolveEntered)),
    gate = new Promise((resolveGate) => (release = resolveGate))
  held = { enter, gate }
  return { entered, release }
}
const deadline = setTimeout(() => {
  void browser?.close().catch(() => {})
}, 90000)
try {
  const monacoYaml = require.resolve('monaco-yaml')
  await build({
    entryPoints: {
      'yaml-worker': require.resolve('monaco-yaml/yaml.worker'),
      'editor-worker': require.resolve('monaco-editor/esm/vs/editor/editor.worker')
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outdir: root,
    logLevel: 'silent'
  })
  await build({
    stdin: {
      contents: `import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import * as monaco from'monaco-editor';import i18next from'i18next';import{initReactI18next}from'react-i18next';import{RelayResourcesPanel}from'./src/renderer/src/components/relay/resources-panel';import{RuleResourcePreviewModal}from'./src/renderer/src/components/relay/rule-resource-preview-modal';
await i18next.use(initReactI18next).init({lng:'zh',initImmediate:false,resources:{zh:{translation:{common:{close:'关闭',save:'保存',loading:'加载中'}}}}});
window.__workerLabels=[];window.MonacoEnvironment={getWorker(_id,label){window.__workerLabels.push(label);if(label!=='yaml'&&label!=='editorWorkerService')throw Error('Unexpected worker '+label);return new Worker('/'+(label==='yaml'?'yaml-worker':'editor-worker')+'.js',{type:'module'})}};
const listeners=new Map;window.electron={ipcRenderer:{invoke:(...args)=>window.__invoke(...args),on:(event,callback)=>{const set=listeners.get(event)||new Set;listeners.set(event,set);set.add(callback);return()=>set.delete(callback)}}};window.__emit=event=>{for(const cb of listeners.get(event)||[])cb()};window.__busyTrace=[];
window.__previewModel=()=>monaco.editor.getModels().find(m=>/\\.(text|clash.yaml)$/.test(m.uri.path));window.__text=()=>window.__previewModel()?.getValue();window.__readonly=()=>monaco.editor.getEditors().every(e=>e.getOption(monaco.editor.EditorOption.readOnly));
function App(){const[busy,setBusy]=React.useState(false),[direct,setDirect]=React.useState(false),[selection,setSelection]=React.useState(${JSON.stringify({ id: resources[0].id, sha256: resources[0].sha256 })});const report=value=>{window.__busyTrace.push(value);setBusy(value)};window.__open=()=>setDirect(true);window.__switch=next=>setSelection(next);window.__unmount=()=>setDirect(false);return <><output id="busy">{busy?'busy':'idle'}</output><output id="direct">{direct?'open':'closed'}</output><RelayResourcesPanel busy={busy} onBusy={report}/>{direct&&<StrictMode><RuleResourcePreviewModal selection={selection} title="Explicit test cache" onClose={()=>setDirect(false)} onBusy={report}/></StrictMode>}</>};createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: app,
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    tsconfig: resolve('tsconfig.web.json'),
    outfile: join(root, 'panel.js'),
    loader: { '.ttf': 'file' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'offline-real-editor-and-forbidden-legacy-ipc',
        setup(builder) {
          builder.onResolve({ filter: /^@renderer\/utils\/ipc$/ }, () => ({
            path: 'forbidden-legacy',
            namespace: 'fixture'
          }))
          builder.onLoad({ filter: /forbidden-legacy/, namespace: 'fixture' }, () => ({
            contents:
              "const forbidden=()=>{window.__legacyCalls=(window.__legacyCalls||0)+1;throw Error('Legacy IPC forbidden')};export{forbidden as getFileStr,forbidden as setFileStr,forbidden as convertMrsRuleset,forbidden as getRuntimeConfig}",
            loader: 'js'
          }))
          builder.onResolve({ filter: /^monaco-yaml$/ }, () => ({
            path: 'actual-yaml-observer',
            namespace: 'fixture'
          }))
          builder.onLoad({ filter: /actual-yaml-observer/, namespace: 'fixture' }, () => ({
            contents: `import{configureMonacoYaml as actual}from${JSON.stringify(monacoYaml)};export function configureMonacoYaml(monaco,options){window.__yamlOptions=options;const api=actual(monaco,options);window.__yamlApi=api;return api}`,
            resolveDir: app,
            loader: 'js'
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
    ]
  })
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><link rel="stylesheet" href="/panel.css"><style>body{font:14px sans-serif;margin:16px}label{display:block;margin:8px}button{margin:5px;padding:6px}section[role=dialog]{position:fixed;inset:30px;background:white;z-index:50;display:flex;flex-direction:column;overflow:hidden}section[role=dialog]>header,section[role=dialog]>footer{padding:12px;flex-shrink:0}section[role=dialog]>div{min-height:0;flex:1}section[role=dialog] [role=status]{height:100px}.h-full{height:100%}.overflow-y-auto{overflow-y:auto}textarea{width:95%}</style><div id="root"></div><script type="module" src="/panel.js"></script>'
  )
  server = createServer(async (request, response) => {
    try {
      const path = resolve(root, '.' + new URL(request.url, 'http://127.0.0.1').pathname)
      if (!path.startsWith(root + '/') || !(await lstat(path)).isFile()) throw Error()
      response.writeHead(200, {
        'Content-Type':
          {
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.html': 'text/html',
            '.ttf': 'font/ttf'
          }[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      })
      response.end(await readFile(path))
    } catch {
      response.writeHead(404)
      response.end('private fixture asset missing')
    }
  })
  await new Promise((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  origin = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run']
  })
  context = await Promise.race([
    browser.newContext({ viewport: { width: 1300, height: 850 }, serviceWorkers: 'block' }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('Private context deadline')), 15000)
      timer.unref()
    })
  ])
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    blocked.push(route.request().url())
    return route.abort('blockedbyclient')
  })
  page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__invoke', async (channel, input) => {
    calls.push({ channel, input })
    if (channel === 'relayResourceState') return { phase: 'idle', pending: false }
    if (channel === 'relayResourceList') return { resources, incomplete: 0, warnings: [] }
    assert.equal(channel, 'relayResourcePreview', 'No acquisition, cancellation or legacy API')
    assert.deepEqual(Object.keys(input).sort(), ['id', 'sha256'])
    let output = responseFor(input)
    if (wrongNext) {
      wrongNext = false
      output.resource.sha256 = 'f'.repeat(64)
    }
    if (oversizeNext) {
      oversizeNext = false
      output.text = 'x'.repeat(512 * 1024 + 1)
    }
    const current = held
    held = undefined
    if (current) {
      current.enter()
      await current.gate
    }
    if (failNext) {
      failNext = false
      throw Error('SYNTHETIC_PRIVATE_MUST_NOT_DISPLAY')
    }
    return output
  })
  await page.goto(origin + '/index.html')
  const previewButton = page.getByRole('button', { name: '只读预览所选规则缓存', exact: true }),
    dialog = page.getByRole('dialog'),
    close = async () => {
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
    },
    idle = () => page.waitForFunction(() => document.querySelector('#busy').textContent === 'idle'),
    choose = (resource) =>
      page.getByRole('combobox', { name: /^选择缓存/u }).selectOption(resource.id),
    expectModel = (text) => page.waitForFunction((value) => window.__text()?.includes(value), text)
  await page.waitForFunction(() => typeof window.__open === 'function')
  assert.equal(previewCalls().length, 0)
  assert(await previewButton.isDisabled())
  checks.push('initial mount does not preview or acquire; no unselected preview')
  await page.getByRole('button', { name: '读取私有资源列表', exact: true }).click()
  await idle()
  for (const resource of resources.slice(3)) {
    await choose(resource)
    assert(await previewButton.isDisabled())
  }
  checks.push('Geo and runtime-file selections have no body preview action')
  await choose(resources[0])
  await previewButton.click()
  await expectModel('synthetic.invalid')
  assert.equal(await page.evaluate(() => window.__readonly()), true)
  assert.equal(await dialog.getByRole('button', { name: '保存', exact: true }).count(), 0)
  assert.deepEqual(previewCalls().at(-1).input, {
    id: resources[0].id,
    sha256: resources[0].sha256
  })
  checks.push('explicit id/SHA opens actual readonly Monaco; no save action')
  await page.waitForFunction(() => !!window.__yamlApi)
  await page.evaluate(() => window.__yamlApi.update({}))
  assert.equal(await page.evaluate(() => window.__yamlOptions.enableSchemaRequest), false)
  assert(await page.evaluate(() => window.__workerLabels.includes('yaml')))
  assert.equal(blocked.length, 0)
  checks.push('actual installed YAML worker keeps external modeline schema fetching disabled')
  await close()
  await idle()
  for (const [index, text] of [
    [1, 'text-preview.invalid'],
    [2, 'converted.invalid']
  ]) {
    await choose(resources[index])
    await previewButton.click()
    await expectModel(text)
    if (index === 2) assert(await dialog.getByText('MRS已转换为文本预览', { exact: false }).count())
    assert.equal(await page.evaluate(() => window.__readonly()), true)
    await close()
    await idle()
  }
  checks.push('text and explicitly converted MRS results remain readonly; no binary UTF8 path')
  failNext = true
  await previewButton.click()
  await dialog.getByRole('alert').waitFor()
  assert(!(await dialog.textContent()).includes('SYNTHETIC_PRIVATE'))
  assert.equal(await dialog.locator('.monaco-editor').count(), 0)
  const failedCount = previewCalls().length
  await close()
  assert.equal(previewCalls().length, failedCount)
  checks.push('safe failure clears text and never leaks raw errors or retries')
  for (const invalid of ['wrong', 'oversize']) {
    if (invalid === 'wrong') wrongNext = true
    else oversizeNext = true
    await previewButton.click()
    await dialog.getByRole('alert').waitFor()
    assert.equal(await dialog.locator('.monaco-editor').count(), 0)
    await close()
  }
  checks.push('mismatched selection and oversized text are rejected before display')
  let gate = holdNext()
  await previewButton.click()
  await gate.entered
  await close()
  assert.equal(await page.locator('#busy').textContent(), 'busy')
  assert(await previewButton.isDisabled())
  assert(await page.getByRole('button', { name: '取消本次资源操作', exact: true }).isDisabled())
  gate.release()
  await idle()
  assert.equal(await dialog.count(), 0)
  checks.push('close held RPC keeps busy and disables guessed cancellation until actual settle')
  for (const event of ['relayBackupPreparationsInvalidated', 'relayDataRestored']) {
    gate = holdNext()
    await previewButton.click()
    await gate.entered
    await page.evaluate((name) => window.__emit(name), event)
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.locator('#busy').textContent(), 'busy')
    gate.release()
    await idle()
    assert.equal(await dialog.count(), 0)
  }
  checks.push(
    'hide-scope and restore invalidation discard held replies without releasing work early'
  )
  gate = holdNext()
  await previewButton.click()
  await gate.entered
  await page.evaluate(() => (location.hash = '#/other-private-fixture'))
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await page.locator('#busy').textContent(), 'busy')
  gate.release()
  await idle()
  checks.push('navigation invalidates a held preview without cancellation or late resurrection')
  gate = holdNext()
  const beforeDirect = previewCalls().length
  await page.evaluate(() => window.__open())
  await gate.entered
  await page.evaluate((selection) => window.__switch(selection), {
    id: resources[1].id,
    sha256: resources[1].sha256
  })
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await page.locator('#busy').textContent(), 'busy')
  assert.equal(previewCalls().length, beforeDirect + 1, 'StrictMode must not duplicate the read')
  gate.release()
  await idle()
  assert.equal(await dialog.count(), 0)
  checks.push('selection change discards old reply; StrictMode remains one explicit read')
  await page.evaluate(() => window.__open())
  await expectModel('text-preview.invalid')
  await close()
  await idle()
  checks.push('fresh explicit reopening uses the new selection after prior work settles')
  gate = holdNext()
  await page.evaluate(() => window.__open())
  await gate.entered
  await page.evaluate(() => window.__unmount())
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await page.locator('#busy').textContent(), 'busy')
  gate.release()
  await idle()
  assert.equal(await dialog.count(), 0)
  checks.push('unmount discards response while its original busy owner settles once')
  assert.equal(await page.evaluate(() => window.__legacyCalls ?? 0), 0)
  assert.equal(calls.filter((call) => /Cancel|Acquire|Prepare|Check/u.test(call.channel)).length, 0)
  assert.equal(blocked.length, 0)
  assert.deepEqual(errors, [])
  assert.deepEqual(await hashes(), sourceSHA256)
  checks.push('zero legacy/write/cancel IPC, zero external page or worker requests; sources stable')
} catch (error) {
  failure = error
  if (page)
    await writeFile(
      resolve('/private/tmp/relay-rule-resource-preview-ui-failure.json'),
      JSON.stringify(
        {
          error: String(error),
          checks,
          calls,
          errors,
          blocked,
          body: await page
            .locator('body')
            .textContent()
            .catch(() => '')
        },
        null,
        2
      )
    )
} finally {
  clearTimeout(deadline)
  if (context) {
    await context.close()
    cleanup.context = true
  }
  if (browser) {
    await browser.close()
    cleanup.browser = true
  }
  if (server) {
    await new Promise((resolveClosed, reject) =>
      server.close((error) => (error ? reject(error) : resolveClosed()))
    )
    cleanup.server = true
  }
  await stop()
  await rm(root, { recursive: true })
  cleanup.privateBundle = true
}
await writeFile(
  output,
  JSON.stringify(
    {
      status: failure ? 'failed' : 'passed',
      sourceSHA256,
      checks,
      calls,
      blocked,
      pageErrors: errors,
      cleanup,
      scope:
        'Real reused HeroUI Viewer/Monaco/installed YAML worker; injected IPC results, no actual MRS conversion or Node cache read claimed; own loopback assets only; no App/Core/Native/installation',
      ...(failure ? { error: String(failure) } : {})
    },
    null,
    2
  ) + '\n'
)
if (failure) throw failure
process.stdout.write(
  JSON.stringify({ passed: checks.length, output, externalRequests: blocked.length }) + '\n'
)
