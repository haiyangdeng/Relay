import { existsSync } from 'fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { createServer } from 'http'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { expect, it } from 'vitest'
import { SubStoreResources } from '../substore/resources'
import { startSubStoreRuntime, type SubStoreRuntime } from '../substore/runtime'
import { convertLegacySubStore } from './legacy-substore'

interface BrowserRequest {
  url(): string
}
interface FixtureRoute {
  request(): BrowserRequest
  continue(): Promise<void>
  abort(): Promise<void>
}
interface FixturePage {
  on(event: 'request', callback: (request: BrowserRequest) => void): void
  on(event: 'pageerror', callback: (error: Error) => void): void
  locator(selector: string): { innerText(): Promise<string> }
  goto(url: string, options: { waitUntil: 'networkidle'; timeout: number }): Promise<unknown>
  waitForTimeout(milliseconds: number): Promise<void>
}
interface FixtureContext {
  route(pattern: string, callback: (route: FixtureRoute) => Promise<void>): Promise<void>
  newPage(): Promise<FixturePage>
  close(): Promise<void>
}
interface FixtureBrowser {
  newContext(options: { serviceWorkers: 'block' }): Promise<FixtureContext>
  close(): Promise<void>
}
interface FixturePlaywright {
  chromium: {
    launch(options: {
      executablePath: string
      headless: boolean
      args: string[]
    }): Promise<FixtureBrowser>
  }
}
const references = join(process.cwd(), '.relay-build/substore-reference'),
  playwright = process.env.RELAY_PLAYWRIGHT_MODULE,
  chrome = process.env.RELAY_CHROME,
  available =
    process.platform === 'darwin' &&
    !!playwright &&
    !!chrome &&
    existsSync(playwright) &&
    existsSync(chrome) &&
    existsSync(join(references, 'sub-store.bundle.js')) &&
    existsSync(join(references, 'dist.zip'))

