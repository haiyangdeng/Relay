import { networkInterfaces } from 'os'
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { createServer, request as httpRequest, type Server } from 'http'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'fs/promises'
import { dirname, extname, isAbsolute, join } from 'path'
import { createConnection } from 'net'
import type { SubStoreAdvancedStart, SubStoreRecovery } from '../../../shared/relay/substore'
import { atomicWriteFile } from '../../utils/safeFile'
import { readBinaryResource } from '../resources/source'
import dependencies from './dependencies.json'
import runnerSource from './runner.cjs?raw'
import type { SubStoreResources } from './resources'

const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
function quote(value: string): string {
  if (
    !isAbsolute(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('Sub-Store沙箱路径无效。')
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
}
export function subStoreSandbox(input: {
  executable: string
  runner: string
  resourceRoot: string
  dependencyRoot: string
  dataRoot: string
  proxyPort: number
  allowLan?: boolean
}): string {
  if (!Number.isInteger(input.proxyPort) || input.proxyPort < 1024 || input.proxyPort > 65535)
    throw new Error('Sub-Store代理端口无效。')
  const appMarker = input.executable.indexOf('.app/Contents/MacOS/')
  const executableRoot =
    appMarker >= 0 ? input.executable.slice(0, appMarker + 4) : dirname(input.executable)
  return `(version 1)\n(deny default)\n(import "system.sb")\n(deny process-fork)\n(allow process-exec (literal ${quote(input.executable)}))\n(allow sysctl-read)\n(allow file-read-metadata)\n(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath ${quote(executableRoot)}) (literal ${quote(input.runner)}) (subpath ${quote(input.resourceRoot)}) (subpath ${quote(input.dependencyRoot)}) (subpath ${quote(input.dataRoot)}) (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null"))\n(allow file-write* (subpath ${quote(input.dataRoot)}))\n(allow network-bind (local tcp "${input.allowLan ? '*:*' : 'localhost:*'}"))\n(allow network-inbound (local tcp "${input.allowLan ? '*:*' : 'localhost:*'}"))\n(allow network-outbound (remote tcp "localhost:${input.proxyPort}"))\n`
}
async function stageDependencies(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const [name, pin] of Object.entries(dependencies)) {
    const bytes = await readFile(join(source, name))
    if (bytes.length !== pin.size || hash(bytes) !== pin.sha256)
      throw new Error('Sub-Store本地依赖与锁定清单不符。')
    const file = join(target, name)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, bytes, { mode: 0o600 })
  }
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })
}
export interface SubStoreRuntime {
  readonly pid: number
  readonly frontendURL: string
  readonly origins: readonly string[]
  readonly lanURL?: string
  request(path: string, signal: AbortSignal): Promise<string>
  alive(): boolean
  stop(): Promise<void>
}
export async function startSubStoreRuntime(input: {
  resources: SubStoreResources
  dependencyRoot: string
  proxyPort: number
  signal: AbortSignal
  executable?: string
  registerCleanup?(stop: () => Promise<void>): void
  advanced?: SubStoreAdvancedStart
  beforeSessionRelease?(): Promise<void>
  egressPID?: number
}): Promise<SubStoreRuntime> {
  if (process.platform !== 'darwin') throw new Error('Sub-Store受控运行当前仅支持macOS。')
  if (input.signal.aborted) throw new Error('Sub-Store启动已取消。')
  if (
    input.egressPID !== undefined &&
    (!Number.isInteger(input.egressPID) || input.egressPID < 2 || input.egressPID > 2147483647)
  )
    throw new Error('独立核心记录身份无效。')
  if (!Number.isInteger(input.proxyPort) || input.proxyPort < 1024 || input.proxyPort > 65535)
    throw new Error('Sub-Store代理端口无效。')
  const proxyLive = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: input.proxyPort })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve(false)
    })
  })
  if (!proxyLive) throw new Error('Sub-Store指定代理端口当前不可达。')
  const loaded = await input.resources.load()
  const executable = await realpath(input.executable ?? process.execPath)
  const executableInfo = await lstat(executable)
  if (!executableInfo.isFile() || executableInfo.mode & 0o022)
    throw new Error('Sub-Store运行时身份无效。')
  const runtimeRoot = join(dirname(loaded.dataRoot), 'Runtime')
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
  const rootInfo = await lstat(runtimeRoot)
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    rootInfo.mode & 0o077 ||
    (await realpath(runtimeRoot)) !== runtimeRoot
  )
    throw new Error('Sub-Store运行目录无效。')
  const temporary = join(loaded.dataRoot, 'Temp')
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  const tempInfo = await lstat(temporary)
  if (
    !tempInfo.isDirectory() ||
    tempInfo.isSymbolicLink() ||
    tempInfo.mode & 0o077 ||
    (await realpath(temporary)) !== temporary
  )
    throw new Error('Sub-Store临时目录无效。')
  const lease = input.resources.sessionDirectory
  await mkdir(lease, { mode: 0o700 }).catch(() => {
    throw new Error('Sub-Store已有运行或待恢复记录；未接管旧进程。')
  })
  const leaseIdentity = await lstat(lease)
  let working = ''
  let runner: string
  let modules: string
  try {
    working = await mkdtemp(join(runtimeRoot, 'session-'))
    runner = join(working, 'runner.cjs')
    modules = join(working, 'node_modules')
    await writeFile(runner, runnerSource, { mode: 0o600 })
    await stageDependencies(input.dependencyRoot, modules)
  } catch (error) {
    if (working) await rm(working, { recursive: true, force: true })
    await rm(lease, { recursive: true, force: true })
    throw error
  }
  const nonce = randomUUID().replaceAll('-', ''),
    prefix = `/relay-${nonce}`,
    proxy = `http://127.0.0.1:${input.proxyPort}`
  const profile = subStoreSandbox({
    executable,
    runner,
    resourceRoot: input.resources.directory,
    dependencyRoot: modules,
    dataRoot: loaded.dataRoot,
    proxyPort: input.proxyPort,
    allowLan: input.advanced?.allowLan === true
  })
  if (input.signal.aborted) {
    await rm(working, { recursive: true, force: true })
    await rm(lease, { recursive: true })
    throw new Error('Sub-Store启动已取消。')
  }
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, runner], {
    cwd: loaded.dataRoot,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: loaded.dataRoot,
      TMPDIR: temporary,
      NODE_PATH: modules,
      ELECTRON_RUN_AS_NODE: '1',
      SUB_STORE_BACKEND_API_HOST: input.advanced?.allowLan ? '0.0.0.0' : '127.0.0.1',
      SUB_STORE_BACKEND_API_PORT: '0',
      SUB_STORE_BACKEND_PREFIX: 'true',
      SUB_STORE_FRONTEND_BACKEND_PATH: prefix,
      SUB_STORE_DATA_BASE_PATH: loaded.dataRoot,
      SUB_STORE_BACKEND_DEFAULT_PROXY: proxy,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      SUB_STORE_BACKEND_CUSTOM_NAME: 'Relay',
      SUB_STORE_BACKEND_SYNC_CRON: input.advanced?.syncCron ?? '',
      SUB_STORE_BACKEND_DOWNLOAD_CRON: input.advanced?.downloadCron ?? '',
      SUB_STORE_BACKEND_UPLOAD_CRON: input.advanced?.uploadCron ?? ''
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  })
  // Subscriptions can contain credentials; raw third-party logs are not forwarded.
  child.stdout?.resume()
  child.stderr?.resume()
  child.stdin?.on('error', () => {})
  let exited = false,
    stopped = false,
    frontend: Server | undefined
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true
      resolve()
    })
    child.once('error', () => {
      exited = true
      resolve()
    })
  })
  let stopping: Promise<void> | undefined
  const finishStop = async (): Promise<void> => {
    if (stopped) return
    if (!exited) {
      if (child.connected)
        child.send({ type: 'stop', nonce }, (error) => {
          if (error && !exited) child.kill('SIGTERM')
        })
      else child.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      const finished = await Promise.race([
        exit.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 5000)
        })
      ])
      if (timer) clearTimeout(timer)
      if (!finished) throw new Error('Sub-Store退出尚未确认；保留恢复句柄。')
    }
    if (frontend) {
      await closeServer(frontend)
      frontend = undefined
    }
    await rm(working, { recursive: true, force: true })
    await input.beforeSessionRelease?.()
    const currentLease = await lstat(lease)
    if (
      currentLease.dev !== leaseIdentity.dev ||
      currentLease.ino !== leaseIdentity.ino ||
      currentLease.isSymbolicLink()
    )
      throw new Error('Sub-Store会话目录已改变，保留当前记录。')
    await rm(lease, { recursive: true })
    stopped = true
  }
  const stop = (): Promise<void> => {
    if (!stopping)
      stopping = finishStop().finally(() => {
        stopping = undefined
      })
    return stopping
  }
  input.registerCleanup?.(stop)
  const aborted = (): void => {
    void stop().catch(() => {})
  }
  input.signal.addEventListener('abort', aborted, { once: true })
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sub-Store启动等待超时。')), 15000)
    const failed = (): void => {
      clearTimeout(timer)
      reject(new Error('Sub-Store后端启动失败。'))
    }
    child.once('error', failed)
    child.once('exit', failed)
    child.on('message', (message) => {
      const value = message as { type?: unknown; nonce?: unknown; port?: unknown }
      if (
        value?.type !== 'ready' ||
        value.nonce !== nonce ||
        typeof value.port !== 'number' ||
        !Number.isInteger(value.port) ||
        value.port < 1024 ||
        value.port > 65535
      )
        return
      clearTimeout(timer)
      child.removeListener('error', failed)
      child.removeListener('exit', failed)
      resolve(value.port)
    })
    child.stdin?.end(
      JSON.stringify({
        nonce,
        backendPath: loaded.backendPath,
        bindHost: input.advanced?.allowLan ? '0.0.0.0' : '127.0.0.1'
      }) + '\n'
    )
  })
  void ready.catch(() => {})
  try {
    const pid = child.pid
    if (!pid) throw new Error('Sub-Store子进程未创建。')
    await atomicWriteFile(
      join(lease, 'owner.json'),
      JSON.stringify({
        version: input.egressPID ? 2 : 1,
        nonce,
        pid,
        ...(input.egressPID ? { egressPID: input.egressPID } : {}),
        createdAt: Date.now()
      }),
      { mode: 0o600 }
    )
    const backendPort = await ready
    if (input.signal.aborted || exited) throw new Error('Sub-Store启动已取消。')
    const backendOrigin = `http://127.0.0.1:${backendPort}`
    const api = backendOrigin + prefix
    const request = (path: string, signal: AbortSignal): Promise<string> =>
      new Promise((resolve, reject) => {
        if (
          exited ||
          stopped ||
          !/^\/(?:api\/(?:subs|collections|utils\/env)|download\/[^\r\n]+)$/u.test(path)
        ) {
          reject(new Error('Sub-Store请求范围无效。'))
          return
        }
        const req = httpRequest(
          api + path,
          { method: 'GET', signal, headers: { 'accept-encoding': 'identity' } },
          (res) => {
            const chunks: Buffer[] = []
            let count = 0
            if (res.statusCode !== 200) {
              res.resume()
              reject(new Error('Sub-Store响应无效。'))
              return
            }
            res.on('data', (chunk: Buffer) => {
              count += chunk.length
              if (count > 2 * 1024 * 1024) req.destroy(new Error('Sub-Store结果超限。'))
              else chunks.push(chunk)
            })
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            res.on('error', reject)
          }
        )
        req.setTimeout(15000, () => req.destroy(new Error('Sub-Store请求超时。')))
        req.on('error', reject)
        req.end()
      })
    await request('/api/utils/env', input.signal)
    const lanIPs = input.advanced?.allowLan
      ? Object.values(networkInterfaces()).flatMap(
          (rows) =>
            rows
              ?.filter((row) => row.family === 'IPv4' && !row.internal)
              .map((row) => row.address) ?? []
        )
      : []
    const staticServer = createServer((req, res) => {
      let servingHost = '127.0.0.1'
      try {
        const host = new URL('http://' + (req.headers.host ?? ''))
        if (
          !['127.0.0.1', ...lanIPs].includes(host.hostname) ||
          host.username ||
          host.password ||
          host.pathname !== '/'
        )
          throw new Error()
        servingHost = host.hostname
      } catch {
        res.writeHead(400).end()
        return
      }

      if (!['GET', 'HEAD'].includes(req.method ?? '')) {
        res.writeHead(405)
        res.end()
        return
      }
      let path: string
      try {
        path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      if (path.includes('..') || path.includes('\\') || path.includes('\0')) {
        res.writeHead(400)
        res.end()
        return
      }
      const name = loaded.files.has(path) ? path : extname(path) ? path : '/index.html',
        bytes = loaded.files.get(name)
      if (!bytes) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': mime[extname(name)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        // The pinned official frontend includes runtime Vue/i18n compilers.
        // Scope their required eval permission to this isolated document;
        // resource bytes, connect origins and Electron isolation stay fixed.
        'content-security-policy': `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://${servingHost}:${backendPort}; frame-src 'none'; object-src 'none'; base-uri 'self'`
      })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    })
    frontend = staticServer
    await new Promise<void>((resolve, reject) => {
      staticServer.once('error', reject)
      staticServer.listen(0, input.advanced?.allowLan ? '0.0.0.0' : '127.0.0.1', resolve)
    })
    const address = staticServer.address()
    if (!address || typeof address !== 'object' || input.signal.aborted)
      throw new Error('Sub-Store前端监听失败。')
    const frontendOrigin = `http://127.0.0.1:${address.port}`
    input.signal.removeEventListener('abort', aborted)
    return {
      pid,
      frontendURL: `${frontendOrigin}/?api=${encodeURIComponent(api)}`,
      ...(input.advanced?.allowLan && lanIPs.length
        ? {
            lanURL: `http://${lanIPs[0]}:${address.port}/?api=${encodeURIComponent(`http://${lanIPs[0]}:${backendPort}${prefix}`)}`
          }
        : {}),
      origins: [frontendOrigin, backendOrigin],
      request,
      alive: () => !exited && !stopped,
      stop
    }
  } catch (error) {
    await stop()
    throw error
  } finally {
    input.signal.removeEventListener('abort', aborted)
  }
}

