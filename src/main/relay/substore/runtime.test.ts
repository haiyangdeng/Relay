import { access, mkdtemp, readFile, realpath, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { createServer, request } from 'http'
import { join } from 'path'
import { expect, it } from 'vitest'
import { ProfileStore } from '../profiles/store'
import { createSubStoreService } from './service'
import { SubStoreResources } from './resources'
import { startSubStoreRuntime, type SubStoreRuntime } from './runtime'

const references = join(process.cwd(), '.relay-build/substore-reference')
const available =
  process.platform === 'darwin' &&
  existsSync(join(references, 'sub-store.bundle.js')) &&
  existsSync(join(references, 'dist.zip'))
const executables = [process.execPath]
const electronExecutable = join(
  process.cwd(),
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)
if (existsSync(electronExecutable)) executables.push(electronExecutable)
it.skipIf(!available).each(executables)(
  'runs verified official Sub-Store in a private sandbox using %s, converts an inline subscription and waits for both ports to close',
  async (executable) => {
    const root = await realpath(await mkdtemp('/private/tmp/relay-substore-real-'))
    const stateRoot = join(root, 'Library/Application Support/Relay')
    const resources = new SubStoreResources(stateRoot),
      signal = new AbortController().signal
    const profiles = new ProfileStore({ home: root, stateRoot })
    let runtime: SubStoreRuntime | undefined, cleanup: (() => Promise<void>) | undefined
    let forwarded = 0,
      originRequests = 0
    const origin = createServer((_req, res) => {
      originRequests++
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('proxies:\n - {name: RemoteFixture, type: http, server: 127.0.0.1, port: 18191}\n')
    })
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
    const originAddress = origin.address()
    if (!originAddress || typeof originAddress !== 'object') throw new Error('missing origin port')
    const originURL = `http://127.0.0.1:${originAddress.port}/snapshot`
    const proxy = createServer((req, res) => {
      if (req.url !== originURL) {
        res.writeHead(502)
        res.end('Only the local fixture origin is allowed')
        return
      }
      forwarded++
      const upstream = request(originURL, { method: 'GET' }, (response) => {
        res.writeHead(response.statusCode ?? 500, response.headers)
        response.pipe(res)
      })
      upstream.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      upstream.end()
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    if (!address || typeof address !== 'object') throw new Error('missing proxy port')
    try {
      await resources.install(
        await readFile(join(references, 'sub-store.bundle.js')),
        await readFile(join(references, 'dist.zip')),
        signal
      )
      const service = createSubStoreService({
        resources,
        start: async (input) => {
          try {
            runtime = await startSubStoreRuntime({
              ...input,
              executable,
              resources,
              dependencyRoot: join(process.cwd(), 'node_modules'),
              registerCleanup: (stop) => {
                cleanup = stop
                input.registerCleanup(stop)
              }
            })
            return runtime
          } catch (error) {
            console.warn(
              'isolated Sub-Store startup diagnostic',
              error instanceof Error ? error.message : 'unknown'
            )
            throw error
          }
        },
        save: (name, text) => profiles.save(name, text),
        confirmAcquire: async () => true,
        confirmStart: async () => true,
        confirmSave: async () => true
      })
      await service.start({ proxyPort: address.port })
      if (!runtime) throw new Error('missing runtime')
      expect(runtime.alive()).toBe(true)
      const frontendURL = new URL(runtime.frontendURL),
        api = frontendURL.searchParams.get('api')
      if (!api) throw new Error('missing API address')
      const page = await fetch(frontendURL)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('<html')
      const denied = await fetch(new URL('/api/subs', api))
      expect(denied.status).toBe(404)
      const add = await fetch(api + '/api/subs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'relay-inline',
          source: 'local',
          content: 'http://user:pass@127.0.0.1:18190#Fixture'
        })
      })
      expect(add.status).toBe(201)
      const list = JSON.parse(await runtime.request('/api/subs', signal))
      expect(list.data.some((item: { name: string }) => item.name === 'relay-inline')).toBe(true)
      const converted = await runtime.request('/download/relay-inline?target=ClashMeta', signal)
      expect(converted).toContain('Fixture')
      expect(converted).toContain('127.0.0.1')
      const inventory = await service.list()
      expect(inventory.subscriptions.map((item) => item.name)).toContain('relay-inline')
      const plan = await service.prepareConversion({ kind: 'subscription', name: 'relay-inline' })
      const saved = (await service.saveConversion({ evidenceId: plan.evidenceId })) as {
        id: string
        sha256: string
      }
      expect((await profiles.read({ id: saved.id, sha256: saved.sha256 })).text).toContain(
        'Fixture'
      )
      const remote = await fetch(api + '/api/subs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'relay-remote', source: 'remote', url: originURL })
      })
      expect(remote.status).toBe(201)
      const beforeProxy = forwarded
      const remotePlan = await service.prepareConversion({
        kind: 'subscription',
        name: 'relay-remote'
      })
      expect(forwarded).toBeGreaterThan(beforeProxy)
      expect(originRequests).toBeGreaterThan(0)
      const remoteSaved = (await service.saveConversion({ evidenceId: remotePlan.evidenceId })) as {
        id: string
        sha256: string
      }
      expect(
        (await profiles.read({ id: remoteSaved.id, sha256: remoteSaved.sha256 })).text
      ).toContain('RemoteFixture')
      const blocked = await fetch(api + '/api/subs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'relay-blocked-direct',
          source: 'remote',
          url: originURL + '/direct-only',
          proxy: `http://127.0.0.1:${originAddress.port}`
        })
      })
      expect(blocked.status).toBe(201)
      const beforeBlocked = originRequests
      await expect(
        runtime.request('/download/relay-blocked-direct?target=ClashMeta&noCache=true', signal)
      ).rejects.toThrow()
      expect(originRequests).toBe(beforeBlocked)
      await access(join(resources.dataRoot, 'root.json'))
      await service.stop()
      expect(runtime.alive()).toBe(false)
      await expect(access(resources.sessionDirectory)).rejects.toThrow()
      await expect(fetch(frontendURL)).rejects.toThrow()
      await expect(fetch(api + '/api/subs')).rejects.toThrow()
      await service.start({ proxyPort: address.port })
      expect((await service.list()).subscriptions.map((item) => item.name)).toContain(
        'relay-remote'
      )
      await service.stop()
      await expect(access(resources.sessionDirectory)).rejects.toThrow()
    } finally {
      await cleanup?.()
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve())
        proxy.closeAllConnections()
      })
      await new Promise<void>((resolve) => {
        origin.close(() => resolve())
        origin.closeAllConnections()
      })
      await rm(root, { recursive: true, force: true })
    }
  },
  30000
)

