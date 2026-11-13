// Synthetic public IPC only. No actual scheduler, credential decryption or network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and isolated test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/webdav-scheduler-ui-')),
  calls = [],
  checks = [],
  errors = [],
  blocked = [],
  busyEvents = [],
  account = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 'a'.repeat(64),
    name: 'Fixture encrypted DAV',
    provider: 'webdav',
    directoryURL: 'https://dav.invalid/Relay/',
    username: 'fixture-user',
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
    name: 'Fixture plain DAV',
    recipient: undefined
  }
let browser,
  state = { pending: false, suspended: false, entries: [] },
  armStatus = 'cancelled',
  failInventory = false,
  failState = false,
  holdArm = false,
  armStarted,
  finishArm,
  holdStop = false,
  stopStarted,
  finishStop,
  stopUncertain = false,
  expectedRetentionKind = 'session-owned'
const count = (channel) => calls.filter((call) => call.channel === channel).length
const nextEntry = (schedule, retention) => ({
  id: account.id,
  revision: account.revision,
  name: account.name,
  directoryURL: account.directoryURL,
  proxyPort: account.proxyPort,
  encrypted: true,
  schedule,
  timeZone: 'Asia/Taipei',
  enabled: true,
  lastStatus: 'armed',
  nextAt: new Date(Date.now() + 60000).toISOString(),
  ...(retention
    ? {
        retention: {
          ...retention,
          ...(retention.kind === 'recorded-owned' ? { uncertainCount: 0 } : {}),
          ownedCount: 0,
          protectedCount: 0,
          deletedCount: 0,
          phase: 'idle'
        }
      }
    : {})
})
const deadline = async (promise, name, milliseconds = 5000) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(name + ' timed out')), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
try {
  await build({
    stdin: {
      contents: `import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';
import{RelayWebdavBackupSchedulerPanel}from'./src/renderer/src/components/relay/webdav-backup-scheduler-panel';
function App(){const[busy,setBusy]=useState(false),[key,setKey]=useState(0);useEffect(()=>{window.__restoreScheduler=()=>setKey(v=>v+1)},[]);return <><button onClick={()=>setBusy(v=>!v)}>切换其他操作忙碌</button><output id="fixture-generation">{key}</output><output id="busy">{String(busy)}</output><RelayWebdavBackupSchedulerPanel key={key} busy={busy} onBusy={v=>{window.__busy(v);setBusy(v)}}/></>};createRoot(document.getElementById('root')).render(<App/>);`,
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
  const context = await deadline(browser.newContext(), 'isolated browser context', 15000),
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
      if (failInventory) throw new Error('PRIVATE-keychain-account-diagnostic')
      return {
        accounts: [
          account,
          plain,
          {
            ...account,
            id: '00000000-0000-4000-8000-000000000003',
            name: 'Excluded Gist',
            provider: 'gist'
          },
          {
            ...account,
            id: '00000000-0000-4000-8000-000000000004',
            name: 'Excluded disabled',
            state: 'disabled'
          }
        ],
        incomplete: 1
      }
    }
    if (channel === 'relayBackupScheduleState') {
      assert.equal(request, undefined)
      if (failState) throw new Error('PRIVATE-scheduler-diagnostic')
      return structuredClone(state)
    }
    if (channel === 'relayBackupScheduleArm') {
      assert.deepEqual(
        Object.keys(request).sort(),
        request.retention
          ? ['id', 'retention', 'revision', 'schedule']
          : ['id', 'revision', 'schedule']
      )
      assert.equal(request.id, account.id)
      assert.equal(request.revision, account.revision)
      if (request.retention) {
        assert.equal(request.retention.kind, expectedRetentionKind)
        assert.deepEqual(Object.keys(request.retention).sort(), ['keepCount', 'kind'])
        assert.ok(
          Number.isInteger(request.retention.keepCount) &&
            request.retention.keepCount >= 1 &&
            request.retention.keepCount <= 100
        )
      }
      const proposed = {
        pending: false,
        suspended: false,
        entries: [nextEntry(request.schedule, request.retention)]
      }
      if (holdArm) {
        armStarted.resolve()
        return new Promise((resolve) => {
          finishArm = () => resolve({ status: 'armed', state: proposed })
        })
      }
      if (armStatus === 'armed') state = proposed
      return { status: armStatus, state: structuredClone(state) }
    }
    assert.equal(channel, 'relayBackupScheduleStop')
    assert.deepEqual(request, { id: account.id })
    const stop = () => {
      state = {
        pending: false,
        suspended: false,
        entries: state.entries.map((entry) => ({
          ...entry,
          enabled: false,
          nextAt: undefined,
          lastStatus: 'stopped',
          ...(stopUncertain
            ? { lastResult: 'uncertain', lastCompletedAt: new Date().toISOString() }
            : {})
        }))
      }
      return structuredClone(state)
    }
    if (holdStop) {
      stopStarted.resolve()
      return new Promise((resolve) => {
        finishStop = () => resolve(stop())
      })
    }
    return stop()
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
  const read = page.getByRole('button', { name: '读取WebDAV账号与定时备份状态', exact: true }),
    arm = page.getByRole('button', { name: '授权本次会话定时备份…', exact: true }),
    stopSelected = page.getByRole('button', { name: '停止所选账号的本次定时备份', exact: true }),
    select = page.getByLabel('本次定时备份账号', { exact: true }),
    retention = page.getByLabel('启用已确认上传文件的保留清理（默认关闭）', { exact: true }),
    keepCount = page.getByLabel('本次授权保留份数（1–100）', { exact: true }),
    retentionKind = page.getByLabel('保留清理回执范围', { exact: true }),
    scheduleKind = page.getByLabel('定时备份周期类型', { exact: true }),
    notice = (text) => page.getByRole('status').filter({ hasText: text })
  await read.waitFor()
  assert.equal(calls.length, 0)
  assert.ok(await arm.isDisabled())
  assert.equal(await retention.isChecked(), false)
  assert.ok(await keepCount.isDisabled())
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  assert.equal(count('relayBackupAccountList'), 1)
  assert.equal(count('relayBackupScheduleState'), 1)
  assert.equal(count('relayBackupScheduleArm'), 0)
  assert.equal(await select.locator('option').count(), 3)
  assert.ok(!(await select.innerText()).includes('Excluded'))
  assert.ok((await page.locator('body').innerText()).includes('状态读取于'))
  checks.push(
    'initial rendering is inert; explicit public reads exclude Gist and disabled accounts and label state as a timestamped authorization snapshot rather than credential validity'
  )

  await select.selectOption(plain.id)
  assert.ok((await page.locator('body').innerText()).includes('敏感明文备份'))
  await select.selectOption(account.id)
  assert.ok((await page.locator('body').innerText()).includes('AGE加密，接收者'))
  await arm.click()
  await notice('已取消本次新授权').waitFor()
  assert.deepEqual(
    calls.filter((call) => call.channel === 'relayBackupScheduleArm').at(-1).request,
    {
      id: account.id,
      revision: account.revision,
      schedule: { kind: 'interval', minutes: 60 }
    }
  )
  assert.equal(count('relayBackupScheduleArm'), 1)
  assert.ok((await page.locator('body').innerText()).includes('读取时没有本次会话调度记录'))
  checks.push(
    'account selection exposes directory, port and AGE/plaintext scope without secrets; native cancellation adds no schedule and no automatic re-arm'
  )

  const armsBeforeInvalid = count('relayBackupScheduleArm')
  await page.getByLabel('备份间隔（分钟，1–35791）', { exact: true }).fill('0')
  await arm.click()
  await notice('读取或授权结果未确认').waitFor()
  assert.equal(count('relayBackupScheduleArm'), armsBeforeInvalid)
  await scheduleKind.selectOption('cron')
  await page.getByLabel('备份5段cron', { exact: true }).fill('* * * *')
  await arm.click()
  await notice('读取或授权结果未确认').waitFor()
  assert.equal(count('relayBackupScheduleArm'), armsBeforeInvalid)
  armStatus = 'armed'
  await page.getByLabel('备份5段cron', { exact: true }).fill('*/5 * * * *')
  await arm.click()
  await notice('本次App会话的定时备份已授权').waitFor()
  assert.deepEqual(
    calls.filter((call) => call.channel === 'relayBackupScheduleArm').at(-1).request.schedule,
    { kind: 'cron', expression: '*/5 * * * *' }
  )
  assert.ok((await page.locator('body').innerText()).includes('时区 Asia/Taipei'))
  checks.push(
    'invalid interval/four-field cron sends no Arm IPC; valid five-field cron is bound to account revision and returned timezone/next-run scope without immediate upload'
  )

  state = {
    pending: false,
    suspended: false,
    entries: [
      {
        ...state.entries[0],
        lastStatus: 'uploaded',
        lastResult: 'uploaded',
        lastAttemptAt: '2026-11-01T03:00:00.000Z',
        lastCompletedAt: '2026-11-01T03:00:01.000Z',
        lastFilename: 'relay-fixture.json',
        lastArchiveSHA256: 'c'.repeat(64)
      }
    ]
  }
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  const body = await page.locator('body').innerText()
  for (const text of [
    'relay-fixture.json',
    'c'.repeat(64),
    '2026-11-01T03:00:00.000Z',
    '2026-11-01T03:00:01.000Z',
    '已上传并读回确认',
    '不代表账号登录或凭据当前有效'
  ])
    assert.ok(body.includes(text))
  checks.push(
    'explicit refresh displays last attempt/completion/result, JSON filename, archive checksum, timezone and next run with a received timestamp; cached enabled status never claims valid login'
  )

  failInventory = true
  state = {
    ...state,
    pending: true,
    entries: state.entries.map((entry) => ({
      ...entry,
      lastStatus: 'running',
      lastAttemptAt: '2026-11-01T03:05:00.000Z',
      lastResult: undefined,
      lastCompletedAt: undefined,
      lastFilename: undefined,
      lastArchiveSHA256: undefined
    }))
  }
  await read.click()
  await notice('已读取调度快照，可停止已有调度').waitFor()
  assert.ok(await arm.isDisabled())
  const runningBody = await page.locator('body').innerText()
  assert.ok(runningBody.includes('本轮备份处理中'))
  assert.ok(runningBody.includes('最近上传结果：尚无结果'))
  assert.ok(runningBody.includes('2026-11-01T03:05:00.000Z'))
  assert.ok(!runningBody.includes('relay-fixture.json') && !runningBody.includes('c'.repeat(64)))
  checks.push(
    'a fresh running snapshot shows no previous successful filename, checksum or completed result while the new attempt is still pending'
  )
  const stopRow = page.getByRole('button', {
    name: '停止' + account.name + '的本次定时备份',
    exact: true
  })
  assert.equal(await stopRow.isDisabled(), false)
  holdStop = true
  stopUncertain = true
  stopStarted = Promise.withResolvers()
  const stopsBefore = count('relayBackupScheduleStop')
  await stopRow.evaluate((button) => {
    button.click()
    button.click()
  })
  await deadline(stopStarted.promise, 'stop')
  assert.equal(count('relayBackupScheduleStop'), stopsBefore + 1)
  assert.ok(await arm.isDisabled())
  holdStop = false
  finishStop()
  await notice('在途写入结果未确认').waitFor()
  assert.ok((await page.locator('body').innerText()).includes('读取时授权：已停止'))
  assert.ok((await page.locator('body').innerText()).includes('写入结果未确认，不自动重试'))
  checks.push(
    'a public-account read failure during a running upload still renders State and Stop; duplicate stop is serialized and uncertain in-flight writes are not labelled successful or retried'
  )

  failInventory = false
  stopUncertain = false
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  await select.selectOption(account.id)
  const busyToggle = page.getByRole('button', { name: '切换其他操作忙碌', exact: true })
  await busyToggle.click()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  assert.ok(await read.isDisabled())
  assert.ok(await arm.isDisabled())
  const busyBeforeStop = busyEvents.length
  assert.equal(await stopSelected.isDisabled(), false)
  await stopSelected.click()
  await notice(/已撤销此账号的本次定时备份授权|此账号定时备份授权已撤销/u).waitFor()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  assert.equal(busyEvents.length, busyBeforeStop)
  await busyToggle.click()
  checks.push(
    'Stop remains available while another foreground operation owns shared busy state and never clears that operation busy flag or invokes a core/system-network channel'
  )

  holdArm = true
  holdStop = true
  armStarted = Promise.withResolvers()
  stopStarted = Promise.withResolvers()
  await arm.click()
  await deadline(armStarted.promise, 'arm')
  assert.equal(await stopSelected.isDisabled(), false)
  await stopSelected.click()
  await deadline(stopStarted.promise, 'stop')
  holdStop = false
  finishStop()
  await notice(/已撤销此账号的本次定时备份授权|此账号定时备份授权已撤销/u).waitFor()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  holdArm = false
  finishArm()
  await page.waitForFunction(() => document.querySelector('#busy')?.textContent === 'false')
  assert.ok((await page.locator('body').innerText()).includes('读取时授权：已停止'))
  assert.ok(!(await page.locator('p[role="status"]').innerText()).includes('已授权'))
  checks.push(
    'Stop can supersede a pending authorization; a late armed response cannot revive stopped UI state and shared busy remains held until both operations settle'
  )

  await retention.check()
  await keepCount.fill('2')
  holdArm = true
  armStarted = Promise.withResolvers()
  await arm.click()
  await deadline(armStarted.promise, 'invalidated arm')
  const beforeInvalidation = calls.length
  await page.evaluate(() => {
    window.__schedulerHeading = document.querySelector('h2')
    window.__invalidateBackup()
  })
  await notice('定时备份准备已撤销').waitFor()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  holdArm = false
  finishArm()
  await page.waitForFunction(() => document.querySelector('#busy')?.textContent === 'false')
  assert.equal(calls.length, beforeInvalidation)
  assert.ok(await arm.isDisabled())
  assert.equal(await retention.isChecked(), false)
  assert.ok(await keepCount.isDisabled())
  assert.ok(!(await page.locator('body').innerText()).includes('状态读取于'))
  assert.equal(
    await page.evaluate(() => window.__schedulerHeading === document.querySelector('h2')),
    true
  )
  checks.push(
    'main-process invalidation clears scheduler metadata and view epoch in place without IPC or remounting; a late armed response cannot restore a cached grant or release busy early'
  )

  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  await select.selectOption(account.id)
  assert.equal(await retention.isChecked(), false)
  const beforeDraft = calls.length,
    beforeInvalidRetention = count('relayBackupScheduleArm')
  await retention.check()
  for (const invalid of ['0', '101', '1.5', '']) {
    await keepCount.fill(invalid)
    await arm.click()
    await notice('读取或授权结果未确认').waitFor()
  }
  assert.equal(count('relayBackupScheduleArm'), beforeInvalidRetention)
  assert.equal(calls.length, beforeDraft)
  await select.selectOption(plain.id)
  assert.equal(await retention.isChecked(), false)
  await select.selectOption(account.id)
  await retention.check()
  await keepCount.fill('2')
  armStatus = 'cancelled'
  await arm.click()
  await notice('已取消本次新授权').waitFor()
  assert.deepEqual(
    calls.filter((call) => call.channel === 'relayBackupScheduleArm').at(-1).request.retention,
    { kind: 'session-owned', keepCount: 2 }
  )
  assert.ok(!(await page.locator('body').innerText()).includes('本次授权保留策略：'))
  checks.push(
    'retention defaults off and is cleared on account change/hide; invalid or fractional keep counts send no IPC, while cancelled explicit Native authorization never installs the draft cleanup scope'
  )

  armStatus = 'armed'
  for (const valid of ['1', '100', '2']) {
    const beforeChange = count('relayBackupScheduleArm')
    await keepCount.fill(valid)
    assert.equal(count('relayBackupScheduleArm'), beforeChange)
    await arm.click()
    await notice('本次App会话的定时备份已授权').waitFor()
    assert.deepEqual(
      calls.filter((call) => call.channel === 'relayBackupScheduleArm').at(-1).request.retention,
      { kind: 'session-owned', keepCount: Number(valid) }
    )
    assert.equal(count('relayBackupScheduleArm'), beforeChange + 1)
  }
  const beforeChangedDraft = count('relayBackupScheduleArm')
  await keepCount.fill('3')
  assert.equal(count('relayBackupScheduleArm'), beforeChangedDraft)
  armStatus = 'cancelled'
  await arm.click()
  await notice('已取消本次新授权').waitFor()
  assert.ok((await page.locator('body').innerText()).includes('目标保留最近2份'))
  assert.ok(!(await page.locator('body').innerText()).includes('目标保留最近3份'))
  checks.push(
    'keep counts 1 and 100 are explicit reauthorizations; changing a draft count does not alter existing permissions and cancelled reauthorization uses only the returned authoritative old scope'
  )

  const confirmed = {
    ...state.entries[0],
    lastStatus: 'uploaded',
    lastResult: 'uploaded',
    lastAttemptAt: '2026-11-01T05:00:00.000Z',
    lastCompletedAt: undefined,
    lastFilename: 'relay-confirmed-new.json',
    lastArchiveSHA256: 'd'.repeat(64),
    retention: {
      kind: 'session-owned',
      keepCount: 2,
      ownedCount: 3,
      protectedCount: 2,
      deletedCount: 0,
      phase: 'checking',
      currentFilename: 'relay-old-owned.json'
    }
  }
  state = { pending: true, suspended: false, entries: [confirmed] }
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  let retentionBody = await page.locator('body').innerText()
  for (const text of [
    '最近上传结果：已上传并读回确认',
    'relay-confirmed-new.json',
    'd'.repeat(64),
    '正在核对清理目标，清理在途',
    '可追踪文件数：3',
    '其中保留的最近文件数：2',
    '本次授权已确认删除数：0',
    '不是整个目录总共K份'
  ])
    assert.ok(retentionBody.includes(text), text)
  assert.equal(await page.locator('#busy').innerText(), 'false')
  assert.ok(await arm.isDisabled())
  assert.ok(await stopSelected.isEnabled())
  state.entries[0].retention.phase = 'deleting'
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  assert.ok((await page.locator('body').innerText()).includes('条件删除及确认在途'))
  checks.push(
    'confirmed upload filename/SHA/result remain visible during independent cleanup checking/deleting; owned/protected/deleted counts describe only the authorization receipt set and Stop remains available without claiming directory-wide K'
  )

  for (const [lastStatus, cleanupResult, phrase] of [
    ['retentionConflict', 'conflict', '目标已变化或不匹配，已停止清理，可能仍超过保留数'],
    ['retentionUncertain', 'uncertain', '删除结果未确认，不自动重试；上传确认仍有效'],
    ['retentionUnsupported', 'unsupported', '强ETag或清理条件不足，已停止'],
    ['retentionFailed', 'failed', '清理未完成，已停止']
  ]) {
    state = {
      pending: false,
      suspended: false,
      entries: [
        {
          ...confirmed,
          enabled: false,
          lastStatus,
          lastCompletedAt: '2026-11-01T05:00:02.000Z',
          retention: {
            ...confirmed.retention,
            phase: 'idle',
            currentFilename: undefined,
            lastAttemptFilename:
              cleanupResult === 'unsupported' ? undefined : 'relay-old-owned.json',
            lastResult: cleanupResult
          }
        }
      ]
    }
    await read.click()
    await notice('已读取公开设置与本机授权快照').waitFor()
    retentionBody = await page.locator('body').innerText()
    assert.ok(retentionBody.includes(phrase))
    assert.ok(retentionBody.includes('最近上传结果：已上传并读回确认'))
    assert.ok(
      retentionBody.includes('relay-confirmed-new.json') && retentionBody.includes('d'.repeat(64))
    )
    assert.ok(retentionBody.includes('本轮收尾：2026-11-01T05:00:02.000Z'))
    if (cleanupResult !== 'unsupported')
      assert.ok(retentionBody.includes('最近清理尝试目标：relay-old-owned.json'))
  }
  checks.push(
    'cleanup conflict/uncertainty/unsupported/failed states stop scope independently and preserve the successful upload evidence; completion time is labelled whole-round settlement rather than upload-confirm time'
  )

  state = {
    pending: true,
    suspended: false,
    entries: [
      {
        ...confirmed,
        retention: {
          ...confirmed.retention,
          phase: 'idle',
          currentFilename: undefined,
          lastAttemptFilename: 'relay-old-owned.json',
          lastResult: 'uncertain'
        }
      }
    ]
  }
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  await busyToggle.click()
  const foreignCleanupBusy = busyEvents.length
  await stopSelected.click()
  await notice('清理删除结果未确认').waitFor()
  assert.equal(busyEvents.length, foreignCleanupBusy)
  assert.equal(await page.locator('#busy').innerText(), 'true')
  assert.ok((await page.locator('body').innerText()).includes('最近上传结果：已上传并读回确认'))
  await busyToggle.click()
  state = {
    pending: false,
    suspended: false,
    entries: [
      {
        ...confirmed,
        retention: {
          ...confirmed.retention,
          ownedCount: 2,
          protectedCount: 2,
          deletedCount: 1,
          phase: 'idle',
          currentFilename: undefined,
          lastResult: 'pruned',
          lastDeletedFilename: 'relay-old-owned.json',
          lastDeletedAt: '2026-11-01T05:00:02.000Z'
        }
      }
    ]
  }
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  retentionBody = await page.locator('body').innerText()
  assert.ok(retentionBody.includes('最近一次条件清理已确认'))
  assert.ok(retentionBody.includes('上次已确认删除：relay-old-owned.json'))
  assert.ok(retentionBody.includes('本次授权已确认删除数：1'))
  checks.push(
    'cleanup Stop preserves uploaded success and uncertainty without clearing foreign busy; pruned/deleted evidence is displayed only from returned public receipts and never causes a renderer DELETE or retry'
  )

  state = {
    ...state,
    pending: true,
    entries: state.entries.map((entry) => ({
      ...entry,
      lastStatus: 'running',
      lastAttemptAt: '2026-11-01T05:05:00.000Z',
      lastResult: undefined,
      lastCompletedAt: undefined,
      lastFilename: undefined,
      lastArchiveSHA256: undefined
    }))
  }
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  retentionBody = await page.locator('body').innerText()
  for (const text of [
    '本轮备份处理中',
    '最近上传结果：尚无结果',
    '最近清理结果：最近一次条件清理已确认',
    '上次已确认删除：relay-old-owned.json'
  ])
    assert.ok(retentionBody.includes(text), text)
  assert.ok(
    !retentionBody.includes('relay-confirmed-new.json') && !retentionBody.includes('d'.repeat(64))
  )
  assert.ok(!retentionBody.includes('本轮条件清理已确认'))
  checks.push(
    'a new upload attempt clears its own success evidence while retained cleanup history is explicitly labelled most recent/previous, never as successful cleanup of the new round'
  )

  state = { ...state, pending: false }
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  if (!(await retention.isChecked())) await retention.check()
  const beforeRecordedDraft = calls.length
  await retentionKind.selectOption('recorded-owned')
  assert.equal(calls.length, beforeRecordedDraft)
  let recordedBody = await page.locator('body').innerText()
  for (const text of [
    '每次开启仍需新的原生删除授权',
    '页面不能输入历史回执',
    '不会按目录前缀、旧ZIP或旧版内存记录认领文件',
    '不会从备份或迁移导入删除权',
    '旧删除结果未确认的文件排除候选，永不自动重试'
  ])
    assert.ok(recordedBody.includes(text), text)
  assert.equal(
    await page
      .locator('input[name="history"],input[name="headSHA256"],input[name="ownedCount"]')
      .count(),
    0
  )
  const beforeRecordedInvalid = count('relayBackupScheduleArm')
  for (const invalid of ['0', '101', '1.5', '']) {
    await keepCount.fill(invalid)
    await arm.click()
    await notice('读取或授权结果未确认').waitFor()
  }
  assert.equal(count('relayBackupScheduleArm'), beforeRecordedInvalid)
  checks.push(
    'recorded-owned is an explicit draft choice only: no history inputs or implicit authorization, clear local verified-fact and fresh Native consent boundaries, and invalid keep counts are rejected before IPC'
  )

  await keepCount.fill('2')
  expectedRetentionKind = 'recorded-owned'
  armStatus = 'cancelled'
  await arm.click()
  await notice('已取消本次新授权').waitFor()
  const recordedRequest = calls
    .filter((call) => call.channel === 'relayBackupScheduleArm')
    .at(-1).request
  assert.deepEqual(recordedRequest.retention, { kind: 'recorded-owned', keepCount: 2 })
  assert.deepEqual(Object.keys(recordedRequest).sort(), ['id', 'retention', 'revision', 'schedule'])
  assert.ok((await page.locator('body').innerText()).includes('本次授权保留策略：仅本授权回执集合'))
  assert.ok(
    !(await page.locator('body').innerText()).includes('本次授权保留策略：本机持久已确认回执')
  )
  checks.push(
    'cancelled cross-session reauthorization sends only policy plus fixed account/schedule and preserves the returned prior session-owned authority; renderer never sends head or historical counts'
  )

  armStatus = 'armed'
  for (const valid of ['1', '100', '2']) {
    await keepCount.fill(valid)
    await arm.click()
    await notice('本次App会话的定时备份已授权').waitFor()
    assert.deepEqual(
      calls.filter((call) => call.channel === 'relayBackupScheduleArm').at(-1).request.retention,
      { kind: 'recorded-owned', keepCount: Number(valid) }
    )
  }
  assert.ok(
    (await page.locator('body').innerText()).includes(
      '本次授权保留策略：本机持久已确认回执（跨会话）'
    )
  )
  checks.push(
    'recorded-owned accepts only explicit fresh authorizations including keep-count boundaries 1 and 100; public returned policy, not the draft, controls the displayed grant'
  )

  state = {
    pending: false,
    suspended: false,
    entries: [
      {
        ...state.entries[0],
        enabled: false,
        lastStatus: 'retentionConflict',
        lastResult: 'uploaded',
        lastFilename: 'relay-new-confirmed.json',
        lastArchiveSHA256: 'e'.repeat(64),
        retention: {
          kind: 'recorded-owned',
          keepCount: 2,
          ownedCount: 5,
          protectedCount: 2,
          deletedCount: 1,
          uncertainCount: 3,
          phase: 'idle',
          lastResult: 'conflict',
          lastAttemptFilename: 'relay-old-delete-candidate.json'
        }
      }
    ]
  }
  await read.click()
  await notice('已读取公开设置与本机授权快照').waitFor()
  recordedBody = await page.locator('body').innerText()
  for (const text of [
    '可追踪文件数：5',
    '其中保留的最近文件数：2',
    '本次授权已确认删除数：1',
    '账本中删除结果未确认的文件数：3',
    '不计入可追踪文件数或其中保留数',
    '永不自动重试',
    '最近上传结果：已上传并读回确认',
    'relay-new-confirmed.json',
    'relay-old-delete-candidate.json',
    '可能仍超过保留数'
  ])
    assert.ok(recordedBody.includes(text), text)
  checks.push(
    'recorded-owned displays pending old delete outcomes separately from owned/protected counts and this-authorization deletions; cleanup conflict leaves confirmed upload evidence intact and never claims directory-wide K or retry'
  )

  await keepCount.fill('2')
  holdArm = true
  armStarted = Promise.withResolvers()
  await arm.click()
  await deadline(armStarted.promise, 'held recorded Arm')
  const beforeRecordedHide = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  await notice('定时备份准备已撤销').waitFor()
  assert.equal(await page.locator('#busy').innerText(), 'true')
  holdArm = false
  finishArm()
  await page.waitForFunction(() => document.querySelector('#busy')?.textContent === 'false')
  assert.equal(calls.length, beforeRecordedHide)
  assert.equal(await retention.isChecked(), false)
  assert.equal(await retentionKind.inputValue(), 'session-owned')
  assert.ok(await retentionKind.isDisabled())
  assert.ok(!(await page.locator('body').innerText()).includes('状态读取于'))
  checks.push(
    'hidden-view invalidation clears recorded opt-in and resets the draft scope without IPC or early busy release; a late recorded Arm response cannot revive persistent deletion authority'
  )

  failState = true
  await read.click()
  await notice('调度状态未确认').waitFor()
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-'))
  assert.ok(!(await page.locator('body').innerText()).includes('状态读取于'))
  failState = false
  const beforeRestore = calls.length
  await page.evaluate(() => window.__restoreScheduler())
  await page.waitForFunction(
    () => document.querySelector('#fixture-generation')?.textContent === '1'
  )
  assert.equal(calls.length, beforeRestore)
  assert.ok(await arm.isDisabled())
  assert.equal(await retention.isChecked(), false)
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  assert.ok(
    calls.every((call) =>
      [
        'relayBackupAccountList',
        'relayBackupScheduleState',
        'relayBackupScheduleArm',
        'relayBackupScheduleStop'
      ].includes(call.channel)
    )
  )
  checks.push(
    'status failures hide private diagnostics and discard stale snapshot timestamps; a restore-driven remount performs no reads or authorization and cannot restart an old schedule'
  )

  const source = 'src/renderer/src/components/relay/webdav-backup-scheduler-panel.tsx',
    shared = 'src/shared/relay/backup-scheduler.ts',
    workspace = 'src/renderer/src/pages/relay-workspace.tsx',
    proof = {
      verifiedAt: new Date().toISOString(),
      scope: 'isolated-injected-browser-WebDAV-session-backup-scheduler',
      source,
      sourceSHA256: createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
      shared,
      sharedSHA256: createHash('sha256')
        .update(await readFile(shared))
        .digest('hex'),
      workspace,
      workspaceSHA256: createHash('sha256')
        .update(await readFile(workspace))
        .digest('hex'),
      checks,
      passed: checks.length,
      actualSchedulerArmed: false,
      actualCredentialDecrypted: false,
      actualAccountUsed: false,
      actualNativeConsentShown: false,
      actualWorkspaceExecuted: false,
      actualCoreOrSystemOperation: false,
      externalRequests: blocked.length,
      productAcceptance: 'pending'
    }
  await writeFile(
    '../evidence/webdav-backup-scheduler-ui-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
