// Original structured controls + real Relay hook; private injected IPC, no DNS/Core/system IO.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Explicit private browser tools required')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const directory = await mkdtemp(resolve('.relay-build/dns-ui-')),
  sha = (value) => createHash('sha256').update(value).digest('hex'),
  checks = [],
  calls = [],
  errors = [],
  blocked = [],
  id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
  profiles = [1, 2].map((n) => ({
    id: id(n),
    sha256: String(n).repeat(64),
    name: 'Source ' + n,
    createdAt: '2026-11-01',
    summary: {}
  })),
  baseline = {
    globalOverrides: [{ id: 'global', kind: 'yaml', content: 'rules: []' }],
    profileOverrides: [],
    profileOverrideSets: [
      { profileId: id(1), overrides: [{ id: 'historical', kind: 'yaml', content: 'ipv6: false' }] }
    ],
    profileRulePatchSets: [
      { profileId: id(2), rulePatch: { prepend: ['DOMAIN,example.invalid,REJECT'] } }
    ],
    overrideLibraryOrder: [id(3)],
    controlDns: true,
    controlSniff: false,
    useNameserverPolicy: true,
    disableDnsOverrideGuard: false,
    confirmedDnsFingerprint: 'c'.repeat(64),
    controlled: {
      ipv6: false,
      sniffer: { enable: false },
      'tcp-concurrent': false,
      dns: {
        enable: false,
        ipv6: false,
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': '198.18.0.1/16',
        'fake-ip-filter': ['+.keep.invalid'],
        'use-hosts': true,
        'use-system-hosts': false,
        'respect-rules': false,
        nameserver: ['https://resolver.invalid/dns-query'],
        'nameserver-policy': {
          'array.invalid': ['https://one.invalid/x,y'],
          'scalar.invalid': 'https://two.invalid/x,y'
        },
        'fallback-filter': {
          geoip: false,
          'geoip-code': 'CN',
          ipcidr: [],
          domain: [],
          'private-preserved': true
        },
        'direct-nameserver-follow-policy': false
      },
      hosts: { 'array-host.invalid': ['127.0.0.1'], 'scalar-host.invalid': '127.0.0.2' }
    }
  }
