import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the existing bundled Playwright and installed test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/remote-list-ui-'))
const calls = [],
  errors = [],
  checks = []
let browser,
  proof,
  downloadStatus = 'inspected',
  heldExecute,
  executeStarted
const report = {
  format: 'clash-party-legacy-zip',
  archiveSHA256: 'a'.repeat(64),
  containsSecrets: true,
  files: [
    {
      path: 'tasks.json',
      bytes: 8,
      sha256: 'b'.repeat(64),
      disposition: 'retained',
      reason: '旧任务仅留原件，不自动执行'
    }
  ],
  profiles: [],
  counts: {
    profiles: 0,
    sources: 0,
    overrides: 0,
    rulePatches: 0,
    applied: 0,
    retained: 1,
    'decision-required': 0
  },
  substore: {
    schema: '2.0',
    subscriptions: 0,
    collections: 0,
    items: [
      {
        kind: 'subscription',
        oldName: '基础定义',
        newName: 'relay-import-fixture',
        disposition: 'retained',
        reason: '基础定义缺少依赖，仅留原件'
      }
    ]
  }
}
const restorePlan = {
  id: 'local-raw-proof',
  baselineSHA256: 'a'.repeat(64),
  targetSHA256: 'b'.repeat(64),
  archiveSHA256: 'c'.repeat(64),
  files: 1,
  replacedFiles: 0,
  removedFiles: 0,
  containsSecrets: true,
  preparedAt: 1
}

