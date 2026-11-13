// Actual reused rule modal/cards/DndKit + private injected IPC. No App/Core/Native/network/user data.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Explicit private browser tools required')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href),
  directory = await mkdtemp(resolve('.relay-build/rules-ui-')),
  sha = (value) => createHash('sha256').update(value).digest('hex'),
  id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
  checks = [],
  calls = [],
  errors = [],
  blocked = []
const duplicate = 'DOMAIN,dup.invalid,DIRECT',
  complex = 'AND,((DOMAIN,a.invalid),(DOMAIN-SUFFIX,b.invalid)),PROXY',
  multi = 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve,src',
  future = 'FUTURE-RULE,opaque,WHATEVER,keep-option',
  originalRules = [
    duplicate,
    duplicate,
    complex,
    'RULE-SET,remoteRules,PROXY',
    'SUB-RULE,(DOMAIN,a.invalid),subA',
    multi,
    future
  ]
const profiles = [1, 2].map((n) => ({
    id: id(n),
    sha256: String(n).repeat(64),
    name: 'Source ' + n,
    createdAt: '2026-11-01',
    summary: {
      proxies: 1,
      groups: 1,
      rules: originalRules.length,
      proxyProviders: 0,
      ruleProviders: 1
    }
  })),
  source = {
    proxies: [{ name: 'node', type: 'direct' }],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['node'] }],
    rules: originalRules,
    'rule-providers': {
      remoteRules: { type: 'inline', behavior: 'classical', payload: ['DOMAIN,provider.invalid'] }
    },
    'sub-rules': { subA: ['DOMAIN,inner.invalid,DIRECT'] }
  }
const baseline = {
  globalOverrides: [],
  profileOverrides: [],
  profileRulePatchSets: [
    {
      profileId: id(1),
      rulePatch: { prepend: ['DOMAIN,local.invalid,DIRECT'], delete: [duplicate] }
    },
    { profileId: id(2), rulePatch: { append: ['MATCH,REJECT'] } }
  ],
  rulePatch: {
    prepend: ['DOMAIN,old.invalid,DIRECT'],
    append: [' -1 ,DOMAIN,end.invalid,DIRECT'],
    delete: [duplicate, duplicate]
  },
  overrideLibraryOrder: [id(7)],
  controlDns: false,
  controlSniff: false,
  useNameserverPolicy: false,
  confirmedDnsFingerprint: 'c'.repeat(64),
  controlled: { dns: { enable: false }, sniffer: { enable: false }, ipv6: false }
}
const local = {
  phase: 'running',
  mode: 'rule',
  pending: false,
  owned: true,
  hasRecord: true,
  uncertain: false,
  instanceId: id(50),
  httpPort: 18080,
  configurationRevision: 'a'.repeat(64),
  traffic: 'listening',
  groups: [],
  systemProxyChanged: false,
  liveGuardEnabled: false,
  warnings: []
}
const tun = {
  phase: 'active',
  pending: false,
  owned: true,
  sessionId: id(70),
  traffic: 'forwarding',
  restorationVerified: false,
  protectionVerified: false,
  warnings: []
}
let kernel = [
    { index: 0, type: 'DOMAIN', payload: 'dup.invalid', proxy: 'DIRECT', disabled: false },
    { index: 1, type: 'DOMAIN', payload: 'dup.invalid', proxy: 'DIRECT', disabled: true },
    { index: 2, type: 'MATCH', payload: '', proxy: 'REJECT', disabled: false },
    { index: 3, type: 'DOMAIN', payload: 'unwrapped.invalid', proxy: 'DIRECT' }
  ],
  tunKernel = structuredClone(kernel),
  tunRevision = 'b'.repeat(64),
  tunOutcome = 'cancelled',
  tunWrites = 0,
  holdTunRead = false,
  tunReadEntered,
  releaseTunRead,
  holdTunChange = false,
  tunChangeEntered,
  releaseTunChange,
  document = structuredClone(baseline),
  serial = 1,
  proofSerial = 60,
  browser,
  page,
  holdDoc = false,
  docEntered,
  releaseDoc,
  failSave = false,
  holdPrepare = false,
  prepareEntered,
  releasePrepare,
  holdProfileSave = false,
  profileSaveEntered,
  releaseProfileSave,
  profileOutcome = 'cancelled',
  holdRule = false,
  ruleEntered,
  releaseRule,
  ruleOutcome = 'cancelled',
  holdCommit = false,
  commitEntered,
  releaseCommit,
  commitReject = false,
  previewRules = [],
  proofs = new Map(),
  copies = [],
  commits = []
