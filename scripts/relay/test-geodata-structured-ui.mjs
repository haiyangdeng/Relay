// Real original GeoData controls + Relay adapter; only synthetic IPC/private browser.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Explicit private tools required')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href),
  directory = await mkdtemp(resolve('.relay-build/geodata-ui-')),
  sha = (x) => createHash('sha256').update(x).digest('hex'),
  id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
  checks = [],
  calls = [],
  errors = [],
  external = [],
  gates = new Map(),
  records = new Map(),
  kinds = ['geoip-dat', 'geosite-dat', 'country-mmdb', 'asn-mmdb'],
  ownerA = id(100),
  ownerB = id(101),
  ownerC = id(102)
const baseline = {
  globalOverrides: [{ id: 'keep', kind: 'yaml', content: 'ipv6: false' }],
  profileOverrides: [],
  profileOverrideSets: [
    { profileId: id(20), overrides: [{ id: 'history', kind: 'yaml', content: 'rules: []' }] }
  ],
  rulePatch: { append: ['MATCH,REJECT'] },
  profileRulePatchSets: [],
  overrideLibraryOrder: [id(30)],
  controlSniff: false,
  confirmedDnsFingerprint: 'e'.repeat(64),
  controlled: {
    ipv6: false,
    dns: { enable: false, 'private-option': ['keep'] },
    sniffer: { enable: false },
    'tcp-concurrent': false
  }
}
let doc = structuredClone(baseline),
  docRevision = sha('doc1'),
  serial = 1,
  op,
  autoState = false,
  saveFailure = false,
  badPrivateRead = false,
  badModeRead = false,
  saveCancelled = false,
  activeStatus = 'snapshot',
  schedule = { pending: false, entries: [] },
  armStatus = 'armed',
  browser,
  page,
  lastStage = 'setup'
