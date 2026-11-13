// Synthetic IPC only; no real accounts, safeStorage, Keychain or remote service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and isolated test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/backup-account-ui-')),
  calls = [],
  checks = [],
  errors = [],
  blocked = [],
  webdav = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 'a'.repeat(64),
    name: 'Fixture DAV',
    provider: 'webdav',
    proxyPort: 18191,
    directoryURL: 'https://dav.invalid/Relay/',
    username: 'fixture-user',
    state: 'active',
    hasCredential: true,
    createdAt: 1,
    updatedAt: 1
  },
  gist = {
    id: '00000000-0000-4000-8000-000000000002',
    revision: 'b'.repeat(64),
    name: 'Fixture Gist',
    provider: 'gist',
    proxyPort: 18191,
    recipient: 'age1fixture-public-recipient',
    state: 'active',
    hasCredential: true,
    createdAt: 1,
    updatedAt: 1
  }
let accounts = [webdav, gist],
  browser,
  version = 1,
  nextAccount = 3,
  holdSave = false,
  saveStarted,
  finishSave,
  failSave = false,
  holdCancel = false,
  cancelStarted,
  finishCancel,
  transferRestore = false,
  holdAccountPrepare = false,
  accountPrepareStarted,
  finishAccountPrepare,
  holdManualPrepare = false,
  manualPrepareStarted,
  finishManualPrepare,
  discoverySequence = 1,
  discoveryCancelled = true,
  discoveryEmpty = false,
  discoveryTTL = 60000,
  holdDiscoveryPrepare = false,
  discoveryPrepareStarted,
  finishDiscoveryPrepare,
  holdDiscoveryExecute = false,
  discoveryExecuteStarted,
  finishDiscoveryExecute,
  holdDiscoveryCancel = false,
  discoveryCancelStarted,
  finishDiscoveryCancel
