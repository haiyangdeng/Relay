import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use the existing bundled Playwright and installed test browser.')
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const base = JSON.parse(await readFile('src/main/relay/core/manifest.json', 'utf8'))
const extra = JSON.parse(await readFile('src/main/relay/core/variants-manifest.json', 'utf8'))
const pins = [base, ...extra.cores].flatMap((core) =>
  ['arm64', 'x64'].map((architecture) => ({
    kind: 'core',
    architecture,
    version: core.version,
    sha256: core.assets[architecture].sha256,
    size: core.assets[architecture].size
  }))
)
const models = extra.models.map(({ version, sha256, size }) => ({
  kind: 'smart',
  version,
  sha256,
  size
}))
const root = await mkdtemp(resolve('.relay-build/variant-ui-'))
const calls = [],
  errors = []
let browser
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {RelayVariantsPanel} from './src/renderer/src/components/relay/variants-panel';
      createRoot(document.getElementById('root')).render(React.createElement(RelayVariantsPanel,{busy:false,onBusy:()=>{}}));`,
      resolveDir: process.cwd(),
      loader: 'tsx'
    },
    bundle: true,
    jsx: 'automatic',
    outfile: join(root, 'panel.js')
  })
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html lang="zh-CN"><body><div id="root"></div><script src="panel.js"></script></body></html>'
  )
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    args: ['--allow-file-access-from-files', '--disable-background-networking']
  })
  const context = await browser.newContext()
  const allowed = pathToFileURL(root).href + '/'
  await context.route('**/*', (route) =>
    route.request().url().startsWith(allowed) ? route.continue() : route.abort()
  )
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.exposeFunction('__invoke', async (channel, value) => {
    calls.push({ channel, value })
    if (channel === 'relayVariantState')
      return {
        records: [],
        activeCoreId: undefined,
        activeSmartId: undefined,
        pinnedDefault: true,
        pending: false,
        trustedCoreVersion: base.version,
        hostArchitecture: 'arm64',
        trustedCoreImports: pins,
        trustedSmartImports: models,
        smartRuntimeSupported: true,
        networkDownloadSupported: false
      }
    if (channel === 'relayVariantPrepare') return { ...value, expiresAt: Date.now() + 60000 }
    throw new Error('Unexpected IPC: ' + channel)
  })
  await page.addInitScript(() => {
    window.electron = { ipcRenderer: { invoke: (...args) => window.__invoke(...args) } }
  })
  await page.goto(pathToFileURL(join(root, 'index.html')).href)
  await page.getByRole('heading', { name: '核心与Smart资源' }).waitFor()
  assert.equal(calls.length, 0)
  await page.getByRole('button', { name: '读取资源与可信清单' }).click()
  await page.getByText('已读取私有资源及可信核心清单。', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('可信核心版本').inputValue(), base.version)
  for (const pin of pins) {
    await page.getByLabel('可信核心版本').selectOption(pin.version)
    await page.getByLabel(/^架构/u).selectOption(pin.architecture)
    assert.equal(await page.getByRole('button', { name: '确认复制并校验…' }).isDisabled(), true)
    await page.getByRole('button', { name: '选择文件并准备导入…' }).click()
    await page.getByRole('status').filter({ hasText: '文件已选择' }).waitFor()
    assert.deepEqual(calls.at(-1), { channel: 'relayVariantPrepare', value: pin })
    assert.equal(await page.getByRole('button', { name: '确认复制并校验…' }).isEnabled(), true)
  }
  await page.getByLabel('资源类型').selectOption('smart')
  for (const pin of models) {
    await page.getByLabel('可信模型版本').selectOption(pin.version)
    await page.getByRole('button', { name: '选择文件并准备导入…' }).click()
    await page.getByRole('status').filter({ hasText: '文件已选择' }).waitFor()
    assert.deepEqual(calls.at(-1), { channel: 'relayVariantPrepare', value: pin })
  }
  assert.deepEqual(errors, [])
  const result = {
    verifiedAt: new Date().toISOString(),
    scope: 'isolated-browser-with-injected-ipc',
    checkedChoices: pins.map(({ version, architecture }) => ({ version, architecture })),
    passed: pins.length + models.length,
    checkedModels: models.map((pin) => pin.version),
    noAutomaticIPC: true,
    exactMetadata: true,
    planInvalidatedOnChoiceChange: true,
    realFilePickerAccepted: false,
    productAcceptance: 'pending'
  }
  await writeFile(
    '../evidence/variant-catalog-ui-verification.json',
    JSON.stringify(result, null, 2) + '\n'
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