type SessionRecord = { nonce: string; pid: number; egressPID?: number; revision: string }
async function readSession(resources: SubStoreResources): Promise<SessionRecord | undefined> {
  try {
    const path = resources.sessionDirectory,
      info = await lstat(path)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      (await realpath(path)) !== path
    )
      throw new Error('Sub-Store旧会话目录无效。')
    const ownerPath = join(path, 'owner.json')
    const ownerInfo = await lstat(ownerPath)
    if (ownerInfo.size > 4096) throw new Error('Sub-Store旧会话记录超限。')
    const bytes = await readBinaryResource(ownerPath, true)
    if (bytes.length > 4096) throw new Error('Sub-Store旧会话记录超限。')
    const raw: unknown = JSON.parse(bytes.toString('utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Sub-Store旧会话记录无效。')
    const record = raw as Record<string, unknown>
    if (
      !(
        (record.version === 1 &&
          Object.keys(record).sort().join(',') === 'createdAt,nonce,pid,version') ||
        (record.version === 2 &&
          Object.keys(record).sort().join(',') === 'createdAt,egressPID,nonce,pid,version' &&
          typeof record.egressPID === 'number' &&
          Number.isInteger(record.egressPID) &&
          record.egressPID >= 2 &&
          record.egressPID <= 2147483647 &&
          record.egressPID !== record.pid)
      ) ||
      typeof record.nonce !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(record.nonce) ||
      typeof record.pid !== 'number' ||
      !Number.isInteger(record.pid) ||
      record.pid < 2 ||
      record.pid > 2147483647 ||
      typeof record.createdAt !== 'number' ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt < 1
    )
      throw new Error('Sub-Store旧会话记录无效。')
    return {
      nonce: record.nonce,
      pid: record.pid,
      ...(record.version === 2 ? { egressPID: record.egressPID as number } : {}),
      revision: hash(bytes)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await lstat(resources.sessionDirectory)
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      }
    }
    throw new Error('Sub-Store旧会话记录无法确认，未归档。')
  }
}
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
function sessionGone(record: SessionRecord): boolean {
  return (
    processGone(record.pid) && (record.egressPID === undefined || processGone(record.egressPID))
  )
}
export async function inspectSubStoreSession(
  resources: SubStoreResources
): Promise<SubStoreRecovery | undefined> {
  try {
    const record = await readSession(resources)
    return record
      ? {
          pid: record.pid,
          egressPID: record.egressPID,
          revision: record.revision,
          canArchive: sessionGone(record)
        }
      : undefined
  } catch {
    return { canArchive: false }
  }
}
export async function archiveSubStoreSession(
  resources: SubStoreResources,
  expected: SubStoreRecovery,
  assertLive: () => void = () => {}
): Promise<void> {
  assertLive()
  const record = await readSession(resources)
  if (
    !record ||
    !expected.canArchive ||
    expected.revision !== record.revision ||
    expected.pid !== record.pid ||
    expected.egressPID !== record.egressPID ||
    !sessionGone(record)
  )
    throw new Error('Sub-Store旧会话仍存在、已改变或状态未知；未归档。')
  assertLive()
  const archive = join(dirname(resources.dataRoot), 'Recovery')
  await mkdir(archive, { recursive: true, mode: 0o700 })
  const info = await lstat(archive)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (await realpath(archive)) !== archive
  )
    throw new Error('Sub-Store恢复归档目录无效。')
  const latest = await readSession(resources)
  if (!latest || latest.revision !== record.revision || !sessionGone(latest))
    throw new Error('Sub-Store旧会话已改变。')
  assertLive()
  await rename(resources.sessionDirectory, join(archive, `session-${record.nonce}`))
}