for (const [index, kind] of kinds.entries()) {
  const definition = {
    descriptor: {
      name: 'Custom ' + kind,
      kind,
      behavior: null,
      selector: kind === 'asn-mmdb' ? '64513' : 'custom-' + index
    },
    source: {
      kind: 'http',
      url: `https://geo${index}.invalid/PRIVATE/path?token=PRIVATE-${index}`,
      proxyPort: 18191,
      headers: { authorization: 'Bearer PRIVATE-' + index, 'x-custom': 'keep' }
    },
    expectedSHA256: '',
    autoIntent: { requested: false, schedule: { kind: 'interval', minutes: 1440 } }
  }
  const info = {
    id: id(index + 1),
    revision: sha('record' + index),
    originRevision: sha('origin' + index),
    descriptor: definition.descriptor,
    origin: new URL(definition.source.url).origin,
    proxyPort: 18191,
    hasPrivateHeaders: true,
    expectedSHA256: '',
    autoIntent: definition.autoIntent,
    createdAt: '2026-11-02T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z'
  }
  records.set(kind, { info, definition })
}
const count = (channel) => calls.filter((c) => c.channel === channel).length,
  body = () => page.locator('body').innerText(),
  button = (text) => page.getByRole('button', { name: text, exact: true }),
  notice = (text) => page.getByRole('status').filter({ hasText: text }),
  recordFor = (selected) => {
    const r = [...records.values()].find((r) => r.info.id === selected.id)
    if (!r || r.info.revision !== selected.revision) throw new Error('Synthetic CAS conflict')
    return r
  },
  hold = (channel) => {
    const gate = Promise.withResolvers(),
      entered = Promise.withResolvers()
    gates.set(channel, { gate, entered })
    return { entered: entered.promise, release: () => gate.resolve() }
  },
  held = async (channel) => {
    const g = gates.get(channel)
    if (g) {
      g.entered.resolve()
      await g.gate.promise
      if (gates.get(channel) === g) gates.delete(channel)
    }
  },
  bounded = async (p, label) => {
    let timer
    try {
      return await Promise.race([
        p,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' deadline')), 15000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
let generation = 'c'.repeat(64),
  activeSHA = 'd'.repeat(64)
const snapshot = (sessionId) => ({
    sessionId,
    configurationRevision: 'a'.repeat(64),
    generationSHA256: generation,
    resources: [{ kind: 'country-mmdb', sha256: activeSHA, bytes: 32, active: true }]
  }),
  done = (label) => {
    checks.push(label)
    lastStage = label
  }
try {
  await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{HeroUIProvider}from'@heroui/react';import i18n from'i18next';import{initReactI18next}from'react-i18next';import{RelayGeoDataPanel}from'./src/renderer/src/components/relay/geodata-panel';function App(){const[busy,setBusy]=useState(false),[foreign,setForeign]=useState(false),[owner,setOwner]=useState(${JSON.stringify(ownerA)}),[pending,setPending]=useState(false),[generation,setGeneration]=useState(0);window.__foreign=setForeign;window.__owner=setOwner;window.__pending=setPending;window.__remount=()=>setGeneration(n=>n+1);return <HeroUIProvider disableAnimation><output id="generation">{generation}</output><output id="owner">{owner}</output><RelayGeoDataPanel key={generation} busy={busy||foreign||pending} onBusy={value=>{window.__busy.push(value);setBusy(value)}} tunSessionId={owner}/></HeroUIProvider>}void(async()=>{await i18n.use(initReactI18next).init({lng:'zh',fallbackLng:'zh',keySeparator:false,resources:{zh:{translation:{'resources.geoData.geoip':'GeoIP','resources.geoData.geosite':'GeoSite','resources.geoData.mmdb':'Country DB','resources.geoData.asn':'ASN DB','resources.geoData.mode':'受控模式','resources.geoData.updateInterval':'小时周期'}}},interpolation:{escapeValue:false}});createRoot(document.getElementById('root')).render(<App/>);})();`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    outfile: join(directory, 'panel.js'),
    bundle: true,
    platform: 'browser',
    tsconfig: 'tsconfig.web.json'
  })
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><style>body{font:15px system-ui}button,input,select{margin:5px}section{padding:10px}label{margin:6px}button:disabled{opacity:.5}</style><div id="root"></div><script src="panel.js"></script>'
  )
  browser = await chromium.launch({ executablePath: process.env.RELAY_CHROME, headless: true })
  const context = await bounded(browser.newContext(), 'private context'),
    allowed = pathToFileURL(directory).href + '/'
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(allowed)) return route.continue()
    external.push(route.request().url())
    return route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (e) => errors.push(e.message))
  await page.exposeFunction('__invoke', async (channel, input) => {
    calls.push({ channel, input: structuredClone(input) })
    if (channel === 'relayGeoOriginList') {
      await held(channel)
      return {
        origins: [...records.values()].map((r) => structuredClone(r.info)),
        incomplete: 0,
        warnings: []
      }
    }
    if (channel === 'relayGeoOriginRead') {
      const output = structuredClone(recordFor(input))
      if (badPrivateRead) output.definition.source.headers = { authorization: 5 }
      await held(channel)
      return output
    }
    if (channel === 'relayGeoOriginState')
      return autoState
        ? {
            pending: true,
            phase: 'acquiring',
            originId: id(3),
            automatic: true,
            operationId: id(999)
          }
        : op
          ? { pending: true, phase: op.phase, originId: op.originId, operationId: op.id }
          : { pending: false, phase: 'idle' }
    if (channel === 'relayGeoOriginSave' || channel === 'relayGeoOriginFetch') {
      const current =
          channel === 'relayGeoOriginFetch'
            ? recordFor(input)
            : input.origin
              ? recordFor(input.origin)
              : undefined,
        done = Promise.withResolvers(),
        local = {
          id: id(1000 + serial),
          originId: current?.info.id,
          phase: channel.endsWith('Save') ? 'confirmingDefinition' : 'acquiring',
          cancelled: false,
          done
        }
      op = local
      try {
        await held(channel)
        if (saveFailure === 'status' && channel.endsWith('Save'))
          return { status: 'failed', warnings: ['Synthetic CAS conflict'] }
        if (saveFailure && channel.endsWith('Save')) throw new Error('Synthetic save unknown')
        if (local.cancelled || (saveCancelled && channel.endsWith('Save')))
          return { status: 'cancelled', warnings: ['Synthetic Native cancelled'] }
        if (channel.endsWith('Save')) {
          const definition = structuredClone(input.definition),
            old = current,
            info = {
              id: old?.info.id ?? id(50),
              revision: sha('saved' + ++serial),
              originRevision: sha('definition' + serial),
              descriptor: definition.descriptor,
              origin: new URL(definition.source.url).origin,
              proxyPort: definition.source.proxyPort,
              hasPrivateHeaders: Object.keys(definition.source.headers).length > 0,
              expectedSHA256: definition.expectedSHA256,
              autoIntent: definition.autoIntent,
              createdAt: old?.info.createdAt ?? '2026-11-02T00:00:00Z',
              updatedAt: '2026-11-02T00:00:00Z',
              ...(old?.info.head ? { head: old.info.head } : {})
            }
          records.set(definition.descriptor.kind, { info, definition })
          return {
            status: 'saved',
            origin: structuredClone(info),
            warnings: ['Definition only, no grant']
          }
        }
        const hash = sha('fake checked cache'),
          resource = { id: id(60), sha256: hash },
          head = {
            resource,
            resourceRevision: sha('resourceMeta'),
            originRevision: current.info.originRevision,
            acquiredAt: '2026-11-02T01:00:00Z'
          }
        current.info = { ...current.info, revision: sha('head' + ++serial), head }
        return {
          status: 'updated',
          origin: structuredClone(current.info),
          check: { status: 'passed', resourceSHA256: hash, warnings: [] },
          warnings: ['Cache checked; not active']
        }
      } finally {
        if (op === local) op = undefined
        done.resolve()
      }
    }
    if (channel === 'relayGeoOriginCancel') {
      assert.deepEqual(Object.keys(input), ['operationId'])
      if (op?.id === input.operationId) {
        const current = op
        current.cancelled = true
        await current.done.promise
      }
      return
    }
    if (channel === 'relayConfigEditRead') {
      const output = { document: structuredClone(doc), revision: docRevision, exists: true }
      if (badModeRead) output.document.controlled['geodata-mode'] = 'future'
      await held(channel)
      return output
    }
    if (channel === 'relayConfigEditSave') {
      assert.equal(input.expectedRevision, docRevision)
      if (saveFailure) throw new Error('Synthetic CAS unknown')
      await held(channel)
      doc = structuredClone(input.document)
      docRevision = sha('doc' + ++serial)
      return { document: structuredClone(doc), revision: docRevision, exists: true }
    }
    if (channel === 'relayTunResourcesRead') {
      const output =
        activeStatus === 'snapshot'
          ? { status: 'snapshot', sessionId: input.sessionId, snapshot: snapshot(input.sessionId) }
          : { status: activeStatus, sessionId: input.sessionId }
      await held(channel)
      return output
    }
    if (channel === 'relayTunResourceReplace') {
      assert.deepEqual(Object.keys(input).sort(), [
        'configurationRevision',
        'expectedGenerationSHA256',
        'origin',
        'sessionId'
      ])
      assert.equal(input.expectedGenerationSHA256, generation)
      const source = recordFor(input.origin)
      assert.ok(source.info.head)
      await held(channel)
      if (activeStatus === 'uncertain') return { status: 'uncertain', sessionId: input.sessionId }
      activeSHA = source.info.head.resource.sha256
      generation = sha('generation' + ++serial)
      return { status: 'updated', sessionId: input.sessionId, snapshot: snapshot(input.sessionId) }
    }
    if (channel === 'relayGeoScheduleState') return structuredClone(schedule)
    if (channel === 'relayGeoScheduleArm') {
      assert.deepEqual(Object.keys(input).sort(), ['origin', 'target'])
      const source = recordFor(input.origin),
        target = structuredClone(input.target),
        candidate = {
          pending: false,
          entries: [
            {
              id: source.info.id,
              name: source.info.descriptor.name,
              origin: source.info.origin,
              schedule: source.info.autoIntent.schedule,
              enabled: true,
              target,
              nextAt: '2026-11-03T00:00:00Z'
            }
          ]
        }
      await held(channel)
      if (armStatus === 'armed') schedule = candidate
      return { status: armStatus, state: structuredClone(schedule) }
    }
    if (channel === 'relayGeoScheduleDisarm') {
      schedule = {
        pending: false,
        entries: schedule.entries.map((e) =>
          e.id === input.id ? { ...e, enabled: false, nextAt: undefined } : e
        )
      }
      return structuredClone(schedule)
    }
    throw new Error('Unexpected/legacy IPC ' + channel)
  })
  await page.addInitScript(() => {
    window.__busy = []
    window.__events = new Map()
    window.__tunUpdated = () => {
      for (const fn of window.__events.get('relayTunUpdated') ?? []) fn()
    }
    window.__invalidate = () => {
      for (const fn of window.__events.get('relayBackupPreparationsInvalidated') ?? []) fn()
    }
    window.electron = {
      ipcRenderer: {
        invoke: (channel, input) => window.__invoke(channel, input),
        on: (channel, callback) => {
          const set = window.__events.get(channel) ?? new Set()
          set.add(callback)
          window.__events.set(channel, set)
          return () => set.delete(callback)
        }
      }
    }
  })
  await page.goto(pathToFileURL(join(directory, 'index.html')).href)
  await button('读取四类来源摘要').waitFor()
  assert.equal(calls.length, 0)
  assert.equal(await button('确认保存当前私有定义').isDisabled(), true)
  assert.equal(await button('CAS保存DB／DAT草稿').isDisabled(), true)
  assert.ok(!(await body()).includes('PRIVATE'))
  done('mount0IPC/no writable base/no invented permission')
  await button('读取四类来源摘要').click()
  await notice('已读取安全来源摘要').waitFor()
  assert.equal(count('relayGeoOriginRead'), 0)
  for (const name of ['geoip URL', 'geosite URL', 'mmdb URL', 'asn URL'])
    assert.equal(await page.getByRole('textbox', { name, exact: true }).inputValue(), '')
  assert.ok(!(await body()).includes('PRIVATE'))
  await button('选择Country DB · 已保存').click()
  await button('显式读取当前私有来源').click()
  await notice('已显式读取私有来源').waitFor()
  assert.equal(
    await page.getByRole('textbox', { name: 'mmdb URL', exact: true }).inputValue(),
    records.get('country-mmdb').definition.source.url
  )
  assert.equal(
    await page.getByRole('textbox', { name: 'Geo校验选择器', exact: true }).inputValue(),
    'custom-2'
  )
  done('explicit detail only; custom selector/name/headers preserved')
  await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).fill('Changed country')
  const intent = page.getByRole('switch', { name: '当前来源自动更新意图（不是权限）', exact: true })
  await intent.click()
  await page.getByRole('spinbutton', { name: 'GeoData小时周期', exact: true }).fill('0.5')
  await intent.click()
  const readCount = count('relayGeoOriginRead')
  await button('确认保存当前私有定义').click()
  await notice('已确认保存定义').waitFor()
  assert.equal(count('relayGeoOriginRead'), readCount)
  assert.equal(count('relayGeoOriginFetch'), 0)
  assert.equal(count('relayConfigEditSave'), 0)
  assert.deepEqual(
    calls.filter((c) => c.channel === 'relayGeoOriginSave').at(-1).input.definition.autoIntent,
    { requested: false, schedule: { kind: 'interval', minutes: 30 } }
  )
  assert.equal(
    calls.filter((c) => c.channel === 'relayGeoOriginSave').at(-1).input.definition.source.headers
      .authorization,
    'Bearer PRIVATE-2'
  )
  assert.equal(await button('确认保存当前私有定义').isDisabled(), true)
  done('definition-only ACK; no secret-detail auto-read/fetch/mode write')
  await button('显式读取当前私有来源').click()
  await notice('已显式读取私有来源').waitFor()
  await page.getByRole('textbox', { name: 'Geo私有请求头', exact: true }).fill('{bad')
  let saves = count('relayGeoOriginSave')
  await button('确认保存当前私有定义').click()
  await notice('请修正来源URL').waitFor()
  assert.equal(count('relayGeoOriginSave'), saves)
  await page
    .getByRole('textbox', { name: 'Geo私有请求头', exact: true })
    .fill('{"authorization":"Custom token","x-custom":"keep"}')
  await button('确认保存当前私有定义').click()
  await notice('已确认保存定义').waitFor()
  done('local validation retains valid CAS; fix saves without rebase')
  await button('显式读取当前私有来源').click()
  await notice('已显式读取私有来源').waitFor()
  await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).fill('CAS conflict draft')
  saveFailure = 'status'
  await button('确认保存当前私有定义').click()
  await notice('保存未通过或来源已变化').waitFor()
  assert.equal(await button('确认保存当前私有定义').isDisabled(), true)
  assert.equal(
    await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).inputValue(),
    'CAS conflict draft'
  )
  saveFailure = false
  await button('读取当前私有来源并放弃未保存草稿').click()
  await notice('已显式读取私有来源').waitFor()
  done('typed failed CAS retains dirty draft and disables retry of its old source revision')

  await button('显式读取当前私有来源').click()
  await notice('已显式读取私有来源').waitFor()
  await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).fill('Retained draft')
  saveFailure = true
  await button('确认保存当前私有定义').click()
  await notice('保存／获取结果未知').waitFor()
  assert.equal(
    await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).inputValue(),
    'Retained draft'
  )
  assert.equal(await button('确认保存当前私有定义').isDisabled(), true)
  saveFailure = false
  badPrivateRead = true
  await button('读取当前私有来源并放弃未保存草稿').click()
  await notice('来源详情读取未确认').waitFor()
  assert.equal(
    await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).inputValue(),
    'Retained draft'
  )
  badPrivateRead = false
  await button('读取当前私有来源并放弃未保存草稿').click()
  await notice('已显式读取私有来源').waitFor()
  done('unknown save/bad private projection retain full draft and refuse staleCAS')
  await button('读取DB／DAT受控草稿').click()
  await notice('已读取受控模式草稿').waitFor()
  await page.getByRole('tab', { name: 'db', exact: true }).click()
  await button('CAS保存DB／DAT草稿').click()
  await notice('DB／DAT受控草稿已保存').waitFor()
  assert.equal(doc.controlled['geodata-mode'], false)
  const expectedDB = {
    ...structuredClone(baseline),
    controlled: { ...structuredClone(baseline.controlled), 'geodata-mode': false }
  }
  assert.deepEqual(doc, expectedDB)
  await page.getByRole('tab', { name: '继承来源', exact: true }).click()
  await button('CAS保存DB／DAT草稿').click()
  await notice('DB／DAT受控草稿已保存').waitFor()
  assert.deepEqual(doc, baseline)
  done(
    'mode inherit/false full-documentCAS preserves every unrelated scope and no auto/Core setting'
  )
  await page.getByRole('tab', { name: 'dat', exact: true }).click()
  saveFailure = true
  await button('CAS保存DB／DAT草稿').click()
  await notice('模式保存结果未确认').waitFor()
  assert.equal(await button('CAS保存DB／DAT草稿').isDisabled(), true)
  saveFailure = false
  badModeRead = true
  await button('重新读取模式并放弃未保存草稿').click()
  await notice('模式草稿读取未确认').waitFor()
  assert.equal(
    await page.getByRole('tab', { name: 'dat', exact: true }).getAttribute('aria-selected'),
    'true'
  )
  badModeRead = false
  await button('重新读取模式并放弃未保存草稿').click()
  await notice('已读取受控模式草稿').waitFor()
  done('mode failedACK/bad read cannot pair old draft with new revision')
  let gate = hold('relayConfigEditSave')
  await page.getByRole('tab', { name: 'dat', exact: true }).click()
  await button('CAS保存DB／DAT草稿').click()
  await gate.entered
  await button('停用当前来源本次授权').click()
  await notice('已停用此来源本次授权').waitFor()
  gate.release()
  await page.waitForFunction(() => window.__busy.at(-1) === false)
  assert.equal(await button('CAS保存DB／DAT草稿').isDisabled(), true)
  await page.getByRole('tab', { name: '继承来源', exact: true }).click()
  await button('CAS保存DB／DAT草稿').click()
  await notice('DB／DAT受控草稿已保存').waitFor()
  assert.deepEqual(doc, baseline)
  done('Stop only invalidates grant work; unrelated admitted modeCAS retains its real ACK')

  await button('手动获取并检查当前缓存').click()
  await notice('已检查并更新缓存head').waitFor()
  assert.deepEqual(
    Object.keys(calls.filter((c) => c.channel === 'relayGeoOriginFetch').at(-1).input).sort(),
    ['id', 'revision']
  )
  assert.equal(count('relayTunResourceReplace'), 0)
  assert.equal(count('relayTunResourcesRead'), 0)
  done('manual saved-source fetch updates cache only; active authority separate')
  gate = hold('relayGeoOriginFetch')
  await button('手动获取并检查当前缓存').click()
  await gate.entered
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent === '取消本次来源操作并等待收尾'
      ).disabled
  )
  await button('取消本次来源操作并等待收尾').click()
  assert.equal(await button('读取四类来源摘要').isDisabled(), true)
  assert.equal(await page.evaluate(() => window.__busy.at(-1)), true)
  gate.release()
  await notice('来源结果：cancelled').waitFor()
  await page.waitForFunction(() => window.__busy.at(-1) === false)
  done('exact interactive operation cancellation holds busy until actualsettle')
  autoState = true
  gate = hold('relayGeoOriginFetch')
  await button('手动获取并检查当前缓存').click()
  await gate.entered
  assert.equal(await button('取消本次来源操作并等待收尾').isDisabled(), true)
  const cancelCount = count('relayGeoOriginCancel')
  gate.release()
  await notice('已检查并更新缓存head').waitFor()
  assert.equal(count('relayGeoOriginCancel'), cancelCount)
  autoState = false
  done('automatic state cannot confer interactive cancellation ID')
  activeStatus = 'unsupported'
  await button('读取当前TUN活动资源').click()
  await notice('只允许缓存工作').waitFor()
  assert.equal(await button('独立确认替换所选TUN活动数据').isDisabled(), true)
  assert.equal(count('relayTunResourceReplace'), 0)
  activeStatus = 'snapshot'
  gate = hold('relayTunResourcesRead')
  await button('读取当前TUN活动资源').click()
  await gate.entered
  await page.evaluate(() => window.__pending(true))
  await page.evaluate(() => window.__tunUpdated())
  gate.release()
  await notice('已读取本次活动代际').waitFor()
  await page.evaluate(() => window.__pending(false))
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent === '读取当前TUN活动资源'
      ).disabled
  )
  done('old capability cache-only and same-owner pending does not discard valid snapshot')
  const headBefore = structuredClone(records.get('country-mmdb').info.head)
  await button('独立确认替换所选TUN活动数据').click()
  await notice('活动替换已收到独立回执').waitFor()
  assert.deepEqual(records.get('country-mmdb').info.head, headBefore)
  assert.equal(
    calls.filter((c) => c.channel === 'relayTunResourceReplace').at(-1).input.origin.id,
    id(3)
  )
  done('replacement binds opaque cfg/generation+savedorigin; no cache/head or history mutation')
  const beforeNotification = calls.length
  await page.evaluate(() => window.__tunUpdated())
  await notice('运行观察已变化').waitFor()
  assert.equal(await button('独立确认替换所选TUN活动数据').isDisabled(), true)
  assert.equal(calls.length, beforeNotification)
  await button('读取当前TUN活动资源').click()
  await notice('已读取本次活动代际').waitFor()
  done(
    'runtime notification invalidates idle cachedgeneration0IO, own in-flight read keeps receipt'
  )

  activeStatus = 'uncertain'
  await button('独立确认替换所选TUN活动数据').click()
  await notice('本会话活动结果不确定').waitFor()
  assert.equal(await button('读取当前TUN活动资源').isDisabled(), true)
  await page.evaluate((owner) => window.__owner(owner), ownerB)
  activeStatus = 'snapshot'
  gate = hold('relayTunResourcesRead')
  await button('读取当前TUN活动资源').click()
  await gate.entered
  await page.evaluate((owner) => window.__owner(owner), ownerC)
  await page.waitForFunction(
    (owner) => document.getElementById('owner').textContent === owner,
    ownerC
  )
  gate.release()
  await page.waitForFunction(() => window.__busy.at(-1) === false)
  assert.ok(!(await body()).includes('会话 ' + ownerB + '；配置'))
  await button('读取当前TUN活动资源').click()
  await notice('已读取本次活动代际').waitFor()
  done('uncertain session quarantined; late different-owner snapshot cannot revive it')
  const source = records.get('country-mmdb')
  source.info.autoIntent = source.definition.autoIntent = {
    requested: true,
    schedule: { kind: 'interval', minutes: 60 }
  }
  source.info.revision = sha('intent' + ++serial)
  await button('读取四类来源摘要').click()
  await notice('已读取安全来源摘要').waitFor()
  armStatus = 'cancelled'
  await button('原生确认启动本次周期授权').click()
  await notice('本次授权：cancelled').waitFor()
  assert.equal((await body()).includes('本会话已授权'), false)
  armStatus = 'armed'
  await page.getByRole('combobox', { name: 'Geo自动授权目标', exact: true }).selectOption('tun')
  gate = hold('relayGeoScheduleArm')
  await button('原生确认启动本次周期授权').click()
  await gate.entered
  await page.evaluate(() => window.__tunUpdated())
  gate.release()
  await notice('本次授权：armed').waitFor()
  assert.equal((await body()).includes('本会话已授权'), true)
  assert.equal(await button('独立确认替换所选TUN活动数据').isDisabled(), true)
  done(
    'Arm own same-owner verification hint clears generation cache without dropping its armed ACK'
  )
  await button('读取当前TUN活动资源').click()
  await notice('已读取本次活动代际').waitFor()

  const arm = calls.filter((c) => c.channel === 'relayGeoScheduleArm').at(-1).input
  assert.deepEqual(arm.target, { kind: 'tun', sessionId: ownerC })
  assert.deepEqual(Object.keys(arm.origin).sort(), ['id', 'revision'])
  done('intent is not grant; explicit Nativearm exacttarget without URLs/body/permissions')
  gate = hold('relayGeoScheduleArm')
  await button('原生确认启动本次周期授权').click()
  await gate.entered
  await button('停用当前来源本次授权').click()
  await notice('已停用此来源本次授权').waitFor()
  assert.equal(await page.evaluate(() => window.__busy.at(-1)), true)
  gate.release()
  await page.waitForFunction(() => window.__busy.at(-1) === false)
  assert.equal((await body()).includes('本会话已授权'), false)
  await page.evaluate(() => window.__foreign(true))
  const busyEvents = await page.evaluate(() => window.__busy.length)
  await button('停用当前来源本次授权').click()
  await notice('已停用此来源本次授权').waitFor()
  assert.equal(await page.evaluate(() => window.__busy.length), busyEvents)
  await page.evaluate(() => window.__foreign(false))
  done('Stop dominates lateArm and never releases foreignbusy')
  gate = hold('relayGeoOriginRead')
  await button('显式读取当前私有来源').click()
  await gate.entered
  const beforeInvalidate = calls.length
  await page.evaluate(() => window.__invalidate())
  await page
    .getByRole('textbox', { name: 'Geo来源名称', exact: true })
    .waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => window.__busy.at(-1)), true)
  gate.release()
  await page.waitForFunction(() => window.__busy.at(-1) === false)
  assert.equal(calls.length, beforeInvalidate)
  assert.equal(await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).count(), 0)
  assert.equal(await page.getByRole('textbox', { name: 'mmdb URL', exact: true }).inputValue(), '')
  done('hidden invalidation clears private view and late read without RPC or earlybusy release')
  await page.evaluate(() => window.__remount())
  await page.waitForFunction(() => document.getElementById('generation').textContent === '1')
  const mountedCalls = calls.length
  assert.equal(await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).count(), 0)
  assert.equal(calls.length, mountedCalls)
  done('remount returns to0IO/no adoptedprivate draft/permission')
  records.delete('asn-mmdb')
  await button('读取四类来源摘要').click()
  await notice('已读取安全来源摘要').waitFor()
  await button('选择ASN DB · 未读取或未定义').click()
  await button('新建当前类型来源草稿').click()
  assert.ok(
    (await page.getByRole('textbox', { name: 'asn URL', exact: true }).inputValue()).includes(
      'GeoLite2-ASN.mmdb'
    )
  )
  await page
    .getByRole('textbox', { name: 'asn URL', exact: true })
    .fill('https://new.invalid/private?key=PRIVATE')
  await page.getByRole('textbox', { name: 'Geo来源名称', exact: true }).fill('Explicit new ASN')
  await page.getByRole('textbox', { name: 'Geo校验选择器', exact: true }).fill('64555')
  await page.getByRole('textbox', { name: 'Geo固定代理端口', exact: true }).fill('18195')
  await page
    .getByRole('textbox', { name: 'Geo私有请求头', exact: true })
    .fill('{"authorization":"new PRIVATE"}')
  await page.getByRole('switch', { name: '当前来源自动更新意图（不是权限）', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'GeoData小时周期', exact: true }).fill('2')
  const armBeforeCreate = count('relayGeoScheduleArm'),
    fetchBeforeCreate = count('relayGeoOriginFetch')
  saveCancelled = true
  await button('确认保存当前私有定义').click()
  await page.getByText('Synthetic Native cancelled', { exact: true }).waitFor()
  assert.equal(records.has('asn-mmdb'), false)
  assert.equal(await button('确认保存当前私有定义').isDisabled(), false)
  saveCancelled = false
  await button('确认保存当前私有定义').click()
  await notice('已确认保存定义').waitFor()
  const created = calls.filter((c) => c.channel === 'relayGeoOriginSave').at(-1).input
  assert.equal(created.origin, null)
  assert.equal(created.definition.descriptor.selector, '64555')
  assert.equal(created.definition.source.proxyPort, 18195)
  assert.deepEqual(created.definition.autoIntent, {
    requested: true,
    schedule: { kind: 'interval', minutes: 120 }
  })
  assert.equal(count('relayGeoScheduleArm'), armBeforeCreate)
  assert.equal(count('relayGeoOriginFetch'), fetchBeforeCreate)
  done('explicit new fourth source/defaultCancel/custom selector/hours; saved intent0autoFetch/arm')
  const geoip = records.get('geoip-dat')
  geoip.info = {
    ...geoip.info,
    revision: sha('geoiphead'),
    head: {
      originRevision: geoip.info.originRevision,
      resource: { id: id(61), sha256: '1'.repeat(64) },
      resourceRevision: sha('geoipmeta'),
      acquiredAt: '2026-11-02T02:00:00Z'
    }
  }
  await button('读取四类来源摘要').click()
  await notice('已读取安全来源摘要').waitFor()
  await button('选择GeoIP DAT · 已保存').click()
  await button('读取当前TUN活动资源').click()
  await notice('已读取本次活动代际').waitFor()
  assert.equal(await button('独立确认替换所选TUN活动数据').isDisabled(), true)
  done('even a checked cache head cannot create a missing active kind')
  const saved = records.get('asn-mmdb').info
  schedule = {
    pending: false,
    entries: [
      {
        id: saved.id,
        name: saved.descriptor.name,
        origin: saved.origin,
        schedule: saved.autoIntent.schedule,
        enabled: true,
        target: { kind: 'cache' },
        nextAt: '2026-11-03T00:00:00Z'
      }
    ]
  }
  await button('读取本会话自动授权').click()
  await notice('已读取本会话授权缓存').waitFor()
  assert.equal((await body()).includes('本会话已授权'), true)
  const beforeHide = {
    stop: count('relayGeoScheduleDisarm'),
    cancel: count('relayGeoOriginCancel')
  }
  await page.evaluate(() => window.__invalidate())
  await page
    .getByText('尚未读取本会话状态；不根据保存的自动意图声称已运行。', { exact: true })
    .waitFor()
  assert.equal(count('relayGeoScheduleDisarm'), beforeHide.stop)
  assert.equal(count('relayGeoOriginCancel'), beforeHide.cancel)
  assert.equal(schedule.entries[0].enabled, true)
  done('hide forgets cachedgrant metadata without silently stopping background authorization')
  await page.evaluate(() => window.__foreign(true))
  const busyBeforeStatus = await page.evaluate(() => window.__busy.length)
  assert.equal(await button('读取本会话自动授权').isDisabled(), false)
  await button('读取本会话自动授权').click()
  await notice('已读取本会话授权缓存').waitFor()
  await button('停用此来源授权').click()
  await notice('已停用此来源本次授权').waitFor()
  assert.equal(schedule.entries[0].enabled, false)
  assert.equal(await page.evaluate(() => window.__busy.length), busyBeforeStatus)
  await page.evaluate(() => window.__foreign(false))
  done('initial safe State/Stop lane stays accessible during foreignbusy with0foreignbusy release')
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  const sources = [
      'src/renderer/src/components/resources/geo-data.tsx',
      'src/renderer/src/components/resources/geo-data-view.tsx',
      'src/renderer/src/utils/relay-geo-config.ts',
      'src/renderer/src/hooks/use-relay-geodata.tsx',
      'src/renderer/src/components/relay/geodata-panel.tsx',
      'src/renderer/src/pages/relay-workspace.tsx',
      'src/renderer/src/components/relay/preview-controls.tsx'
    ],
    sourceHashes = Object.fromEntries(
      await Promise.all(sources.map(async (f) => [f, sha(await readFile(f))]))
    )
  const output =
    process.env.RELAY_GEODATA_UI_OUTPUT ??
    '../evidence/geodata-structured-ui-verification-20261102.json'
  await writeFile(
    output,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        status: 'passed',
        scope:
          'Real original HeroUI controls + Relay hook, synthetic Main/Native/cache/active/scheduler IPC, no realCore/network',
        checks,
        sourceHashes,
        calls: calls.map((c) => ({ channel: c.channel })),
        errors,
        external
      },
      null,
      2
    ) + '\n'
  )
  console.log(JSON.stringify({ output, checks: checks.length, external: external.length }))
} catch (error) {
  const output =
    process.env.RELAY_GEODATA_UI_FAILURE ??
    '../evidence/geodata-structured-ui-failure-20261102.json'
  await writeFile(
    output,
    JSON.stringify(
      {
        failedAt: new Date().toISOString(),
        stage: lastStage,
        message: String(error),
        checks,
        errors,
        external,
        calls: calls.map((c) => ({ channel: c.channel })),
        body: page ? await body().catch(() => null) : null
      },
      null,
      2
    ) + '\n'
  )
  throw error
} finally {
  for (const g of gates.values()) g.gate.resolve()
  await browser?.close()
  await rm(directory, { recursive: true, force: true })
}
