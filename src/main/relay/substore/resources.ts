import { createHash } from 'crypto'
import { performance } from 'perf_hooks'
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile, readdir } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import AdmZip from 'adm-zip'
import { readBinaryResource } from '../resources/source'
import { requestOnce } from '../../resolve/plugin/http-client'
import pins from './manifest.json'

export type SubStoreManifest = typeof pins
export const subStoreManifest: SubStoreManifest = pins
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export function verifySubStoreAsset(bytes: Buffer, pin: SubStoreManifest['backend']): void {
  if (bytes.length !== pin.size || hash(bytes) !== pin.sha256)
    throw new Error('Sub-Store资源大小或固定摘要不符。')
}
export function subStoreFrontendFiles(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>(),
    zip = new AdmZip(bytes)
  const entries = zip.getEntries()
  if (entries.length > 512) throw new Error('Sub-Store前端文件数量超限。')
  let total = 0
  for (const entry of entries) {
    const name = entry.entryName
    if (
      !name.startsWith('dist/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').some((part) => part === '..' || part === '.')
    )
      throw new Error('Sub-Store前端压缩路径无效。')
    if (entry.isDirectory) continue
    const path = '/' + name.slice(5)
    if (files.has(path) || entry.header.size > 8 * 1024 * 1024)
      throw new Error('Sub-Store前端文件无效。')
    total += entry.header.size
    if (total > 16 * 1024 * 1024) throw new Error('Sub-Store前端解压预算超限。')
    const data = entry.getData()
    if (data.length !== entry.header.size) throw new Error('Sub-Store前端文件大小不符。')
    files.set(path, data)
  }
  if (!files.has('/index.html')) throw new Error('Sub-Store前端缺少入口。')
  return files
}
export async function downloadSubStoreAsset(
  pin: SubStoreManifest['backend'],
  proxyPort: number,
  signal: AbortSignal
): Promise<Buffer> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('Sub-Store资源下载要求TLS校验。')
  if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535)
    throw new Error('Sub-Store资源代理端口无效。')
  const startedWall = Date.now(),
    startedMono = performance.now()
  let lastWall = startedWall,
    lastMono = startedMono
  // The redirects share one budget. Reuse the theme downloader's remaining
  // timeout and the theme service's independent wall/monotonic expiry guards.
  // Like TrafficContext, neither clock may regress from an observed value.
  const remaining = (): number => {
    const wall = Date.now(),
      mono = performance.now()
    if (
      signal.aborted ||
      !Number.isFinite(startedWall) ||
      !Number.isFinite(startedMono) ||
      !Number.isFinite(wall) ||
      !Number.isFinite(mono) ||
      wall < lastWall ||
      mono < lastMono ||
      wall - startedWall >= 60000 ||
      mono - startedMono >= 60000
    )
      throw new Error('Sub-Store资源获取已取消或超时。')
    lastWall = wall
    lastMono = mono
    return Math.max(1, Math.ceil(60000 - Math.max(wall - startedWall, mono - startedMono)))
  }
  let url = pin.url
  for (let redirects = 0; redirects <= 3; redirects++) {
    remaining()
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'https:' ||
      ![
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
        'github-releases.githubusercontent.com'
      ].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      throw new Error('Sub-Store资源重定向来源无效。')
    const response = await requestOnce(url, {
      method: 'GET',
      proxy: { host: '127.0.0.1', port: proxyPort },
      signal,
      timeout: remaining(),
      maxBytes: pin.size,
      binary: true,
      captureRedirects: true,
      headers: { 'user-agent': 'Relay', 'accept-encoding': 'identity' }
    })
    remaining()
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location
      if (typeof location !== 'string') throw new Error('Sub-Store资源重定向无效。')
      url = new URL(location, url).href
      continue
    }
    if (
      response.status !== 200 ||
      !Buffer.isBuffer(response.bytes) ||
      (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
    )
      throw new Error('Sub-Store资源获取失败。')
    verifySubStoreAsset(response.bytes, pin)
    remaining()
    return response.bytes
  }
  throw new Error('Sub-Store资源重定向次数超限。')
}
export class SubStoreResources {
  readonly directory: string
  readonly dataRoot: string
  readonly sessionDirectory: string
  private readonly root: string
  constructor(
    stateRoot: string,
    readonly manifest: SubStoreManifest = pins
  ) {
    if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot || stateRoot.includes('\0'))
      throw new Error('Sub-Store目录无效。')
    this.root = join(stateRoot, 'SubStore')
    this.directory = join(
      this.root,
      `resources-${manifest.backend.sha256.slice(0, 12)}-${manifest.frontend.sha256.slice(0, 12)}`
    )
    this.dataRoot = join(this.root, 'Data')
    this.sessionDirectory = join(this.root, '.session')
  }
  private async directoryCheck(path: string): Promise<void> {
    const info = await lstat(path)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      (await realpath(path)) !== path
    )
      throw new Error('Sub-Store私有目录身份或权限无效。')
  }
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.directoryCheck(this.root)
    await mkdir(this.dataRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    await this.directoryCheck(this.dataRoot)
  }
  async install(backend: Buffer, frontend: Buffer, signal: AbortSignal): Promise<void> {
    verifySubStoreAsset(backend, this.manifest.backend)
    verifySubStoreAsset(frontend, this.manifest.frontend)
    subStoreFrontendFiles(frontend)
    if (signal.aborted) throw new Error('Sub-Store资源操作已取消。')
    await this.initialize()
    const stage = await mkdtemp(join(this.root, '.resources-'))
    try {
      await writeFile(join(stage, 'backend.cjs'), backend, { mode: 0o600 })
      await writeFile(join(stage, 'frontend.zip'), frontend, { mode: 0o600 })
      if (signal.aborted) throw new Error('Sub-Store资源操作已取消。')
      try {
        await rename(stage, this.directory)
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error
        try {
          await this.load()
          return
        } catch {
          // A corrupt immutable cache must not make explicit reacquisition
          // permanently unusable. Preserve the old directory; Data is separate.
          await this.directoryCheck(this.root)
          await this.directoryCheck(this.dataRoot)
          await this.directoryCheck(this.directory)
          const names = await readdir(this.directory)
          if (names.sort().join(',') !== 'backend.cjs,frontend.zip')
            throw new Error('资源目录含未知内容，未替换。')
          for (const name of names) {
            const info = await lstat(join(this.directory, name))
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              info.nlink !== 1 ||
              info.uid !== process.getuid?.() ||
              info.mode & 0o077 ||
              info.size > 128 * 1024 * 1024
            )
              throw new Error('资源目录含未知文件身份，未替换。')
          }
          if (signal.aborted) throw new Error('Sub-Store资源操作已取消。')
          const retained = await mkdtemp(join(this.root, 'retained-resources-'))
          const original = join(retained, 'original')
          await rename(this.directory, original)
          try {
            await rename(stage, this.directory)
          } catch (publishError) {
            // Do not overwrite a concurrently created target during rollback.
            try {
              await lstat(this.directory)
            } catch (observationError) {
              if ((observationError as NodeJS.ErrnoException).code === 'ENOENT') {
                await rename(original, this.directory).catch(() => {
                  /* Retained originals remain inspectable. */
                })
              }
            }
            throw publishError
          }
        }
      }
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
  async load(): Promise<{ backendPath: string; files: Map<string, Buffer>; dataRoot: string }> {
    await this.directoryCheck(this.root)
    await this.directoryCheck(this.directory)
    await this.directoryCheck(this.dataRoot)
    const backendPath = join(this.directory, 'backend.cjs')
    const [backend, frontend] = await Promise.all([
      readBinaryResource(backendPath, true),
      readBinaryResource(join(this.directory, 'frontend.zip'), true)
    ])
    verifySubStoreAsset(backend, this.manifest.backend)
    verifySubStoreAsset(frontend, this.manifest.frontend)
    return { backendPath, files: subStoreFrontendFiles(frontend), dataRoot: this.dataRoot }
  }
}