const revision = () => sha(String(serial)),
  count = (channel) => calls.filter((call) => call.channel === channel).length,
  snapshot = () => ({
    instanceId: local.instanceId,
    configurationRevision: local.configurationRevision,
    rulesSHA256: sha(JSON.stringify(kernel)),
    rules: structuredClone(kernel)
  }),
  tunSnapshot = () => ({
    sessionId: tun.sessionId,
    configurationRevision: tunRevision,
    rulesSHA256: sha(JSON.stringify(tunKernel)),
    rules: structuredClone(tunKernel)
  }),
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
      contents:
        "export {composeRuntimeConfiguration} from './src/main/relay/configuration/merge';export {configurationEditDocument,profileOverridesFor,profileRulePatchFor} from './src/shared/relay/configuration-edit';export {tunRulesReadRequest,tunRuleChangeRequest} from './src/shared/relay/tun-rules';",
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile: join(directory, 'merge.cjs'),
    platform: 'node',
    format: 'cjs',
    bundle: true
  })
  const {
    composeRuntimeConfiguration,
    configurationEditDocument,
    profileOverridesFor,
    profileRulePatchFor,
    tunRulesReadRequest,
    tunRuleChangeRequest
  } = createRequire(import.meta.url)(join(directory, 'merge.cjs'))
  await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{HeroUIProvider}from'@heroui/react';import i18n from'i18next';import{initReactI18next}from'react-i18next';import{RelayRulesManager}from'./src/renderer/src/components/relay/rules-panel';import RuleEditorModal from'./src/renderer/src/components/rules/rule-editor-modal';import{adoptRuleState}from'./src/renderer/src/utils/relay-rule-editor';
 const initial=${JSON.stringify(local)};
 function App(){const[busy,setBusy]=useState(false),[foreign,setForeign]=useState(false),[generation,setGeneration]=useState(0),[state,setState]=useState(initial),[tunState,setTunState]=useState(),[tunUnconfirmed,setTunUnconfirmed]=useState(false),[standalone,setStandalone]=useState();window.__foreign=setForeign;window.__remount=()=>setGeneration(n=>n+1);window.__setLocal=setState;window.__owner=state;window.__setTun=setTunState;window.__tun=tunState;window.__tunUnknown=setTunUnconfirmed;window.__openModal=setStandalone;return <HeroUIProvider disableAnimation><output id="generation">{generation}</output><output id="runtime-owner">{JSON.stringify([state?.instanceId,state?.configurationRevision,state?.mode??null])}</output><output id="tun-owner">{JSON.stringify([tunState?.sessionId,tunState?.phase,tunState?.pending,tunUnconfirmed])}</output><RelayRulesManager key={generation} busy={busy||foreign||!!tunState?.owned||!!tunState?.pending||tunUnconfirmed} runtimeBusy={busy||foreign||!!tunState?.pending||tunUnconfirmed} onBusy={value=>{window.__busy.push(value);setBusy(value)}} onChanged={()=>window.__changes++} localState={state} tunState={tunState} tunUnconfirmed={tunUnconfirmed} onLocalState={(next,expected)=>setState(current=>{const adopted=adoptRuleState(current,next,expected);if(adopted!==current)window.__localAcks.push(next.instanceId);return adopted})}/>{standalone&&<RuleEditorModal index={null} initialValue={standalone} data={{rules:[],outbounds:['DIRECT','PROXY','REJECT'],ruleProviders:['remoteRules'],subRules:['subA']}} onCommit={value=>window.__commit(value)} onSaved={()=>window.__modalSaved++} onClose={()=>setStandalone(undefined)}/>}</HeroUIProvider>}
 void(async()=>{await i18n.use(initReactI18next).init({lng:'zh',fallbackLng:'zh',keySeparator:false,resources:{zh:{translation:{'common.cancel':'取消','rules.hitAt.never':'从未','rules.hitAt.seconds':'刚才'}}},interpolation:{escapeValue:false}});createRoot(document.getElementById('root')).render(<App/>);})();`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    outfile: join(directory, 'panel.js'),
    bundle: true,
    platform: 'browser',
    tsconfig: 'tsconfig.web.json',
    plugins: [
      {
        name: 'forbid-legacy-ipc',
        setup(plugin) {
          plugin.onResolve({ filter: /^@renderer\/utils\/ipc$/ }, (args) => ({
            path: args.path,
            namespace: 'blocked-legacy'
          }))
          plugin.onLoad({ filter: /.*/, namespace: 'blocked-legacy' }, () => ({
            contents:
              "const forbidden=()=>{throw new Error('Legacy rule IPC must not run')};export const saveSimpleRules=forbidden,mihomoRulesDisable=forbidden;",
            loader: 'js'
          }))
        }
      }
    ]
  })
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><style>body{font:16px system-ui}button,input,select{margin:5px}section{padding:8px}[data-rule-row]{border:1px solid #999;margin:6px;padding:8px}section[role=dialog]{position:fixed;inset:25px;overflow:auto;background:white;border:2px solid #777;padding:14px;z-index:100}[role=listbox]{max-height:220px;overflow:auto;background:white;padding:8px;border:1px solid #888}</style><div id="root"></div><script src="panel.js"></script>'
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
  await page.exposeFunction('__commit', async (value) => {
    commits.push(value)
    if (holdCommit) {
      commitEntered.resolve()
      await new Promise((resolve) => (releaseCommit = resolve))
    }
    if (commitReject) throw new Error('PRIVATE commit failure')
  })
  await page.exposeFunction('__invoke', async (channel, input) => {
    calls.push({ channel, input: structuredClone(input) })
    if (channel === 'relayConfigEditRead') {
      if (holdDoc) {
        docEntered.resolve()
        await new Promise((resolve) => (releaseDoc = resolve))
      }
      return { document: structuredClone(document), revision: revision(), exists: true }
    }
    if (channel === 'relayProfileList')
      return { profiles: structuredClone(profiles), incomplete: 0, activeId: null, warnings: [] }
    if (channel === 'relayProfileRulesRead') {
      const profile = profiles.find(
        (profile) => profile.id === input.id && profile.sha256 === input.sha256
      )
      assert.ok(profile)
      return {
        profile: structuredClone(profile),
        rules: [...originalRules],
        targets: ['DIRECT', 'REJECT', 'PROXY'],
        providers: ['remoteRules'],
        subRules: ['subA']
      }
    }
    if (channel === 'relayConfigEditSave') {
      if (failSave || input.expectedRevision !== revision()) throw new Error('PRIVATE stale CAS')
      document = configurationEditDocument(input.document)
      serial++
      return { document: structuredClone(document), revision: revision(), exists: true }
    }
    if (channel === 'relayConfigEditPreview') {
      const checked = configurationEditDocument(
          Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'profile'))
        ),
        composed = await composeRuntimeConfiguration({
          source: JSON.stringify(source),
          profileId: input.profile.id,
          ...checked,
          profileOverrides: profileOverridesFor(checked, input.profile.id),
          profileRulePatch: profileRulePatchFor(checked, input.profile.id)
        })
      previewRules = composed.configuration.rules ?? []
      return { order: composed.order, dns: composed.dns, configuration: composed.configuration }
    }
    if (channel === 'relayProfileRulesPrepare') {
      assert.ok(
        profiles.some(
          (profile) => profile.id === input.profile.id && profile.sha256 === input.profile.sha256
        )
      )
      assert.ok(
        !input.rules.includes(multi) && !input.rules.includes(future),
        'test deliberately removes unsupported originals before preparing'
      )
      if (holdPrepare) {
        prepareEntered.resolve()
        await new Promise((resolve) => (releasePrepare = resolve))
      }
      const plan = {
        evidenceId: id(++proofSerial),
        name: 'New rule copy',
        sha256: sha(JSON.stringify(input.rules)),
        bytes: 128,
        inspection: {
          structure: 'passed',
          coreCompatibility: 'notVerified',
          active: false,
          issues: []
        }
      }
      proofs.set(plan.evidenceId, structuredClone(input.rules))
      return plan
    }
    if (channel === 'relayProfileSave') {
      const rules = proofs.get(input.evidenceId)
      assert.ok(rules)
      proofs.delete(input.evidenceId)
      if (holdProfileSave) {
        profileSaveEntered.resolve()
        await new Promise((resolve) => (releaseProfileSave = resolve))
      }
      if (profileOutcome === 'cancelled') return { status: 'cancelled', warnings: [] }
      const profile = {
        ...profiles[0],
        id: id(90 + copies.length),
        name: 'New rule copy',
        sha256: sha(JSON.stringify(rules))
      }
      copies.push({ profile, rules })
      return { status: 'saved', profile, warnings: [] }
    }
    if (channel === 'relayTunRulesRead') {
      const selected = tunRulesReadRequest(input)
      assert.equal(selected.sessionId, tun.sessionId)
      const captured = tunSnapshot()
      if (holdTunRead) {
        tunReadEntered.resolve()
        await new Promise((resolve) => (releaseTunRead = resolve))
      }
      return tunOutcome === 'unsupported'
        ? { status: 'unsupported', sessionId: selected.sessionId }
        : { status: 'snapshot', sessionId: selected.sessionId, snapshot: captured }
    }
    if (channel === 'relayTunRuleChange') {
      const selected = tunRuleChangeRequest(input)
      assert.equal(selected.sessionId, tun.sessionId)
      if (
        selected.configurationRevision !== tunRevision ||
        selected.rulesSHA256 !== tunSnapshot().rulesSHA256
      )
        return { status: 'stale', sessionId: selected.sessionId }
      const row = tunKernel.find((rule) => rule.index === selected.index)
      assert.equal(typeof row?.disabled, 'boolean')
      if (holdTunChange) {
        tunChangeEntered.resolve()
        await new Promise((resolve) => (releaseTunChange = resolve))
      }
      if (tunOutcome === 'cancelled') return { status: 'cancelled', sessionId: selected.sessionId }
      row.disabled = selected.disabled
      tunWrites++
      return tunOutcome === 'uncertain'
        ? { status: 'uncertain', sessionId: selected.sessionId }
        : { status: 'changed', sessionId: selected.sessionId, snapshot: tunSnapshot() }
    }
    if (channel === 'relayLocalProxyAction') {
      assert.equal(input.instanceId, local.instanceId)
      if (input.action === 'rules')
        return { status: 'refreshed', state: structuredClone(local), rules: snapshot() }
      assert.equal(input.action, 'rule')
      assert.equal(input.configurationRevision, local.configurationRevision)
      assert.equal(input.rulesSHA256, snapshot().rulesSHA256)
      const row = kernel.find((rule) => rule.index === input.index)
      assert.equal(typeof row?.disabled, 'boolean')
      if (holdRule) {
        ruleEntered.resolve()
        await new Promise((resolve) => (releaseRule = resolve))
      }
      if (ruleOutcome === 'cancelled') return { status: 'cancelled', state: structuredClone(local) }
      row.disabled = input.disabled
      return ruleOutcome === 'unconfirmed'
        ? { status: 'unconfirmed', state: structuredClone(local) }
        : { status: 'ruleChanged', state: structuredClone(local), rules: snapshot() }
    }
    throw new Error('Unexpected channel ' + channel)
  })
  await page.addInitScript(() => {
    const listeners = new Map(),
      boundKeys = new Map(),
      add = document.addEventListener,
      remove = document.removeEventListener
    window.__keySensors = []
    document.addEventListener = function (type, listener, options) {
      void options
      const result = Reflect.apply(add, this, arguments)
      if (
        type === 'keydown' &&
        typeof listener === 'function' &&
        listener.name.includes('handleKeyDown') &&
        !boundKeys.has(listener)
      ) {
        const entry = { id: window.__keySensors.length, name: listener.name, removed: false }
        boundKeys.set(listener, entry)
        window.__keySensors.push(entry)
      }
      return result
    }
    document.removeEventListener = function (type, listener, options) {
      void options
      const result = Reflect.apply(remove, this, arguments)
      if (type === 'keydown') {
        const entry = boundKeys.get(listener)
        if (entry) entry.removed = true
        boundKeys.delete(listener)
      }
      return result
    }
    window.__busy = []
    window.__changes = 0
    window.__localAcks = []
    window.__modalSaved = 0
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
      name: /^(读取规则补丁与来源|重新读取并放弃未保存规则补丁)$/u
    }),
    scope = page.getByRole('combobox', { name: '规则补丁范围', exact: true }),
    contextSource = page.getByRole('combobox', { name: '规则上下文来源', exact: true }),
    readContext = page.getByRole('button', { name: '读取所选来源规则上下文', exact: true }),
    savePatch = page.getByRole('button', { name: '保存所选范围规则补丁', exact: true }),
    notice = (text) => page.getByRole('status').filter({ hasText: text }),
    dialog = () =>
      page
        .locator('section[role=dialog]')
        .filter({ has: page.getByText(/^(添加规则|编辑规则)$/u) }),
    saveModal = () => dialog().getByRole('button', { name: '保存到规则草稿', exact: true }),
    runtime = page.getByRole('region', { name: '自有本地代理临时规则开关', exact: true }),
    runtimeRead = runtime.getByRole('button', { name: '读取当前自有实例运行规则', exact: true })
  await read.waitFor()
  assert.equal(calls.length, 0)
  assert.equal(await scope.count(), 0)
  assert.equal(await runtime.getByRole('switch').count(), 0)
  checks.push(
    'all three workflows mount inertly; no writable patch, source copy or runtime switch exists before explicit reads'
  )
  await page.evaluate((value) => window.__openModal(value), multi)
  await dialog().waitFor()
  assert.ok((await dialog().innerText()).includes('原规则包含多个选项'))
  holdCommit = true
  commitReject = true
  commitEntered = Promise.withResolvers()
  await saveModal().click()
  await bounded(commitEntered.promise, 'modal commit')
  assert.ok(await dialog().getByRole('button', { name: '取消', exact: true }).isDisabled())
  assert.equal(await page.evaluate(() => window.__modalSaved), 0)
  holdCommit = false
  releaseCommit()
  await dialog().getByRole('alert').waitFor()
  assert.equal(commits.at(-1), multi)
  assert.ok(!(await dialog().innerText()).includes('PRIVATE'))
  commitReject = false
  await saveModal().click()
  await page.waitForFunction(() => !document.querySelector('section[role=dialog]'))
  assert.equal(await page.evaluate(() => window.__modalSaved), 1)
  checks.push(
    'the actual modal preserves an unchanged multi-option original, waits for its Promise acknowledgement before closing, and retains the draft on rejected commit without exposing errors'
  )
  await page.evaluate((value) => window.__openModal(value), future)
  await dialog().waitFor()
  await saveModal().click()
  await page.waitForFunction(() => !document.querySelector('section[role=dialog]'))
  assert.equal(commits.at(-1), future)
  assert.equal(calls.length, 0)
  checks.push(
    'an untouched unknown rule/target round-trips byte-for-byte through the real modal without an old simple-rule save or inferred equivalence'
  )
  holdDoc = true
  docEntered = Promise.withResolvers()
  await read.click()
  await bounded(docEntered.promise, 'held patch read')
  await page.evaluate(() => window.__invalidate())
  assert.deepEqual(await page.evaluate(() => window.__busy), [true])
  holdDoc = false
  releaseDoc()
  await page.waitForFunction(() => window.__busy.length === 2)
  assert.equal(count('relayProfileList'), 0)
  assert.equal(await scope.count(), 0)
  checks.push(
    'invalidated patch reads do not issue a stale ProfileList or initialize a draft; owned busy remains until actual settlement'
  )
  await read.click()
  await scope.waitFor()
  await contextSource.selectOption(id(1))
  await readContext.click()
  await notice('已读取此来源规则上下文').waitFor()
  const beforeGlobal = structuredClone(document)
  const addRule = async (label, payload, position) => {
    await page
      .getByRole('region', { name: label, exact: true })
      .getByRole('button', { name: '添加' + label, exact: true })
      .click()
    await dialog().waitFor()
    await dialog().getByRole('textbox', { name: '规则内容', exact: true }).fill(payload)
    if (position !== undefined)
      await dialog()
        .getByRole('textbox', { name: '规则插入位置（可选整数）', exact: true })
        .fill(position)
    await saveModal().click()
    await page.waitForFunction(() => !document.querySelector('section[role=dialog]'))
  }
  await addRule('前置规则', 'front.invalid', '0')
  assert.equal(count('relayConfigEditSave'), 0)
  await savePatch.click()
  await notice('所选范围规则补丁已保存').waitFor()
  assert.deepEqual(document.rulePatch.prepend, [
    'DOMAIN,old.invalid,DIRECT',
    '0,DOMAIN-SUFFIX,front.invalid,PROXY'
  ])
  assert.deepEqual({ ...document, rulePatch: beforeGlobal.rulePatch }, beforeGlobal)
  assert.deepEqual(document.rulePatch.delete, [duplicate, duplicate])
  checks.push(
    'structured prepend edits only a local draft until explicit full-document CAS; positional prefixes, duplicate exact exclusions and unrelated fields/scopes remain intact'
  )
  await scope.selectOption(id(1))
  await readContext.click()
  await notice('已读取此来源规则上下文').waitFor()
  const beforeProfile = structuredClone(document)
  await addRule('后置规则', 'tail.invalid', '')
  await savePatch.click()
  await notice('所选范围规则补丁已保存').waitFor()
  assert.deepEqual(document.rulePatch, beforeProfile.rulePatch)
  assert.deepEqual(document.profileRulePatchSets[1], beforeProfile.profileRulePatchSets[1])
  assert.equal(
    document.profileRulePatchSets[0].rulePatch.append[0],
    'DOMAIN-SUFFIX,tail.invalid,PROXY'
  )
  assert.equal(document.confirmedDnsFingerprint, 'c'.repeat(64))
  await page.getByRole('button', { name: '预览此来源最终规则', exact: true }).click()
  await notice('已按现合并器预览最终规则').waitFor()
  assert.deepEqual(
    await page
      .locator('details')
      .filter({ hasText: '候选最终规则' })
      .locator('ol li')
      .allTextContents(),
    previewRules
  )
  assert.equal(previewRules.filter((rule) => rule === duplicate).length, 0)
  assert.equal(count('relayLocalProxyAction'), 0)
  checks.push(
    'profile-scoped patches preserve global/other-profile data; the preview uses the actual existing compose function and exact delete removes all matching duplicates without a runtime toggle'
  )
  await addRule('后置规则', 'conflict.invalid', '')
  failSave = true
  await savePatch.click()
  await notice('规则补丁读取、候选或保存未通过').waitFor()
  assert.ok(await savePatch.isDisabled())
  assert.equal(await read.innerText(), '重新读取并放弃未保存规则补丁')
  assert.ok((await page.locator('body').innerText()).includes('conflict.invalid'))
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE stale'))
  failSave = false
  await read.click()
  await scope.waitFor()
  await scope.selectOption(id(1))
  await readContext.click()
  await notice('已读取此来源规则上下文').waitFor()
  checks.push(
    'patch CAS failure preserves dirty rows and blocks stale retry until explicit reread, with a visible discard warning and no automatic rebase'
  )
  await addRule('后置规则', 'second-tail.invalid', '')
  const append = page.getByRole('region', { name: '后置规则', exact: true }),
    beforeKeys = await append
      .locator('[data-rule-row]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-rule-row')))
  const drag = append.locator('[data-rule-row] > [role=button]').first()
  const keyBaseline = await page.evaluate(() => window.__keySensors.length)
  await drag.focus()
  await drag.press('Space')
  await page.waitForFunction(
    (key) =>
      document
        .querySelector('[data-rule-row="' + key + '"] > [role=button]')
        ?.getAttribute('aria-pressed') === 'true',
    beforeKeys[0]
  )
  await page.waitForFunction(
    (key) =>
      [...document.querySelectorAll('[role=status]')].some((node) =>
        node.textContent.includes('was moved over droppable area ' + key)
      ),
    beforeKeys[0]
  )
  await page.waitForFunction(
    (baseline) => window.__keySensors.slice(baseline).some((entry) => !entry.removed),
    keyBaseline
  )
  assert.equal(
    await page.evaluate((baseline) => window.__keySensors.slice(baseline).length, keyBaseline),
    1
  )
  await drag.press('ArrowDown')
  await page.waitForFunction(
    (key) =>
      [...document.querySelectorAll('[role=status]')].some((node) =>
        node.textContent.includes('was moved over droppable area ' + key)
      ),
    beforeKeys[1]
  )
  await drag.press('Space')
  await page.waitForFunction(
    (baseline) => window.__keySensors.slice(baseline).every((entry) => entry.removed),
    keyBaseline
  )
  await page.waitForFunction((keys) => {
    const section = [...document.querySelectorAll('section')].find(
      (node) => node.getAttribute('aria-label') === '后置规则'
    )
    return section?.querySelector('[data-rule-row]')?.getAttribute('data-rule-row') === keys[1]
  }, beforeKeys)
  await savePatch.click()
  await notice('所选范围规则补丁已保存').waitFor()
  assert.deepEqual(document.profileRulePatchSets[0].rulePatch.append, [
    'DOMAIN-SUFFIX,second-tail.invalid,PROXY',
    'DOMAIN-SUFFIX,tail.invalid,PROXY'
  ])
  await append.getByRole('textbox', { name: '后置规则筛选', exact: true }).fill('second-tail')
  assert.equal(await append.locator('[data-rule-row]').count(), 1)
  assert.equal(await append.locator('[data-rule-row] > [role=button]').count(), 0)
  assert.equal(
    await append.getByRole('button', { name: '编辑规则 1', exact: true }).isEnabled(),
    true
  )
  await append.getByRole('button', { name: '编辑规则 1', exact: true }).click()
  await dialog().getByRole('textbox', { name: '规则内容', exact: true }).fill('filtered.invalid')
  await saveModal().click()
  await page.waitForFunction(() => !document.querySelector('section[role=dialog]'))
  await savePatch.click()
  await notice('所选范围规则补丁已保存').waitFor()
  assert.equal(document.profileRulePatchSets[0].rulePatch.append.length, 2)
  await append.getByRole('textbox', { name: '后置规则筛选', exact: true }).fill('')
  checks.push(
    'actual DndKit keyboard ordering persists ordered rows, while filtering disables drag and editing a visible row still retains the complete unfiltered patch'
  )
  await page.getByRole('button', { name: '打开所选来源完整规则副本编辑', exact: true }).click()
  const full = page.getByRole('region', { name: '完整规则副本 Source 1', exact: true })
  assert.equal(await full.getByRole('region', { name: '完整规则', exact: true }).count(), 0)
  await full.getByRole('button', { name: '读取完整规则草稿', exact: true }).click()
  await full.getByRole('region', { name: '完整规则', exact: true }).waitFor()
  const list = full.getByRole('region', { name: '完整规则', exact: true })
  assert.equal(await list.locator('[data-rule-row]').count(), originalRules.length)
  for (const index of [3, 4, 5, 6, 7]) {
    await list.getByRole('button', { name: '编辑规则 ' + index, exact: true }).click()
    await dialog().waitFor()
    await saveModal().click()
    await page.waitForFunction(() => !document.querySelector('section[role=dialog]'))
  }
  assert.equal(count('relayProfileRulesPrepare'), 0)
  assert.equal(copies.length, 0)
  checks.push(
    'the profile workflow uses the original rule modal with real nested logic/provider/sub-rule/multi-option/unknown contexts; untouched full rules remain local and no copy is prepared automatically'
  )
  for (const text of ['10.0.0.0/8', 'opaque,WHATEVER']) {
    const row = list.locator('[data-rule-row]').filter({ hasText: text })
    await row.getByRole('button', { name: /^删除规则/u }).click()
    const confirmDialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: '删除', exact: true }) })
    assert.ok((await confirmDialog.innerText()).includes('仅从完整规则草稿移除此行'))
    assert.ok(!(await confirmDialog.innerText()).includes('自动清理关联引用'))
    await confirmDialog.getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('section[role=dialog]'))
  }
  await addRule('完整规则', 'full-copy.invalid')
  await full.getByRole('button', { name: '检查完整规则并准备新副本', exact: true }).click()
  await full.getByText('候选 New rule copy', { exact: false }).waitFor()
  assert.equal(count('relayProfileSave'), 0)
  await full.getByRole('button', { name: '单独Native确认另存规则副本', exact: true }).click()
  await notice('Native已取消另存').waitFor()
  assert.equal(copies.length, 0)
  assert.ok(
    await full.getByRole('button', { name: '单独Native确认另存规则副本', exact: true }).isDisabled()
  )
  checks.push(
    'full-row removal means draft removal only; Prepare is separate from default-cancel Native Save, cancellation creates no copy and consumes the visible proof without a retry'
  )
  await full.getByRole('button', { name: '检查完整规则并准备新副本', exact: true }).click()
  await full.getByText('候选 New rule copy', { exact: false }).waitFor()
  profileOutcome = 'saved'
  holdProfileSave = true
  profileSaveEntered = Promise.withResolvers()
  await full.getByRole('button', { name: '单独Native确认另存规则副本', exact: true }).click()
  await bounded(profileSaveEntered.promise, 'held copy save')
  assert.ok((await full.innerText()).includes('尚未另存修改'))
  assert.ok(
    await full
      .getByRole('button', { name: '重新读取并放弃未另存规则草稿', exact: true })
      .isDisabled()
  )
  holdProfileSave = false
  releaseProfileSave()
  await notice('规则草稿已另存新UUID副本').waitFor()
  assert.equal(copies.length, 1)
  assert.ok(!(await full.innerText()).includes('尚未另存修改'))
  assert.deepEqual(source.rules, originalRules)
  assert.ok(!copies[0].rules.includes(multi) && !copies[0].rules.includes(future))
  assert.ok(copies[0].rules.includes('DOMAIN-SUFFIX,full-copy.invalid,PROXY'))
  checks.push(
    'dirty state clears only after the admitted copy Save acknowledgement; the new UUID holds the complete draft and the original profile/source and running state remain untouched'
  )
  holdPrepare = true
  prepareEntered = Promise.withResolvers()
  await full.getByRole('button', { name: '检查完整规则并准备新副本', exact: true }).click()
  await bounded(prepareEntered.promise, 'late preparation')
  const savesBeforeHide = count('relayProfileSave'),
    busyBeforeHide = (await page.evaluate(() => window.__busy)).length
  await page.evaluate(() => window.__invalidate())
  assert.equal((await page.evaluate(() => window.__busy)).length, busyBeforeHide)
  holdPrepare = false
  releasePrepare()
  await page.waitForFunction((n) => window.__busy.length > n, busyBeforeHide)
  assert.equal(await full.count(), 0)
  assert.equal(count('relayProfileSave'), savesBeforeHide)
  checks.push(
    'hiding invalidates a late prepared copy locally without follow-up Save or resurrected proof, while retaining busy until the underlying operation settles'
  )
  await runtimeRead.click()
  await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).waitFor()
  assert.equal(await runtime.getByRole('switch').count(), 3)
  assert.ok((await runtime.innerText()).includes('没有可验证的wrapper禁用位'))
  await runtime.getByRole('textbox', { name: '运行规则筛选', exact: true }).fill('dup.invalid')
  holdRule = true
  ruleEntered = Promise.withResolvers()
  await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).click()
  await bounded(ruleEntered.promise, 'held native rule')
  assert.equal(
    await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).isChecked(),
    false
  )
  assert.ok(await runtimeRead.isDisabled())
  holdRule = false
  releaseRule()
  await notice('已取消本次规则操作').waitFor()
  assert.equal(await runtime.getByRole('switch').count(), 0)
  assert.equal(kernel[1].disabled, true)
  checks.push(
    'runtime reads are explicit and rows without wrapper metadata stay read-only; a filtered toggle uses the original snapshot index, remains non-optimistic and cancellation invalidates the old table'
  )
  await runtimeRead.click()
  await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).waitFor()
  ruleOutcome = 'confirmed'
  const docSavesBeforeRuntime = count('relayConfigEditSave')
  await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).click()
  await notice('临时禁用位已整表读回确认').waitFor()
  assert.equal(
    await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).isChecked(),
    true
  )
  assert.equal(kernel[1].disabled, false)
  assert.equal(
    calls
      .filter((call) => call.channel === 'relayLocalProxyAction' && call.input.action === 'rule')
      .at(-1).input.index,
    1
  )
  assert.equal(count('relayConfigEditSave'), docSavesBeforeRuntime)
  assert.equal(copies.length, 1)
  checks.push(
    'a confirmed temporary bit is displayed only from a returned matching-owner/revision snapshot and never writes a configuration document, copy or disabled ledger'
  )
  ruleOutcome = 'unconfirmed'
  await runtime.getByRole('switch', { name: '临时启用规则 1', exact: true }).click()
  await notice('规则操作结果未确认').waitFor()
  assert.equal(await runtime.getByRole('switch').count(), 0)
  const actionsAfterUnknown = count('relayLocalProxyAction')
  assert.equal(count('relayLocalProxyAction'), actionsAfterUnknown)
  checks.push(
    'unconfirmed runtime mutation clears the stale table and offers no automatic retry or rollback, regardless of whether the private injected backend changed a bit'
  )
  await runtimeRead.click()
  await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).waitFor()
  ruleOutcome = 'confirmed'
  holdRule = true
  ruleEntered = Promise.withResolvers()
  await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).click()
  await bounded(ruleEntered.promise, 'old owner acknowledgement')
  const ackCount = await page.evaluate(() => window.__localAcks.length)
  await page.evaluate((next) => window.__setLocal(next), {
    ...local,
    instanceId: id(51),
    configurationRevision: 'b'.repeat(64)
  })
  holdRule = false
  releaseRule()
  await page.waitForFunction(() => window.__busy.at(-1) === false)
  await page.waitForFunction(
    (expected) =>
      document.getElementById('runtime-owner')?.textContent ===
      JSON.stringify([expected.instanceId, expected.configurationRevision, 'rule']),
    { instanceId: id(51), configurationRevision: 'b'.repeat(64) }
  )
  assert.equal(await runtime.getByRole('switch').count(), 0)
  assert.equal(await page.evaluate(() => window.__localAcks.length), ackCount)
  checks.push(
    'an injected late old-owner acknowledgement cannot restore the previous owner, table or toggle after the parent instance/revision changes'
  )
  await page.evaluate((next) => window.__setLocal(next), { ...local })
  await runtimeRead.click()
  await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).waitFor()
  holdRule = true
  ruleEntered = Promise.withResolvers()
  await runtime.getByRole('switch', { name: '临时启用规则 2', exact: true }).click()
  await bounded(ruleEntered.promise, 'queued same-owner observation')
  const beforeModeAcks = await page.evaluate(() => window.__localAcks.length)
  await page.evaluate((next) => window.__setLocal(next), { ...local, mode: 'global' })
  holdRule = false
  releaseRule()
  await page.waitForFunction(
    () =>
      window.__busy.at(-1) === false &&
      document.getElementById('runtime-owner')?.textContent ===
        JSON.stringify([
          window.__owner?.instanceId,
          window.__owner?.configurationRevision,
          'global'
        ])
  )
  assert.equal(await page.evaluate(() => window.__localAcks.length), beforeModeAcks)
  checks.push(
    'a queued newer observation of the same instance/revision keeps its mode because parent state adoption compares the exact RPC-start observation object inside the functional updater'
  )
  await page.evaluate(() => window.__foreign(true))
  await page.waitForFunction(() => document.querySelector('button').disabled)
  const foreignBusy = await page.evaluate(() => [...window.__busy]),
    callsBeforeForeign = calls.length
  assert.ok(await read.isDisabled())
  assert.deepEqual(await page.evaluate(() => window.__busy), foreignBusy)
  assert.equal(calls.length, callsBeforeForeign)
  await page.evaluate(() => window.__foreign(false))
  holdDoc = true
  docEntered = Promise.withResolvers()
  await read.click()
  await bounded(docEntered.promise, 'remount read')
  await page.evaluate(() => window.__remount())
  await page.waitForFunction(() => document.getElementById('generation').textContent === '1')
  const profileListsBeforeRemount = count('relayProfileList')
  holdDoc = false
  releaseDoc()
  await page.waitForFunction(() => !document.querySelector('button').disabled)
  assert.equal(await scope.count(), 0)
  assert.equal(count('relayProfileList'), profileListsBeforeRemount)
  checks.push(
    'foreign busy is not released by this manager and remounting rejects a late patch read before any follow-up profile request'
  )
  const tunPanel = page.getByRole('region', { name: '自有TUN临时规则开关', exact: true }),
    tunRead = tunPanel.getByRole('button', { name: '读取当前TUN运行规则', exact: true }),
    tunNotice = (text) => tunPanel.getByRole('status').filter({ hasText: text }),
    setTun = async (next) => {
      await page.evaluate((next) => window.__setTun(next), next)
      await page.waitForFunction(
        (value) => document.getElementById('tun-owner')?.textContent === value,
        JSON.stringify([next?.sessionId, next?.phase, next?.pending, false])
      )
    },
    localCallsBeforeTun = count('relayLocalProxyAction'),
    localAcksBeforeTun = await page.evaluate(() => window.__localAcks.length)
  assert.equal(count('relayTunRulesRead'), 0)
  assert.equal(count('relayTunRuleChange'), 0)
  assert.ok(await tunRead.isDisabled())
  await setTun(tun)
  await tunRead.click()
  await tunPanel.getByRole('switch', { name: '临时启用规则 2', exact: true }).waitFor()
  assert.equal(await tunPanel.getByRole('switch').count(), 3)
  assert.equal(await read.isDisabled(), true)
  assert.deepEqual(calls.filter((v) => v.channel === 'relayTunRulesRead').at(-1).input, {
    sessionId: tun.sessionId
  })
  assert.ok(!Object.hasOwn(tun, 'httpPort') && !Object.hasOwn(tun, 'configurationRevision'))
  checks.push(
    'stable owned TUN explicitly reads via the strict session-only dedicated IPC with no HTTP port or fabricated state revision; persistent edits remain locked'
  )
  await tunPanel.getByRole('textbox', { name: 'TUN运行规则筛选', exact: true }).fill('dup.invalid')
  holdTunChange = true
  tunChangeEntered = Promise.withResolvers()
  await tunPanel.getByRole('switch', { name: '临时启用规则 2', exact: true }).click()
  await bounded(tunChangeEntered.promise, 'TUN Native cancel')
  assert.ok(await tunRead.isDisabled())
  assert.equal(
    await tunPanel.getByRole('switch', { name: '临时启用规则 2', exact: true }).isChecked(),
    false
  )
  await setTun({ ...tun, pending: true })
  const busyBeforeTunSettlement = await page.evaluate(() => window.__busy.length)
  assert.ok(await tunRead.isDisabled())
  holdTunChange = false
  releaseTunChange()
  await tunNotice('已取消本次TUN规则操作').waitFor()
  assert.equal(await tunPanel.getByRole('switch').count(), 0)
  assert.equal(tunWrites, 0)
  await setTun(tun)
  assert.ok((await page.evaluate(() => window.__busy.length)) > busyBeforeTunSettlement)
  checks.push(
    'TUN filtered toggle retains its original Native index, is non-optimistic, and same-owner pending blocks new work without invalidating the eventual default-cancel result'
  )
  holdTunRead = true
  tunReadEntered = Promise.withResolvers()
  await tunRead.click()
  await bounded(tunReadEntered.promise, 'TUN held read')
  await setTun({ ...tun, pending: true })
  holdTunRead = false
  releaseTunRead()
  await tunNotice('已读取本次TUN的Native规则快照').waitFor()
  await setTun(tun)
  await tunPanel.getByRole('switch', { name: '临时启用规则 2', exact: true }).waitFor()
  tunOutcome = 'changed'
  await tunPanel.getByRole('switch', { name: '临时启用规则 2', exact: true }).click()
  await tunNotice('本次TUN临时禁用位已整表读回确认').waitFor()
  assert.equal(tunKernel[1].disabled, false)
  const tunChangedCall = calls.filter((v) => v.channel === 'relayTunRuleChange').at(-1)
  assert.deepEqual(Object.keys(tunChangedCall.input).sort(), [
    'configurationRevision',
    'disabled',
    'index',
    'rulesSHA256',
    'sessionId'
  ])
  assert.equal(tunChangedCall.input.configurationRevision, 'b'.repeat(64))
  assert.equal(tunChangedCall.input.index, 1)
  assert.equal(await page.evaluate(() => window.__localAcks.length), localAcksBeforeTun)
  assert.equal(count('relayLocalProxyAction'), localCallsBeforeTun)
  checks.push(
    'same-owner pending during a held read keeps the valid late snapshot; confirmed TUN mutation uses only Native snapshot revision/SHA and never adopts a parent TUN or localProxy state'
  )
  const writesBeforeStaleTun = tunWrites,
    tunReadsBeforeStale = count('relayTunRulesRead')
  await tunPanel.getByRole('textbox', { name: 'TUN运行规则筛选', exact: true }).fill('')
  tunRevision = 'c'.repeat(64)
  await tunPanel.getByRole('switch', { name: '临时启用规则 1', exact: true }).click()
  await tunNotice('TUN规则选择或结果未确认').waitFor()
  assert.equal(tunWrites, writesBeforeStaleTun)
  assert.equal(count('relayTunRulesRead'), tunReadsBeforeStale)
  assert.equal(await tunPanel.getByRole('switch').count(), 0)
  checks.push(
    'an unseen same-session Native configuration revision change is rejected by the injected strict fresh backend boundary; UI clears its old table and does not invent a revision or automatically reread/retry'
  )
  await tunRead.click()
  await tunPanel.getByRole('switch', { name: '临时启用规则 1', exact: true }).waitFor()
  holdTunChange = true
  tunChangeEntered = Promise.withResolvers()
  await tunPanel.getByRole('switch', { name: '临时启用规则 1', exact: true }).click()
  await bounded(tunChangeEntered.promise, 'TUN owner replacement')
  const busyBeforeTunOwners = await page.evaluate(() => window.__busy.length)
  await setTun({ ...tun, sessionId: id(71) })
  await setTun(tun)
  assert.equal(await page.evaluate(() => window.__busy.length), busyBeforeTunOwners)
  assert.ok(await tunRead.isDisabled())
  holdTunChange = false
  releaseTunChange()
  await page.waitForFunction(
    () => !document.querySelector('section[aria-label="自有TUN临时规则开关"] button').disabled
  )
  assert.equal(await tunPanel.getByRole('switch').count(), 0)
  checks.push(
    'an injected stale changed reply cannot resurrect a table after TUN owner A→B→A; source generations reject it while the original operation keeps busy until settlement'
  )
  holdTunRead = true
  tunReadEntered = Promise.withResolvers()
  await tunRead.click()
  await bounded(tunReadEntered.promise, 'TUN hidden read')
  const callsBeforeTunHide = calls.length,
    busyBeforeTunHide = await page.evaluate(() => window.__busy.length)
  await page.evaluate(() => window.__invalidate())
  assert.equal(await page.evaluate(() => window.__busy.length), busyBeforeTunHide)
  holdTunRead = false
  releaseTunRead()
  await page.waitForFunction(
    () => !document.querySelector('section[aria-label="自有TUN临时规则开关"] button').disabled
  )
  assert.equal(await tunPanel.getByRole('switch').count(), 0)
  assert.equal(calls.length, callsBeforeTunHide)
  checks.push(
    'hide invalidation discards a held TUN read without follow-up IPC, retry or early busy release'
  )
  await tunRead.click()
  await tunPanel.getByRole('switch', { name: '临时启用规则 1', exact: true }).waitFor()
  tunOutcome = 'uncertain'
  await tunPanel.getByRole('switch', { name: '临时启用规则 1', exact: true }).click()
  await tunNotice('TUN规则选择或结果未确认').waitFor()
  assert.equal(await tunPanel.getByRole('switch').count(), 0)
  const changesAfterUnknownTun = count('relayTunRuleChange')
  tunOutcome = 'unsupported'
  await tunRead.click()
  await tunNotice('本次客户端未提供独立TUN规则能力').waitFor()
  assert.equal(await tunPanel.getByRole('switch').count(), 0)
  assert.equal(count('relayTunRuleChange'), changesAfterUnknownTun)
  assert.equal(count('relayLocalProxyAction'), localCallsBeforeTun)
  checks.push(
    'uncertain changes and unsupported old-client reads both invalidate the old TUN table with zero automatic retry, lifecycle action or localProxy fallback'
  )
  await page.evaluate(() => window.__foreign(true))
  await page.waitForFunction(
    () => document.querySelector('section[aria-label="自有TUN临时规则开关"] button').disabled
  )
  const foreignTunBusy = await page.evaluate(() => [...window.__busy]),
    callsBeforeForeignTun = calls.length
  assert.ok(await tunRead.isDisabled())
  assert.deepEqual(await page.evaluate(() => window.__busy), foreignTunBusy)
  assert.equal(calls.length, callsBeforeForeignTun)
  await page.evaluate(() => window.__foreign(false))
  await page.evaluate(() => window.__tunUnknown(true))
  await page.waitForFunction(() =>
    document.getElementById('tun-owner').textContent.endsWith('true]')
  )
  assert.ok(await tunRead.isDisabled())
  assert.equal(count('relayLocalProxyAction'), localCallsBeforeTun)
  checks.push(
    'foreign busy and unconfirmed TUN prevent new requests without releasing another owner or switching sources'
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  const files = [
      'src/renderer/src/components/rules/rule-editor-modal.tsx',
      'src/renderer/src/components/rules/rule-item.tsx',
      'src/renderer/src/components/rules/relay-rule-list-editor.tsx',
      'src/renderer/src/components/relay/rules-panel.tsx',
      'src/renderer/src/components/relay/profile-rule-editor.tsx',
      'src/renderer/src/hooks/use-relay-rule-editor.tsx',
      'src/renderer/src/utils/relay-rule-editor.ts',
      'src/renderer/src/components/simple/delete-resource-button.tsx',
      'src/renderer/src/pages/relay-workspace.tsx',
      'src/renderer/src/components/relay/preview-controls.tsx',
      'scripts/relay/test-rules-structured-ui.mjs'
    ],
    result = {
      verifiedAt: new Date().toISOString(),
      passed: checks.length,
      checks,
      sourceSHA256: Object.fromEntries(
        await Promise.all(files.map(async (file) => [file, sha(await readFile(file))]))
      ),
      actualPreviewComposer: true,
      actualBackendIPC: false,
      actualNativeOrCore: false,
      actualNetwork: false,
      externalRequests: blocked.length,
      scope:
        'Actual original Modal/Select/Radio/RuleItem/Confirm/DndKit plus real Relay hooks; private injected CAS/profile-copy/localProxy and dedicated TUN IPC with actual strict TUN request validators. Preview calls the actual pure compose function. Standalone callbacks and stale owner replies are injected boundaries, not actual Main/Native authorization.',
      productAcceptance: 'pending'
    }
  await writeFile(
    process.env.RELAY_UI_VERIFICATION_OUTPUT ??
      '../evidence/rules-structured-ui-browser-verification-20261101.json',
    JSON.stringify(result, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  await writeFile(
    '/private/tmp/relay-rules-ui-failure.json',
    JSON.stringify(
      {
        checks,
        channels: calls.map((call) => ({ channel: call.channel, action: call.input?.action })),
        status: await page?.getByRole('status').allTextContents(),
        dialogs: await page?.getByRole('dialog').allTextContents(),
        keySensors: await page?.evaluate(() => window.__keySensors),
        observedOwner: await page?.evaluate(() => window.__owner),
        dragRows: await page?.locator('[data-rule-row] > [role=button]').evaluateAll((nodes) =>
          nodes.map((node) => ({
            key: node.parentElement.getAttribute('data-rule-row'),
            rect: node.getBoundingClientRect().toJSON(),
            pressed: node.getAttribute('aria-pressed'),
            transform: node.style.transform
          }))
        ),
        scroll: await page?.evaluate(() => ({ x: scrollX, y: scrollY })),
        errors
      },
      null,
      2
    ) + '\n'
  )
  await page?.screenshot({ path: '/private/tmp/relay-rules-ui-failure.png' })
  throw error
} finally {
  await browser?.close()
  await rm(directory, { recursive: true, force: true })
}
