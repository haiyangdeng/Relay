// Synthetic public IPC only. No real account, Token, runtime, Native dialog or network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and isolated test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/runtime-gist-sync-ui-')),
  calls = [],
  checks = [],
  errors = [],
  blocked = [],
  busyEvents = [],
  account = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 'a'.repeat(64),
    name: 'Fixture encrypted Gist',
    provider: 'gist',
    proxyPort: 18191,
    recipient: 'age1fixture-recipient',
    state: 'active',
    hasCredential: true,
    createdAt: 1,
    updatedAt: 1
  },
  plain = {
    ...account,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Fixture plain Gist',
    recipient: undefined
  },
  empty = () => ({ enabled: false, pending: false, phase: 'idle', dirty: false }),
  capture = (character) => ({
    revision: character.repeat(64),
    configurationSHA256: character.repeat(64),
    bytes: 123,
    capturedAt: 1793500000000
  }),
  armed = () => ({
    ...empty(),
    enabled: true,
    phase: 'waiting',
    account: { id: account.id, revision: account.revision, name: account.name },
    target: {
      gistId: 'abcde12345',
      url: 'https://gist.github.com/abcde12345',
      filename: 'clash-party.yaml'
    },
    owner: { instanceId: 'fixture-owner', proxyPort: account.proxyPort },
    encrypted: true,
    latestCaptured: capture('b'),
    lastResult: 'armed'
  }),
  count = (channel) => calls.filter((call) => call.channel === channel).length
let expectedSource,
  browser,
  state = empty(),
  armStatus = 'cancelled',
  failInventory = false,
  failState = false,
  holdArm = false,
  armStarted,
  finishArm,
  holdState = false,
  stateStarted,
  finishState