it.skipIf(process.platform !== 'darwin')(
  'enforces the OS sandbox: only the chosen proxy is reachable and files outside private data cannot be read or written',
  async () => {
    const { execFile } = await import('child_process'),
      { promisify } = await import('util'),
      { writeFile, mkdir } = await import('fs/promises')
    const { subStoreSandbox } = await import('./runtime')
    const root = await realpath(await mkdtemp('/private/tmp/relay-substore-policy-'))
    const allowed = createServer((_req, res) => res.end('allowed')),
      denied = createServer((_req, res) => res.end('must not be reached'))
    await new Promise<void>((resolve) => allowed.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => denied.listen(0, '127.0.0.1', resolve))
    const allowedAddress = allowed.address(),
      deniedAddress = denied.address()
    if (
      !allowedAddress ||
      typeof allowedAddress !== 'object' ||
      !deniedAddress ||
      typeof deniedAddress !== 'object'
    )
      throw new Error('missing ports')
    try {
      const dataRoot = join(root, 'Data'),
        codeRoot = join(root, 'Code')
      await mkdir(dataRoot, { mode: 0o700 })
      await mkdir(codeRoot, { mode: 0o700 })
      const secret = join(root, 'outside-secret')
      await writeFile(secret, 'fixture private content')
      const executable = await realpath(process.execPath),
        profile = subStoreSandbox({
          executable,
          runner: join(codeRoot, 'runner.cjs'),
          resourceRoot: codeRoot,
          dependencyRoot: codeRoot,
          dataRoot,
          proxyPort: allowedAddress.port
        })
      const script = `const fs=require('fs'),http=require('http');let readDenied=false,writeDenied=false;try{fs.readFileSync(${JSON.stringify(secret)})}catch(e){readDenied=['EACCES','EPERM'].includes(e.code)}try{fs.writeFileSync(${JSON.stringify(secret)},'changed')}catch(e){writeDenied=['EACCES','EPERM'].includes(e.code)};const get=p=>new Promise(r=>{const q=http.get('http://127.0.0.1:'+p,s=>{s.resume();s.on('end',()=>r(true))});q.on('error',()=>r(false));q.setTimeout(2000,()=>q.destroy())});Promise.all([get(${allowedAddress.port}),get(${deniedAddress.port})]).then(([proxyAllowed,directAllowed])=>console.log(JSON.stringify({readDenied,writeDenied,proxyAllowed,directAllowed})))`
      const result = await promisify(execFile)(
        '/usr/bin/sandbox-exec',
        ['-p', profile, executable, '-e', script],
        { timeout: 10000, env: { PATH: '/usr/bin:/bin', HOME: dataRoot } }
      )
      expect(JSON.parse(result.stdout)).toEqual({
        readDenied: true,
        writeDenied: true,
        proxyAllowed: true,
        directAllowed: false
      })
      expect(await readFile(secret, 'utf8')).toBe('fixture private content')
    } finally {
      await new Promise<void>((resolve) => allowed.close(() => resolve()))
      await new Promise<void>((resolve) => denied.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  15000
)

it.skipIf(process.platform !== 'darwin').each(executables)(
  'rejects ordinary and detached descendant processes in the real OS sandbox using %s',
  async (executablePath) => {
    const { execFile } = await import('child_process'),
      { promisify } = await import('util'),
      { writeFile, mkdir } = await import('fs/promises')
    const { subStoreSandbox } = await import('./runtime')
    const root = await realpath(await mkdtemp('/private/tmp/relay-substore-descendant-'))
    try {
      const dataRoot = join(root, 'Data'),
        codeRoot = join(root, 'Code')
      await mkdir(dataRoot, { mode: 0o700 })
      await mkdir(codeRoot, { mode: 0o700 })
      const executable = await realpath(executablePath),
        runner = join(codeRoot, 'runner.cjs'),
        marker = join(dataRoot, 'descendant-ran')
      const script = `
        const { spawn } = require('child_process');
        const childCode = ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},'unexpected descendant')`)};
        const attempt = detached => new Promise(resolve => {
          try {
            const child = spawn(process.execPath, ['-e', childCode], { detached, stdio: 'ignore' });
            child.once('error', error => resolve(error.code));
            child.once('spawn', () => resolve('spawned'));
          } catch (error) { resolve(error.code); }
        });
        Promise.all([attempt(false), attempt(true)]).then(result => console.log(JSON.stringify(result)));
      `
      await writeFile(runner, script, { mode: 0o600 })
      const profile = subStoreSandbox({
        executable,
        runner,
        resourceRoot: codeRoot,
        dependencyRoot: codeRoot,
        dataRoot,
        proxyPort: 18192
      })
      const result = await promisify(execFile)(
        '/usr/bin/sandbox-exec',
        ['-p', profile, executable, runner],
        {
          timeout: 10000,
          env: { PATH: '/usr/bin:/bin', HOME: dataRoot, ELECTRON_RUN_AS_NODE: '1' }
        }
      )
      expect(JSON.parse(result.stdout)).toEqual(['EPERM', 'EPERM'])
      await expect(access(marker)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  15000
)
