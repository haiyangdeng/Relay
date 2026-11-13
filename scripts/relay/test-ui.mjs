import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

// Optional test: use an authorized test browser, never to bypass an App access denial.
if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME) {
  throw new Error('Set RELAY_PLAYWRIGHT_MODULE and RELAY_CHROME for an authorized UI test.')
}
const { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href)
const fixtures = JSON.parse(readFileSync('../evidence/preview-fixtures.json', 'utf8'))
const root = resolve('out/renderer')
const browser = await chromium.launch({
  executablePath: process.env.RELAY_CHROME,
  headless: true,
  args: [
    '--allow-file-access-from-files',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-crash-reporter'
  ]
})
const context = await browser.newContext({
  viewport: { width: 1180, height: 1000 },
  locale: 'zh-CN'
})
let blocked = 0
await context.route('**/*', (route) => {
  const url = route.request().url()
  if (
    url.startsWith(pathToFileURL(root).href + '/') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  )
    return route.continue()
  blocked++
  return route.abort()
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.exposeFunction('__relayTestInvoke', async (channel, input) => {
  if (channel === 'relayStatus')
    return {
      name: 'Relay',
      version: '2.0.0-dev.3',
      upstream: 'Clash Party v2.0.4',
      mode: 'preview',
      coreRunning: false,
      networkChangesAllowed: false,
      nativeReady: true,
      guardEnabled: false
    }
  if (channel === 'relayPreview')
    return JSON.parse(
      execFileSync(resolve('extra/relay/RelayNative'), ['--preview'], {
        input: JSON.stringify(input),
        encoding: 'utf8',
        timeout: 10000
      })
    )
  if (channel in fixtures) return fixtures[channel]
  if (['applyTheme', 'setNativeTheme'].includes(channel)) return undefined
  throw new Error('Preview action refused')
})
await page.addInitScript(() => {
  window.electron = {
    process: { platform: 'darwin' },
    ipcRenderer: {
      invoke: (...args) => window.__relayTestInvoke(...args),
      send: () => {},
      on: () => () => {},
      removeListener: () => {},
      removeAllListeners: () => {}
    }
  }
  window.api = { webUtils: {} }
})
try {
  await page.goto(pathToFileURL(resolve('out/renderer/index.html')).href + '#/relay')
  await page.getByRole('heading', { name: 'Relay', exact: true }).waitFor({ timeout: 20000 })
  await page.getByLabel('现有节点名称').fill('fixture-node')
  await page.getByLabel('内网直连例外').fill('git.corp,10.10.0.5')
  await page
    .getByLabel('已有 settings.json 草稿')
    .fill('{"env":{"CUSTOM":"keep","NO_PROXY":".com,.ai,*:443"}}')
  await page.getByRole('button', { name: '生成配置预览', exact: true }).click()
  const output = page.getByLabel('生成的配置草稿')
  await output.waitFor({ timeout: 15000 })
  const json = JSON.parse(await output.inputValue())
  if (json.env.CUSTOM !== 'keep' || json.env.NO_PROXY.includes('.com'))
    throw new Error('UI preview merge mismatch')
  await page.getByRole('button', { name: 'Clash plan', exact: true }).click()
  if (!(await output.inputValue()).includes('DOMAIN-SUFFIX,anthropic.com,fixture-node'))
    throw new Error('UI plan mismatch')
  await page.screenshot({ path: '../evidence/Relay-preview.png', fullPage: true })
  const result = {
    passed: true,
    checks: [
      'Initial Relay page',
      'Native preview interaction',
      'Preserved custom env',
      'Removed broad bypass',
      'Clash plan tab'
    ],
    pageErrors: errors,
    blockedRemoteRequests: blocked,
    scope:
      'Headless browser with fixture IPC and actual native preview executable. Not an Electron application launch or real network/client test.'
  }
  if (errors.length) throw new Error(JSON.stringify(errors))
  writeFileSync('../evidence/ui-test.json', JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await context.close()
  await browser.close()
}
