// Private original HeroUI controls + real Relay hook; injected two-channel CAS IPC.
// No App/Core/network/user files or legacy runtime/settings actions.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Explicit private browser tools required')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const directory = await mkdtemp(resolve('.relay-build/sniffer-ui-')),
  sha = (value) => createHash('sha256').update(value).digest('hex'),
  checks = [],
  calls = [],
  errors = [],
  blocked = [],
  baseline = {
    globalOverrides: [{ id: 'global', kind: 'yaml', content: 'rules: []' }],
    profileOverrides: [],
    profileOverrideSets: [
      {
        profileId: '00000000-0000-4000-8000-000000000001',
        overrides: [{ id: 'historical', kind: 'yaml', content: 'rules: [MATCH,REJECT]' }]
      }
    ],
    overrideLibraryOrder: ['00000000-0000-4000-8000-000000000002'],
    rulePatch: { prepend: ['DOMAIN,example.invalid,REJECT'] },
    controlDns: false,
    controlSniff: false,
    useNameserverPolicy: false,
    controlled: {
      dns: { enable: false, nameserver: ['1.1.1.1'] },
      hosts: { 'private.invalid': '127.0.0.1' },
      ipv6: false,
      sniffer: {
        enable: false,
        'parse-pure-ip': false,
        'force-dns-mapping': false,
        'override-destination': false,
        sniff: {
          HTTP: { ports: ['80', '8000-9000'], 'override-destination': false },
          TLS: { 'override-destination': false }
        },
        sniffing: ['http', 'tls'],
        'port-whitelist': ['80'],
        'skip-domain': ['b.invalid', 'a.invalid']
      }
    }
  }
let document = structuredClone(baseline),
  serial = 1,
  browser,
  holdRead = false,
  readEntered,
  releaseRead,
  holdSave = false,
  saveEntered,
  releaseSave,
  failSave = false
const revision = () => sha(String(serial)),
  count = (channel) => calls.filter((call) => call.channel === channel).length,
  bounded = async (promise, label) => {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' deadline')), 15000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