try {
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {RelayRemoteBackupPanel} from './src/renderer/src/components/relay/backup-remote-panel';
    createRoot(document.getElementById('root')).render(React.createElement(RelayRemoteBackupPanel,{busy:false,onBusy:()=>{},onRestoreNotice:()=>{}}));`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    bundle: true,
    jsx: 'automatic',
    outfile: join(root, 'panel.js')
  })
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script src="panel.js"></script></body></html>'
  )
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    args: ['--allow-file-access-from-files', '--disable-background-networking']
  })
  const context = await Promise.race([
      browser.newContext(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('context timeout')), 15000))
    ]),
    allowed = pathToFileURL(root).href + '/'
  await context.route('**/*', (route) =>
    route.request().url().startsWith(allowed) ? route.continue() : route.abort()
  )
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__invoke', async (channel, request) => {
    calls.push({ channel, request })
    if (channel === 'relayBackupRemotePrepare') {
      if (request.provider === 'gist') {
        assert.equal(request.action, 'list')
        assert.equal(request.page, 2)
        assert.equal(request.token, 'fixture-token')
        assert.ok(!('secretKey' in request) && !('recipient' in request) && !('gistId' in request))
      }
      if (request.archiveFormat === 'legacy-zip')
        assert.ok(!('secretKey' in request) && !('recipient' in request))
      proof = {
        evidenceId: '00000000-0000-4000-8000-000000000037',
        provider: request.provider,
        action: request.action,
        ...(request.archiveFormat ? { archiveFormat: request.archiveFormat } : {}),
        endpoint: 'https://api.github.com/gists?per_page=100&page=2',
        proxyPort: request.proxyPort,
        encrypted: false,
        containsSecrets: false,
        expiresAt: Date.now() + 60000
      }
      return proof
    }
    if (channel === 'relayBackupRemoteCancel') {
      proof = undefined
      return
    }
    if (channel === 'relayBackupRemoteExecute') {
      assert.ok(proof)
      assert.equal(request.evidenceId, proof.evidenceId)
      const current = proof
      proof = undefined
      if (heldExecute) {
        executeStarted.resolve()
        await heldExecute.promise
      }
      if (current.provider === 'webdav') {
        if (current.action === 'list')
          return {
            status: 'listed',
            listing: {
              directoryURL: 'https://dav.invalid/Relay/',
              scanned: 1,
              entries: [
                {
                  url: 'https://dav.invalid/Relay/old.zip',
                  name: 'old.zip',
                  envelopeBytes: 128,
                  format: 'legacy-zip',
                  verified: false
                }
              ]
            }
          }
        if (current.archiveFormat !== 'legacy-zip')
          throw new Error('PRIVATE invalid modern envelope')
        if (downloadStatus === 'cancelled') return { status: 'cancelled' }
        return {
          status: downloadStatus,
          report,
          migrationId: 'migration-fixture',
          ...(downloadStatus === 'prepared' ? { plan: restorePlan } : {})
        }
      }
      return {
        status: 'listed',
        listing: {
          page: 2,
          nextPage: 3,
          scanned: 5,
          entries: [
            {
              id: 'a'.repeat(32),
              updatedAt: '2026-10-28T12:00:00Z',
              envelopeBytes: 1024,
              verified: false
            }
          ]
        }
      }
    }
    if (channel === 'relayBackupCancel') return
    if (channel === 'relayBackupRestore') {
      assert.deepEqual(request, { id: 'local-raw-proof' })
      return { status: 'restored' }
    }
    throw new Error('Unexpected capability: ' + channel)
  })
  await page.addInitScript(() => {
    const listeners = new Map()
    window.__invalidateBackup = () =>
      listeners.get('relayBackupPreparationsInvalidated')?.forEach((fn) => fn())
    window.electron = {
      ipcRenderer: {
        invoke: (...args) => window.__invoke(...args),
        on(channel, fn) {
          const set = listeners.get(channel) ?? new Set()
          set.add(fn)
          listeners.set(channel, set)
          return () => set.delete(fn)
        }
      }
    }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  await page.getByRole('heading', { name: 'WebDAV／Gist远程备份' }).waitFor()
  assert.equal(calls.length, 0)
  await page.getByLabel(/^提供者/u).selectOption('gist')
  await page.getByLabel(/^操作/u).selectOption('list')
  await page.getByLabel(/^本次列表页码/u).fill('2')
  await page.getByLabel(/^本次GitHub Token/u).fill('fixture-token')
  assert.equal(await page.getByLabel(/^本次AGE私钥/u).count(), 0)
  await page.getByRole('button', { name: '准备本次远程备份', exact: true }).click()
  await page.getByRole('button', { name: '确认远程传输', exact: true }).waitFor()
  assert.equal(await page.getByLabel(/^本次GitHub Token/u).inputValue(), '')
  checks.push(
    'list preparation omits archive keys, clears the token and awaits separate confirmation'
  )
  await page.getByLabel(/^本地HTTP代理端口/u).fill('17892')
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')].some(
        (button) => button.textContent === '确认远程传输'
      )
  )
  assert.ok(calls.some((call) => call.channel === 'relayBackupRemoteCancel'))
  assert.equal(calls.filter((call) => call.channel === 'relayBackupRemoteExecute').length, 0)
  checks.push('editing form inputs invalidates the old plan without sending a transfer')
  await page.getByLabel(/^本次GitHub Token/u).fill('fixture-token')
  await page.getByRole('button', { name: '准备本次远程备份', exact: true }).click()
  await page.getByRole('button', { name: '确认远程传输', exact: true }).click()
  await page.getByRole('button', { name: '选择该ID准备下载', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '单独确认恢复', exact: true }).count(), 0)
  checks.push('listing exposes unverified metadata and a next page, without preparing a restore')
  await page.getByRole('button', { name: '选择该ID准备下载', exact: true }).click()
  assert.equal(await page.getByLabel(/^指定Gist ID/u).inputValue(), 'a'.repeat(32))
  assert.equal(await page.getByLabel(/^操作/u).inputValue(), 'download')
  assert.equal(await page.getByLabel(/^本次AGE私钥/u).count(), 1)
  assert.equal(calls.filter((call) => call.channel === 'relayBackupRemoteExecute').length, 1)
  assert.ok(
    calls
      .filter((call) => call.channel === 'relayBackupRemotePrepare')
      .every((call) => call.request.action === 'list')
  )
  checks.push(
    'choosing a candidate only fills its ID; download and restore remain separate actions'
  )

  await page.getByLabel(/^提供者/u).selectOption('webdav')
  await page.getByLabel(/^操作/u).selectOption('download')
  assert.equal(
    await page.getByLabel('下载归档格式', { exact: true }).inputValue(),
    'relay-envelope'
  )
  await page.getByLabel(/^本次AGE私钥/u).fill('AGE-SECRET-KEY-fixture')
  await page.getByLabel('下载归档格式', { exact: true }).selectOption('legacy-zip')
  assert.equal(await page.getByLabel(/^本次AGE私钥/u).count(), 0)
  assert.equal(
    await page
      .getByText('列表只读取元数据，无需AGE私钥。每次需重新输入凭据并确认。', { exact: true })
      .count(),
    0
  )
  assert.equal(
    await page.getByRole('button', { name: '生成新AGE密钥并导出私钥', exact: true }).count(),
    0
  )
  await page
    .getByLabel('HTTPS指定文件地址', { exact: true })
    .fill('https://dav.invalid/Relay/old.zip')
  const prepare = page.getByRole('button', { name: '准备本次远程备份', exact: true }),
    execute = page.getByRole('button', { name: '确认远程传输', exact: true })
  const credentials = async () => {
    await page.getByLabel('本次用户名', { exact: true }).fill('fixture-user')
    await page.getByLabel('本次密码', { exact: true }).fill('fixture-password')
  }
  await credentials()
  await prepare.click()
  await execute.waitFor()
  assert.equal(calls.at(-1).request.archiveFormat, 'legacy-zip')
  assert.ok(!('secretKey' in calls.at(-1).request) && !('recipient' in calls.at(-1).request))
  downloadStatus = 'cancelled'
  await execute.click()
  await page.getByRole('status').filter({ hasText: '本次远程传输已取消' }).waitFor()
  assert.equal(await page.getByText('旧Clash迁移检查报告', { exact: true }).count(), 0)
  assert.equal(calls.filter((x) => x.channel === 'relayBackupRestore').length, 0)
  checks.push(
    'explicit raw format clears AGE inputs, omits both AGE keys and respects cancelled transfer without restoring'
  )
  downloadStatus = 'inspected'
  await credentials()
  await prepare.click()
  await execute.click()
  await page.getByText('旧Clash迁移检查报告', { exact: true }).waitFor()
  await page.getByText('本次迁移原件记录：migration-fixture', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '单独确认恢复', exact: true }).count(), 0)
  await page.getByText('旧Clash迁移检查报告', { exact: true }).click()
  assert.ok((await page.locator('body').innerText()).includes('旧任务仅留原件'))
  assert.ok((await page.locator('body').innerText()).includes('noFlow=true'))
  checks.push(
    'an inspected raw ZIP with zero profile candidates still exposes the sanitized partial report and retained original record, without a restore action'
  )
  report.substore.subscriptions = 1
  report.substore.items[0].disposition = 'accepted'
  report.substore.items[0].reason = 'noFlow默认关闭'
  report.counts.applied = 1
  downloadStatus = 'prepared'
  await credentials()
  await prepare.click()
  await execute.click()
  await page.getByRole('button', { name: '单独确认恢复', exact: true }).waitFor()
  assert.equal(calls.filter((x) => x.channel === 'relayBackupRestore').length, 0)
  await page.getByRole('button', { name: '单独确认恢复', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '私有数据恢复完成' }).waitFor()
  assert.equal(calls.filter((x) => x.channel === 'relayBackupRestore').length, 1)
  assert.equal(await page.getByText('旧Clash迁移检查报告', { exact: true }).count(), 1)
  checks.push(
    'a raw candidate reuses the separate local restore confirmation and keeps its neutral migration report after the terminal result'
  )
  await page.getByLabel(/^操作/u).selectOption('list')
  await page.getByLabel('HTTPS指定目录地址', { exact: true }).fill('https://dav.invalid/Relay/')
  await credentials()
  await prepare.click()
  await execute.click()
  await page.getByRole('button', { name: '选择该文件准备下载', exact: true }).click()
  assert.equal(await page.getByLabel('下载归档格式', { exact: true }).inputValue(), 'legacy-zip')
  assert.equal(await page.getByLabel(/^本次AGE私钥/u).count(), 0)
  checks.push(
    'an unverified legacy ZIP directory row is selectable and explicitly binds raw format without fetching its body'
  )
  await credentials()
  await prepare.click()
  heldExecute = Promise.withResolvers()
  executeStarted = Promise.withResolvers()
  await execute.click()
  await executeStarted.promise
  await page.evaluate(() => window.__invalidateBackup())
  heldExecute.resolve()
  heldExecute = undefined
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')]
        .find((x) => x.textContent === '准备本次远程备份')
        .matches(':disabled')
  )
  assert.equal(await page.getByText('旧Clash迁移检查报告', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '单独确认恢复', exact: true }).count(), 0)
  assert.equal(
    await page.getByLabel('下载归档格式', { exact: true }).inputValue(),
    'relay-envelope'
  )
  assert.equal(await page.getByLabel(/^本次AGE私钥/u).inputValue(), '')
  checks.push(
    'memory invalidation rejects a late raw inspection/report/restore plan, resets format and keeps pending busy until the transfer finally returns'
  )

  const beforeModernFailure = calls.filter(
    (call) => call.channel === 'relayBackupRemotePrepare'
  ).length
  await credentials()
  await prepare.click()
  await execute.click()
  await page.getByRole('status').filter({ hasText: '操作未确认' }).waitFor()
  assert.equal(
    calls.filter((call) => call.channel === 'relayBackupRemotePrepare').length,
    beforeModernFailure + 1
  )
  assert.equal(
    calls.filter((call) => call.channel === 'relayBackupRemotePrepare').at(-1).request
      .archiveFormat,
    'relay-envelope'
  )
  assert.equal(
    await page.getByLabel('下载归档格式', { exact: true }).inputValue(),
    'relay-envelope'
  )
  assert.equal(await page.getByText('旧Clash迁移检查报告', { exact: true }).count(), 0)
  assert.equal(calls.filter((call) => call.channel === 'relayBackupRestore').length, 1)
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE'))
  checks.push(
    'a failed modern envelope stays modern with a generic error, never resubmits as raw ZIP or exposes a stale migration report'
  )
  assert.deepEqual(errors, [])
  const result = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-browser-with-injected-backup-ipc',
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          'src/renderer/src/components/relay/backup-remote-panel.tsx',
          'src/renderer/src/components/relay/backup-panel.tsx',
          'src/shared/relay/backup-remote.ts',
          'scripts/relay/test-remote-list-ui.mjs'
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
    actualGitHubAccountAccepted: false,
    remoteWrites: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    process.env.RELAY_UI_VERIFICATION_OUTPUT ?? '../evidence/gist-list-verification.json',
    JSON.stringify(result, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
