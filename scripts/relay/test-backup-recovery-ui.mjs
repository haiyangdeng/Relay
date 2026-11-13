import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and existing test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/backup-recovery-ui-'))
const calls = [],
  checks = [],
  errors = [],
  blocked = [],
  commitStarted = Promise.withResolvers(),
  restorePlan = {
    id: 'normal-restore-proof',
    baselineSHA256: 'a'.repeat(64),
    targetSHA256: 'b'.repeat(64),
    archiveSHA256: 'c'.repeat(64),
    files: 2,
    replacedFiles: 1,
    removedFiles: 1,
    containsSecrets: true,
    preparedAt: Date.now()
  },
  migrationReport = {
    format: 'clash-party-legacy-zip',
    archiveSHA256: 'd'.repeat(64),
    containsSecrets: true,
    counts: {
      profiles: 1,
      sources: 0,
      overrides: 1,
      rulePatches: 0,
      applied: 2,
      retained: 1,
      'decision-required': 1
    },
    files: [
      {
        path: 'profiles/legacy-fixture.yaml',
        bytes: 128,
        sha256: 'e'.repeat(64),
        disposition: 'applied',
        reason: '已生成独立候选，尚未写入当前资料'
      }
    ],
    profiles: [
      {
        legacyId: 'legacy-fixture',
        profileId: 'new-profile-fixture',
        disposition: 'applied',
        reason: '保持原记录，新增配置'
      }
    ]
  }
let browser,
  legacyStatus = 'prepared',
  restoreStatus = 'cancelled',
  failLegacy = false,
  holdCommit = false,
  commitStatus = 'uncertain',
  finishCommit,
  nextCommitEntered,
  holdNextCancel = false,
  cancelEntered,
  finishCancel,
  failNextCancel = false,
  relayInspectStatus = 'cancelled',
  relayInspection,
  relayInspectSequence = 0,
  expiredRelayInspection = false,
  holdRelayInspect = false,
  relayInspectEntered,
  finishRelayInspect,
  holdRelayPrepare = false,
  relayPrepareEntered,
  finishRelayPrepare,
  nextCancelObserved