try {
  await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{HeroUIProvider}from'@heroui/react';import i18n from'i18next';import{initReactI18next}from'react-i18next';import{RelaySnifferManager}from'./src/renderer/src/pages/sniffer';
      function App(){const[busy,setBusy]=useState(false),[foreign,setForeign]=useState(false),[generation,setGeneration]=useState(0);window.__foreign=setForeign;window.__remount=()=>setGeneration(n=>n+1);return <HeroUIProvider disableAnimation><output id="generation">{generation}</output><RelaySnifferManager key={generation} busy={busy||foreign} onBusy={value=>{window.__busy.push(value);setBusy(value)}} onChanged={()=>window.__changes++}/></HeroUIProvider>}
      void(async()=>{await i18n.use(initReactI18next).init({lng:'zh',fallbackLng:'zh',keySeparator:false,resources:{zh:{translation:{'sniffer.enable':'嗅探启用','sniffer.overrideDestination':'覆写目的地址','sniffer.forceDNSMapping':'强制DNS映射','sniffer.parsePureIP':'解析纯IP','sniffer.sniff.title':'HTTP端口','sniffer.sniff.tls':'TLS端口','sniffer.sniff.quic':'QUIC端口','sniffer.skipDomain.placeholder':'跳过域名','sniffer.forceDomain.placeholder':'强制域名','sniffer.skipDstAddress.placeholder':'跳过目的地址','sniffer.skipSrcAddress.placeholder':'跳过来源地址','common.delete':'删除'}}},interpolation:{escapeValue:false}});createRoot(document.getElementById('root')).render(<App/>);})();`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    outfile: join(directory, 'panel.js'),
    bundle: true,
    platform: 'browser',
    tsconfig: 'tsconfig.web.json',
    plugins: [
      {
        name: 'block-legacy-wrapper-only',
        setup(plugin) {
          plugin.onResolve(
            {
              filter:
                /^@renderer\/(components\/base\/base-page|hooks\/use-controled-mihomo-config|hooks\/use-app-config|utils\/ipc|utils\/error-display)$/
            },
            (args) => ({ path: args.path, namespace: 'inert-legacy' })
          )
          plugin.onLoad({ filter: /.*/, namespace: 'inert-legacy' }, () => ({
            contents:
              "const forbidden=()=>{throw new Error('Legacy action must never run')};export default forbidden;export const useControledMihomoConfig=forbidden,useAppConfig=forbidden,mihomoHotReloadConfig=forbidden,showErrorSync=forbidden;",
            loader: 'js'
          }))
        }
      }
    ]
  })
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><style>body{font:16px system-ui}button,input{margin:6px}section{padding:12px}label{margin:6px}</style><div id="root"></div><script src="panel.js"></script>'
  )
  browser = await chromium.launch({ executablePath: process.env.RELAY_CHROME, headless: true })
  const context = await bounded(browser.newContext(), 'private context'),
    allowed = pathToFileURL(directory).href + '/'
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(allowed)) return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__invoke', async (channel, input) => {
    calls.push({ channel, input: structuredClone(input) })
    if (channel === 'relayConfigEditRead') {
      if (holdRead) {
        readEntered.resolve()
        await new Promise((resolve) => (releaseRead = resolve))
      }
      return { document: structuredClone(document), revision: revision(), exists: true }
    }
    if (channel === 'relayConfigEditSave') {
      if (failSave || input.expectedRevision !== revision())
        throw new Error('PRIVATE backend conflict detail')
      document = structuredClone(input.document)
      serial++
      if (holdSave) {
        saveEntered.resolve()
        await new Promise((resolve) => (releaseSave = resolve))
      }
      return { document: structuredClone(document), revision: revision(), exists: true }
    }
    throw new Error('Unexpected channel ' + channel)
  })
  await page.addInitScript(() => {
    const listeners = new Map()
    window.__busy = []
    window.__changes = 0
    window.__invalidate = () =>
      listeners.get('relayBackupPreparationsInvalidated')?.forEach((fn) => fn())
    window.electron = {
      ipcRenderer: {
        invoke: (...args) => window.__invoke(...args),
        on(channel, fn) {
          const group = listeners.get(channel) ?? new Set()
          group.add(fn)
          listeners.set(channel, group)
          return () => group.delete(fn)
        }
      }
    }
  })
  await page.goto(pathToFileURL(join(directory, 'index.html')).href)
  const read = page.getByRole('button', {
      name: /^(读取保存的嗅探编辑|重新读取并放弃未保存嗅探草稿)$/u
    }),
    save = page.getByRole('button', { name: '保存嗅探编辑', exact: true }),
    control = page.getByRole('switch', { name: '合并这份受控Sniffer设置', exact: true }),
    notice = (text) => page.getByRole('status').filter({ hasText: text }),
    http = page.getByRole('textbox', { name: 'HTTP端口', exact: true })
  await read.waitFor()
  assert.equal(calls.length, 0)
  assert.ok(await save.isDisabled())
  assert.ok(await control.isDisabled())
  assert.equal(await http.count(), 0)
  checks.push('initial mount is inert; no editable or saveable body exists before explicit read')

  holdRead = true
  readEntered = Promise.withResolvers()
  await read.click()
  await bounded(readEntered.promise, 'held read')
  await page.evaluate(() => window.__invalidate())
  assert.ok(await read.isDisabled())
  assert.deepEqual(await page.evaluate(() => window.__busy), [true])
  holdRead = false
  releaseRead()
  await page.waitForFunction(() => window.__busy.length === 2)
  assert.equal(await http.count(), 0)
  assert.equal(calls.length, 1)
  checks.push(
    'lifecycle invalidation rejects a late read and keeps owned busy until the actual promise settles'
  )

  await read.click()
  await http.waitFor()
  assert.equal(await control.isChecked(), false)
  assert.equal(await page.getByRole('switch', { name: '嗅探启用', exact: true }).isChecked(), false)
  assert.equal(await page.getByRole('switch', { name: '解析纯IP', exact: true }).isChecked(), false)
  assert.equal(await http.inputValue(), '80,8000-9000')
  await control.click()
  await save.click()
  await notice('嗅探编辑已保存').waitFor()
  assert.equal(document.controlSniff, true)
  assert.deepEqual(document.controlled.sniffer, baseline.controlled.sniffer)
  checks.push(
    'the merge flag is separate from enable; a control-only save preserves the exact optional sniffer body and false values'
  )

  const originalOther = structuredClone(document)
  await http.fill('80,,443')
  const sentBeforeInvalid = count('relayConfigEditSave')
  await save.click()
  await notice('草稿格式未通过').waitFor()
  assert.equal(count('relayConfigEditSave'), sentBeforeInvalid)
  assert.equal(await http.inputValue(), '80,,443')
  await http.fill('81, 9100-9200')
  await page.getByRole('switch', { name: '嗅探启用', exact: true }).click()
  await save.click()
  await notice('嗅探编辑已保存').waitFor()
  assert.deepEqual(document.controlled.sniffer.sniff.HTTP.ports, ['81', '9100-9200'])
  assert.deepEqual(document.controlled.sniffer.sniff.TLS, { 'override-destination': false })
  assert.deepEqual({ ...document, controlled: originalOther.controlled }, originalOther)
  assert.deepEqual(
    { ...document.controlled, sniffer: originalOther.controlled.sniffer },
    originalOther.controlled
  )
  assert.deepEqual(document.controlled.sniffer.sniffing, ['http', 'tls'])
  assert.deepEqual(document.controlled.sniffer['port-whitelist'], ['80'])
  assert.equal(Object.hasOwn(document.controlled.sniffer.sniff, 'QUIC'), false)
  checks.push(
    'local validation retains the draft and revision; corrected save writes strict string ports while preserving absent TLS ports, optional flags and unrelated scopes/options/order'
  )

  failSave = true
  await http.fill('82')
  await save.click()
  await notice('草稿保留，请重新读取核对').waitFor()
  assert.equal(await http.inputValue(), '82')
  assert.ok(await save.isDisabled())
  assert.equal(await read.innerText(), '重新读取并放弃未保存嗅探草稿')
  assert.ok((await page.locator('body').innerText()).includes('重新读取会放弃这些未保存修改'))
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE'))
  failSave = false
  document.globalOverrides.push({ id: 'external-scope', kind: 'yaml', content: 'ipv6: false' })
  serial++
  await read.click()
  await notice('已读取受控嗅探草稿').waitFor()
  await http.fill('83')
  await save.click()
  await notice('嗅探编辑已保存').waitFor()
  assert.equal(document.globalOverrides.at(-1).id, 'external-scope')
  checks.push(
    'failed or stale CAS preserves dirty input and invalidates the save base; explicit reread is required and preserves newer unrelated scope changes'
  )

  holdSave = true
  saveEntered = Promise.withResolvers()
  await http.fill('84')
  await save.click()
  await bounded(saveEntered.promise, 'admitted save')
  assert.ok(await read.isDisabled())
  assert.ok(await http.isDisabled())
  const busyCount = (await page.evaluate(() => window.__busy)).length
  await page.evaluate(() => window.__invalidate())
  assert.equal((await page.evaluate(() => window.__busy)).length, busyCount)
  holdSave = false
  releaseSave()
  await page.waitForFunction((n) => window.__busy.length > n, busyCount)
  assert.equal(await http.count(), 0)
  assert.deepEqual(document.controlled.sniffer.sniff.HTTP.ports, ['84'])
  checks.push(
    'an admitted save can settle after hiding, but its late acknowledgement cannot revive the editor or claim rollback; busy is not released by invalidation'
  )

  await page.evaluate(() => window.__foreign(true))
  await page.waitForFunction(() => document.querySelector('button').disabled)
  const callsBeforeForeign = calls.length,
    busyBeforeForeign = await page.evaluate(() => [...window.__busy])
  assert.ok(await read.isDisabled())
  assert.deepEqual(await page.evaluate(() => window.__busy), busyBeforeForeign)
  assert.equal(calls.length, callsBeforeForeign)
  await page.evaluate(() => window.__foreign(false))
  checks.push(
    'foreign busy blocks editing/read/save without releasing another operation or invoking a hidden legacy action'
  )

  holdRead = true
  readEntered = Promise.withResolvers()
  await read.click()
  await bounded(readEntered.promise, 'remount read')
  await page.evaluate(() => window.__remount())
  await page.waitForFunction(() => document.getElementById('generation').textContent === '1')
  holdRead = false
  releaseRead()
  await page.waitForFunction(() => !document.querySelector('button').disabled)
  assert.equal(await http.count(), 0)
  await read.click()
  await http.waitFor()
  assert.equal(await http.inputValue(), '84')
  checks.push(
    'unmount/remount rejects an old read acknowledgement and requires a fresh read of the current persisted document'
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  const files = [
      'src/renderer/src/pages/sniffer.tsx',
      'src/renderer/src/components/sniffer/sniffer-settings-view.tsx',
      'src/renderer/src/hooks/use-relay-sniffer-config.tsx',
      'src/renderer/src/pages/relay-workspace.tsx',
      'src/renderer/src/components/relay/preview-controls.tsx',
      'scripts/relay/test-sniffer-structured-ui.mjs'
    ],
    result = {
      verifiedAt: new Date().toISOString(),
      passed: checks.length,
      checks,
      sourceSHA256: Object.fromEntries(
        await Promise.all(files.map(async (file) => [file, sha(await readFile(file))]))
      ),
      channels: [...new Set(calls.map((call) => call.channel))],
      externalRequests: blocked.length,
      actualApp: false,
      actualCore: false,
      actualUserFiles: false,
      actualBackendIPC: false,
      scope:
        'original HeroUI/SettingCard/SettingItem controls and actual Relay hook with injected revision-CAS IPC; no editor or runtime engine replacement',
      productAcceptance: 'pending'
    }
  await writeFile(
    process.env.RELAY_UI_VERIFICATION_OUTPUT ??
      '../evidence/sniffer-structured-ui-browser-verification-20261101.json',
    JSON.stringify(result, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(directory, { recursive: true, force: true })
}
