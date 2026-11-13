import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the bundled Playwright and existing test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const root = await mkdtemp(resolve('.relay-build/runtime-gist-ui-'))
const calls = [],
  checks = [],
  errors = [],
  blocked = [],
  gistId = 'a'.repeat(32),
  recipient = 'age1-fixture-recipient',
  uploadedURL = `https://gist.github.com/${gistId}`,
  executeStarted = Promise.withResolvers()
let browser,
  resultStatus = 'uncertain',
  holdExecute = false,
  failPrepare = false,
  finishExecute,
  holdPrepare = false,
  prepareStarted,
  finishPrepare
try {
  await build({
    stdin: {
      contents: `import React,{useState,useEffect} from 'react'; import {createRoot} from 'react-dom/client';
    import {RelayRuntimeGistPanel} from './src/renderer/src/components/relay/runtime-gist-panel';
    function App(){const[session,setSession]=useState('11111111-1111-4111-8111-111111111111');useEffect(()=>{window.__setTunSession=setSession},[]);return <RelayRuntimeGistPanel busy={false} onBusy={()=>{}} tunSessionId={session}/>};createRoot(document.getElementById('root')).render(<App/>);`,
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
  const context = await browser.newContext(),
    allowed = pathToFileURL(root).href + '/'
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(allowed)) return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__invoke', async (channel, request) => {
    calls.push({ channel, request })
    if (channel === 'relayRuntimeGistCancel') {
      assert.equal(request, undefined)
      return
    }
    if (channel === 'relayRuntimeGistPrepare') {
      assert.equal(request.token, 'PRIVATE-fixture-token')
      assert.equal(request.proxyPort, 18191)
      if (failPrepare) throw new Error('PRIVATE-token-and-configuration-path')
      if (holdPrepare) {
        prepareStarted.resolve()
        await new Promise((resolve) => {
          finishPrepare = resolve
        })
      }
      if (request.gistId) assert.equal(request.gistId, gistId)
      if (request.recipient) assert.equal(request.recipient, recipient)
      return {
        evidenceId: 'runtime-gist-proof',
        action: request.gistId ? 'update' : 'create',
        endpoint: `https://api.github.com/gists${request.gistId ? `/${gistId}` : ''}`,
        filename: 'clash-party.yaml',
        ...(request.gistId ? { gistId } : {}),
        proxyPort: request.proxyPort,
        encrypted: !!request.recipient,
        containsSecrets: true,
        ...(request.source ? { source: request.source } : {}),
        instanceId: request.source?.sessionId ?? 'owned-fixture-instance',
        configurationRevision: 'r'.repeat(64),
        configurationSHA256: 'c'.repeat(64),
        configurationBytes: 128,
        payloadSHA256: 'd'.repeat(64),
        payloadBytes: 256,
        expiresAt: Date.now() + 60000
      }
    }
    assert.equal(channel, 'relayRuntimeGistExecute')
    assert.deepEqual(request, { evidenceId: 'runtime-gist-proof' })
    if (holdExecute) {
      return new Promise((resolve) => {
        finishExecute = resolve
        executeStarted.resolve()
      })
    }
    return { status: resultStatus, gistId, url: uploadedURL }
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
  await page.getByRole('heading', { name: '运行配置同步到Gist', exact: true }).waitFor()
  const token = page.getByLabel('本次GitHub Token'),
    port = page.getByLabel('本地HTTP代理端口'),
    target = page.getByLabel('目标Gist ID（留空新建）'),
    encryption = page.getByLabel('AGE接收者（可选）'),
    prepare = page.getByRole('button', { name: '准备本次运行配置上传', exact: true }),
    execute = page.getByRole('button', { name: '发起本次上传确认', exact: true }),
    cancel = page.getByRole('button', { name: '取消本次上传准备', exact: true }),
    uploadedAddress = page.getByLabel('已核对的Gist地址（可选中复制）')
  assert.equal(calls.length, 0)
  assert.ok(await prepare.isDisabled())
  assert.ok(await execute.isDisabled())
  await token.fill('PRIVATE-fixture-token')
  await port.fill('18191')
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '已准备当前运行配置的副本' }).waitFor()
  assert.equal(await token.inputValue(), '')
  assert.deepEqual(calls[0], {
    channel: 'relayRuntimeGistPrepare',
    request: { token: 'PRIVATE-fixture-token', proxyPort: 18191 }
  })
  const plaintext = await page.locator('body').innerText()
  assert.ok(plaintext.includes('将创建新的非公开Gist'))
  assert.ok(plaintext.includes('敏感明文上传'))
  assert.ok(plaintext.includes('c'.repeat(64)))
  assert.ok(plaintext.includes('d'.repeat(64)))
  assert.equal(calls.filter((call) => call.channel === 'relayRuntimeGistExecute').length, 0)
  checks.push(
    'initial UI is inert and explicit preparation clears Token while disclosing plaintext creation and both digests'
  )

  await cancel.click()
  await page.getByRole('status').filter({ hasText: '已取消本次准备' }).waitFor()
  assert.ok(await execute.isDisabled())
  assert.equal(await uploadedAddress.count(), 0)
  await token.fill('PRIVATE-fixture-token')
  await target.fill(gistId)
  await encryption.fill(recipient)
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '已准备当前运行配置的副本' }).waitFor()
  assert.deepEqual(calls.at(-1), {
    channel: 'relayRuntimeGistPrepare',
    request: { token: 'PRIVATE-fixture-token', proxyPort: 18191, gistId, recipient }
  })
  const encrypted = await page.locator('body').innerText()
  assert.ok(encrypted.includes(`将更新Gist ${gistId}`))
  assert.ok(encrypted.includes('目标文件内容会被替换'))
  assert.ok(encrypted.includes('AGE加密上传'))
  await port.fill('18192')
  await page.getByRole('status').filter({ hasText: '输入已更改' }).waitFor()
  assert.ok(await execute.isDisabled())
  assert.equal(calls.at(-1).channel, 'relayRuntimeGistCancel')
  checks.push(
    'cancellation and any field edit revoke the old proof; encrypted updates identify the overwritten file'
  )

  await port.fill('18191')
  await token.fill('PRIVATE-fixture-token')
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '已准备当前运行配置的副本' }).waitFor()
  await execute.click()
  await page.getByRole('status').filter({ hasText: '上传结果未确认' }).waitFor()
  assert.equal(await uploadedAddress.count(), 0)
  assert.ok(await execute.isDisabled())
  resultStatus = 'cancelled'
  await token.fill('PRIVATE-fixture-token')
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '已准备当前运行配置的副本' }).waitFor()
  await execute.click()
  await page.getByRole('status').filter({ hasText: '本次上传已取消' }).waitFor()
  assert.equal(await uploadedAddress.count(), 0)
  assert.ok(await execute.isDisabled())
  checks.push(
    'uncertain and cancelled transfers consume their proof without publishing a successful Gist address or retrying'
  )

  await token.fill('PRIVATE-fixture-token')
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '已准备当前运行配置的副本' }).waitFor()
  holdExecute = true
  await execute.click()
  const timeout = setTimeout(
    () => executeStarted.reject(new Error('execute adapter not entered')),
    5000
  )
  try {
    await executeStarted.promise
  } finally {
    clearTimeout(timeout)
  }
  assert.ok(
    await page
      .locator('input,button')
      .evaluateAll((items) => items.every((item) => item.matches(':disabled')))
  )
  finishExecute({ status: 'uploaded', gistId, url: uploadedURL })
  await page.getByRole('status').filter({ hasText: '运行配置副本已上传并核对' }).waitFor()
  assert.equal(await uploadedAddress.inputValue(), uploadedURL)
  assert.equal(await uploadedAddress.getAttribute('readonly'), '')
  assert.equal(await page.getByRole('link').count(), 0)
  assert.equal(await token.isDisabled(), false)
  checks.push(
    'an in-flight upload locks every control and only verified uploaded results expose a readonly copyable Gist address without external navigation'
  )

  failPrepare = true
  await token.fill('PRIVATE-fixture-token')
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '操作未确认' }).waitFor()
  assert.equal(await token.inputValue(), '')
  assert.ok(await execute.isDisabled())
  assert.equal(await uploadedAddress.count(), 0)
  assert.ok(
    !(await page.locator('body').innerText()).includes('PRIVATE-token-and-configuration-path')
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  checks.push(
    'failed preparation clears credentials and stale success/proof without leaking private errors'
  )

  failPrepare = false
  holdPrepare = true
  prepareStarted = Promise.withResolvers()
  await token.fill('PRIVATE-fixture-token')
  await prepare.click()
  const prepareTimeout = setTimeout(
    () => prepareStarted.reject(new Error('held prepare not entered')),
    5000
  )
  try {
    await prepareStarted.promise
  } finally {
    clearTimeout(prepareTimeout)
  }
  const beforeInvalidation = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  await page.waitForFunction(() => document.querySelector('input[type="password"]')?.value === '')
  assert.equal(await token.inputValue(), '')
  assert.ok(await token.isDisabled())
  holdPrepare = false
  finishPrepare()
  await page.waitForFunction(
    () => !document.querySelector('input[type="password"]')?.matches(':disabled')
  )
  assert.equal(calls.length, beforeInvalidation)
  assert.ok(await execute.isDisabled())
  assert.equal(await uploadedAddress.count(), 0)
  await token.fill('PRIVATE-fixture-token')
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '已准备当前运行配置的副本' }).waitFor()
  const beforeIdleInvalidation = calls.length
  await page.evaluate(() => window.__invalidateBackup())
  await page.getByRole('status').filter({ hasText: '运行配置上传准备已撤销' }).waitFor()
  assert.equal(calls.length, beforeIdleInvalidation)
  assert.ok(await execute.isDisabled())
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  checks.push(
    'main-process invalidation clears secrets and passive upload proofs, ignores late preparation results, preserves in-flight busy until completion and sends no Cancel IPC'
  )

  const sourceSelector = page.getByLabel('本次运行配置来源', { exact: true }),
    tunSource = { kind: 'tun-managed', sessionId: '11111111-1111-4111-8111-111111111111' }
  await sourceSelector.selectOption('tun-managed')
  await token.fill('PRIVATE-fixture-token')
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '已准备当前运行配置的副本' }).waitFor()
  assert.deepEqual(
    calls.filter((call) => call.channel === 'relayRuntimeGistPrepare').at(-1).request.source,
    tunSource
  )
  assert.ok((await page.locator('body').innerText()).includes('托管TUN会话 ' + tunSource.sessionId))
  assert.ok((await page.locator('body').innerText()).includes('不是核心内存全量导出'))
  const beforeSessionLoss = calls.length
  await page.evaluate(() => window.__setTunSession('22222222-2222-4222-8222-222222222222'))
  await page.getByText('所选会话已失效', { exact: false }).waitFor()
  assert.ok(await prepare.isDisabled())
  assert.equal(await sourceSelector.inputValue(), 'tun-managed')
  assert.ok(await execute.isDisabled())
  assert.equal(calls.length, beforeSessionLoss)
  await sourceSelector.selectOption('local-proxy')
  await token.fill('PRIVATE-fixture-token')
  await prepare.click()
  await page.getByRole('status').filter({ hasText: '已准备当前运行配置的副本' }).waitFor()
  assert.ok(
    !('source' in calls.filter((call) => call.channel === 'relayRuntimeGistPrepare').at(-1).request)
  )
  checks.push(
    'explicit TUN preparation pins its session metadata and explains loaded-body provenance; session replacement disables new preparation without automatic fallback or IPC, and an explicit local selection preserves the old request shape'
  )

  const proof = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-injected-browser-runtime-Gist-upload',
    sourceSHA256: createHash('sha256')
      .update(await readFile('src/renderer/src/components/relay/runtime-gist-panel.tsx'))
      .digest('hex'),
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          'src/renderer/src/components/relay/runtime-gist-panel.tsx',
          'src/renderer/src/components/relay/runtime-gist-source.tsx',
          'src/shared/relay/runtime-gist.ts'
        ].map(async (path) => [
          path,
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex')
        ])
      )
    ),
    browserChecks: checks,
    passed: checks.length,
    nativeElectronWindowAccepted: false,
    actualGitHubRequested: false,
    actualUserFileWritten: false,
    externalRequests: blocked.length,
    systemNetworkChanged: false,
    coreLifecycleChanged: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/runtime-gist-ui-verification.json',
    JSON.stringify(proof, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