let document = structuredClone(baseline),
  serial = 1,
  browser,
  page,
  holdRead = false,
  readEntered,
  releaseRead,
  holdPreview = false,
  previewEntered,
  releasePreview,
  holdSave = false,
  saveEntered,
  releaseSave,
  failSave = false,
  badSaveAck = false
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
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{HeroUIProvider}from'@heroui/react';import i18n from'i18next';import{initReactI18next}from'react-i18next';import{RelayDnsManager}from'./src/renderer/src/pages/dns';
 function App(){const[busy,setBusy]=useState(false),[foreign,setForeign]=useState(false),[generation,setGeneration]=useState(0);window.__foreign=setForeign;window.__remount=()=>setGeneration(n=>n+1);return <HeroUIProvider disableAnimation><output id="generation">{generation}</output><RelayDnsManager key={generation} busy={busy||foreign} onBusy={value=>{window.__busy.push(value);setBusy(value)}} onChanged={()=>window.__changes++}/></HeroUIProvider>}
 void(async()=>{await i18n.use(initReactI18next).init({lng:'zh',fallbackLng:'zh',keySeparator:false,resources:{zh:{translation:{'dns.enhancedMode.fakeIp':'Fake-IP模式','dns.enhancedMode.redirHost':'重定向模式','dns.enhancedMode.normal':'普通模式','dns.fakeIp.filterMode.blacklist':'黑名单','dns.fakeIp.filterMode.whitelist':'白名单','dns.fakeIp.filterMode.rule':'规则','dns.defaultNameserverPlaceholder':'默认解析器','dns.proxyServerNameserverPlaceholder':'代理解析器','dns.nameserverPlaceholder':'解析器','dns.directNameserverPlaceholder':'直连解析器','dns.fallbackPlaceholder':'回退解析器','dns.fakeIp.filterPlaceholder':'Fake-IP过滤项','dns.fakeIp.filterPlaceholder.rule':'Fake-IP过滤规则','dns.fallbackFilter.title':'回退过滤','dns.fallbackFilter.ipcidrPlaceholder':'回退IP网段','dns.fallbackFilter.domainPlaceholder':'回退域名'}}},interpolation:{escapeValue:false}});createRoot(document.getElementById('root')).render(<App/>);})();`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    outfile: join(directory, 'panel.js'),
    bundle: true,
    platform: 'browser',
    tsconfig: 'tsconfig.web.json',
    plugins: [
      {
        name: 'block-legacy-only',
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
              "const forbidden=()=>{throw new Error('Legacy action must not run')};export default forbidden;export const useControledMihomoConfig=forbidden,useAppConfig=forbidden,mihomoHotReloadConfig=forbidden,showErrorSync=forbidden;",
            loader: 'js'
          }))
        }
      }
    ]
  })
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><style>body{font:16px system-ui}button,input,select{margin:6px}section{padding:12px}label{margin:6px}</style><div id="root"></div><script src="panel.js"></script>'
  )
  browser = await chromium.launch({ executablePath: process.env.RELAY_CHROME, headless: true })
  const context = await bounded(browser.newContext(), 'private context'),
    allowed = pathToFileURL(directory).href + '/'
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(allowed)) return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  page = await context.newPage()
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
    if (channel === 'relayProfileList') return { profiles: structuredClone(profiles) }
    if (channel === 'relayConfigEditPreview') {
      if (holdPreview) {
        previewEntered.resolve()
        await new Promise((resolve) => (releasePreview = resolve))
      }
      assert.ok(
        profiles.some(
          (profile) => profile.id === input.profile.id && profile.sha256 === input.profile.sha256
        )
      )
      const fingerprint = (input.profile.id === id(1) ? 'f' : 'e').repeat(64),
        autoDisabled =
          input.controlDns &&
          !input.disableDnsOverrideGuard &&
          input.confirmedDnsFingerprint !== fingerprint
      return {
        order: [],
        dns: {
          requested: input.controlDns,
          effective: input.controlDns && !autoDisabled,
          autoDisabled,
          fingerprint
        },
        configuration: { secret: 'PRIVATE-preview-body' }
      }
    }
    if (channel === 'relayConfigEditSave') {
      if (failSave || input.expectedRevision !== revision())
        throw new Error('PRIVATE backend conflict details')
      document = structuredClone(input.document)
      serial++
      if (holdSave) {
        saveEntered.resolve()
        await new Promise((resolve) => (releaseSave = resolve))
      }
      const acknowledged = structuredClone(document)
      if (badSaveAck) acknowledged.controlled.dns['enhanced-mode'] = 'unsupported-future-mode'
      return { document: acknowledged, revision: revision(), exists: true }
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
      name: /^(读取DNS编辑与来源|重新读取并放弃未保存DNS草稿)$/u
    }),
    save = page.getByRole('button', { name: '保存DNS编辑', exact: true }),
    notice = (text) => page.getByRole('status').filter({ hasText: text }),
    policy = page.getByRole('switch', { name: '合并受控域名DNS策略', exact: true }),
    hosts = page.getByRole('switch', { name: '使用自定义hosts', exact: true }),
    source = page.getByRole('combobox', { name: 'DNS保护预览来源', exact: true }),
    preview = page.getByRole('button', { name: '预览此来源DNS保护', exact: true }),
    confirm = page.getByRole('button', { name: '确认覆盖此来源DNS并保存草稿', exact: true })
  await read.waitFor()
  assert.equal(calls.length, 0)
  assert.ok(await save.isDisabled())
  assert.equal(await policy.count(), 0)
  checks.push(
    'initial mount is inert with no saveable DNS body or source confirmation before explicit read'
  )
  holdRead = true
  readEntered = Promise.withResolvers()
  await read.click()
  await bounded(readEntered.promise, 'held read')
  await page.evaluate(() => window.__invalidate())
  assert.deepEqual(await page.evaluate(() => window.__busy), [true])
  holdRead = false
  releaseRead()
  await page.waitForFunction(() => window.__busy.length === 2)
  assert.equal(count('relayProfileList'), 0)
  assert.equal(await policy.count(), 0)
  checks.push(
    'a late invalidated Read cannot initialize defaults or issue the follow-up ProfileList, and owned busy persists to settlement'
  )
  await read.click()
  await policy.waitFor()
  assert.deepEqual(
    calls.slice(-2).map((call) => call.channel),
    ['relayConfigEditRead', 'relayProfileList']
  )
  assert.ok(await policy.isChecked())
  assert.equal(await page.getByRole('switch', { name: 'DNS启用', exact: true }).isChecked(), false)
  assert.equal(await page.getByRole('switch', { name: 'DNS IPv6', exact: true }).isChecked(), false)
  await policy.click()
  await save.click()
  await notice('DNS编辑已保存').waitFor()
  assert.equal(document.useNameserverPolicy, false)
  assert.deepEqual(
    document.controlled.dns['nameserver-policy'],
    baseline.controlled.dns['nameserver-policy']
  )
  assert.equal(document.confirmedDnsFingerprint, baseline.confirmedDnsFingerprint)
  await read.click()
  await notice('已读取DNS受控草稿').waitFor()
  assert.equal(await policy.isChecked(), false)
  await policy.click()
  await page.getByRole('textbox', { name: '策略域名 1', exact: true }).fill('renamed.invalid')
  await save.click()
  await notice('DNS编辑已保存').waitFor()
  assert.deepEqual(document.controlled.dns['nameserver-policy']['renamed.invalid'], [
    'https://one.invalid/x,y'
  ])
  assert.equal(
    document.controlled.dns['nameserver-policy']['scalar.invalid'],
    'https://two.invalid/x,y'
  )
  checks.push(
    'inactive policy persists across save/read/re-enable; changing only a mapping key retains single-array and comma-containing scalar values'
  )
  const other = structuredClone(document)
  await hosts.click()
  await page.getByRole('switch', { name: 'DNS IPv6', exact: true }).click()
  await save.click()
  await notice('DNS编辑已保存').waitFor()
  assert.deepEqual(document.controlled.hosts, baseline.controlled.hosts)
  assert.equal(document.controlled.dns.ipv6, true)
  assert.equal(document.controlled.ipv6, false)
  assert.deepEqual({ ...document, controlled: other.controlled }, other)
  assert.deepEqual({ ...document.controlled, dns: other.controlled.dns }, other.controlled)
  checks.push(
    'turning hosts off retains their stored values; DNS IPv6 changes only nested DNS while unrelated scopes, options and top-level IPv6 remain unchanged'
  )
  await page.getByRole('button', { name: '回退过滤', exact: true }).click()
  assert.equal(
    await page.getByRole('switch', { name: '回退GeoIP过滤', exact: true }).isChecked(),
    false
  )
  await page.getByRole('tab', { name: '普通模式', exact: true }).click()
  await page.getByRole('tab', { name: '重定向模式', exact: true }).click()
  await page.getByRole('tab', { name: 'Fake-IP模式', exact: true }).click()
  assert.equal(
    await page.getByRole('textbox', { name: 'Fake-IP范围', exact: true }).inputValue(),
    '198.18.0.1/16'
  )
  await save.click()
  await notice('DNS编辑已保存').waitFor()
  assert.equal(document.controlled.dns['fallback-filter'].geoip, false)
  assert.equal(document.controlled.dns['fallback-filter']['private-preserved'], true)
  assert.equal(document.controlled.dns['direct-nameserver-follow-policy'], false)
  checks.push(
    'real mode tabs retain hidden drafts; false fallback GeoIP and unrendered DNS/filter options survive body saves'
  )
  const sentBeforeInvalid = count('relayConfigEditSave')
  await page.getByRole('textbox', { name: '策略域名 2', exact: true }).fill('renamed.invalid')
  await save.click()
  await notice('DNS草稿或来源预览未通过').waitFor()
  assert.equal(count('relayConfigEditSave'), sentBeforeInvalid)
  assert.equal(
    await page.getByRole('textbox', { name: '策略域名 2', exact: true }).inputValue(),
    'renamed.invalid'
  )
  await page.getByRole('textbox', { name: '策略域名 2', exact: true }).fill('scalar.invalid')
  await save.click()
  await notice('DNS编辑已保存').waitFor()
  checks.push(
    'duplicate mapping keys fail before IPC without losing dirty rows; correction reuses the valid CAS base without silently overwriting a mapping'
  )
  assert.equal(await confirm.count(), 0)
  await source.selectOption(id(1))
  await preview.click()
  await confirm.waitFor()
  assert.equal(count('relayConfigEditSave'), sentBeforeInvalid + 1)
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-preview-body'))
  await source.selectOption(id(2))
  assert.equal(await confirm.count(), 0)
  await preview.click()
  await confirm.waitFor()
  await page
    .getByRole('textbox', { name: '解析器 1', exact: true })
    .fill('https://changed.invalid/query')
  assert.equal(await confirm.count(), 0)
  assert.equal(document.confirmedDnsFingerprint, 'c'.repeat(64))
  await preview.click()
  await confirm.waitFor()
  await confirm.click()
  await notice('已保存此来源DNS内容的明确确认').waitFor()
  assert.equal(document.confirmedDnsFingerprint, 'e'.repeat(64))
  assert.equal(document.disableDnsOverrideGuard, false)
  assert.equal(
    calls.filter((call) => call.channel === 'relayConfigEditPreview').at(-1).input.profile.id,
    id(2)
  )
  checks.push(
    'source preview alone grants nothing; source/draft changes revoke the temporary confirmation, and explicit confirmation saves the exact returned fingerprint through CAS without disabling the global guard'
  )
  await page
    .getByRole('textbox', { name: '解析器 1', exact: true })
    .fill('https://failed.invalid/query')
  failSave = true
  await save.click()
  await notice('保存未确认或版本已变化').waitFor()
  assert.ok(await save.isDisabled())
  assert.equal(await read.innerText(), '重新读取并放弃未保存DNS草稿')
  assert.equal(
    await page.getByRole('textbox', { name: '解析器 1', exact: true }).inputValue(),
    'https://failed.invalid/query'
  )
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE backend'))
  assert.equal(await confirm.count(), 0)
  failSave = false
  await read.click()
  await notice('已读取DNS受控草稿').waitFor()
  assert.equal(await source.inputValue(), '')
  checks.push(
    'save rejection preserves dirty DNS text, blocks stale CAS and source confirmation, and explicitly warns that reread discards unsaved edits'
  )
  holdPreview = true
  previewEntered = Promise.withResolvers()
  await source.selectOption(id(1))
  await preview.click()
  await bounded(previewEntered.promise, 'held preview')
  const busyBeforePreview = (await page.evaluate(() => window.__busy)).length
  await page.evaluate(() => window.__invalidate())
  assert.equal((await page.evaluate(() => window.__busy)).length, busyBeforePreview)
  holdPreview = false
  releasePreview()
  await page.waitForFunction((n) => window.__busy.length > n, busyBeforePreview)
  assert.equal(await confirm.count(), 0)
  assert.equal(await policy.count(), 0)
  checks.push(
    'hidden late preview cannot revive a source confirmation or form, and invalidation does not release owned busy early'
  )
  await read.click()
  await policy.waitFor()
  await source.selectOption(id(1))
  await preview.click()
  await confirm.waitFor()
  holdSave = true
  saveEntered = Promise.withResolvers()
  await confirm.click()
  await bounded(saveEntered.promise, 'admitted confirmation save')
  const busyBeforeSave = (await page.evaluate(() => window.__busy)).length
  await page.evaluate(() => window.__invalidate())
  assert.equal((await page.evaluate(() => window.__busy)).length, busyBeforeSave)
  holdSave = false
  releaseSave()
  await page.waitForFunction((n) => window.__busy.length > n, busyBeforeSave)
  assert.equal(await policy.count(), 0)
  assert.equal(document.confirmedDnsFingerprint, 'f'.repeat(64))
  checks.push(
    'an admitted fingerprint save may complete after hiding but its acknowledgement cannot repopulate the UI or pretend rollback'
  )
  await read.click()
  await policy.waitFor()
  await page
    .getByRole('textbox', { name: '解析器 1', exact: true })
    .fill('https://dirty.invalid/query')
  const valid = structuredClone(document)
  document.controlled.dns.nameserver = 42
  serial++
  const listsBeforeBad = count('relayProfileList')
  await read.click()
  await notice('DNS读取或字段投影未通过').waitFor()
  assert.equal(
    await page.getByRole('textbox', { name: '解析器 1', exact: true }).inputValue(),
    'https://dirty.invalid/query'
  )
  assert.ok(await save.isDisabled())
  assert.ok(await page.getByRole('textbox', { name: '解析器 1', exact: true }).isDisabled())
  assert.equal(count('relayProfileList'), listsBeforeBad)
  document = valid
  serial++
  await read.click()
  await policy.waitFor()
  checks.push(
    'dirty reread with an unrepresentable saved DNS type keeps the old draft but cannot adopt a new writable CAS base or issue ProfileList; successful explicit reread is required'
  )
  await page
    .getByRole('textbox', { name: '解析器 1', exact: true })
    .fill('https://admitted.invalid/query')
  badSaveAck = true
  await save.click()
  await notice('保存未确认或版本已变化').waitFor()
  assert.equal(
    await page.getByRole('textbox', { name: '解析器 1', exact: true }).inputValue(),
    'https://admitted.invalid/query'
  )
  assert.ok(await save.isDisabled())
  badSaveAck = false
  await read.click()
  await notice('已读取DNS受控草稿').waitFor()
  assert.equal(
    await page.getByRole('textbox', { name: '解析器 1', exact: true }).inputValue(),
    'https://admitted.invalid/query'
  )
  checks.push(
    'a synthetic unprojectable save acknowledgement cannot mix a new base with an old draft; the admitted write is not treated as rollback and requires a fresh valid read'
  )
  await page.evaluate(() => window.__foreign(true))
  await page.waitForFunction(() => document.querySelector('button').disabled)
  const beforeForeign = calls.length,
    busyForeign = await page.evaluate(() => [...window.__busy])
  assert.ok(await read.isDisabled())
  assert.equal(calls.length, beforeForeign)
  assert.deepEqual(await page.evaluate(() => window.__busy), busyForeign)
  await page.evaluate(() => window.__foreign(false))
  holdRead = true
  readEntered = Promise.withResolvers()
  await read.click()
  await bounded(readEntered.promise, 'remount read')
  await page.evaluate(() => window.__remount())
  await page.waitForFunction(() => document.getElementById('generation').textContent === '1')
  holdRead = false
  releaseRead()
  await page.waitForFunction(() => !document.querySelector('button').disabled)
  assert.equal(await policy.count(), 0)
  assert.equal(await confirm.count(), 0)
  checks.push(
    'foreign busy is never released by this view, and a remounted manager rejects an older read without issuing stale follow-up IPC'
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  const files = [
      'src/renderer/src/pages/dns.tsx',
      'src/renderer/src/components/dns/dns-settings-view.tsx',
      'src/renderer/src/hooks/use-relay-dns-config.tsx',
      'src/renderer/src/utils/relay-dns-config.ts',
      'src/renderer/src/pages/relay-workspace.tsx',
      'src/renderer/src/components/relay/preview-controls.tsx',
      'scripts/relay/test-dns-structured-ui.mjs'
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
      actualBackendIPC: false,
      actualDnsOrHostsOrCore: false,
      scope:
        'Actual original HeroUI tabs/lists/maps and real Relay projection/hook; injected revision-CAS/source-preview IPC, no engine replacement',
      productAcceptance: 'pending'
    }
  await writeFile(
    process.env.RELAY_UI_VERIFICATION_OUTPUT ??
      '../evidence/dns-structured-ui-browser-verification-20261101.json',
    JSON.stringify(result, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  await writeFile(
    '/private/tmp/relay-dns-ui-failure.json',
    JSON.stringify(
      {
        checks,
        channels: calls.map((call) => call.channel),
        status: await page?.getByRole('status').allTextContents(),
        errors
      },
      null,
      2
    ) + '\n'
  )
  throw error
} finally {
  await browser?.close()
  await rm(directory, { recursive: true, force: true })
}
