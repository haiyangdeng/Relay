// Synthetic public IPC only; no real saved credential, WebDAV request or Native dialog.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and isolated test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/webdav-directory-ui-')),
  calls = [],
  checks = [],
  errors = [],
  blocked = [],
  busyEvents = [],
  first = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 'a'.repeat(64),
    name: 'Fixture directory A',
    provider: 'webdav',
    directoryURL: 'https://dav.invalid/Parent/Relay/',
    username: 'fixture-user',
    proxyPort: 18191,
    state: 'active',
    hasCredential: true,
    createdAt: 1,
    updatedAt: 1
  },
  second = {
    ...first,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Fixture directory B',
    directoryURL: 'https://dav.invalid/Other/Relay%20B/'
  },
  rootAccount = {
    ...first,
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Fixture existing root',
    directoryURL: 'https://dav.invalid/'
  },
  count = (channel) => calls.filter((call) => call.channel === channel).length
let browser,
  proofNumber = 10,
  lastPlan,
  failList = false,
  failCancel = false,
  result = { status: 'cancelled', submitted: false },
  holdPrepare = false,
  prepareStarted,
  finishPrepare,
  holdExecute = false,
  executeStarted,
  finishExecute,
  holdCancel = false,
  cancelStarted,
  finishCancel
const deadline = async (promise, label) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label + ' adapter not entered')), 5000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
try {
  await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{RelayWebdavDirectoryPanel}from'./src/renderer/src/components/relay/webdav-directory-panel';function App(){const[busy,setBusy]=useState(false);return <><button onClick={()=>setBusy(v=>!v)}>切换其他操作忙碌</button><output id="busy">{String(busy)}</output><RelayWebdavDirectoryPanel busy={busy} onBusy={v=>{window.__busy(v);setBusy(v)}}/></>};createRoot(document.getElementById('root')).render(<App/>);`,
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
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__busy', (value) => busyEvents.push(value))
  await page.exposeFunction('__invoke', async (channel, request) => {
    calls.push({ channel, request })
    if (channel === 'relayBackupAccountList') {
      assert.equal(request, undefined)
      if (failList) throw Error('PRIVATE-Keychain-directory-list-diagnostic')
      return {
        accounts: [
          first,
          second,
          rootAccount,
          {
            ...first,
            id: '00000000-0000-4000-8000-000000000004',
            provider: 'gist',
            name: 'Excluded Gist'
          },
          {
            ...first,
            id: '00000000-0000-4000-8000-000000000005',
            state: 'disabled',
            name: 'Excluded disabled'
          }
        ],
        incomplete: 1
      }
    }
    if (channel === 'relayBackupDirectoryPrepare') {
      assert.deepEqual(Object.keys(request).sort(), ['id', 'revision'])
      const account = [first, second].find((item) => item.id === request.id)
      assert.ok(account)
      assert.equal(request.revision, account.revision)
      const prepared = {
        evidenceId: '00000000-0000-4000-8000-' + String(++proofNumber).padStart(12, '0'),
        provider: 'webdav',
        action: 'createDirectory',
        id: account.id,
        revision: account.revision,
        name: account.name,
        directoryURL: account.directoryURL,
        parentURL: new URL('../', account.directoryURL).href,
        username: account.username,
        proxyPort: account.proxyPort,
        usesCredential: true,
        parentMustExist: true,
        recursive: false,
        overwrite: false,
        expiresAt: Date.now() + 60000
      }
      lastPlan = prepared
      if (holdPrepare) {
        prepareStarted.resolve()
        return new Promise((resolve) => {
          finishPrepare = () => resolve(prepared)
        })
      }
      return prepared
    }
    if (channel === 'relayBackupDirectoryExecute') {
      assert.deepEqual(request, { evidenceId: lastPlan.evidenceId })
      const current = structuredClone(result)
      if (holdExecute) {
        executeStarted.resolve()
        return new Promise((resolve) => {
          finishExecute = () => resolve(current)
        })
      }
      return current
    }
    assert.equal(channel, 'relayBackupDirectoryCancel')
    assert.deepEqual(Object.keys(request), ['evidenceId'])
    assert.match(request.evidenceId, /^00000000-0000-4000-8000-\d{12}$/u)
    if (failCancel) throw Error('PRIVATE-cancel-directory-diagnostic')
    if (holdCancel) {
      cancelStarted.resolve()
      return new Promise((resolve, reject) => {
        finishCancel = (error) => (error ? reject(error) : resolve())
      })
    }
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
  const read = page.getByRole('button', { name: '读取可创建目录的WebDAV账号', exact: true }),
    select = page.getByLabel('创建目录账号', { exact: true }),
    prepare = page.getByRole('button', { name: '准备创建账号目录末层', exact: true }),
    execute = page.getByRole('button', { name: '确认并执行本次目录创建…', exact: true }),
    cancel = page.getByRole('button', { name: '撤销本次目录操作权限', exact: true }),
    notice = (text) => page.locator('p[role="status"]').filter({ hasText: text }),
    readAccounts = async () => {
      await read.click()
      await notice('已读取公开账号设置').waitFor()
    },
    prepareFirst = async () => {
      await select.selectOption(first.id)
      await prepare.click()
      await notice('目录范围已准备').waitFor()
    }
  await read.waitFor()
  assert.equal(calls.length, 0)
  assert.ok(await prepare.isDisabled())
  assert.equal(await page.locator('input').count(), 0)
  await readAccounts()
  assert.equal(await select.locator('option').count(), 4)
  assert.ok(!(await select.innerText()).includes('Excluded'))
  assert.equal(count('relayBackupDirectoryPrepare'), 0)
  checks.push(
    'initial render is inert; explicit metadata read filters active saved WebDAV accounts and exposes no password or URL/path input and does not prepare or create'
  )

  await select.selectOption(rootAccount.id)
  assert.ok(await prepare.isDisabled())
  assert.ok((await page.locator('body').innerText()).includes('根目录无需创建'))
  await prepareFirst()
  assert.ok(
    (await page.locator('body').innerText()).includes(
      '必须已存在的父目录：https://dav.invalid/Parent/'
    )
  )
  assert.equal(count('relayBackupDirectoryExecute'), 0)
  await execute.click()
  await notice('本次目录执行已结束').waitFor()
  assert.ok((await page.locator('body').innerText()).includes('本次目录操作已取消，未提交目录写入'))
  assert.equal(await execute.count(), 0)
  checks.push(
    'root target has no creation action; preparing sends only account id/revision, previews the fixed last-level scope and parent, and default Native cancellation consumes the executable plan'
  )

  for (const [reply, expected] of [
    [
      { status: 'created', directoryURL: first.directoryURL, verifiedAt: Date.now() },
      '末层目录已创建，并确认目标是目录集合'
    ],
    [
      { status: 'alreadyExists', directoryURL: first.directoryURL, verifiedAt: Date.now() },
      '目标目录已存在，并确认是目录集合'
    ],
    [
      { status: 'uncertain', directoryURL: first.directoryURL, httpStatus: 201 },
      '目录写入结果未确认，可能已经创建'
    ],
    [
      {
        status: 'conflict',
        directoryURL: first.directoryURL,
        reason: 'targetNotCollection',
        httpStatus: 405
      },
      '目标已存在且未确认是目录集合'
    ],
    [
      {
        status: 'rejected',
        directoryURL: first.directoryURL,
        reason: 'parentMissing',
        httpStatus: 409
      },
      '父目录不存在，请先在服务器端建立父目录'
    ]
  ]) {
    result = reply
    await prepareFirst()
    await execute.click()
    await notice('本次目录执行已结束').waitFor()
    assert.ok((await page.locator('body').innerText()).includes(expected))
    assert.equal(await execute.count(), 0)
    if (reply.httpStatus === 405)
      assert.ok(
        !(await page.locator('body').innerText()).includes('目标目录已存在，并确认是目录集合')
      )
    const after = calls.length
    await page.waitForTimeout(50)
    assert.equal(calls.length, after)
  }
  checks.push(
    'created/alreadyExists/uncertain/conflict/rejected responses are displayed exactly by typed status and sanitized reason; 405 is not reinterpreted as success and no result causes automatic retry'
  )

  await prepareFirst()
  const oldId = lastPlan.evidenceId,
    beforePrepare = count('relayBackupDirectoryPrepare')
  holdCancel = true
  cancelStarted = Promise.withResolvers()
  await select.selectOption(second.id)
  await deadline(cancelStarted.promise, 'old scoped Cancel')
  await prepare.click()
  await notice('正在准备固定目录范围').waitFor()
  await page.waitForTimeout(50)
  assert.equal(count('relayBackupDirectoryPrepare'), beforePrepare)
  finishCancel()
  holdCancel = false
  await notice('目录范围已准备').waitFor()
  assert.equal(lastPlan.id, second.id)
  assert.notEqual(lastPlan.evidenceId, oldId)
  assert.equal(
    calls.filter((call) => call.channel === 'relayBackupDirectoryCancel').at(-1).request.evidenceId,
    oldId
  )
  assert.ok(
    (await page.locator('body').innerText()).includes(
      '本次MKCOL目标：https://dav.invalid/Other/Relay%20B/'
    )
  )
  checks.push(
    'account context changes cancel only the captured evidenceId; a delayed old Cancel is awaited before preparing a new account and cannot revoke its new proof'
  )

  await page.getByRole('button', { name: '切换其他操作忙碌', exact: true }).click()
  assert.ok(await prepare.isDisabled())
  assert.ok(await execute.isDisabled())
  assert.ok(await cancel.isEnabled())
  const beforeForeignBusy = busyEvents.length
  await cancel.click()
  await notice('本次目录操作权限已撤销').waitFor()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  assert.equal(busyEvents.length, beforeForeignBusy)
  await page.getByRole('button', { name: '切换其他操作忙碌', exact: true }).click()
  checks.push(
    'an idle owned proof can be cancelled during foreign busy without releasing the other operation or invoking global backup/runtime cancel channels'
  )

  await prepareFirst()
  result = { status: 'uncertain', directoryURL: first.directoryURL }
  holdExecute = true
  executeStarted = Promise.withResolvers()
  await execute.click()
  await deadline(executeStarted.promise, 'Execute')
  holdCancel = true
  cancelStarted = Promise.withResolvers()
  await cancel.click()
  await deadline(cancelStarted.promise, 'active Cancel')
  finishExecute()
  holdExecute = false
  await notice('本次目录执行已结束').waitFor()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  assert.ok((await page.locator('body').innerText()).includes('目录写入结果未确认，可能已经创建'))
  finishCancel()
  holdCancel = false
  await notice('本次目录操作权限已撤销').waitFor()
  await page.waitForFunction(() => document.querySelector('#busy')?.textContent === 'false')
  assert.ok((await page.locator('body').innerText()).includes('目录写入结果未确认，可能已经创建'))
  checks.push(
    'active Cancel uses the consumed proof id; busy remains owned until Execute and Cancel both settle and the real uncertain write result survives the later cancellation acknowledgement'
  )

  await select.selectOption(first.id)
  holdPrepare = true
  prepareStarted = Promise.withResolvers()
  await prepare.click()
  await deadline(prepareStarted.promise, 'hidden Prepare')
  const beforeHide = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  await notice('目录准备已撤销').waitFor()
  assert.equal(calls.length, beforeHide)
  assert.equal(await page.locator('#busy').innerText(), 'true')
  assert.equal(await select.inputValue(), '')
  finishPrepare()
  holdPrepare = false
  await page.waitForFunction(() => document.querySelector('#busy')?.textContent === 'false')
  assert.equal(await execute.count(), 0)
  assert.ok(!(await page.locator('body').innerText()).includes('公开账号设置读取于'))
  assert.equal(calls.length, beforeHide)
  checks.push(
    'hidden-view invalidation clears metadata, timestamp and plan without cancellation RPC or premature busy release; late preparation cannot revive an executable capability'
  )

  await readAccounts()
  await prepareFirst()
  result = { status: 'created', directoryURL: first.directoryURL, verifiedAt: Date.now() }
  holdExecute = true
  executeStarted = Promise.withResolvers()
  await execute.click()
  await deadline(executeStarted.promise, 'hidden Execute')
  const beforeWriteHide = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  await notice('目录准备已撤销').waitFor()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  assert.equal(calls.length, beforeWriteHide)
  finishExecute()
  holdExecute = false
  await notice('本次目录执行已结束').waitFor()
  assert.ok(
    (await page.locator('body').innerText()).includes('末层目录已创建，并确认目标是目录集合')
  )
  assert.equal(await execute.count(), 0)
  assert.equal(await select.inputValue(), '')
  checks.push(
    'an entered write reports its actual terminal created result after hide while retaining no executable plan, selection or hidden-view read cache'
  )

  await readAccounts()
  await prepareFirst()
  failCancel = true
  await cancel.click()
  await notice('目录取消结果未确认').waitFor()
  failCancel = false
  await readAccounts()
  await prepareFirst()
  await cancel.click()
  await notice('本次目录操作权限已撤销').waitFor()
  checks.push(
    'failed scoped cancellation hides the old plan but does not poison later explicit metadata reads and new preparation; diagnostics remain sanitized'
  )

  await prepareFirst()
  holdCancel = true
  cancelStarted = Promise.withResolvers()
  await select.selectOption(second.id)
  await deadline(cancelStarted.promise, 'hidden old Cancel')
  const beforeCancelHide = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  await notice('目录准备已撤销').waitFor()
  finishCancel(Error('PRIVATE-late-cancel-diagnostic'))
  holdCancel = false
  await page.waitForTimeout(50)
  assert.equal(calls.length, beforeCancelHide)
  assert.ok(await notice('目录准备已撤销').isVisible())
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-'))
  checks.push(
    'a late failed context-cancellation after hide cannot overwrite the new view notice or trigger another IPC'
  )

  await readAccounts()
  assert.ok((await page.locator('body').innerText()).includes('有1条账号记录未能确认'))
  failList = true
  await read.click()
  await notice('账号读取或目录准备未确认').waitFor()
  assert.equal(await select.inputValue(), '')
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-'))
  assert.ok(!(await page.locator('body').innerText()).includes('公开账号设置读取于'))
  assert.ok(!(await page.locator('body').innerText()).includes('有1条账号记录未能确认'))
  checks.push(
    'failed public metadata reads remove cached identity and read time without leaking private diagnostics or creating work'
  )

  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  assert.ok(
    calls.every((call) =>
      [
        'relayBackupAccountList',
        'relayBackupDirectoryPrepare',
        'relayBackupDirectoryExecute',
        'relayBackupDirectoryCancel'
      ].includes(call.channel)
    )
  )
  const sources = [
      'src/renderer/src/components/relay/webdav-directory-panel.tsx',
      'src/renderer/src/pages/relay-workspace.tsx',
      'src/shared/relay/backup-directory.ts'
    ],
    sourceSHA256 = {}
  for (const source of sources)
    sourceSHA256[source] = createHash('sha256')
      .update(await readFile(source))
      .digest('hex')
  assert.ok((await readFile(sources[1], 'utf8')).includes('<RelayWebdavDirectoryPanel'))
  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-injected-browser-WebDAV-single-level-directory',
    sourceSHA256,
    checks,
    passed: checks.length,
    actualAccountUsed: false,
    actualCredentialDecrypted: false,
    actualNativeConsentShown: false,
    actualWebdavRequest: false,
    actualWorkspaceExecuted: false,
    actualCoreOrSystemOperation: false,
    externalRequests: blocked.length,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/webdav-directory-ui-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