const relayProfiles = [1, 2].map((number) => ({
  id:
    `${number}`.repeat(8) +
    '-' +
    `${number}`.repeat(4) +
    '-4' +
    `${number}`.repeat(3) +
    '-8' +
    `${number}`.repeat(3) +
    '-' +
    `${number}`.repeat(12),
  name: number === 1 ? 'Old Alpha' : 'Old Beta',
  createdAt: new Date().toISOString(),
  sha256: String(number).repeat(64),
  revision: String(number + 2).repeat(64),
  summary: { proxies: 1, groups: 1, rules: 1, proxyProviders: 0, ruleProviders: 0 }
}))
async function deadline(promise, label, ms = 5000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
try {
  await build({
    stdin: {
      contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {RelayBackupPanel} from './src/renderer/src/components/relay/backup-panel';
    function App(){const [busy,setBusy]=useState(false),[inspectBusy,setInspectBusy]=useState(false);window.__setBackupBusy=(write,read)=>{setBusy(write);setInspectBusy(read)};return React.createElement(RelayBackupPanel,{busy,inspectBusy,onBusy:value=>{window.__busyState=value},onRestoreNotice:()=>{}})}
    createRoot(document.getElementById('root')).render(React.createElement(App));`,
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
    args: ['--allow-file-access-from-files', '--disable-background-networking']
  })
  const context = await deadline(browser.newContext(), 'private browser context timeout', 15000),
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
    if (['relayBackupCancel', 'relayBackupRecoveryCancel'].includes(channel)) {
      assert.equal(request, undefined)
      if (channel === 'relayBackupCancel') nextCancelObserved?.()
      if (channel === 'relayBackupCancel' && failNextCancel) {
        failNextCancel = false
        throw new Error('PRIVATE-cancel-transport-detail')
      }
      if (holdNextCancel && channel === 'relayBackupCancel') {
        holdNextCancel = false
        cancelEntered.resolve()
        await new Promise((resolve) => {
          finishCancel = resolve
        })
      }
      return
    }
    if (channel === 'relayBackupLegacyRelayInspect') {
      assert.deepEqual(Object.keys(request), ['origin'])
      assert.ok(['Relay', 'Relay-Preview'].includes(request.origin))
      relayInspectSequence++
      const time = Date.now() - (expiredRelayInspection ? 60001 : 0)
      relayInspection = {
        inspectionId: '33333333-3333-4333-8333-' + String(relayInspectSequence).padStart(12, '0'),
        origin: request.origin,
        sourceSHA256: '5'.repeat(64),
        preparedAt: time,
        expiresAt: time + 60000,
        profiles: relayProfiles,
        incomplete: 1,
        warnings: ['一个未知UUID条目未接纳，旧原件保留']
      }
      const result =
        relayInspectStatus === 'cancelled'
          ? { status: 'cancelled' }
          : { status: 'inspected', inspection: structuredClone(relayInspection) }
      if (holdRelayInspect) {
        holdRelayInspect = false
        relayInspectEntered?.()
        await new Promise((resolve) => {
          finishRelayInspect = resolve
        })
      }
      return result
    }
    if (channel === 'relayBackupLegacyRelayPrepare') {
      assert.deepEqual(Object.keys(request).sort(), ['inspectionId', 'profiles'])
      assert.equal(request.inspectionId, relayInspection.inspectionId)
      assert.ok(request.profiles.length > 0)
      for (const profile of request.profiles) {
        assert.deepEqual(Object.keys(profile).sort(), ['id', 'revision', 'sha256'])
        const known = relayProfiles.find(({ id }) => id === profile.id)
        assert.deepEqual(profile, { id: known.id, sha256: known.sha256, revision: known.revision })
      }
      const result = {
        status: 'prepared',
        plan: { ...restorePlan, id: 'legacy-relay-restore-proof' },
        report: {
          format: 'relay-legacy-profiles-v1',
          origin: relayInspection.origin,
          sourceSHA256: relayInspection.sourceSHA256,
          originalArchiveSHA256: '6'.repeat(64),
          containsSecrets: true,
          profiles: request.profiles.map((profile, index) => ({
            legacyId: profile.id,
            legacySHA256: profile.sha256,
            legacyRevision: profile.revision,
            profileId: '99999999-9999-4999-8999-' + String(index + 1).padStart(12, '0'),
            profileSHA256: profile.sha256
          })),
          warnings: []
        }
      }
      if (holdRelayPrepare) {
        holdRelayPrepare = false
        relayPrepareEntered?.()
        await new Promise((resolve) => {
          finishRelayPrepare = resolve
        })
      }
      return result
    }
    if (channel === 'relayBackupRecoveryList') {
      assert.equal(request, undefined)
      return [
        {
          id: 'record-v2',
          version: 2,
          phase: 'uncertain',
          actions: ['resume', 'rollback'],
          containsSecrets: true
        },
        {
          id: 'record-v1',
          version: 1,
          phase: 'applying',
          actions: ['resume'],
          containsSecrets: true
        },
        {
          id: 'record-unknown',
          version: 'unknown',
          phase: 'PRIVATE-journal-path',
          actions: ['rollback'],
          reason: 'PRIVATE-original-path',
          containsSecrets: true
        }
      ]
    }
    if (channel === 'relayBackupImportPrepare') {
      assert.equal(request, undefined)
      return { status: 'prepared', plan: restorePlan }
    }
    if (channel === 'relayBackupLegacyPrepare') {
      assert.ok(Object.keys(request).every((key) => key === 'proxyPort'))
      if (request.proxyPort !== undefined) assert.equal(request.proxyPort, 18191)
      if (failLegacy) throw new Error('PRIVATE-legacy-zip-content-and-path')
      return {
        status: legacyStatus,
        report: migrationReport,
        ...(legacyStatus === 'prepared'
          ? { plan: { ...restorePlan, id: 'legacy-restore-proof' } }
          : {})
      }
    }
    if (channel === 'relayBackupRestore') {
      assert.ok(['legacy-restore-proof', 'legacy-relay-restore-proof'].includes(request.id))
      assert.deepEqual(Object.keys(request), ['id'])
      return { status: restoreStatus }
    }
    if (channel === 'relayBackupRecoveryPrepare') {
      assert.equal(request.id, 'record-v2')
      assert.ok(['resume', 'rollback'].includes(request.action))
      return {
        status: 'prepared',
        plan: {
          evidenceId: 'recovery-proof',
          id: request.id,
          action: request.action,
          recordSHA256: 'f'.repeat(64),
          baselineSHA256: 'a'.repeat(64),
          targetSHA256: 'b'.repeat(64),
          currentSHA256: 'c'.repeat(64),
          files: 2,
          containsSecrets: true,
          preparedAt: Date.now(),
          expiresAt: Date.now() + 60000
        }
      }
    }
    assert.equal(channel, 'relayBackupRecoveryCommit')
    assert.deepEqual(request, { evidenceId: 'recovery-proof' })
    if (holdCommit) {
      return new Promise((resolve) => {
        finishCommit = resolve
        commitStarted.resolve()
        nextCommitEntered?.()
      })
    }
    return { status: commitStatus }
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
  await page.getByRole('heading', { name: 'Relay本地备份与恢复', exact: true }).waitFor()
  const ordinary = page.getByRole('button', { name: '选择备份并检查', exact: true }),
    legacy = page.getByRole('button', { name: '选择旧Clash备份并检查', exact: true }),
    restore = page.getByRole('button', { name: '确认恢复这份备份', exact: true }),
    list = page.getByRole('button', { name: '读取恢复记录', exact: true }),
    commit = page.getByRole('button', { name: '单独确认本次续作', exact: true }),
    recoveryCancel = page.getByRole('button', { name: '取消本次续作准备', exact: true }),
    proxyPort = page.getByLabel('订阅默认代理端口（可选）'),
    activeRecord = page.getByRole('listitem').filter({ hasText: 'record-v2' })
  assert.equal(calls.length, 0)
  assert.ok(await restore.isDisabled())
  assert.ok(await commit.isDisabled())
  await list.click()
  await page.getByRole('status').filter({ hasText: '已读取3条恢复记录' }).waitFor()
  assert.equal(await activeRecord.getByRole('button').count(), 2)
  for (const id of ['record-v1', 'record-unknown']) {
    assert.equal(
      await page.getByRole('listitem').filter({ hasText: id }).getByRole('button').count(),
      0
    )
  }
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-'))
  checks.push(
    'rendering performs no IO; records require an explicit read and v1/unknown records expose no forced actions or private diagnostics'
  )

  await ordinary.click()
  await page.getByRole('status').filter({ hasText: '备份完整性与当前数据基线已检查' }).waitFor()
  assert.equal(await restore.isDisabled(), false)
  assert.ok(
    (await page.locator('body').innerText()).includes(
      '白名单范围内未包含在备份中的文件将移出当前资料'
    )
  )
  await activeRecord.getByRole('button', { name: '核对继续恢复', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '记录与当前资料已核对' }).waitFor()
  assert.ok(await restore.isDisabled())
  assert.equal(await commit.isDisabled(), false)
  await legacy.click()
  await page.getByRole('status').filter({ hasText: '迁移仍待单独确认' }).waitFor()
  assert.equal(await restore.isDisabled(), false)
  assert.ok(await commit.isDisabled())
  assert.deepEqual(calls.at(-1), { channel: 'relayBackupLegacyPrepare', request: {} })
  assert.ok((await page.locator('body').innerText()).includes('这是待确认的迁移，尚未导入'))
  assert.ok((await page.locator('body').innerText()).includes('迁移候选合并当前资料与新增资料'))
  assert.ok(
    !(await page.locator('body').innerText()).includes(
      '白名单范围内未包含在备份中的文件将移出当前资料'
    )
  )
  await restore.click()
  await page.getByRole('status').filter({ hasText: '本次操作已取消' }).waitFor()
  assert.ok(await restore.isDisabled())
  assert.ok(await commit.isDisabled())
  checks.push(
    'ordinary import, recovery and legacy preparation revoke one another; migration is only pending until separate native confirmation and cancellation consumes its proof'
  )

  legacyStatus = 'inspected'
  await proxyPort.fill('18191')
  await legacy.click()
  await page.getByRole('status').filter({ hasText: '没有可执行的迁移准备' }).waitFor()
  assert.deepEqual(calls.at(-1), {
    channel: 'relayBackupLegacyPrepare',
    request: { proxyPort: 18191 }
  })
  assert.ok(await restore.isDisabled())
  await page.getByText('旧Clash迁移检查报告', { exact: true }).click()
  await page.getByRole('cell', { name: 'profiles/legacy-fixture.yaml', exact: true }).waitFor()
  assert.ok((await page.locator('body').innerText()).includes('new-profile-fixture'))
  checks.push(
    'legacy reports remain readable with file and ID mappings, while inspection-only results have no executable restore proof'
  )

  const previousMigration = structuredClone(migrationReport)
  legacyStatus = 'prepared'
  migrationReport.counts.profiles = 0
  migrationReport.profiles = []
  migrationReport.files = [
    {
      path: 'substore/sub-store.json',
      bytes: 256,
      sha256: 'f'.repeat(64),
      disposition: 'applied',
      reason: '基础定义候选，其他行为仅保留原件'
    }
  ]
  migrationReport.substore = {
    schema: '2.0',
    subscriptions: 1,
    collections: 0,
    items: [
      {
        kind: 'subscription',
        oldName: '旧基础定义',
        newName: 'relay-import-sub-fixture',
        disposition: 'accepted',
        reason: '基础订阅候选，noFlow=true'
      },
      {
        kind: 'collection',
        oldName: '依赖未完整接纳的集合',
        disposition: 'retained',
        reason: '缺少映射；整项留原件'
      },
      {
        kind: 'section',
        oldName: 'artifacts',
        disposition: 'retained',
        reason: '旧定时任务与脚本不进入候选'
      }
    ]
  }
  await legacy.click()
  await page.getByRole('status').filter({ hasText: '迁移仍待单独确认' }).waitFor()
  assert.equal(await restore.isDisabled(), false)
  const freshClashReport = page
    .locator('details')
    .filter({ has: page.getByText('旧Clash迁移检查报告', { exact: true }) })
  if (!(await freshClashReport.evaluate((details) => details.open)))
    await freshClashReport.getByText('旧Clash迁移检查报告', { exact: true }).click()
  const substoreReport = page.getByRole('region', { name: 'Sub-Store逐项迁移报告' })
  await substoreReport
    .getByRole('cell', { name: 'relay-import-sub-fixture', exact: true })
    .waitFor()
  const substoreText = await substoreReport.innerText()
  assert.match(substoreText, /接纳订阅\s*1项/u)
  assert.match(substoreText, /静态集合\s*0项/u)
  for (const text of [
    '2.0数组',
    'noFlow=true',
    '自动流量查询默认关闭',
    '不启动Sub-Store',
    '旧基础定义',
    '候选接纳',
    '依赖未完整接纳的集合',
    '缺少映射；整项留原件',
    'artifacts',
    '旧定时任务与脚本不进入候选'
  ])
    assert.ok(substoreText.includes(text), text)
  assert.equal(await substoreReport.getByRole('button').count(), 0)
  assert.ok(!(await page.locator('body').innerText()).includes('没有可执行的迁移准备'))
  restoreStatus = 'restored'
  await restore.click()
  await page.getByRole('status').filter({ hasText: '私有数据恢复已确认' }).waitFor()
  restoreStatus = 'cancelled'
  const restoredSubstoreText = await substoreReport.innerText()
  assert.ok(restoredSubstoreText.includes('候选接纳'))
  assert.ok(!restoredSubstoreText.includes('尚未写入'))
  assert.ok(await restore.isDisabled())
  checks.push(
    'partial Sub-Store2.0 metadata shows accepted definition mappings, retained tasks and noFlow; a restored terminal response retains the report without claiming still unwritten or treating zero profiles as no candidate'
  )
  Object.assign(migrationReport, previousMigration)
  delete migrationReport.substore

  await activeRecord.getByRole('button', { name: '核对回滚原件', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '记录与当前资料已核对' }).waitFor()
  holdCommit = true
  const cancellationsBeforeCommit = calls.filter(
    (call) => call.channel === 'relayBackupRecoveryCancel'
  ).length
  await commit.click()
  const timeout = setTimeout(
    () => commitStarted.reject(new Error('commit adapter not entered')),
    5000
  )
  try {
    await commitStarted.promise
  } finally {
    clearTimeout(timeout)
  }
  assert.ok(
    await page
      .locator('input,button')
      .evaluateAll((items) => items.every((item) => item.matches(':disabled')))
  )
  assert.ok(await recoveryCancel.isDisabled())
  assert.equal(
    calls.filter((call) => call.channel === 'relayBackupRecoveryCancel').length,
    cancellationsBeforeCommit
  )
  finishCommit({ status: 'uncertain' })
  await page.getByRole('status').filter({ hasText: '续作结果未确认' }).waitFor()
  assert.ok(await commit.isDisabled())
  assert.ok(!(await page.locator('body').innerText()).includes('回滚原件已确认'))
  checks.push(
    'commit locks all competing actions and cannot be disguised as cancellation; uncertain execution clears the proof without claiming restored or rolled back'
  )

  holdCommit = false
  await list.click()
  await page.getByRole('status').filter({ hasText: '已读取3条恢复记录' }).waitFor()
  await activeRecord.getByRole('button', { name: '核对继续恢复', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '记录与当前资料已核对' }).waitFor()
  await recoveryCancel.click()
  await page.getByRole('status').filter({ hasText: '已取消续作准备' }).waitFor()
  assert.ok(await commit.isDisabled())
  await activeRecord.getByRole('button', { name: '核对继续恢复', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '记录与当前资料已核对' }).waitFor()
  commitStatus = 'cancelled'
  await commit.click()
  await page.getByRole('status').filter({ hasText: '本次续作确认已取消' }).waitFor()
  assert.ok(await commit.isDisabled())
  checks.push(
    'both cancelling prepared recovery and cancelling native confirmation leave no executable proof or success claim'
  )

  legacyStatus = 'prepared'
  await legacy.click()
  await page.getByRole('status').filter({ hasText: '迁移仍待单独确认' }).waitFor()
  legacyStatus = 'cancelled'
  await legacy.click()
  await page.getByRole('status').filter({ hasText: '本次旧备份检查已取消' }).waitFor()
  assert.ok(await restore.isDisabled())
  legacyStatus = 'prepared'
  await legacy.click()
  await page.getByRole('status').filter({ hasText: '迁移仍待单独确认' }).waitFor()
  failLegacy = true
  await legacy.click()
  await page.getByRole('status').filter({ hasText: '本次操作未确认' }).waitFor()
  assert.ok(await restore.isDisabled())
  assert.ok(await commit.isDisabled())
  assert.ok(
    !(await page.locator('body').innerText()).includes('PRIVATE-legacy-zip-content-and-path')
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  checks.push(
    'cancelled or failed legacy scans revoke old executable plans while preserving only readable report metadata and hiding private errors'
  )

  failLegacy = false
  await legacy.click()
  await page.getByRole('status').filter({ hasText: '迁移仍待单独确认' }).waitFor()
  const beforeInvalidation = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  await page.getByRole('status').filter({ hasText: '备份准备已撤销' }).waitFor()
  assert.ok(await restore.isDisabled())
  assert.ok(await commit.isDisabled())
  assert.equal(calls.length, beforeInvalidation)
  checks.push(
    'main-process preparation invalidation clears ordinary, legacy and recovery capabilities and cached records without issuing cancellation IPC'
  )

  holdNextCancel = true
  cancelEntered = Promise.withResolvers()
  await legacy.click()
  const cancelTimeout = setTimeout(
    () => cancelEntered.reject(new Error('held cancellation not entered')),
    5000
  )
  try {
    await cancelEntered.promise
  } finally {
    clearTimeout(cancelTimeout)
  }
  const beforeLateCancellation = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  finishCancel()
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent.trim() === '选择旧Clash备份并检查'
    )
    return button && !button.matches(':disabled')
  })
  assert.equal(calls.length, beforeLateCancellation)
  assert.ok(await restore.isDisabled())
  checks.push(
    'invalidation between asynchronous cancellation replies prevents the old operation from dispatching a second Cancel or a new preparation afterward'
  )

  await list.click()
  await page.getByRole('status').filter({ hasText: '已读取3条恢复记录' }).waitFor()
  await activeRecord.getByRole('button', { name: '核对继续恢复', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '记录与当前资料已核对' }).waitFor()
  holdCommit = true
  const enteredAgain = Promise.withResolvers()
  nextCommitEntered = enteredAgain.resolve
  await commit.click()
  const enteredTimeout = setTimeout(
    () => enteredAgain.reject(new Error('second commit adapter not entered')),
    5000
  )
  try {
    await enteredAgain.promise
  } finally {
    clearTimeout(enteredTimeout)
  }
  const beforeActiveInvalidation = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  assert.ok(
    await page
      .locator('input,button')
      .evaluateAll((items) => items.every((item) => item.matches(':disabled')))
  )
  assert.equal(calls.length, beforeActiveInvalidation)
  finishCommit({ status: 'restored' })
  await page.getByRole('status').filter({ hasText: '继续恢复已确认' }).waitFor()
  assert.ok(await commit.isDisabled())
  assert.ok(await restore.isDisabled())
  checks.push(
    'invalidation does not release an entered restore transaction busy barrier; its genuine completed result remains visible after the capability is cleared'
  )

  const relayInspect = page.getByRole('button', { name: '只读检查旧Relay配置', exact: true }),
    relayPrepare = page.getByRole('button', { name: '准备新的未启用配置副本', exact: true }),
    relayCancel = page.getByRole('button', { name: '取消旧Relay检查或准备', exact: true }),
    relayOrigin = page.getByLabel('旧Relay固定来源'),
    relaySelection = (index) =>
      page.getByRole('checkbox', {
        name: `选择旧配置 ${relayProfiles[index].name}（${relayProfiles[index].id}）`,
        exact: true
      }),
    waitRelayIdle = () =>
      page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll('button')).find(
            (button) => button.textContent === '只读检查旧Relay配置'
          ).disabled
      )
  assert.equal(
    calls.filter(({ channel }) => channel.startsWith('relayBackupLegacyRelay')).length,
    0
  )
  assert.equal(await relayOrigin.inputValue(), 'Relay-Preview')
  assert.ok(await relayPrepare.isDisabled())
  await relayInspect.click()
  await page.getByRole('status').filter({ hasText: '本次旧Relay检查已取消' }).waitFor()
  assert.equal(await page.getByRole('checkbox').count(), 0)
  assert.ok(await relayPrepare.isDisabled())
  assert.ok(await restore.isDisabled())
  checks.push(
    'fixed-origin Relay inspection is explicit, native cancellation returns no selectable metadata and no candidate or automatic root scan'
  )

  relayInspectStatus = 'inspected'
  await relayInspect.click()
  await relaySelection(0).waitFor()
  assert.equal(await relaySelection(0).isChecked(), false)
  assert.equal(await relaySelection(1).isChecked(), false)
  assert.ok(await relayPrepare.isDisabled())
  await relaySelection(0).check()
  await page.evaluate(() => window.__setBackupBusy(true, false))
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === '选择备份并检查'
      ).disabled
  )
  assert.equal(await relayInspect.isDisabled(), false)
  assert.equal(await relayOrigin.isDisabled(), false)
  assert.equal(await relaySelection(0).isDisabled(), false)
  assert.ok(await relayPrepare.isDisabled())
  assert.ok(await restore.isDisabled())
  const beforeReadonlyBusy = calls.length
  await page.evaluate(() => window.__setBackupBusy(true, true))
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === '只读检查旧Relay配置'
      ).disabled
  )
  assert.ok(await relayOrigin.isDisabled())
  assert.ok(await relaySelection(0).isDisabled())
  assert.equal(calls.length, beforeReadonlyBusy)
  await page.evaluate(() => window.__setBackupBusy(false, false))
  await waitRelayIdle()
  checks.push(
    'a narrow metadata busy prop permits stable-owner inspection and local selection while backup prepare/restore stay blocked; pending or unknown metadata state locks it without requests'
  )
  const restoreCallsBeforeCopy = calls.filter(
    ({ channel }) => channel === 'relayBackupRestore'
  ).length
  const selectedInspectionId = relayInspection.inspectionId
  await relayPrepare.click()
  await page.getByRole('status').filter({ hasText: '旧Relay副本候选已准备' }).waitFor()
  assert.deepEqual(calls.at(-1), {
    channel: 'relayBackupLegacyRelayPrepare',
    request: {
      inspectionId: selectedInspectionId,
      profiles: [
        {
          id: relayProfiles[0].id,
          sha256: relayProfiles[0].sha256,
          revision: relayProfiles[0].revision
        }
      ]
    }
  })
  assert.equal(
    calls.filter(({ channel }) => channel === 'relayBackupRestore').length,
    restoreCallsBeforeCopy
  )
  assert.equal(await page.getByRole('checkbox').count(), 0)
  await page.getByText('旧Relay配置副本报告', { exact: true }).click()
  await page.getByRole('cell', { name: relayProfiles[0].id, exact: true }).waitFor()
  assert.equal(await page.getByRole('cell', { name: relayProfiles[1].id, exact: true }).count(), 0)
  assert.equal(await page.getByText('旧Clash迁移检查报告', { exact: true }).count(), 0)
  const relayReportBody = await page.locator('body').innerText()
  for (const text of [
    '复制为新的未启用配置',
    '未搬走或清空旧根',
    '再次显式检查并复制',
    '没有自动去重',
    '原件归档摘要'
  ])
    assert.ok(relayReportBody.includes(text), text)
  assert.ok(!relayReportBody.includes('PRIVATE'))
  await restore.click()
  await page.getByRole('status').filter({ hasText: '本次操作已取消' }).waitFor()
  assert.deepEqual(calls.at(-1), {
    channel: 'relayBackupRestore',
    request: { id: 'legacy-relay-restore-proof' }
  })
  assert.ok(await restore.isDisabled())
  assert.equal(await page.getByText('旧Relay配置副本报告', { exact: true }).count(), 1)
  checks.push(
    'Relay subset preparation sends only inspected id/SHA/revision, consumes selection, distinguishes its new-ID report and requires a separate restore confirmation'
  )

  const heldInspection = Promise.withResolvers()
  relayInspectEntered = heldInspection.resolve
  holdRelayInspect = true
  await relayInspect.click()
  await deadline(heldInspection.promise, 'Relay inspection not entered')
  const inspectedCallsBeforeOrigin = calls.filter(
      ({ channel }) => channel === 'relayBackupLegacyRelayInspect'
    ).length,
    originCancel = Promise.withResolvers()
  nextCancelObserved = originCancel.resolve
  assert.ok(await relayOrigin.isDisabled())
  await relayOrigin.evaluate((select) => {
    select.value = 'Relay'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await deadline(originCancel.promise, 'origin Cancel not dispatched')
  nextCancelObserved = undefined
  assert.equal(await page.evaluate(() => window.__busyState), true)
  assert.ok(await relayInspect.isDisabled())
  finishRelayInspect()
  await waitRelayIdle()
  assert.equal(await relayOrigin.inputValue(), 'Relay')
  assert.equal(await page.getByRole('checkbox').count(), 0)
  assert.ok(await restore.isDisabled())
  assert.equal(
    calls.filter(({ channel }) => channel === 'relayBackupLegacyRelayInspect').length,
    inspectedCallsBeforeOrigin
  )
  checks.push(
    'an injected already-queued origin change is guarded even with the visible selector locked: Cancel keeps in-flight busy and its late response cannot repopulate metadata or auto-inspect'
  )

  await relayInspect.click()
  await relaySelection(1).waitFor()
  await relaySelection(1).check()
  const heldPreparation = Promise.withResolvers()
  relayPrepareEntered = heldPreparation.resolve
  holdRelayPrepare = true
  await relayPrepare.click()
  await deadline(heldPreparation.promise, 'Relay preparation not entered')
  const beforeRelayPreparationInvalidation = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  assert.equal(await page.evaluate(() => window.__busyState), true)
  assert.equal(calls.length, beforeRelayPreparationInvalidation)
  finishRelayPrepare()
  await waitRelayIdle()
  assert.ok(await restore.isDisabled())
  assert.equal(await page.getByText('旧Relay配置副本报告', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('checkbox').count(), 0)
  checks.push(
    'lifecycle invalidation clears Relay inspection, selected subset and copy report without issuing IPC or releasing entered preparation busy, and rejects late prepared replies'
  )

  const hiddenInspection = Promise.withResolvers()
  relayInspectEntered = hiddenInspection.resolve
  holdRelayInspect = true
  await relayInspect.click()
  await deadline(hiddenInspection.promise, 'hidden Relay inspection not entered')
  const beforeRelayInspectionInvalidation = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  assert.equal(calls.length, beforeRelayInspectionInvalidation)
  assert.equal(await page.evaluate(() => window.__busyState), true)
  finishRelayInspect()
  await waitRelayIdle()
  assert.equal(await page.getByRole('checkbox').count(), 0)
  assert.ok(await relayPrepare.isDisabled())
  checks.push(
    'a hidden or replaced renderer discards a late Relay inspection response without automatic retry or a stale selection'
  )

  expiredRelayInspection = true
  await relayInspect.click()
  await page.getByText('旧Relay检查已过期，请重新显式检查。', { exact: true }).waitFor()
  assert.ok(await relayPrepare.isDisabled())
  assert.ok(await relaySelection(0).isDisabled())
  const afterExpiredInspection = calls.length
  await waitRelayIdle()
  assert.equal(calls.length, afterExpiredInspection)
  expiredRelayInspection = false
  checks.push(
    'expired Relay metadata disables selection and preparation and asks for an explicit fresh check without automatic reread'
  )

  await relayInspect.click()
  await relaySelection(0).waitFor()
  await relaySelection(0).check()
  await ordinary.click()
  await page.getByRole('status').filter({ hasText: '备份完整性与当前数据基线已检查' }).waitFor()
  assert.equal(await page.getByRole('checkbox').count(), 0)
  await relayInspect.click()
  await relaySelection(0).waitFor()
  await relaySelection(0).check()
  const afterInspectBeforeCancel = calls.length,
    finalRelayCancel = Promise.withResolvers()
  nextCancelObserved = finalRelayCancel.resolve
  await relayCancel.click()
  await page.getByRole('status').filter({ hasText: '旧Relay检查或准备已撤销' }).waitFor()
  await deadline(finalRelayCancel.promise, 'Relay Cancel not observed')
  nextCancelObserved = undefined
  assert.equal(await page.getByRole('checkbox').count(), 0)
  assert.ok(await relayPrepare.isDisabled())
  assert.ok(await restore.isDisabled())
  assert.deepEqual(calls.slice(afterInspectBeforeCancel), [
    { channel: 'relayBackupCancel', request: undefined }
  ])
  checks.push(
    'ordinary restore preparation and explicit Relay cancellation clear old selections; cancellation sends only the shared Cancel channel and creates no writes or new preparation'
  )
  await relayInspect.click()
  await relaySelection(0).waitFor()
  failNextCancel = true
  const beforeRejectedCancel = calls.length
  await relayCancel.click()
  await page.getByRole('status').filter({ hasText: '后台撤销尚未确认' }).waitFor()
  assert.equal(await page.getByRole('checkbox').count(), 0)
  assert.ok(await restore.isDisabled())
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE'))
  assert.deepEqual(calls.slice(beforeRejectedCancel), [
    { channel: 'relayBackupCancel', request: undefined }
  ])
  checks.push(
    'failed cancellation keeps local Relay capabilities cleared, reports backend uncertainty without private error details and never retries or claims confirmed revocation'
  )
  const prepareRelayReport = async () => {
    await relayInspect.click()
    await relaySelection(0).waitFor()
    await relaySelection(0).check()
    await relayPrepare.click()
    await page.getByRole('status').filter({ hasText: '旧Relay副本候选已准备' }).waitFor()
    assert.equal(await page.getByText('旧Relay配置副本报告', { exact: true }).count(), 1)
  }
  await prepareRelayReport()
  await ordinary.click()
  await page.getByRole('status').filter({ hasText: '备份完整性与当前数据基线已检查' }).waitFor()
  assert.equal(await page.getByText('旧Relay配置副本报告', { exact: true }).count(), 0)
  assert.ok(
    (await page.locator('body').innerText()).includes(
      '白名单范围内未包含在备份中的文件将移出当前资料'
    )
  )
  await prepareRelayReport()
  await list.click()
  await page.getByRole('status').filter({ hasText: '已读取3条恢复记录' }).waitFor()
  await activeRecord.getByRole('button', { name: '核对回滚原件', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '记录与当前资料已核对' }).waitFor()
  assert.equal(await page.getByText('旧Relay配置副本报告', { exact: true }).count(), 0)
  assert.equal(await commit.isDisabled(), false)
  checks.push(
    'starting ordinary or recovery preparation removes the prior Relay migration report so it cannot describe another plan; a genuine restore terminal response can retain its report until a new preparation'
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])

  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-injected-browser-local-backup-recovery-and-legacy-migration',
    sourceSHA256: createHash('sha256')
      .update(await readFile('src/renderer/src/components/relay/backup-panel.tsx'))
      .digest('hex'),
    browserChecks: checks,
    passed: checks.length,
    nativeElectronWindowAccepted: false,
    actualRestoreExecuted: false,
    actualLegacyArchiveRead: false,
    actualUserFileWritten: false,
    externalRequests: blocked.length,
    systemNetworkChanged: false,
    coreLifecycleChanged: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/backup-recovery-ui-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