const discoveryProofs = new Map()
const count = (channel) => calls.filter((call) => call.channel === channel).length
const deadline = async (promise, name) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(name + ' adapter was not entered')), 5000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
try {
  await build({
    stdin: {
      contents: `import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
import{RelayBackupAccountPanel}from'./src/renderer/src/components/relay/backup-account-panel';
import{RelayRemoteBackupPanel}from'./src/renderer/src/components/relay/backup-remote-panel';
import{RelayRuntimeGistPanel}from'./src/renderer/src/components/relay/runtime-gist-panel';
function App(){const[busy,setBusy]=useState(false),[proof,setProof]=useState(''),[remote,setRemote]=useState(),[runtime,setRuntime]=useState(),[restored,setRestored]=useState(0),[stableTun,setStableTun]=useState(false),[foreignBusy,setForeignBusy]=useState(false);const changeBusy=v=>{window.__busyEvents.push(v);setBusy(v)};useEffect(()=>{window.__stableTun=setStableTun;window.__foreignBusy=setForeignBusy;window.__simulateRestore=()=>{setProof('');setRemote({});setRuntime({});setRestored(v=>v+1)};return window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated',()=>{setProof('');setRemote({});setRuntime({})})},[]);return <div key={restored}><RelayBackupAccountPanel busy={busy||foreignBusy} remoteBusy={busy||foreignBusy||stableTun} tunSessionId="11111111-1111-4111-8111-111111111111" onBusy={changeBusy} onInvalidate={()=>{setProof('');setRemote({});setRuntime({})}} onPrepared={p=>{setProof('remote:'+p.evidenceId);setRemote({plan:p})}} onRuntimePrepared={p=>{setProof('runtime:'+p.evidenceId);setRuntime({plan:p})}}/><RelayRemoteBackupPanel busy={busy||foreignBusy} onBusy={changeBusy} onRestoreNotice={()=>{}} externalPreparation={remote}/><RelayRuntimeGistPanel tunSessionId="11111111-1111-4111-8111-111111111111" busy={busy||foreignBusy} onBusy={changeBusy} externalPreparation={runtime}/><output id="proof">{proof}</output></div>};
createRoot(document.getElementById('root')).render(<App/>);`,
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
  await page.exposeFunction('__invoke', async (channel, request) => {
    calls.push({ channel, request })
    if (channel === 'relayRuntimeGistDiscoveryPrepare') {
      assert.deepEqual(Object.keys(request).sort(), ['id', 'page', 'revision'])
      const account = accounts.find((item) => item.id === request.id)
      assert.equal(account?.provider, 'gist')
      assert.equal(account?.state, 'active')
      assert.equal(request.revision, account.revision)
      const plan = {
        id: account.id,
        revision: account.revision,
        name: account.name,
        evidenceId: '00000000-0000-4000-8000-' + String(discoverySequence++).padStart(12, '0'),
        action: 'listRuntimeCandidates',
        endpoint: 'https://api.github.com/gists?per_page=100&page=' + request.page,
        proxyPort: account.proxyPort,
        description: 'Auto Synced Clash Party Runtime Config',
        filename: 'clash-party.yaml',
        page: request.page,
        perPage: 100,
        expiresAt: Date.now() + discoveryTTL
      }
      discoveryProofs.set(plan.evidenceId, plan)
      if (holdDiscoveryPrepare) {
        discoveryPrepareStarted.resolve()
        await new Promise((resolve) => {
          finishDiscoveryPrepare = resolve
        })
      }
      return plan
    }
    if (channel === 'relayRuntimeGistDiscoveryExecute') {
      assert.deepEqual(Object.keys(request), ['evidenceId'])
      const plan = discoveryProofs.get(request.evidenceId)
      assert.ok(plan)
      discoveryProofs.delete(request.evidenceId)
      if (holdDiscoveryExecute) {
        discoveryExecuteStarted.resolve()
        await new Promise((resolve) => {
          finishDiscoveryExecute = resolve
        })
      }
      if (discoveryCancelled) return { status: 'cancelled' }
      return {
        status: 'listed',
        page: plan.page,
        scanned: 5,
        moreAvailable: true,
        ...(plan.page < 1000 ? { nextPage: plan.page + 1 } : {}),
        budgetReached: plan.page === 1000,
        checkedAt: Date.now(),
        account: { id: plan.id, revision: plan.revision },
        entries: discoveryEmpty
          ? []
          : [
              {
                id: 'a'.repeat(32),
                updatedAt: '2026-11-01T00:00:00Z',
                payloadBytes: 128,
                verified: false
              },
              {
                id: 'b'.repeat(32),
                updatedAt: '2026-11-01T01:00:00Z',
                payloadBytes: 256,
                verified: false
              }
            ]
      }
    }
    if (channel === 'relayRuntimeGistDiscoveryCancel') {
      assert.deepEqual(Object.keys(request), ['evidenceId'])
      assert.match(request.evidenceId, /^[a-f0-9-]{36}$/u)
      discoveryProofs.delete(request.evidenceId)
      if (holdDiscoveryCancel) {
        discoveryCancelStarted.resolve()
        await new Promise((resolve) => {
          finishDiscoveryCancel = resolve
        })
      }
      return
    }
    if (channel === 'relayBackupAccountList') {
      assert.equal(request, undefined)
      return { accounts: structuredClone(accounts), incomplete: 1 }
    }
    if (channel === 'relayBackupAccountSave') {
      if (holdSave) {
        saveStarted.resolve()
        await new Promise((resolve) => {
          finishSave = resolve
        })
      }
      if (failSave) throw new Error('PRIVATE-backend-credential-diagnostic')
      const old = request.id ? accounts.find((account) => account.id === request.id) : undefined
      if (old) assert.equal(request.revision, old.revision)
      const metadata = { ...request }
      for (const key of ['password', 'token', 'revision']) delete metadata[key]
      const account = {
        ...metadata,
        id: old?.id ?? '00000000-0000-4000-8000-' + String(nextAccount++).padStart(12, '0'),
        revision: (++version).toString(16).padStart(64, '0'),
        state: 'active',
        hasCredential: true,
        createdAt: old?.createdAt ?? 1,
        updatedAt: version
      }
      accounts = [...accounts.filter((item) => item.id !== account.id), account]
      return account
    }
    if (channel === 'relayBackupAccountDisable') {
      assert.deepEqual(Object.keys(request).sort(), ['id', 'revision'])
      const account = accounts.find((item) => item.id === request.id)
      assert.equal(request.revision, account.revision)
      const disabled = {
        ...account,
        state: 'disabled',
        revision: 'e'.repeat(64),
        updatedAt: ++version
      }
      accounts = accounts.map((item) => (item.id === disabled.id ? disabled : item))
      return disabled
    }
    if (channel === 'relayBackupRemoteCancel' || channel === 'relayRuntimeGistCancel') {
      assert.equal(request, undefined)
      if (holdCancel) {
        cancelStarted.resolve()
        await new Promise((resolve) => {
          finishCancel = resolve
        })
      }
      return
    }
    if (channel === 'relayBackupRemotePrepare') {
      if (holdManualPrepare) {
        manualPrepareStarted.resolve()
        await new Promise((resolve) => {
          finishManualPrepare = resolve
        })
      }
      return {
        evidenceId: 'manual-proof',
        provider: 'webdav',
        action: request.action,
        endpoint: request.url,
        proxyPort: request.proxyPort,
        encrypted: false,
        containsSecrets: true,
        expiresAt: Date.now() + 60000
      }
    }
    if (channel === 'relayBackupRemoteExecute') {
      assert.ok(['remote-proof', 'manual-proof'].includes(request.evidenceId))
      assert.deepEqual(Object.keys(request), ['evidenceId'])
      return transferRestore
        ? {
            status: 'prepared',
            plan: {
              id: 'staged-local-proof',
              baselineSHA256: 'a'.repeat(64),
              targetSHA256: 'b'.repeat(64),
              archiveSHA256: 'c'.repeat(64),
              files: 1,
              replacedFiles: 1,
              removedFiles: 0,
              containsSecrets: true,
              preparedAt: Date.now()
            }
          }
        : { status: 'cancelled' }
    }
    if (channel === 'relayRuntimeGistExecute') {
      assert.deepEqual(request, { evidenceId: 'runtime-proof' })
      return { status: 'cancelled' }
    }
    assert.ok(
      ['relayBackupAccountPrepareRemote', 'relayBackupAccountPrepareRuntime'].includes(channel)
    )
    assert.ok(
      !['token', 'password', 'url', 'directoryURL', 'username', 'proxyPort', 'recipient'].some(
        (key) => key in request
      )
    )
    const account = accounts.find((item) => item.id === request.id)
    assert.equal(request.revision, account.revision)
    assert.equal(account.state, 'active')
    if (holdAccountPrepare) {
      accountPrepareStarted.resolve()
      await new Promise((resolve) => {
        finishAccountPrepare = resolve
      })
    }
    if (channel.endsWith('Runtime'))
      return {
        evidenceId: 'runtime-proof',
        action: request.gistId ? 'update' : 'create',
        filename: 'clash-party.yaml',
        endpoint: 'https://injected.invalid/',
        ...(request.gistId ? { gistId: request.gistId } : {}),
        proxyPort: account.proxyPort,
        encrypted: true,
        containsSecrets: true,
        ...(request.source ? { source: request.source } : {}),
        instanceId: request.source?.sessionId ?? 'fixture-owned-core',
        configurationRevision: 'a'.repeat(64),
        configurationSHA256: 'b'.repeat(64),
        configurationBytes: 256,
        payloadSHA256: 'c'.repeat(64),
        payloadBytes: 512,
        expiresAt: Date.now() + 60000
      }
    return {
      evidenceId: channel.endsWith('Runtime') ? 'runtime-proof' : 'remote-proof',
      provider: account.provider,
      action: request.action ?? 'create',
      ...(request.archiveFormat ? { archiveFormat: request.archiveFormat } : {}),
      endpoint: 'https://injected.invalid/',
      proxyPort: account.proxyPort,
      encrypted: true,
      containsSecrets: true,
      expiresAt: Date.now() + 60000
    }
  })
  await page.addInitScript(() => {
    window.__busyEvents = []
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
  const list = page.getByRole('button', { name: '读取已保存账号', exact: true }),
    newAccount = page.getByRole('button', { name: '新建备份账号', exact: true }),
    saveNew = page.getByRole('button', { name: '保存新账号', exact: true }),
    save = page.getByRole('button', { name: '保存账号修改', exact: true }),
    disable = page.getByRole('button', { name: '停用所选账号', exact: true }),
    prepare = page.getByRole('button', { name: '用所选账号准备远程备份', exact: true }),
    runtime = page.getByRole('button', { name: '用所选账号准备运行配置上传', exact: true }),
    notice = (text) => page.getByRole('status').filter({ hasText: text }),
    choose = (name) => page.getByRole('button', { name: '选择' + name, exact: true }).click()
  await list.waitFor()
  assert.equal(calls.length, 0)
  assert.ok(await prepare.isDisabled())
  await list.click()
  await notice('已读取2个账号').waitFor()
  assert.equal(count('relayBackupAccountList'), 1)
  assert.ok(
    calls.every((call) =>
      ['relayBackupAccountList', 'relayBackupRemoteCancel', 'relayRuntimeGistCancel'].includes(
        call.channel
      )
    )
  )
  assert.ok((await page.locator('body').innerText()).includes('1条账号记录未能确认'))
  await choose('Fixture DAV')
  assert.equal(await page.getByLabel('账号密码', { exact: true }).inputValue(), '')
  assert.ok(
    calls.every((call) =>
      ['relayBackupAccountList', 'relayBackupRemoteCancel', 'relayRuntimeGistCancel'].includes(
        call.channel
      )
    )
  )
  checks.push(
    'render is inert; explicit inventory and selection use public metadata without credential readback or decrypt IPC'
  )

  await newAccount.click()
  await page.getByLabel('账号名称', { exact: true }).fill('New DAV')
  await page.getByLabel('账号HTTPS目录', { exact: true }).fill('https://dav.invalid/New/')
  await page.getByLabel('账号用户名', { exact: true }).fill('new-user')
  await page.getByLabel('账号密码', { exact: true }).fill('FIXTURE-new-password')
  await saveNew.click()
  await notice('本机加密保存').waitFor()
  assert.deepEqual(
    calls.filter((call) => call.channel === 'relayBackupAccountSave').at(-1).request,
    {
      name: 'New DAV',
      provider: 'webdav',
      proxyPort: 17891,
      directoryURL: 'https://dav.invalid/New/',
      username: 'new-user',
      password: 'FIXTURE-new-password'
    }
  )
  assert.equal(await page.getByLabel('账号密码', { exact: true }).inputValue(), '')
  await page.getByLabel('账号名称', { exact: true }).fill('Renamed DAV')
  await save.click()
  await notice('本机加密保存').waitFor()
  const update = calls.filter((call) => call.channel === 'relayBackupAccountSave').at(-1).request
  assert.ok(update.id && update.revision)
  assert.ok(!('password' in update) && !('token' in update))
  checks.push(
    'new credentials are sent only to save and cleared afterward; public-only updates retain credentials by omission without masked placeholder values'
  )

  await page.getByLabel('账号用户名', { exact: true }).fill('changed-user')
  const savesBeforeMissing = count('relayBackupAccountSave')
  await save.click()
  await notice('操作未确认').waitFor()
  assert.equal(count('relayBackupAccountSave'), savesBeforeMissing)
  assert.equal(await save.isDisabled(), false)
  await page.getByLabel('明确使用空密码', { exact: true }).check()
  await save.click()
  await notice('本机加密保存').waitFor()
  assert.equal(
    calls.filter((call) => call.channel === 'relayBackupAccountSave').at(-1).request.password,
    ''
  )
  checks.push(
    'changing the WebDAV endpoint identity requires a fresh password decision; explicit empty password is distinct from retaining the existing credential'
  )

  const uploadFilename = page.getByLabel('账号目录内新文件名（.json）', { exact: true }),
    preparesBeforeZIP = count('relayBackupAccountPrepareRemote')
  await uploadFilename.fill('new-backup.zip')
  await prepare.click()
  await notice('操作未确认').waitFor()
  assert.equal(count('relayBackupAccountPrepareRemote'), preparesBeforeZIP)
  await uploadFilename.fill('new-backup.json')
  await prepare.click()
  await page.locator('#proof').filter({ hasText: 'remote:remote-proof' }).waitFor()
  assert.equal(
    calls.filter((call) => call.channel === 'relayBackupAccountPrepareRemote').at(-1).request
      .filename,
    'new-backup.json'
  )
  await page.getByRole('button', { name: '确认远程传输', exact: true }).waitFor()
  checks.push(
    'saved-account uploads require a JSON envelope filename: .zip is rejected locally before Prepare IPC and .json hands off to the existing confirmation flow'
  )

  await choose('Fixture Gist')
  assert.equal(await page.getByLabel('账号GitHub Token', { exact: true }).inputValue(), '')
  await page.getByLabel('账号备份操作', { exact: true }).selectOption('list')
  await page.getByLabel('账号列表页码', { exact: true }).fill('2')
  await prepare.click()
  await page.locator('#proof').filter({ hasText: 'remote:remote-proof' }).waitFor()
  assert.deepEqual(
    calls.filter((call) => call.channel === 'relayBackupAccountPrepareRemote').at(-1).request,
    {
      id: gist.id,
      revision: gist.revision,
      action: 'list',
      page: 2
    }
  )
  await page.getByRole('button', { name: '确认远程传输', exact: true }).click()
  await notice('本次远程传输已取消').waitFor()
  await page.getByLabel('账号备份操作', { exact: true }).selectOption('download')
  await page
    .getByLabel('账号操作目标Gist ID（运行配置留空新建）', { exact: true })
    .fill('abcde12345')
  await page
    .getByLabel('本次账号下载AGE私钥（不保存）', { exact: true })
    .fill('AGE-SECRET-KEY-1FIXTURE')
  await prepare.click()
  await page.locator('#proof').filter({ hasText: 'remote:remote-proof' }).waitFor()
  assert.ok(count('relayBackupRemoteCancel') >= 1)
  assert.equal(
    calls.filter((call) => call.channel === 'relayBackupAccountPrepareRemote').at(-1).request
      .secretKey,
    'AGE-SECRET-KEY-1FIXTURE'
  )
  assert.equal(
    await page.getByLabel('本次账号下载AGE私钥（不保存）', { exact: true }).inputValue(),
    ''
  )
  transferRestore = true
  await page.getByRole('button', { name: '确认远程传输', exact: true }).click()
  await page.getByRole('button', { name: '单独确认恢复', exact: true }).waitFor()
  transferRestore = false
  checks.push(
    'saved-account prepare passes bound id/revision and operation fields to the existing remote confirmation flow; download AGE identity is cleared and restoration requires its separate button'
  )

  holdCancel = true
  cancelStarted = Promise.withResolvers()
  await page.getByLabel('账号操作目标Gist ID（运行配置留空新建）', { exact: true }).fill('')
  await deadline(cancelStarted.promise, 'cancellation')
  await page
    .getByRole('button', { name: '单独确认恢复', exact: true })
    .waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: '单独确认恢复', exact: true }).count(), 0)
  assert.equal(count('relayBackupCancel'), 0)
  const runtimesBefore = count('relayBackupAccountPrepareRuntime')
  await runtime.click()
  assert.equal(count('relayBackupAccountPrepareRuntime'), runtimesBefore)
  holdCancel = false
  finishCancel()
  await page.locator('#proof').filter({ hasText: 'runtime:runtime-proof' }).waitFor()
  assert.deepEqual(
    calls.filter((call) => call.channel === 'relayBackupAccountPrepareRuntime').at(-1).request,
    {
      id: gist.id,
      revision: gist.revision
    }
  )
  await page.getByRole('button', { name: '发起本次上传确认', exact: true }).click()
  await notice('本次上传已取消').waitFor()
  await choose('Fixture DAV')
  await notice('已选择账号的公开设置').waitFor()
  assert.equal(await page.locator('#proof').innerText(), '')
  checks.push(
    'changing or selecting an account revokes handed-off proofs and clears the parent view; a later prepare waits for prior server cancellation'
  )

  await page
    .getByLabel('HTTPS指定文件地址', { exact: true })
    .fill('https://dav.invalid/manual.json')
  await page.getByLabel('本次用户名', { exact: true }).fill('manual-user')
  await page.getByLabel('本次密码', { exact: true }).fill('FIXTURE-manual-password')
  await page.getByRole('button', { name: '准备本次远程备份', exact: true }).click()
  await page.getByRole('button', { name: '确认远程传输', exact: true }).waitFor()
  await page.getByLabel('账号名称', { exact: true }).fill('New account context')
  await page
    .getByRole('button', { name: '确认远程传输', exact: true })
    .waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: '确认远程传输', exact: true }).count(), 0)
  await choose('Fixture DAV')
  checks.push(
    'account context changes also clear a later manually prepared plan, even after prior account handoff was consumed; no late generic backup cancellation can revoke a newer local proof'
  )

  holdSave = true
  saveStarted = Promise.withResolvers()
  await page.getByLabel('账号名称', { exact: true }).fill('DAV busy save')
  const savesBeforeBusy = count('relayBackupAccountSave')
  await save.evaluate((button) => {
    button.click()
    button.click()
  })
  await deadline(saveStarted.promise, 'save')
  assert.equal(count('relayBackupAccountSave'), savesBeforeBusy + 1)
  assert.ok(await list.isDisabled())
  assert.ok(await page.getByLabel('账号名称', { exact: true }).isDisabled())
  assert.ok(await prepare.isDisabled())
  holdSave = false
  finishSave()
  await notice('本机加密保存').waitFor()
  failSave = true
  await page.getByLabel('账号密码', { exact: true }).fill('FIXTURE-replacement-password')
  await save.click()
  await notice('操作未确认').waitFor()
  assert.equal(await page.getByLabel('账号密码', { exact: true }).inputValue(), '')
  assert.ok(await save.isDisabled())
  assert.ok(await prepare.isDisabled())
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-'))
  failSave = false
  checks.push(
    'one in-flight barrier prevents duplicate writes; a failed revision-bound write clears transient secrets and requires reread/reselection instead of automatic retry'
  )

  await list.click()
  await notice('已读取3个账号').waitFor()
  await choose('DAV busy save')
  await disable.click()
  await notice('账号已停用').waitFor()
  assert.ok(await save.isDisabled())
  assert.ok(await disable.isDisabled())
  assert.ok(await prepare.isDisabled())
  assert.ok(await page.getByLabel('账号名称', { exact: true }).isDisabled())
  assert.ok((await page.locator('body').innerText()).includes('历史加密记录仍保留'))
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  checks.push(
    'disable binds the selected revision, invalidates old preparations and leaves the account read-only without claiming historical ciphertext erasure'
  )

  await newAccount.click()
  await page.getByLabel('账号提供者', { exact: true }).selectOption('gist')
  await page.getByLabel('账号名称', { exact: true }).fill('New Gist')
  await page.getByLabel('账号GitHub Token', { exact: true }).fill('FIXTURE-new-gist-token')
  await saveNew.click()
  await notice('本机加密保存').waitFor()
  const newGist = calls.filter((call) => call.channel === 'relayBackupAccountSave').at(-1).request
  assert.equal(newGist.token, 'FIXTURE-new-gist-token')
  assert.ok(!('password' in newGist) && !('directoryURL' in newGist) && !('username' in newGist))
  assert.equal(await page.getByLabel('账号GitHub Token', { exact: true }).inputValue(), '')
  checks.push(
    'new Gist account saving sends Token only to encrypted account persistence and never mixes WebDAV fields or refills the Token'
  )
  await runtime.click()
  await page.locator('#proof').filter({ hasText: 'runtime:runtime-proof' }).waitFor()
  const callsBeforeRestore = calls.length
  await page.evaluate(() => window.__simulateRestore())
  await page.waitForFunction(() => document.querySelector('#proof')?.textContent === '')
  await page.getByRole('heading', { name: '已保存的备份账号', exact: true }).waitFor()
  assert.equal(await page.locator('#proof').innerText(), '')
  assert.ok(await page.getByRole('button', { name: '发起本次上传确认', exact: true }).isDisabled())
  assert.equal(await page.getByRole('button', { name: '确认远程传输', exact: true }).count(), 0)
  assert.equal(calls.length, callsBeforeRestore)
  checks.push(
    'clearing external preparation messages before a restore-driven remount prevents revoked account plans from reappearing; the remount performs no account IO'
  )

  await list.click()
  await notice('已读取4个账号').waitFor()
  await choose('Fixture Gist')
  holdAccountPrepare = true
  accountPrepareStarted = Promise.withResolvers()
  await prepare.click()
  await deadline(accountPrepareStarted.promise, 'account prepare')
  const beforeAccountInvalidation = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  assert.ok(await list.isDisabled())
  holdAccountPrepare = false
  finishAccountPrepare()
  await notice('账号选择已变化，本次准备已取消').waitFor()
  assert.equal(calls.length, beforeAccountInvalidation)
  assert.equal(await page.locator('#proof').innerText(), '')
  assert.ok(await prepare.isDisabled())
  assert.equal(await page.getByRole('button', { name: '确认远程传输', exact: true }).count(), 0)
  assert.equal(await page.getByLabel('账号GitHub Token', { exact: true }).inputValue(), '')
  checks.push(
    'a main-process preparations-invalidated event discards a late saved-account proof without Cancel IPC or early busy release and requires fresh account selection'
  )

  await page.getByLabel('HTTPS指定文件地址', { exact: true }).fill('https://dav.invalid/late.json')
  await page.getByLabel('本次用户名', { exact: true }).fill('late-user')
  await page.getByLabel('本次密码', { exact: true }).fill('FIXTURE-late-password')
  holdManualPrepare = true
  manualPrepareStarted = Promise.withResolvers()
  await page.getByRole('button', { name: '准备本次远程备份', exact: true }).click()
  await deadline(manualPrepareStarted.promise, 'manual prepare')
  const beforeManualInvalidation = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  holdManualPrepare = false
  finishManualPrepare()
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent.trim() === '准备本次远程备份'
    )
    return button && !button.matches(':disabled')
  })
  assert.equal(calls.length, beforeManualInvalidation)
  assert.equal(await page.getByLabel('本次密码', { exact: true }).inputValue(), '')
  assert.equal(await page.getByRole('button', { name: '确认远程传输', exact: true }).count(), 0)
  assert.ok(await page.getByRole('button', { name: '发起本次上传确认', exact: true }).isDisabled())
  checks.push(
    'the same memory-only invalidation clears transient manual secrets and rejects a late manual remote plan while keeping the existing mounted workflow'
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])

  await page.evaluate(() => window.__stableTun(true))
  await list.click()
  await notice('已读取4个账号').waitFor()
  await choose('Fixture Gist')
  await notice('已选择账号的公开设置').waitFor()
  assert.ok(await prepare.isDisabled())
  assert.ok(await save.isDisabled())
  assert.ok(await disable.isDisabled())
  assert.ok(!(await list.isDisabled()))
  await page.getByLabel('账号运行配置来源', { exact: true }).selectOption('tun-managed')
  await page.getByLabel('账号运行配置目标Gist ID（留空新建）', { exact: true }).fill('abcde')
  await runtime.click()
  await page.locator('#proof').filter({ hasText: 'runtime:runtime-proof' }).waitFor()
  const tunRequest = calls
    .filter((call) => call.channel === 'relayBackupAccountPrepareRuntime')
    .at(-1).request
  assert.deepEqual(tunRequest, {
    id: gist.id,
    revision: gist.revision,
    gistId: 'abcde',
    source: { kind: 'tun-managed', sessionId: '11111111-1111-4111-8111-111111111111' }
  })
  assert.ok(
    (await page.locator('body').innerText()).includes(
      '托管TUN会话 11111111-1111-4111-8111-111111111111'
    )
  )
  assert.equal(await page.getByLabel('账号GitHub Token', { exact: true }).inputValue(), '')
  checks.push(
    'a stable TUN permits public account selection and explicit runtime source handoff while account mutations and ordinary remote backup stay blocked; the request carries no token, port override or persisted source preference'
  )

  await page.evaluate(() => window.__stableTun(false))
  accounts = accounts.map((account) =>
    account.name === 'Renamed DAV' ? { ...account, recipient: 'age1-stored-public' } : account
  )
  await list.click()
  await notice('已读取4个账号').waitFor()
  await choose('Renamed DAV')
  await page.getByLabel('账号备份操作', { exact: true }).selectOption('download')
  assert.equal(
    await page.getByLabel('账号下载归档格式', { exact: true }).inputValue(),
    'relay-envelope'
  )
  await page
    .getByLabel('本次账号下载AGE私钥（不保存）', { exact: true })
    .fill('AGE-SECRET-KEY-fixture')
  await page.getByLabel('账号下载归档格式', { exact: true }).selectOption('legacy-zip')
  assert.equal(await page.getByLabel('本次账号下载AGE私钥（不保存）', { exact: true }).count(), 0)
  assert.equal(await page.getByLabel('账号AGE接收者（可选）', { exact: true }).count(), 0)
  await page.getByLabel('账号目录内文件名', { exact: true }).fill('old.zip')
  await prepare.click()
  await page.locator('#proof').filter({ hasText: 'remote:remote-proof' }).waitFor()
  const raw = calls
    .filter((call) => call.channel === 'relayBackupAccountPrepareRemote')
    .at(-1).request
  assert.deepEqual(Object.keys(raw).sort(), [
    'action',
    'archiveFormat',
    'filename',
    'id',
    'revision'
  ])
  assert.equal(raw.archiveFormat, 'legacy-zip')
  assert.equal(raw.filename, 'old.zip')
  assert.equal(accounts.find((account) => account.id === raw.id).recipient, 'age1-stored-public')
  await page.getByText('绑定下载格式：旧Clash Party ZIP迁移', { exact: false }).waitFor()
  assert.equal(await page.getByLabel('下载归档格式', { exact: true }).inputValue(), 'legacy-zip')
  assert.equal(await page.getByLabel(/^本次AGE私钥/u).count(), 0)
  assert.equal(
    await page.getByRole('button', { name: '生成新AGE密钥并导出私钥', exact: true }).count(),
    0
  )
  checks.push(
    'saved WebDAV explicit raw format hides and clears transient AGE keys, does not alter stored recipient or account metadata, and hands off a format-bound plan without secrets'
  )
  await page.getByLabel('账号下载归档格式', { exact: true }).selectOption('relay-envelope')
  assert.equal(
    await page.getByLabel('本次账号下载AGE私钥（不保存）', { exact: true }).inputValue(),
    ''
  )
  assert.equal(
    await page.getByLabel('账号AGE接收者（可选）', { exact: true }).inputValue(),
    'age1-stored-public'
  )
  await choose('Fixture Gist')
  await page.getByLabel('账号备份操作', { exact: true }).selectOption('download')
  assert.equal(await page.getByLabel('账号下载归档格式', { exact: true }).count(), 0)
  checks.push(
    'leaving raw mode restores the unchanged public recipient and empty transient key; Gist offers no raw format selector'
  )
  await choose('Renamed DAV')
  await page.getByLabel('账号备份操作', { exact: true }).selectOption('download')
  await page.getByLabel('账号下载归档格式', { exact: true }).selectOption('legacy-zip')
  await page.getByLabel('账号目录内文件名', { exact: true }).fill('late.zip')
  holdAccountPrepare = true
  accountPrepareStarted = Promise.withResolvers()
  await prepare.click()
  await deadline(accountPrepareStarted.promise, 'raw saved account prepare')
  const rawCalls = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  assert.ok(await list.isDisabled())
  holdAccountPrepare = false
  finishAccountPrepare()
  await notice('账号选择已变化，本次准备已取消').waitFor()
  assert.equal(calls.length, rawCalls)
  assert.equal(await page.locator('#proof').innerText(), '')
  assert.equal(await page.getByRole('button', { name: '确认远程传输', exact: true }).count(), 0)
  assert.equal(
    await page.getByLabel('账号下载归档格式', { exact: true }).inputValue(),
    'relay-envelope'
  )
  checks.push(
    'a late raw saved-account prepare is discarded on hidden-context invalidation without extra RPC or early busy release, and the opt-in format is reset'
  )

  const discoveryPrepare = page.getByRole('button', {
      name: '准备查找旧运行Gist候选',
      exact: true
    }),
    discoveryExecute = page.getByRole('button', {
      name: '单独确认读取本页运行Gist候选',
      exact: true
    }),
    discoveryCancel = page.getByRole('button', { name: '取消本页运行Gist候选准备', exact: true }),
    discoveryPage = page.getByLabel('旧运行Gist候选页码', { exact: true })
  const discover = async () => {
    await discoveryPrepare.click()
    await discoveryExecute.waitFor()
    await discoveryExecute.click()
  }
  const noWritesBefore = {
    runtime: count('relayBackupAccountPrepareRuntime'),
    remote: count('relayBackupAccountPrepareRemote'),
    runtimeExecute: count('relayRuntimeGistExecute'),
    saves: count('relayBackupAccountSave')
  }
  assert.equal(count('relayRuntimeGistDiscoveryPrepare'), 0)
  await list.click()
  await notice('已读取4个账号').waitFor()
  await choose('Fixture Gist')
  await page.getByLabel('账号名称', { exact: true }).fill('unsaved Gist')
  assert.ok(await discoveryPrepare.isDisabled())
  await choose('Fixture Gist')
  await discoveryPage.fill('0')
  await discoveryPrepare.click()
  await notice('候选检查未确认').waitFor()
  assert.equal(count('relayRuntimeGistDiscoveryPrepare'), 0)
  await discoveryPage.fill('1')
  await discoveryPrepare.click()
  await discoveryExecute.waitFor()
  assert.equal(count('relayRuntimeGistDiscoveryExecute'), 0)
  assert.deepEqual(
    calls.filter((x) => x.channel === 'relayRuntimeGistDiscoveryPrepare').at(-1).request,
    { id: gist.id, revision: gist.revision, page: 1 }
  )
  await discoveryExecute.click()
  await notice('本页候选检查已取消').waitFor()
  assert.equal(await page.getByRole('button', { name: /^填入运行配置目标ID/u }).count(), 0)
  checks.push(
    'runtime candidate discovery stays inert on mount, requires saved clean active Gist metadata and valid page, and separates preparation from a cancellable Native read consent'
  )

  discoveryCancelled = false
  await discover()
  await notice('已读取本页未验证候选').waitFor()
  assert.equal(await page.getByRole('button', { name: /^填入运行配置目标ID/u }).count(), 2)
  assert.equal(
    await page.getByLabel('账号操作目标Gist ID（运行配置留空新建）', { exact: true }).inputValue(),
    ''
  )
  await page
    .getByRole('button', { name: '填入运行配置目标ID ' + 'a'.repeat(32), exact: true })
    .click()
  assert.equal(
    await page.getByLabel('账号操作目标Gist ID（运行配置留空新建）', { exact: true }).inputValue(),
    'a'.repeat(32)
  )
  assert.equal(await page.locator('#proof').innerText(), '')
  assert.deepEqual(
    {
      runtime: count('relayBackupAccountPrepareRuntime'),
      remote: count('relayBackupAccountPrepareRemote'),
      runtimeExecute: count('relayRuntimeGistExecute'),
      saves: count('relayBackupAccountSave')
    },
    noWritesBefore
  )
  checks.push(
    'all matching runtime metadata candidates are shown without default selection; choosing one only fills the existing ID and clears old plans, with zero runtime/remote prepare, upload, arm, create or account save'
  )

  await discover()
  await notice('已读取本页未验证候选').waitFor()
  const priorPageReads = count('relayRuntimeGistDiscoveryExecute'),
    priorPagePrepares = count('relayRuntimeGistDiscoveryPrepare')
  await page.getByRole('button', { name: '填写下一页页码（仍需重新准备）', exact: true }).click()
  assert.equal(await discoveryPage.inputValue(), '2')
  assert.equal(count('relayRuntimeGistDiscoveryExecute'), priorPageReads)
  assert.equal(count('relayRuntimeGistDiscoveryPrepare'), priorPagePrepares)
  discoveryEmpty = true
  await discover()
  await page.getByText('本页没有匹配候选；不会自动新建或继续翻页。', { exact: true }).waitFor()
  assert.equal(
    calls.filter((x) => x.channel === 'relayRuntimeGistDiscoveryPrepare').at(-1).request.page,
    2
  )
  assert.equal(
    await page.getByRole('button', { name: '填写下一页页码（仍需重新准备）', exact: true }).count(),
    1
  )
  await discoveryPage.fill('1000')
  await discover()
  await page
    .getByText('已到客户端页码预算，仍可能有后续；不能视为已列完。', { exact: true })
    .waitFor()
  assert.equal(
    await page.getByRole('button', { name: '填写下一页页码（仍需重新准备）', exact: true }).count(),
    0
  )
  checks.push(
    'next-page selection only fills a page number and revokes old metadata; empty pages never create targets, and page 1000 reports a client budget instead of completeness'
  )

  discoveryTTL = -1
  await discoveryPrepare.click()
  await page.getByText('准备已过期，请重新准备；不会自动重新读取。', { exact: true }).waitFor()
  assert.ok(await discoveryExecute.isDisabled())
  assert.equal(count('relayRuntimeGistDiscoveryExecute'), priorPageReads + 2)
  discoveryTTL = 60000
  await choose('Renamed DAV')
  assert.equal(await discoveryExecute.count(), 0)
  assert.equal(await discoveryPage.count(), 0)
  await choose('Fixture Gist')
  checks.push(
    'expired discovery plans cannot execute and require an explicit new preparation; account changes clear the old plan/page/results without auto-reading another account'
  )

  holdDiscoveryPrepare = true
  discoveryPrepareStarted = Promise.withResolvers()
  await discoveryPrepare.click()
  await deadline(discoveryPrepareStarted.promise, 'discovery prepare')
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find((item) =>
      item.closest('label')?.textContent.includes('旧运行Gist候选页码')
    )
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '3')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  assert.ok(await list.isDisabled())
  holdDiscoveryPrepare = false
  finishDiscoveryPrepare()
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')]
        .find((item) => item.textContent === '读取已保存账号')
        .matches(':disabled')
  )
  assert.equal(await discoveryExecute.count(), 0)
  assert.equal(await discoveryPage.inputValue(), '3')
  checks.push(
    'an already queued page edit invalidates a late discovery preparation even while visible controls are locked; no result or executable plan revives'
  )

  holdDiscoveryPrepare = true
  discoveryPrepareStarted = Promise.withResolvers()
  await discoveryPrepare.click()
  await deadline(discoveryPrepareStarted.promise, 'hidden discovery prepare')
  const hiddenDiscoveryCalls = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  assert.ok(await list.isDisabled())
  holdDiscoveryPrepare = false
  finishDiscoveryPrepare()
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')]
        .find((item) => item.textContent === '读取已保存账号')
        .matches(':disabled')
  )
  assert.equal(calls.length, hiddenDiscoveryCalls)
  assert.equal(await discoveryExecute.count(), 0)
  assert.equal(await discoveryPage.inputValue(), '1')
  checks.push(
    'hidden-context invalidation clears discovery caches and page opt-in, discards a late prepared reply without RPC, and holds busy until the actual promise settles'
  )

  await list.click()
  await notice('已读取4个账号').waitFor()
  await choose('Fixture Gist')
  discoveryEmpty = false
  await discoveryPrepare.click()
  await discoveryExecute.waitFor()
  holdDiscoveryExecute = true
  discoveryExecuteStarted = Promise.withResolvers()
  await discoveryExecute.click()
  await deadline(discoveryExecuteStarted.promise, 'discovery execute')
  holdDiscoveryCancel = true
  discoveryCancelStarted = Promise.withResolvers()
  await discoveryCancel.click()
  await deadline(discoveryCancelStarted.promise, 'discovery cancel')
  holdDiscoveryExecute = false
  finishDiscoveryExecute()
  await page.waitForFunction(() => window.__busyEvents.at(-1) === true)
  assert.ok(await list.isDisabled())
  assert.equal(await page.getByRole('button', { name: /^填入运行配置目标ID/u }).count(), 0)
  holdDiscoveryCancel = false
  finishDiscoveryCancel()
  await notice('本页候选准备已取消').waitFor()
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')]
        .find((item) => item.textContent === '读取已保存账号')
        .matches(':disabled')
  )
  checks.push(
    'conditional discovery Cancel wins over a late list response and preserves owned busy until both Execute and matching Cancel really finish'
  )

  await discoveryPrepare.click()
  await discoveryExecute.waitFor()
  await page.evaluate(() => window.__foreignBusy(true))
  const foreignBusyEvents = await page.evaluate(() => window.__busyEvents.length)
  await discoveryCancel.click()
  await notice('本页候选准备已取消').waitFor()
  assert.ok(await list.isDisabled())
  assert.equal(await page.evaluate(() => window.__busyEvents.length), foreignBusyEvents)
  await page.evaluate(() => window.__foreignBusy(false))
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')]
        .find((item) => item.textContent === '读取已保存账号')
        .matches(':disabled')
  )
  checks.push(
    'an idle discovery cancellation remains available under foreign busy and never calls onBusy(false) or releases another operation'
  )

  await page.evaluate(() => window.__stableTun(true))
  assert.ok(!(await discoveryPrepare.isDisabled()))
  assert.ok(await prepare.isDisabled())
  assert.ok(await save.isDisabled())
  discoveryCancelled = true
  await discover()
  await notice('本页候选检查已取消').waitFor()
  await page.evaluate(() => window.__stableTun(false))
  discoveryCancelled = false
  checks.push(
    'stable owned TUN leaves explicit runtime-candidate metadata discovery available while account writes and ordinary backup transfer remain blocked; no runtime capture or core action occurs'
  )

  await discoveryPrepare.click()
  await discoveryExecute.waitFor()
  holdDiscoveryExecute = true
  discoveryExecuteStarted = Promise.withResolvers()
  await discoveryExecute.click()
  await deadline(discoveryExecuteStarted.promise, 'hidden discovery execute')
  const hiddenExecuteCalls = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  assert.ok(await list.isDisabled())
  holdDiscoveryExecute = false
  finishDiscoveryExecute()
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')]
        .find((item) => item.textContent === '读取已保存账号')
        .matches(':disabled')
  )
  assert.equal(calls.length, hiddenExecuteCalls)
  assert.equal(await page.getByRole('button', { name: /^填入运行配置目标ID/u }).count(), 0)
  assert.deepEqual(
    {
      runtime: count('relayBackupAccountPrepareRuntime'),
      remote: count('relayBackupAccountPrepareRemote'),
      runtimeExecute: count('relayRuntimeGistExecute'),
      saves: count('relayBackupAccountSave')
    },
    noWritesBefore
  )
  checks.push(
    'a hidden renderer rejects a late discovery list without extra RPC or any write preparation; manual target and writing flows remain independent'
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])

  const source = 'src/renderer/src/components/relay/backup-account-panel.tsx'
  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-injected-browser-saved-backup-account-panel',
    source,
    sourceSHA256: createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          source,
          'src/renderer/src/components/relay/backup-remote-panel.tsx',
          'src/renderer/src/components/relay/runtime-gist-panel.tsx',
          'src/renderer/src/pages/relay-workspace.tsx',
          'src/shared/relay/backup-accounts.ts',
          'src/renderer/src/components/relay/runtime-gist-source.tsx',
          'src/shared/relay/runtime-gist.ts',
          'src/shared/relay/runtime-gist-discovery.ts'
        ].map(async (path) => [
          path,
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex')
        ])
      )
    ),
    checks,
    passed: checks.length,
    actualCredentialDecrypted: false,
    actualAccountSaved: false,
    actualNativeConfirmationShown: false,
    externalRequests: blocked.length,
    systemNetworkChanged: false,
    existingWorkflowIntegrated: true,
    hiddenLocalRestoreProofPolicy:
      'Account context clears its old restore button without generic BackupCancel; any unconsumed local proof expires or is superseded by the next local staging operation',
    productAcceptance: 'pending'
  }
  await writeFile(
    process.env.RELAY_UI_VERIFICATION_OUTPUT ?? '../evidence/backup-account-ui-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