const deadline = async (promise, label) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' adapter not entered')), 5000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
try {
  await build({
    stdin: {
      contents: `import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{RelayRuntimeGistSyncPanel}from'./src/renderer/src/components/relay/runtime-gist-sync-panel';function App(){const[busy,setBusy]=useState(false),[key,setKey]=useState(0),[session,setSession]=useState('11111111-1111-4111-8111-111111111111');useEffect(()=>{window.__remountSync=()=>setKey(v=>v+1);window.__setTunSession=setSession},[]);return <><button onClick={()=>setBusy(v=>!v)}>切换其他操作忙碌</button><output id="fixture-generation">{key}</output><output id="busy">{String(busy)}</output><RelayRuntimeGistSyncPanel key={key} tunSessionId={session} busy={busy} onBusy={v=>{window.__busy(v);setBusy(v)}}/></>};createRoot(document.getElementById('root')).render(<App/>);`,
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
    args: [
      '--allow-file-access-from-files',
      '--disable-background-networking',
      '--disable-component-update'
    ]
  })
  const context = await browser.newContext(),
    allowed = pathToFileURL(root).href + '/'
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(allowed)) return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__busy', (value) => busyEvents.push(value))
  await page.exposeFunction('__invoke', async (channel, request) => {
    calls.push({ channel, request })
    if (channel === 'relayBackupAccountList') {
      assert.equal(request, undefined)
      if (failInventory) throw new Error('PRIVATE-account-diagnostic')
      return {
        accounts: [
          account,
          plain,
          {
            ...account,
            id: '00000000-0000-4000-8000-000000000003',
            provider: 'webdav',
            name: 'Excluded DAV'
          },
          {
            ...account,
            id: '00000000-0000-4000-8000-000000000004',
            state: 'disabled',
            name: 'Excluded disabled'
          }
        ],
        incomplete: 1
      }
    }
    if (channel === 'relayRuntimeGistSyncState') {
      assert.equal(request, undefined)
      if (failState) throw new Error('PRIVATE-state-diagnostic')
      const captured = structuredClone(state)
      if (holdState) {
        stateStarted.resolve()
        return new Promise((resolve) => {
          finishState = () => resolve(captured)
        })
      }
      return captured
    }
    if (channel === 'relayRuntimeGistSyncArm') {
      assert.deepEqual(request, {
        id: account.id,
        revision: account.revision,
        gistId: 'abcde12345',
        ...(expectedSource ? { source: expectedSource } : {})
      })
      if (holdArm) {
        armStarted.resolve()
        return new Promise((resolve) => {
          finishArm = () => resolve({ status: 'armed', state: armed() })
        })
      }
      if (armStatus === 'armed') {
        state = armed()
        if (request.source)
          state.owner = {
            ...state.owner,
            source: request.source,
            instanceId: request.source.sessionId
          }
      }
      return { status: armStatus, state: structuredClone(state) }
    }
    assert.equal(channel, 'relayRuntimeGistSyncStop')
    assert.equal(request, undefined)
    state = {
      ...state,
      enabled: false,
      pending: false,
      phase: 'idle',
      uploading: undefined,
      dirty: false,
      stopReason: 'stopped'
    }
    return structuredClone(state)
  })
  await page.addInitScript(() => {
    const listeners = new Map()
    window.__invalidateBackup = () =>
      listeners
        .get('relayBackupPreparationsInvalidated')
        ?.forEach((listener) => listener({}, undefined))
    window.electron = {
      ipcRenderer: {
        invoke: (...args) => window.__invoke(...args),
        on: (channel, listener) => {
          const set = listeners.get(channel) ?? new Set()
          set.add(listener)
          listeners.set(channel, set)
          return () => set.delete(listener)
        }
      }
    }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  const read = page.getByRole('button', { name: '读取Gist账号与自动同步状态', exact: true }),
    arm = page.getByRole('button', { name: '授权本次会话运行配置自动同步…', exact: true }),
    stop = page.getByRole('button', { name: '停止本次会话自动同步', exact: true }),
    select = page.getByLabel('自动同步Gist账号', { exact: true }),
    gist = page.getByLabel('现有专用Gist ID', { exact: true }),
    notice = (text) => page.locator('p[role="status"]').filter({ hasText: text }),
    readState = async () => {
      await read.click()
      await notice(
        failInventory
          ? '账号公开设置未确认'
          : failState
            ? '同步状态未确认'
            : '已读取公开账号与本机授权快照'
      ).waitFor()
    }
  await read.waitFor()
  assert.equal(calls.length, 0)
  assert.ok(await arm.isDisabled())
  await readState()
  assert.equal(count('relayRuntimeGistSyncArm'), 0)
  assert.equal(await select.locator('option').count(), 3)
  assert.ok(!(await select.innerText()).includes('Excluded'))
  assert.equal(await page.locator('input[type="password"]').count(), 0)
  checks.push(
    'initial render is inert; explicit metadata reads filter active Gist accounts, do not retrieve Tokens or authorize, and label timestamped local authority separately from credential validity'
  )

  await select.selectOption(account.id)
  for (const bad of ['https://gist.github.com/abcde12345', 'ABCDE', 'new']) {
    await gist.fill(bad)
    await arm.click()
    await notice('不接受URL或新建').waitFor()
  }
  assert.equal(count('relayRuntimeGistSyncArm'), 0)
  await gist.fill('abcde12345')
  await arm.click()
  await notice('本次新授权已取消').waitFor()
  assert.equal(count('relayRuntimeGistSyncArm'), 1)
  assert.ok(
    !(await page.locator('body').innerText()).includes('本次App会话的运行配置自动同步已授权')
  )
  checks.push(
    'invalid or URL targets fail before Arm IPC; explicit Native cancellation never creates enabled UI state; Arm sends only selected id/revision and dedicated existing gistId'
  )

  await select.selectOption(plain.id)
  assert.ok((await page.locator('body').innerText()).includes('敏感明文运行配置'))
  await select.selectOption(account.id)
  assert.ok((await page.locator('body').innerText()).includes('AGE加密，接收者'))
  armStatus = 'armed'
  await arm.click()
  await notice('本次App会话的运行配置自动同步已授权').waitFor()
  assert.ok(await gist.isDisabled())
  assert.ok(await select.isDisabled())
  assert.ok((await page.locator('body').innerText()).includes('并发覆盖的窗口'))
  const afterArm = calls.length
  await page.waitForTimeout(100)
  assert.equal(calls.length, afterArm)
  checks.push(
    'AGE/plain account metadata and non-atomic overwrite warning are explicit; active authorization locks scope and never starts renderer polling'
  )

  state = {
    ...armed(),
    dirty: true,
    latestCaptured: capture('c'),
    uploading: { ...capture('b'), payloadSHA256: 'd'.repeat(64), submitted: true },
    lastUploaded: { source: capture('a'), payloadSHA256: 'e'.repeat(64), at: 1793500001000 },
    lastResult: 'uploaded'
  }
  await readState()
  const queued = await page.locator('body').innerText()
  for (const phrase of [
    '有配置变化待捕获；尚无本轮正文SHA',
    '最近已捕获配置',
    '本轮在途配置',
    '上次已读回确认的配置',
    '尚不能确认当前配置已追上上传'
  ])
    assert.ok(queued.includes(phrase))
  assert.ok(!queued.includes('截至读取时，最近已捕获正文已追上上传确认'))
  assert.equal(await page.locator('#busy').innerText(), 'false')
  checks.push(
    'queued dirty hints, captured latest source, submitted in-flight source/payload and previous confirmed upload stay distinct; old success cannot claim current sync and background pending does not own global busy'
  )

  state = {
    ...armed(),
    latestCaptured: capture('b'),
    lastUploaded: { source: capture('b'), payloadSHA256: 'd'.repeat(64), at: 1793500001000 }
  }
  await readState()
  assert.ok(
    (await page.locator('body').innerText()).includes('截至读取时，最近已捕获正文已追上上传确认')
  )
  for (const extra of [
    { dirty: true },
    { pending: true },
    { uploading: { ...capture('b'), payloadSHA256: 'd'.repeat(64), submitted: false } },
    { latestCaptured: capture('c') }
  ]) {
    const before = structuredClone(state)
    state = { ...state, ...extra }
    await readState()
    assert.ok(
      !(await page.locator('body').innerText()).includes('截至读取时，最近已捕获正文已追上上传确认')
    )
    state = before
  }
  checks.push(
    'caught-up wording requires equal latest/uploaded source SHA with no dirty, upload or pending flag and is explicitly limited to read time'
  )

  await page.getByRole('button', { name: '切换其他操作忙碌', exact: true }).click()
  assert.ok(await read.isDisabled())
  assert.ok(await arm.isDisabled())
  assert.ok(await stop.isEnabled())
  const beforeForeign = busyEvents.length
  state = {
    ...state,
    lastResult: 'uncertain',
    lastAttempt: {
      source: capture('b'),
      payloadSHA256: 'd'.repeat(64),
      submitted: true,
      result: 'uncertain',
      at: 1793500001000
    }
  }
  await stop.click()
  await notice('在途写入结果未确认').waitFor()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  assert.equal(busyEvents.length, beforeForeign)
  await page.getByRole('button', { name: '切换其他操作忙碌', exact: true }).click()
  checks.push(
    'Stop remains independent during foreign busy, reports uncertain write without retry and never clears the other operation busy ownership'
  )

  state = empty()
  await readState()
  await select.selectOption(account.id)
  await gist.fill('abcde12345')
  holdArm = true
  armStarted = Promise.withResolvers()
  await arm.click()
  await deadline(armStarted.promise, 'Arm')
  await stop.click()
  await notice('已撤销本次自动同步授权').waitFor()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  finishArm()
  holdArm = false
  await page.waitForFunction(() => document.querySelector('#busy')?.textContent === 'false')
  assert.ok((await page.locator('body').innerText()).includes('读取时授权：已关闭'))
  assert.ok(
    !(await page.locator('body').innerText()).includes('本次App会话的运行配置自动同步已授权')
  )
  checks.push(
    'Stop supersedes a late successful Arm snapshot while owned busy is held until both calls settle'
  )

  state = armed()
  failInventory = true
  await readState()
  assert.ok((await page.locator('body').innerText()).includes('读取时授权：已开启'))
  assert.ok(await stop.isEnabled())
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-'))
  await stop.click()
  await notice('已撤销本次自动同步授权').waitFor()
  failInventory = false
  checks.push(
    'state success survives unavailable metadata so existing authority can be stopped, without displaying private diagnostic text'
  )

  await readState()
  await select.selectOption(account.id)
  await gist.fill('abcde12345')
  holdArm = true
  armStarted = Promise.withResolvers()
  await arm.click()
  await deadline(armStarted.promise, 'hidden Arm')
  const beforeHide = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  await notice('会话自动同步授权已撤销').waitFor()
  assert.equal(calls.length, beforeHide)
  assert.equal(await gist.inputValue(), '')
  assert.equal(await select.inputValue(), '')
  assert.equal(await page.locator('#busy').innerText(), 'true')
  finishArm()
  holdArm = false
  await page.waitForFunction(() => document.querySelector('#busy')?.textContent === 'false')
  assert.ok(!(await page.locator('body').innerText()).includes('状态读取于：'))
  assert.ok(
    !(await page.locator('body').innerText()).includes('本次App会话的运行配置自动同步已授权')
  )
  checks.push(
    'hidden-view invalidation clears scope, public caches and timestamps without issuing Stop/Cancel or releasing in-flight busy; late Arm cannot revive the view'
  )

  state = armed()
  holdState = true
  stateStarted = Promise.withResolvers()
  await read.click()
  await deadline(stateStarted.promise, 'State')
  const beforeReadHide = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  await notice('会话自动同步授权已撤销').waitFor()
  finishState()
  holdState = false
  await page.waitForFunction(() => document.querySelector('#busy')?.textContent === 'false')
  assert.equal(calls.length, beforeReadHide)
  assert.ok(!(await page.locator('body').innerText()).includes('状态读取于：'))
  failState = true
  await readState()
  failState = false
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-'))
  assert.ok(!(await page.locator('body').innerText()).includes('状态读取于：'))
  const beforeRemount = calls.length
  await page.evaluate(() => window.__remountSync())
  await page.waitForFunction(
    () => document.querySelector('#fixture-generation')?.textContent === '1'
  )
  assert.equal(calls.length, beforeRemount)
  checks.push(
    'late public reads after invalidation and failed State reads cannot restore cached authority; restore-style remount is inert'
  )

  state = empty()
  await readState()
  await select.selectOption(account.id)
  await gist.fill('abcde12345')
  expectedSource = { kind: 'tun-managed', sessionId: '11111111-1111-4111-8111-111111111111' }
  const sourceSelector = page.getByLabel('自动同步配置来源', { exact: true })
  await sourceSelector.selectOption('tun-managed')
  armStatus = 'armed'
  await arm.click()
  await notice('本次App会话的运行配置自动同步已授权').waitFor()
  assert.deepEqual(
    calls.filter((call) => call.channel === 'relayRuntimeGistSyncArm').at(-1).request.source,
    expectedSource
  )
  assert.ok((await page.locator('body').innerText()).includes('托管TUN（已加载正文与观察mode）'))
  assert.ok(await sourceSelector.isDisabled())
  await stop.click()
  await notice('已撤销本次自动同步授权').waitFor()
  const beforeSourceLoss = calls.length
  await page.evaluate(() => window.__setTunSession(undefined))
  await page.getByText('所选会话已失效', { exact: false }).waitFor()
  assert.ok(await arm.isDisabled())
  assert.equal(await sourceSelector.inputValue(), 'tun-managed')
  assert.equal(calls.length, beforeSourceLoss)
  assert.ok(!(await page.locator('body').innerText()).includes('Token输入'))
  checks.push(
    'explicit TUN auto authorization includes only its fixed session and saved account revision, labels loaded-body provenance, freezes scope until independent Stop, and never falls back or rearms after source loss'
  )

  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  assert.ok(
    calls.every((call) =>
      [
        'relayBackupAccountList',
        'relayRuntimeGistSyncState',
        'relayRuntimeGistSyncArm',
        'relayRuntimeGistSyncStop'
      ].includes(call.channel)
    )
  )
  const sources = [
      'src/renderer/src/components/relay/runtime-gist-sync-panel.tsx',
      'src/renderer/src/pages/relay-workspace.tsx',
      'src/shared/relay/runtime-gist-sync.ts',
      'src/renderer/src/components/relay/runtime-gist-source.tsx',
      'src/shared/relay/runtime-gist.ts'
    ],
    sourceSHA256 = {}
  for (const source of sources)
    sourceSHA256[source] = createHash('sha256')
      .update(await readFile(source))
      .digest('hex')
  const workspace = await readFile(sources[1], 'utf8')
  assert.ok(workspace.includes('<RelayRuntimeGistSyncPanel'))
  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-injected-browser-runtime-gist-session-sync',
    sourceSHA256,
    checks,
    passed: checks.length,
    actualAccountUsed: false,
    actualCredentialDecrypted: false,
    actualNativeConsentShown: false,
    actualRuntimeRead: false,
    actualWorkspaceExecuted: false,
    actualCoreOrSystemOperation: false,
    externalRequests: blocked.length,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/runtime-gist-sync-ui-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
