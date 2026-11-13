// Private browser fixture. Original toolbar/cards/modals, inert editor stand-in.
// No App, Core, user files, backend network or production dependencies are run.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use isolated bundled Playwright and browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const directory = await mkdtemp(resolve('.relay-build/override-library-ui-')),
  sha = (value) => createHash('sha256').update(value).digest('hex'),
  id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
  calls = [],
  bootstrapCalls = [],
  checks = [],
  errors = [],
  blocked = [],
  oldA = '0'.repeat(64),
  oldB = '1'.repeat(64),
  oldShadow = '2'.repeat(64),
  p1 = { id: id(101), sha256: 'a'.repeat(64), revision: 'c'.repeat(64) },
  p2 = { id: id(102), sha256: 'b'.repeat(64), revision: 'd'.repeat(64) },
  profiles = [
    { ...p1, name: 'Profile One', createdAt: '2026-11-01', summary: {} },
    { ...p2, name: 'Profile Two', createdAt: '2026-11-01', summary: {} }
  ]
let serial = 1,
  editSerial = 1,
  nextId = 4,
  browser,
  diagnosticPage,
  activeLibrary = false,
  holdList = false,
  failNextList = false,
  listEntered,
  releaseList,
  holdRead = false,
  readEntered,
  releaseRead,
  holdBindings = false,
  bindingsEntered,
  releaseBindings,
  failMetadata = false,
  failBody = false,
  failOrder = false,
  holdExecute = false,
  executeEntered,
  releaseExecute,
  holdCancel = false,
  cancelEntered,
  releaseCancel,
  fetchCancelled = false,
  commitDespiteCancel = false,
  fetchProof,
  fetchActive,
  records = [
    {
      id: id(1),
      name: 'Alpha YAML',
      kind: 'yaml',
      type: 'local',
      content: 'rules: []\n',
      bodyState: 'local'
    },
    {
      id: id(2),
      name: 'Beta JS',
      kind: 'js',
      type: 'local',
      content: 'function main(config) { return config }\n',
      bodyState: 'local'
    },
    {
      id: id(3),
      name: 'Remote YAML',
      kind: 'yaml',
      type: 'remote',
      content: 'dns: {}\n',
      remote: { url: 'https://override.invalid/old.yaml?token=PRIVATE-url', proxyPort: 17891 },
      bodyState: 'current'
    }
  ].map((item) => ({
    ...item,
    createdAt: 1,
    metadataUpdatedAt: 1,
    bodyUpdatedAt: 1,
    metadataRevision: sha(item.name),
    bodyRevision: sha(item.content),
    bodyBytes: Buffer.byteLength(item.content)
  })),
  order = records.map((item) => item.id),
  globals = [{ id: id(1), bodyRevision: oldA }],
  profileRefs = new Map([
    [
      p1.id,
      [
        { id: id(2), bodyRevision: oldB },
        { id: id(1), bodyRevision: oldShadow }
      ]
    ],
    [p2.id, [{ id: id(2), bodyRevision: sha(records[1].content) }]]
  ])
const revision = () => sha('library-' + serial),
  editRevision = () => sha('edit-' + editSerial)
const summary = (item) =>
  Object.fromEntries(
    [
      'id',
      'name',
      'kind',
      'type',
      'metadataRevision',
      'bodyRevision',
      'bodyBytes',
      'bodyState',
      'createdAt',
      'metadataUpdatedAt',
      'bodyUpdatedAt',
      'lastFetchedAt'
    ]
      .filter((key) => item[key] !== undefined)
      .map((key) => [key, item[key]])
  )