it.skipIf(!available)(
  'loads migrated definitions in the fixed sandboxed backend and frontend without automatic flow, task or subscription requests',
  async () => {
    if (!playwright || !chrome) throw new Error('Missing isolated browser fixture')
    const home = await realpath(await mkdtemp('/private/tmp/relay-legacy-substore-runtime-')),
      resources = new SubStoreResources(join(home, 'Library/Application Support/Relay')),
      signal = new AbortController().signal,
      proxy = createServer((_request, response) => {
        proxyRequests++
        response.writeHead(503)
        response.end('Fixture never forwards any request')
      })
    let proxyRequests = 0,
      cleanup: (() => Promise<void>) | undefined,
      runtime: SubStoreRuntime | undefined,
      browser: FixtureBrowser | undefined,
      context: FixtureContext | undefined,
      proof: Record<string, unknown> | undefined,
      failure: Error | undefined
    proxy.on('connect', (_request, socket) => {
      proxyRequests++
      socket.end('HTTP/1.1 503 Fixture does not forward\r\n\r\n')
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    if (!address || typeof address !== 'object') throw new Error('Missing owned fixture port')
    try {
      await resources.install(
        await readFile(join(references, 'sub-store.bundle.js')),
        await readFile(join(references, 'dist.zip')),
        signal
      )
      const converted = convertLegacySubStore(
        Buffer.from(
          JSON.stringify({
            schemaVersion: '2.0',
            subs: [
              {
                name: 'Migrated local',
                source: 'local',
                content: 'http://u:p@127.0.0.1:1234#Fixture'
              },
              {
                name: 'Migrated remote',
                source: 'remote',
                url: 'https://migration.invalid/private'
              }
            ],
            collections: [
              { name: 'Migrated collection', subscriptions: ['Migrated local', 'Migrated remote'] }
            ],
            artifacts: [
              {
                name: 'old-auto-job',
                type: 'subscription',
                source: 'Migrated remote',
                sync: true,
                cron: '* * * * * *'
              }
            ],
            settings: { autoDownload: true },
            tokens: [{ token: 'PRIVATE-OLD-TOKEN' }]
          })
        )
      )
      if (!converted.bytes) throw new Error('Missing eligible imported definitions')
      await writeFile(join(resources.dataRoot, 'sub-store.json'), converted.bytes, {
        mode: 0o600,
        flag: 'wx'
      })
      runtime = await startSubStoreRuntime({
        resources,
        dependencyRoot: join(process.cwd(), 'node_modules'),
        proxyPort: address.port,
        signal,
        registerCleanup: (stop) => {
          cleanup = stop
        }
      })
      const inventory = JSON.parse(await runtime.request('/api/subs', signal)) as {
        data: { name: string; displayName: string; noFlow: boolean }[]
      }
      expect(inventory.data).toHaveLength(2)
      expect(inventory.data.every((item) => item.noFlow)).toBe(true)
      expect(proxyRequests).toBe(0)
      const beforeFrontend = JSON.parse(
        await readFile(join(resources.dataRoot, 'sub-store.json'), 'utf8')
      )
      expect(beforeFrontend.settings).toEqual({})
      const module = (await import(
        /* @vite-ignore */ pathToFileURL(playwright).href
      )) as FixturePlaywright
      browser = await module.chromium.launch({
        executablePath: chrome,
        headless: true,
        args: [
          '--disable-background-networking',
          '--no-first-run',
          '--disable-component-update',
          '--disable-sync'
        ]
      })
      context = await browser.newContext({ serviceWorkers: 'block' })
      const requests: string[] = [],
        blocked: string[] = [],
        pageErrors: string[] = []
      await context.route('**/*', async (route) => {
        const url = route.request().url()
        if (runtime?.origins.includes(new URL(url).origin)) await route.continue()
        else {
          blocked.push(url)
          await route.abort()
        }
      })
      const page = await context.newPage()
      page.on('request', (request) => requests.push(new URL(request.url()).pathname))
      page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
      const subscriptionsURL = new URL(runtime.frontendURL)
      subscriptionsURL.pathname = '/subs'
      await page.goto(subscriptionsURL.href, { waitUntil: 'networkidle', timeout: 15000 })
      // The original artificial task uses a seconds cron; this also observes
      // a scheduling boundary while the real frontend runs its initial queries.
      await page.waitForTimeout(1200)
      const renderedBody = await page.locator('body').innerText()
      expect(renderedBody).toContain('Migrated local')
      expect(renderedBody).toContain('Migrated remote')
      expect(
        requests.some((path) => path.endsWith('/api/subs')),
        JSON.stringify({
          requests,
          blocked,
          pageErrors,
          body: await page.locator('body').innerText()
        })
      ).toBe(true)
      const automaticFlowRequests = requests.filter((path) =>
        path.includes('/api/sub/flow/')
      ).length
      expect(automaticFlowRequests).toBe(0)
      expect(proxyRequests).toBe(0)
      expect(pageErrors).toEqual([])
      const pageResponse = await fetch(runtime.frontendURL),
        csp = pageResponse.headers.get('content-security-policy')
      expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
      expect(csp).toContain(`connect-src 'self' ${runtime.origins[1]};`)
      expect(csp).not.toContain('connect-src *')
      const api = new URL(runtime.frontendURL).searchParams.get('api')
      if (!api) throw new Error('Missing private API')
      const remote = inventory.data.find((item) => item.displayName === 'Migrated remote')
      if (!remote) throw new Error('Missing imported remote definition')
      const flow = await fetch(api + '/api/sub/flow/' + encodeURIComponent(remote.name))
      expect(flow.status).toBe(400)
      expect(await flow.text()).toContain('NO_FLOW_INFO')
      expect(proxyRequests).toBe(0)
      const stored = JSON.parse(await readFile(join(resources.dataRoot, 'sub-store.json'), 'utf8'))
      expect(stored.artifacts).toEqual([])
      expect(stored.tokens).toEqual([])
      expect(stored.settings.autoDownload).toBeUndefined()
      proof = {
        verifiedAt: new Date().toISOString(),
        scope:
          'Fixed official sandboxed backend and headless frontend with synthetic imported definitions; no real user/account/App',
        backendVersion: resources.manifest.backend.version,
        backendSHA256: resources.manifest.backend.sha256,
        frontendVersion: resources.manifest.frontend.version,
        frontendSHA256: resources.manifest.frontend.sha256,
        csp,
        resourceBytesChanged: false,
        importedSubscriptions: inventory.data.length,
        frontendSubscriptionListRequests: requests.filter((path) => path.endsWith('/api/subs'))
          .length,
        uncaughtPageErrors: pageErrors.length,
        frontendAutomaticFlowRequests: automaticFlowRequests,
        proxyRequests,
        blockedExternalBrowserRequests: blocked.length,
        explicitNoFlowProbeStatus: flow.status,
        oldJobsTokensSettingsImported: false,
        realUserDataRead: false,
        systemNetworkChanged: false,
        currentClashOrMihomoStopped: false,
        productAcceptance: 'pending'
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    const stopped = await Promise.allSettled([
      (async () => {
        try {
          await context?.close()
        } finally {
          await browser?.close()
        }
      })(),
      (async () => {
        try {
          await cleanup?.()
        } finally {
          await new Promise<void>((resolve) => {
            proxy.close(() => resolve())
            proxy.closeAllConnections()
          })
        }
      })()
    ])
    const cleanupErrors = stopped.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        'Owned fixture cleanup failed; private home retained: ' + home
      )
    expect(runtime?.alive() ?? false).toBe(false)
    await rm(home, { recursive: true, force: true })
    if (failure) throw failure
    if (proof)
      await writeFile(
        '../evidence/legacy-substore-runtime-verification-20261101.json',
        JSON.stringify(
          {
            ...proof,
            backendStopped: true,
            fixtureBrowserClosed: true,
            privateHomeRemoved: true
          },
          null,
          2
        ) + '\n',
        { mode: 0o600 }
      )
  },
  30000
)