const inventory = () => ({ revision: revision(), exists: true, items: records.map(summary) })
const target = (raw) => {
  if (!raw) return undefined
  const value = [p1, p2].find((item) => item.id === raw.id)
  assert.ok(value)
  assert.equal(raw.sha256, value.sha256)
  return value
}
const bindings = (raw) => ({
  editRevision: editRevision(),
  order: [...order, ...records.map((item) => item.id).filter((id) => !order.includes(id))],
  globalRefs: structuredClone(globals),
  profileRefs: raw ? structuredClone(profileRefs.get(raw.id) ?? []) : [],
  ...(raw ? { target: target(raw) } : {})
})
const count = (channel) => calls.filter((call) => call.channel === channel).length
const bounded = async (promise, name) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(name + ' deadline')), 15000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
try {
  await build({
    stdin: {
      contents: `import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{HeroUIProvider}from'@heroui/react';import i18n from'i18next';import{initReactI18next}from'react-i18next';import{RelayOverrideLibraryManager}from'./src/renderer/src/pages/override';
  const translations={'override.actions.newYaml':'新建YAML覆写','override.actions.newJs':'新建JavaScript覆写','override.menuItems.editInfo':'编辑元信息','override.menuItems.editFile':'编辑正文','override.menuItems.delete':'删除定义','override.editInfo.title':'编辑覆写元信息','override.editInfo.name':'名称','override.editInfo.url':'远端地址','override.editInfo.global':'全局','override.editFile.title':'编辑覆写正文','common.cancel':'取消','common.save':'保存元信息','common.confirm':'保存正文'};
  function App(){const[busy,setBusy]=useState(false),[foreign,setForeign]=useState(false);useEffect(()=>{window.__foreign=setForeign},[]);return <HeroUIProvider disableAnimation><RelayOverrideLibraryManager busy={busy||foreign} onBusy={value=>{window.__busy.push(value);setBusy(value)}} onBindingsChanged={()=>window.__changes++}/></HeroUIProvider>};void(async()=>{await i18n.use(initReactI18next).init({lng:'zh',fallbackLng:'zh',keySeparator:false,resources:{zh:{translation:translations}},interpolation:{escapeValue:false}});createRoot(document.getElementById('root')).render(<App/>);})();`,
      loader: 'tsx',
      resolveDir: process.cwd()
    },
    tsconfig: resolve('tsconfig.web.json'),
    bundle: true,
    jsx: 'automatic',
    outfile: join(directory, 'panel.js'),
    plugins: [
      {
        name: 'isolated-editor',
        setup(build) {
          build.onResolve({ filter: /base-editor$/ }, () => ({
            path: 'editor',
            namespace: 'fixture'
          }))
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `import React from'react';export const BaseEditor=({value,readOnly,onChange})=><textarea aria-label="覆写正文编辑器" value={value} readOnly={readOnly} onChange={e=>onChange?.(e.target.value)}/>;`,
            loader: 'tsx',
            resolveDir: process.cwd()
          }))
        }
      }
    ]
  })
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><style>body{font:16px system-ui;padding:12px}[data-override-id]{min-height:160px;border:1px solid #888;padding:8px;margin:6px}button,input,select{margin:4px}textarea{width:650px;height:260px}section[role=dialog]{background:white;border:2px solid #888;padding:16px;position:fixed;inset:30px;overflow:auto;z-index:100}section{margin-bottom:24px}</style><div id="root"></div><script src="panel.js"></script>'
  )
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    args: [
      '--allow-file-access-from-files',
      '--disable-background-networking',
      '--disable-component-update'
    ]
  })
  const context = await bounded(browser.newContext(), 'context'),
    allowed = pathToFileURL(directory).href + '/'
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(allowed)) return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  diagnosticPage = page
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__invoke', async (channel, input) => {
    if (channel === 'changeLanguage') {
      bootstrapCalls.push({ channel, input })
      return
    }
    calls.push({ channel, input: structuredClone(input) })
    if (channel === 'relayProfileList')
      return {
        profiles: profiles.map((profile) => ({
          id: profile.id,
          sha256: profile.sha256,
          name: profile.name,
          createdAt: profile.createdAt,
          summary: profile.summary
        })),
        incomplete: 0,
        activeId: null,
        warnings: []
      }
    if (channel === 'relayOverrideLibraryFetchCancel') {
      assert.deepEqual(Object.keys(input), ['evidenceId'])
      if (fetchProof?.evidenceId === input.evidenceId) fetchProof = undefined
      if (fetchActive?.evidenceId === input.evidenceId) fetchCancelled = true
      if (holdCancel) {
        cancelEntered.resolve()
        await new Promise((resolve) => {
          releaseCancel = resolve
        })
      }
      return
    }
    assert.ok(channel.startsWith('relayOverrideLibrary'), 'Forbidden legacy IPC: ' + channel)
    assert.equal(activeLibrary, false, 'Library requests overlapped')
    activeLibrary = true
    try {
      if (channel === 'relayOverrideLibraryList') {
        assert.equal(input, undefined)
        if (failNextList) {
          failNextList = false
          throw new Error('PRIVATE refresh failure')
        }
        if (holdList) {
          listEntered.resolve()
          await new Promise((resolve) => {
            releaseList = resolve
          })
        }
        return inventory()
      }
      if (channel === 'relayOverrideLibraryBindingsRead') {
        if (input.target) assert.deepEqual(Object.keys(input.target).sort(), ['id', 'sha256'])
        if (holdBindings) {
          bindingsEntered.resolve()
          await new Promise((resolve) => {
            releaseBindings = resolve
          })
        }
        return bindings(input.target)
      }
      if (channel === 'relayOverrideLibraryRead') {
        assert.equal(input.expectedLibraryRevision, revision())
        const item = records.find((item) => item.id === input.id)
        assert.ok(item)
        if (holdRead) {
          readEntered.resolve()
          await new Promise((resolve) => {
            releaseRead = resolve
          })
        }
        return { revision: revision(), item: structuredClone(item) }
      }
      if (channel === 'relayOverrideLibraryCreate') {
        assert.equal(input.expectedLibraryRevision, revision())
        if (input.type === 'remote') assert.ok(!('content' in input))
        const content = input.content,
          item = {
            id: id(nextId++),
            name: input.name,
            kind: input.kind,
            type: input.type,
            ...(input.remote ? { remote: input.remote } : {}),
            ...(content !== undefined ? { content } : {}),
            createdAt: Date.now(),
            metadataUpdatedAt: Date.now(),
            metadataRevision: sha(input.name + serial),
            bodyRevision: content === undefined ? '' : sha(content),
            bodyBytes: content === undefined ? 0 : Buffer.byteLength(content),
            bodyState: input.type === 'remote' ? 'missing' : 'local'
          }
        records.push(item)
        serial++
        return { revision: revision(), item: summary(item) }
      }
      if (
        channel === 'relayOverrideLibrarySaveMetadata' ||
        channel === 'relayOverrideLibrarySaveBody'
      ) {
        assert.equal(input.expectedLibraryRevision, revision())
        const item = records.find((item) => item.id === input.id)
        assert.ok(item)
        if (channel.endsWith('SaveMetadata')) {
          assert.equal(input.expectedMetadataRevision, item.metadataRevision)
          if (failMetadata) throw new Error('PRIVATE metadata CAS')
          item.name = input.name
          if (input.remote) {
            item.remote = input.remote
            if (item.content !== undefined) item.bodyState = 'stale'
          }
          item.metadataRevision = sha(item.name + serial)
        } else {
          assert.equal(input.expectedBodyRevision, item.bodyRevision)
          if (failBody) throw new Error('PRIVATE body CAS')
          item.content = input.content
          item.bodyRevision = sha(input.content)
          item.bodyBytes = Buffer.byteLength(input.content)
          item.bodyState = item.type === 'remote' ? 'manual' : 'local'
          item.bodyUpdatedAt = Date.now()
        }
        serial++
        return { revision: revision(), item: summary(item) }
      }
      if (channel === 'relayOverrideLibraryRemove') {
        assert.equal(input.expectedLibraryRevision, revision())
        assert.ok(
          !globals.some((ref) => ref.id === input.id) &&
            ![...profileRefs.values()].flat().some((ref) => ref.id === input.id)
        )
        records = records.filter((item) => item.id !== input.id)
        serial++
        return inventory()
      }
      if (channel === 'relayOverrideLibraryOrder') {
        assert.equal(input.expectedEditRevision, editRevision())
        if (failOrder) throw new Error('PRIVATE order CAS')
        order = [...input.ids]
        globals.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
        editSerial++
        return bindings()
      }
      if (channel === 'relayOverrideLibraryBind') {
        assert.equal(input.expectedEditRevision, editRevision())
        if (input.target) {
          assert.equal(input.target.revision, target(input.target).revision)
          profileRefs.set(input.target.id, structuredClone(input.refs))
        } else globals = structuredClone(input.refs)
        editSerial++
        return bindings(input.target)
      }
      if (channel === 'relayOverrideLibraryRefresh') {
        assert.equal(input.expectedEditRevision, editRevision())
        const refs = input.target ? profileRefs.get(input.target.id) : globals
        for (const ref of input.refs) {
          const old = refs.find((item) => item.id === ref.id),
            head = records.find((item) => item.id === ref.id)
          assert.equal(ref.expectedOldBodyRevision, old.bodyRevision)
          assert.equal(ref.bodyRevision, head.bodyRevision)
          old.bodyRevision = ref.bodyRevision
        }
        editSerial++
        return bindings(input.target)
      }
      if (channel === 'relayOverrideLibraryFetchPrepare') {
        assert.equal(input.expectedLibraryRevision, revision())
        const item = records.find((item) => item.id === input.id)
        assert.equal(item.type, 'remote')
        fetchProof = {
          evidenceId: id(900),
          action: 'fetchOverride',
          id: item.id,
          name: item.name,
          kind: item.kind,
          endpoint: 'https://override.invalid/redacted.yaml',
          proxyPort: item.remote.proxyPort,
          sourceFingerprint: 'f'.repeat(64),
          libraryRevision: revision(),
          metadataRevision: item.metadataRevision,
          bodyRevision: item.bodyRevision,
          maxBytes: 131072,
          expiresAt: Date.now() + 60000
        }
        return structuredClone(fetchProof)
      }
      if (channel === 'relayOverrideLibraryFetchExecute') {
        assert.equal(input.evidenceId, fetchProof?.evidenceId)
        fetchActive = fetchProof
        fetchProof = undefined
        fetchCancelled = false
        if (holdExecute) {
          executeEntered.resolve()
          await new Promise((resolve) => {
            releaseExecute = resolve
          })
        }
        if (fetchCancelled && !commitDespiteCancel) {
          fetchActive = undefined
          return { status: 'cancelled' }
        }
        const item = records.find((item) => item.id === fetchActive.id)
        item.content = 'rules: [MATCH,REJECT]\n'
        item.bodyRevision = sha(item.content)
        item.bodyBytes = Buffer.byteLength(item.content)
        item.bodyState = 'current'
        item.lastFetchedAt = Date.now()
        serial++
        fetchActive = undefined
        return { status: 'updated', revision: revision(), item: summary(item) }
      }
      throw new Error('Unknown library channel ' + channel)
    } finally {
      activeLibrary = false
    }
  })
  await page.addInitScript(() => {
    const listeners = new Map(),
      captureListeners = new Map(),
      add = document.addEventListener,
      remove = document.removeEventListener,
      captures = (options) => options === true || options?.capture === true
    window.__captureClickGuards = []
    // Observe the real sensor teardown without changing dispatch or its deadline.
    document.addEventListener = function (type, listener, options) {
      const result = Reflect.apply(add, this, arguments)
      if (type === 'click' && captures(options) && !captureListeners.has(listener)) {
        const entry = {
          id: window.__captureClickGuards.length,
          stack: new Error('Capture listener observation').stack,
          removed: false
        }
        captureListeners.set(listener, entry)
        window.__captureClickGuards.push(entry)
      }
      return result
    }
    document.removeEventListener = function (type, listener, options) {
      const result = Reflect.apply(remove, this, arguments)
      if (type === 'click' && captures(options)) {
        const entry = captureListeners.get(listener)
        if (entry) entry.removed = true
        captureListeners.delete(listener)
      }
      return result
    }
    window.__busy = []
    window.__changes = 0
    window.__replies = {}
    window.__menuDiagnostics = []
    window.__focusEvents = []
    for (const type of ['focusin', 'focusout', 'keydown', 'pointerdown'])
      document.addEventListener(
        type,
        (event) => {
          const target = event.target
          window.__focusEvents.push({
            type,
            tag: target?.tagName,
            role: target?.getAttribute?.('role'),
            key: event.key,
            action: target?.getAttribute?.('data-key')
          })
        },
        true
      )
    window.__invalidate = () =>
      listeners.get('relayBackupPreparationsInvalidated')?.forEach((fn) => fn())
    window.electron = {
      ipcRenderer: {
        invoke: async (...args) => {
          try {
            return await window.__invoke(...args)
          } finally {
            window.__replies[args[0]] = (window.__replies[args[0]] ?? 0) + 1
          }
        },
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
  const read = page.getByRole('button', { name: '读取覆写库与引用', exact: true }),
    notice = (text) => page.getByRole('status').filter({ hasText: text }),
    card = (n) => page.locator(`[data-override-id="${id(n)}"]`),
    menu = async (n, name) => {
      const trigger = card(n).getByRole('button', { name: /^覆写操作/u })
      // This unstyled fixture stacks cards; finish its real scroll before opening
      // an overlay whose production useCloseOnScroll correctly closes on scroll.
      await bounded(
        trigger.evaluate(async (node) => {
          const rect = node.getBoundingClientRect()
          if (
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            rect.left >= 0 &&
            rect.right <= innerWidth
          )
            return
          await new Promise((resolve, reject) => {
            let timer
            const finish = (error) => {
                document.removeEventListener('scrollend', onEnd)
                clearTimeout(timer)
                if (error) reject(error)
                else resolve()
              },
              onEnd = (event) => {
                if (event.target === document) finish()
              },
              beforeX = scrollX,
              beforeY = scrollY
            document.addEventListener('scrollend', onEnd)
            timer = setTimeout(() => finish(new Error('Fixture scrollend deadline exceeded')), 4500)
            try {
              node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
              if (scrollX === beforeX && scrollY === beforeY) finish()
            } catch (error) {
              finish(error)
            }
          })
        }),
        'actual scrollend before opening'
      )
      await trigger.click()
      const action = page.getByRole('menuitem', { name, exact: true })
      await action.waitFor()
      await page.evaluate(() =>
        window.__menuDiagnostics.push({
          dialogs: [...document.querySelectorAll('[role=dialog]')].map((node) => ({
            tag: node.tagName,
            slot: node.getAttribute('data-slot'),
            position: getComputedStyle(node).position,
            inset: getComputedStyle(node).inset,
            rect: node.getBoundingClientRect().toJSON()
          })),
          menus: [...document.querySelectorAll('[role=menu]')].map((node) => ({
            tag: node.tagName,
            rect: node.getBoundingClientRect().toJSON()
          }))
        })
      )
      await action.focus()
      await action.press('Enter')
    },
    dialog = () => page.getByRole('dialog')
  await read.waitFor()
  assert.equal(calls.length, 0)
  holdList = true
  listEntered = Promise.withResolvers()
  await read.click()
  await bounded(listEntered.promise, 'list entered')
  assert.ok(await read.isDisabled())
  assert.equal(count('relayOverrideLibraryBindingsRead'), 0)
  assert.equal(count('relayProfileList'), 0)
  holdList = false
  releaseList()
  await notice('已读取私有覆写库').waitFor()
  await card(1).waitFor()
  assert.deepEqual(
    calls.slice(0, 3).map((call) => call.channel),
    ['relayOverrideLibraryList', 'relayOverrideLibraryBindingsRead', 'relayProfileList']
  )
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE'))
  checks.push(
    'initial render is inert; explicit reload serializes held List, Bindings and ProfileList without overlapping singleflight or releasing pending early'
  )

  await page.getByRole('button', { name: '新建本地覆写', exact: true }).click()
  await page.getByRole('menuitem', { name: '新建YAML覆写', exact: true }).click()
  await page.getByRole('heading', { name: '新建YAML覆写', exact: true }).waitFor()
  const local = records.find((item) => item.name === '新建YAML覆写')
  assert.equal(local.type, 'local')
  assert.ok(local.content)
  assert.equal(count('relayOverrideLibraryFetchPrepare'), 0)
  await page.getByLabel('远端覆写公共名称', { exact: true }).fill('新远端定义')
  await page
    .getByLabel('新增远端覆写地址', { exact: true })
    .fill('https://override.invalid/PRIVATE-path?token=PRIVATE-query')
  await page.getByRole('button', { name: '保存远端定义（不获取）', exact: true }).click()
  await page.getByRole('heading', { name: '新远端定义', exact: true }).waitFor()
  assert.equal(records.find((item) => item.name === '新远端定义').bodyState, 'missing')
  assert.equal(count('relayOverrideLibraryFetchExecute'), 0)
  assert.equal(await page.getByRole('heading', { name: /PRIVATE-path/u }).count(), 0)
  checks.push(
    'original new-local menu and URL toolbar create inert definitions; remote creation stores only metadata and never downloads or executes'
  )

  await page.getByRole('button', { name: '新建本地覆写', exact: true }).click()
  await page.getByRole('menuitem', { name: '新建JavaScript覆写', exact: true }).click()
  await page.getByRole('heading', { name: '新建JavaScript覆写', exact: true }).waitFor()
  const newJS = records.find((item) => item.name === '新建JavaScript覆写')
  for (const item of [newJS, local]) {
    await page.locator(`[data-override-id="${item.id}"]`).getByRole('switch').click()
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('button')]
          .find((node) => node.textContent === '读取覆写库与引用')
          .matches(':disabled')
    )
  }
  assert.deepEqual(
    globals.map((ref) => ref.id),
    [id(1), local.id, newJS.id]
  )
  assert.equal(globals[0].bodyRevision, oldA)
  const unused = records.find((item) => item.name === '新远端定义')
  await page
    .locator(`[data-override-id="${unused.id}"]`)
    .getByRole('button', { name: /^覆写操作/u })
    .click()
  const deleteItem = page.getByRole('menuitem', { name: '删除定义', exact: true })
  await deleteItem.waitFor()
  await deleteItem.focus()
  await deleteItem.press('Enter')
  await page
    .getByRole('heading', { name: '新远端定义', exact: true })
    .waitFor({ state: 'detached' })
  assert.ok(!records.some((item) => item.id === unused.id))
  assert.equal(profileRefs.get(p1.id)[1].bodyRevision, oldShadow)
  checks.push(
    'original global switches bind only explicitly chosen new heads in library order, retain old existing hashes and delete only an unused revision-bound definition without a core action'
  )

  await menu(3, '编辑元信息')
  await page.getByLabel('覆写名称', { exact: true }).fill('Remote renamed')
  await page.getByLabel('覆写代理端口', { exact: true }).fill('17892')
  failMetadata = true
  await dialog().getByRole('button', { name: '保存元信息', exact: true }).click()
  await dialog().getByRole('alert').waitFor()
  assert.equal(await page.getByLabel('覆写名称', { exact: true }).inputValue(), 'Remote renamed')
  assert.ok(!(await dialog().innerText()).includes('PRIVATE metadata CAS'))
  assert.equal(records[2].name, 'Remote YAML')
  failMetadata = false
  holdList = true
  listEntered = Promise.withResolvers()
  await dialog().getByRole('button', { name: '保存元信息', exact: true }).click()
  await bounded(listEntered.promise, 'metadata refresh')
  assert.equal(await dialog().count(), 1)
  assert.ok(await dialog().getByRole('button', { name: '取消', exact: true }).isDisabled())
  holdList = false
  releaseList()
  await dialog().waitFor({ state: 'detached' })
  assert.equal(records[2].name, 'Remote renamed')
  assert.equal(records[2].bodyState, 'stale')
  assert.equal(count('relayOverrideLibraryFetchPrepare'), 0)
  checks.push(
    'reused metadata modal reads details on demand, preserves failed drafts, binds independent revisions and stays pending through the complete acknowledgement refresh without fetching'
  )

  await menu(1, '编辑正文')
  await page.getByLabel('覆写正文编辑器', { exact: true }).fill('rules: [MATCH,REJECT]\n')
  failBody = true
  await dialog().getByRole('button', { name: '保存正文', exact: true }).click()
  await dialog().getByRole('alert').waitFor()
  assert.equal(
    await page.getByLabel('覆写正文编辑器', { exact: true }).inputValue(),
    'rules: [MATCH,REJECT]\n'
  )
  assert.equal(globals[0].bodyRevision, oldA)
  failBody = false
  await dialog().getByRole('button', { name: '保存正文', exact: true }).click()
  await dialog().waitFor({ state: 'detached' })
  assert.equal(globals[0].bodyRevision, oldA)
  assert.equal(profileRefs.get(p1.id)[1].bodyRevision, oldShadow)
  await card(1).getByRole('button', { name: '更新全局引用', exact: true }).click()
  await notice('显式更新所选引用').waitFor()
  assert.equal(globals[0].bodyRevision, records[0].bodyRevision)
  assert.equal(profileRefs.get(p1.id)[1].bodyRevision, oldShadow)
  checks.push(
    'reused body editor keeps conflict drafts and only saves a library head; existing global/history snapshots stay old until a separate explicit refresh'
  )

  await menu(1, '编辑正文')
  await page.getByLabel('覆写正文编辑器', { exact: true }).fill('dns: {enable: true}\n')
  const savesBeforeRefreshFailure = count('relayOverrideLibrarySaveBody')
  failNextList = true
  await dialog().getByRole('button', { name: '保存正文', exact: true }).click()
  await dialog().getByRole('alert').filter({ hasText: '本次库写入已确认，但刷新失败' }).waitFor()
  assert.equal(records[0].content, 'dns: {enable: true}\n')
  assert.equal(count('relayOverrideLibrarySaveBody'), savesBeforeRefreshFailure + 1)
  assert.ok(await dialog().getByRole('button', { name: '保存正文', exact: true }).isDisabled())
  assert.ok(!(await dialog().getByRole('button', { name: '取消', exact: true }).isDisabled()))
  assert.equal(
    await page.getByLabel('覆写正文编辑器', { exact: true }).inputValue(),
    'dns: {enable: true}\n'
  )
  await dialog().getByRole('button', { name: '取消', exact: true }).click()
  await read.click()
  await notice('已读取私有覆写库').waitFor()
  await card(1).getByRole('button', { name: '更新全局引用', exact: true }).click()
  await notice('显式更新所选引用').waitFor()
  checks.push(
    'an acknowledged body write followed by failed List refresh is reported as saved-needs-reread, preserves the draft and disables stale CAS retry without pretending cancelled or no write'
  )

  const beforeOther = JSON.stringify(profileRefs.get(p2.id))
  await page.getByLabel('覆写作用域', { exact: true }).selectOption(p1.id)
  await notice('此作用域的引用快照').waitFor()
  assert.ok((await page.locator('body').innerText()).includes('全局优先，旧引用保留'))
  const selectionPanel = page.getByRole('region', { name: '配置级有序覆写选择' })
  await selectionPanel.getByRole('button', { name: '前移', exact: true }).nth(1).click()
  await selectionPanel.getByRole('button', { name: '保存此配置有序选择', exact: true }).click()
  await notice('此配置的有序引用').waitFor()
  assert.deepEqual(profileRefs.get(p1.id), [
    { id: id(1), bodyRevision: oldShadow },
    { id: id(2), bodyRevision: oldB }
  ])
  assert.equal(JSON.stringify(profileRefs.get(p2.id)), beforeOther)
  const lastBind = calls.filter((call) => call.channel === 'relayOverrideLibraryBind').at(-1).input
  assert.equal(lastBind.target.revision, p1.revision)
  assert.notEqual(lastBind.target.revision, p1.sha256)
  checks.push(
    'profile bootstrap uses only id/SHA then preserves the real returned revision; reordering retains old inline hashes including globally shadowed refs and keeps other profiles intact'
  )

  await selectionPanel.getByRole('button', { name: '显式更新此引用', exact: true }).nth(1).click()
  await notice('显式更新所选引用').waitFor()
  assert.equal(profileRefs.get(p1.id)[1].bodyRevision, records[1].bodyRevision)
  assert.equal(profileRefs.get(p1.id)[0].bodyRevision, oldShadow)
  assert.equal(JSON.stringify(profileRefs.get(p2.id)), beforeOther)
  checks.push(
    'a separate profile refresh sends expected-old SHA and the read-ack target revision, upgrading only the chosen reference while preserving shadowed and other-profile snapshots'
  )

  await page.getByLabel('覆写作用域', { exact: true }).selectOption('')
  await notice('此作用域的引用快照').waitFor()
  const priorOrder = [...order],
    visible = async () =>
      page
        .locator('[data-override-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-override-id')))
  const drag = async () => {
    const guardBaseline = await page.evaluate(() => window.__captureClickGuards.length)
    await card(1).scrollIntoViewIfNeeded()
    await card(2).scrollIntoViewIfNeeded()
    const from = await card(1).locator('[role="button"]').first().boundingBox(),
      to = await card(2).locator('[role="button"]').first().boundingBox()
    assert.ok(from && to)
    await page.mouse.move(from.x + 15, from.y + 15)
    await page.mouse.down()
    await page.mouse.move(to.x + 15, to.y + to.height / 2, { steps: 12 })
    await page.mouse.up()
    const guards = await page.evaluate(
      (baseline) =>
        window.__captureClickGuards
          .slice(baseline)
          .filter((entry) => entry.stack.includes('handleStart'))
          .map((entry) => entry.id),
      guardBaseline
    )
    assert.equal(guards.length, 1)
    await page.waitForFunction(
      (ids) => ids.every((id) => window.__captureClickGuards[id]?.removed),
      guards
    )
  }
  failOrder = true
  await drag()
  await notice('写入或读取结果未确认').waitFor()
  assert.deepEqual(order, priorOrder)
  assert.deepEqual(
    await visible(),
    priorOrder.concat(
      records.filter((item) => !priorOrder.includes(item.id)).map((item) => item.id)
    )
  )
  failOrder = false
  await drag()
  await notice('库顺序与全局执行顺序已保存').waitFor()
  assert.equal(order[0], id(2))
  assert.equal(order[1], id(1))
  assert.equal(globals[0].bodyRevision, records[0].bodyRevision)
  checks.push(
    'real original DndKit cards restore their last acknowledged order on CAS rejection and persist successful order without silently upgrading inline content; the fixture waits for each actual sensor capture-click guard to be removed before the next action'
  )

  await card(3).getByRole('button', { name: '准备获取覆写 Remote renamed', exact: true }).click()
  await page.getByRole('button', { name: '单独确认获取覆写缓存', exact: true }).waitFor()
  assert.equal(count('relayOverrideLibraryFetchExecute'), 0)
  await page.getByRole('button', { name: '单独确认获取覆写缓存', exact: true }).click()
  await notice('本次获取已更新库缓存').waitFor()
  assert.equal(records[2].bodyState, 'current')
  assert.equal(profileRefs.get(p1.id)[0].bodyRevision, oldShadow)
  checks.push(
    'remote update is explicit Prepare then Native Execute; success refreshes only the cache and never calls legacy reload, path or script execution APIs'
  )

  await card(3).getByRole('button', { name: '准备获取覆写 Remote renamed', exact: true }).click()
  await page.getByRole('button', { name: '单独确认获取覆写缓存', exact: true }).waitFor()
  holdExecute = true
  executeEntered = Promise.withResolvers()
  await page.getByRole('button', { name: '单独确认获取覆写缓存', exact: true }).click()
  await bounded(executeEntered.promise, 'fetch execute')
  holdCancel = true
  cancelEntered = Promise.withResolvers()
  await page.getByRole('button', { name: '取消本次覆写获取', exact: true }).click()
  await bounded(cancelEntered.promise, 'fetch cancel')
  const priorReplies = await page.evaluate(
    () => window.__replies.relayOverrideLibraryFetchExecute ?? 0
  )
  holdExecute = false
  releaseExecute()
  await page.waitForFunction(
    (expected) => window.__replies.relayOverrideLibraryFetchExecute === expected,
    priorReplies + 1
  )
  assert.ok(await read.isDisabled())
  holdCancel = false
  releaseCancel()
  await notice('单次获取已取消').waitFor()
  assert.ok(!(await read.isDisabled()))
  checks.push(
    'matching fetch Cancel runs independently and retains owned busy until both the original request and cancellation actually settle'
  )

  await card(3).getByRole('button', { name: '准备获取覆写 Remote renamed', exact: true }).click()
  await page.getByRole('button', { name: '单独确认获取覆写缓存', exact: true }).waitFor()
  await page.evaluate(() => window.__foreign(true))
  const foreignEvents = await page.evaluate(() => window.__busy.length)
  await page.getByRole('button', { name: '取消本次覆写获取', exact: true }).click()
  await notice('单次获取准备已清除').waitFor()
  assert.ok(await read.isDisabled())
  assert.equal(await page.evaluate(() => window.__busy.length), foreignEvents)
  await page.evaluate(() => window.__foreign(false))
  checks.push(
    'idle fetch cancellation under foreign busy uses only its matching proof and never releases another operation'
  )

  await card(3).getByRole('button', { name: '准备获取覆写 Remote renamed', exact: true }).click()
  await page.getByRole('button', { name: '单独确认获取覆写缓存', exact: true }).waitFor()
  holdExecute = true
  executeEntered = Promise.withResolvers()
  commitDespiteCancel = true
  await page.getByRole('button', { name: '单独确认获取覆写缓存', exact: true }).click()
  await bounded(executeEntered.promise, 'admitted fetch write')
  holdCancel = true
  cancelEntered = Promise.withResolvers()
  await page.getByRole('button', { name: '取消本次覆写获取', exact: true }).click()
  await bounded(cancelEntered.promise, 'admitted cancel')
  holdExecute = false
  releaseExecute()
  await notice('本次获取已更新库缓存').waitFor()
  assert.ok(await read.isDisabled())
  holdCancel = false
  releaseCancel()
  await notice('本次缓存写入已确认').waitFor()
  commitDespiteCancel = false
  checks.push(
    'a producer-confirmed admitted cache write remains updated after Cancel; cancellation never claims it rolled back or performed zero writes'
  )

  holdBindings = true
  bindingsEntered = Promise.withResolvers()
  await page.getByLabel('覆写作用域', { exact: true }).selectOption(p1.id)
  await bounded(bindingsEntered.promise, 'bindings read')
  await page.evaluate((value) => {
    const select = document.querySelector('select[aria-label="覆写作用域"]')
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, p2.id)
  holdBindings = false
  releaseBindings()
  await notice('写入或读取结果未确认').waitFor()
  assert.equal(await page.getByLabel('覆写作用域', { exact: true }).inputValue(), '')
  checks.push(
    'a queued second target selection invalidates the first held acknowledgement instead of applying its revision or inline refs to another profile'
  )

  holdRead = true
  readEntered = Promise.withResolvers()
  await menu(1, '编辑正文')
  await bounded(readEntered.promise, 'body read')
  await page.evaluate(() => window.__invalidate())
  holdRead = false
  releaseRead()
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
  assert.equal(await page.locator('[data-override-id]').count(), 0)
  await read.click()
  await notice('已读取私有覆写库').waitFor()
  holdList = true
  listEntered = Promise.withResolvers()
  await read.click()
  await bounded(listEntered.promise, 'hidden list')
  const beforeHidden = calls.length
  await page.evaluate(() => window.__invalidate())
  assert.ok(await read.isDisabled())
  holdList = false
  releaseList()
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')]
        .find((node) => node.textContent === '读取覆写库与引用')
        .matches(':disabled')
  )
  assert.equal(calls.length, beforeHidden)
  assert.equal(await page.locator('[data-override-id]').count(), 0)
  checks.push(
    'lifecycle invalidation rejects late detail/list replies, clears transient cached content and performs no stale follow-up IPC or early busy release'
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  const files = [
    'src/renderer/src/hooks/use-relay-override-config.tsx',
    'src/renderer/src/pages/override.tsx',
    'src/renderer/src/components/override/override-item.tsx',
    'src/renderer/src/components/override/edit-info-modal.tsx',
    'src/renderer/src/components/override/edit-file-modal.tsx',
    'src/renderer/src/pages/relay-workspace.tsx',
    'src/renderer/src/components/relay/preview-controls.tsx',
    'scripts/relay/test-override-library-ui.mjs'
  ]
  const result = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-original-components-with-injected-library-ipc',
    checks,
    passed: checks.length,
    sourceHashes: Object.fromEntries(
      await Promise.all(files.map(async (file) => [file, sha(await readFile(file))]))
    ),
    editorEngine:
      'Only BaseEditor engine replaced by a textarea stand-in; production modal/card/hook/DndKit/HeroUI are real. App build and P7 validate Monaco separately.',
    fixtureLanguageBootstrap: bootstrapCalls,
    actualNetwork: false,
    actualUserFiles: false,
    actualCore: false,
    externalRequests: blocked.length,
    productAcceptance: 'pending'
  }
  await writeFile(
    process.env.RELAY_UI_VERIFICATION_OUTPUT ??
      '../evidence/override-library-ui-browser-verification-20261101.json',
    JSON.stringify(result, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  await writeFile(
    '/private/tmp/relay-override-ui-failure.json',
    JSON.stringify(
      {
        checks,
        channels: calls.map((call) => call.channel),
        status: await diagnosticPage?.getByRole('status').allTextContents(),
        menuDiagnostics: await diagnosticPage?.evaluate(() => window.__menuDiagnostics),
        captureClickGuards: await diagnosticPage?.evaluate(() => window.__captureClickGuards),
        focusEvents: await diagnosticPage?.evaluate(() => window.__focusEvents.slice(-25)),
        pageErrors: errors
      },
      null,
      2
    ) + '\n'
  )
  await diagnosticPage?.screenshot({ path: '/private/tmp/relay-override-ui-failure.png' })
  throw error
} finally {
  await browser?.close()
  await rm(directory, { recursive: true, force: true })
}
