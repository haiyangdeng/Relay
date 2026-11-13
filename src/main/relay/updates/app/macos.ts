import { execFile } from 'node:child_process'
import { lstat, mkdtemp, open, opendir, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { parse as parsePlist } from 'plist'
import { compare } from '../vendor/semver-7.8.5.mjs'
import {
  appUpdateHash,
  hashAppUpdateFile,
  readAppUpdateFile,
  type AppUpdateCandidateStore,
  type StoredAppUpdate
} from './store'
import type { AppReleaseConfiguration } from './configuration'
import { appVersion } from './release'

// The existing Core checker handles thin Mach-O only. Electron Apps may be
// universal; read only the bounded fat_arch/fat_arch_64 table defined by Apple's
// SDK mach-o/fat.h, without requiring end users to install lipo/developer tools.
async function macBinaryArchitectures(path: string): Promise<string[]> {
  if ((await realpath(path)) !== path) throw new Error('App执行文件路径未确认。')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size < 8)
      throw new Error('App执行文件无效。')
    const read = async (count: number, position = 0): Promise<Buffer> => {
      const bytes = Buffer.alloc(count)
      let size = 0
      while (size < count) {
        const part = await file.read(bytes, size, count - size, position + size)
        if (!part.bytesRead) throw new Error('Mach-O头被截断。')
        size += part.bytesRead
      }
      return bytes
    }
    const first = await read(8),
      types: number[] = []
    if (first.readUInt32LE(0) === 0xfeedfacf) types.push(first.readUInt32LE(4))
    else {
      const magic = first.readUInt32BE(0),
        count = first.readUInt32BE(4)
      if (![0xcafebabe, 0xcafebabf].includes(magic) || count < 1 || count > 8)
        throw new Error('App通用架构头无效。')
      const stride = magic === 0xcafebabf ? 32 : 20,
        table = await read(8 + stride * count)
      const spans: { offset: number; end: number }[] = []
      for (let index = 0; index < count; index++) {
        const position = 8 + stride * index,
          cpu = table.readUInt32BE(position)
        const offset =
          stride === 32
            ? Number(table.readBigUInt64BE(position + 8))
            : table.readUInt32BE(position + 8)
        const size =
          stride === 32
            ? Number(table.readBigUInt64BE(position + 16))
            : table.readUInt32BE(position + 12)
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(size) ||
          size < 8 ||
          offset < table.length ||
          offset + size > before.size ||
          spans.some((span) => offset < span.end && offset + size > span.offset)
        )
          throw new Error('App通用架构切片范围无效。')
        const header = await read(8, offset)
        if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== cpu)
          throw new Error('App通用架构表与切片不一致。')
        spans.push({ offset, end: offset + size })
        types.push(cpu)
      }
    }
    if (
      new Set(types).size !== types.length ||
      types.some((cpu) => ![0x100000c, 0x1000007].includes(cpu))
    )
      throw new Error('App含未支持或重复的架构。')
    const after = await file.stat(),
      linked = await lstat(path)
    if (
      [after, linked].some(
        (value) =>
          value.dev !== before.dev ||
          value.ino !== before.ino ||
          value.size !== before.size ||
          value.mtimeMs !== before.mtimeMs ||
          value.ctimeMs !== before.ctimeMs ||
          value.mode !== before.mode ||
          value.nlink !== before.nlink
      )
    )
      throw new Error('App执行文件读取期间变化。')
    return types.map((cpu) => (cpu === 0x100000c ? 'arm64' : 'x86_64'))
  } finally {
    await file.close()
  }
}

function command(file: string, args: readonly string[], maximum = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      [...args],
      {
        timeout: 60000,
        maxBuffer: maximum,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error('macOS应用发布校验或只读查询未确认。'))
        else resolve(stdout + stderr)
      }
    )
  )
}
function xml(bytes: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error('安装包元数据不允许外部实体。')
  const document = new DOMParser({
    onError: () => {
      throw new Error('安装包XML无效。')
    }
  }).parseFromString(text, 'application/xml')
  if (!document?.documentElement) throw new Error('安装包XML不完整。')
  return document
}

// Installer evaluates these fields as JavaScript even without a <script> tag.
// Apple Distribution Definition XML Schema Reference: choice and pkg-ref.
const installerExpressions = new Map<string, readonly string[]>([
  ['choice', ['enabled', 'selected', 'visible']],
  ['pkg-ref', ['active']]
])
const noSystemAction = /^(?:none)?$/iu

export function appUpdateDistributionScriptHashes(
  bytes: Buffer,
  config: Pick<AppReleaseConfiguration, 'applicationIdentifier' | 'packageIdentifier'>,
  componentName: string,
  architecture?: 'arm64' | 'x64'
): string[] {
  const document = xml(bytes)
  const root = document.documentElement
  if (root?.tagName !== 'installer-gui-script') throw new Error('安装包描述根元素无效。')
  // The default allows other volumes. Recovery observes the boot volume's App
  // and receipt, so require a static, explicit system-volume target.
  const domains = Array.from(root.getElementsByTagName('domains'))
  if (
    domains.length !== 1 ||
    domains[0].parentNode !== root ||
    domains[0].getAttribute('enable_anywhere') !== 'false' ||
    domains[0].getAttribute('enable_currentUserHome') !== 'false' ||
    domains[0].getAttribute('enable_localSystem') !== 'true'
  )
    throw new Error('安装描述必须将安装范围固定在当前系统卷。')
  const scripts: string[] = []
  for (const node of Array.from(document.getElementsByTagName('*'))) {
    if (node.tagName === 'options' && architecture && node.hasAttribute('hostArchitectures')) {
      const expected = architecture === 'x64' ? 'x86_64' : 'arm64'
      const declared = node
        .getAttribute('hostArchitectures')
        ?.split(',')
        .map((item) => item.trim())
      if (!declared?.includes(expected)) throw new Error('安装描述架构与所选应用更新不匹配。')
    }
    if (node.tagName === 'pkg-ref') {
      const local = node.textContent?.trim() ?? ''
      if (
        node.getAttribute('id') !== config.packageIdentifier ||
        (local && local !== '#' + componentName && local !== componentName)
      )
        throw new Error('安装描述含其他包或外部包来源。')
      if (
        !noSystemAction.test(node.getAttribute('onConclusion') ?? '') ||
        node.hasAttribute('onConclusionScript')
      )
        throw new Error('安装描述不允许要求退出登录、重启或关机。')
    }
    if (
      node.tagName === 'app' &&
      node.parentNode?.nodeName === 'must-close' &&
      node.getAttribute('id') !== config.applicationIdentifier
    )
      throw new Error('安装描述不允许要求关闭其他应用。')
    if (node.tagName === 'relocate') throw new Error('安装描述不允许重定位Relay。')
    if (
      node.tagName === 'options' &&
      node.hasAttribute('allow-external-scripts') &&
      node.getAttribute('allow-external-scripts') !== 'false'
    )
      throw new Error('安装包不允许外部脚本。')
    if (node.tagName === 'script') scripts.push(appUpdateHash(Buffer.from(node.textContent ?? '')))
    for (const { name, value } of Array.from(node.attributes)) {
      if (
        name === 'script' ||
        (installerExpressions.get(node.tagName)?.includes(name) &&
          value !== 'true' &&
          value !== 'false')
      )
        scripts.push(appUpdateHash(Buffer.from(value)))
    }
  }
  return scripts
}

export function appUpdatePackageInfo(bytes: Buffer) {
  const metadata = xml(bytes).documentElement
  if (!metadata || metadata.tagName !== 'pkg-info') throw new Error('安装包组件元数据无效。')
  if (
    !noSystemAction.test(metadata.getAttribute('postinstall-action') ?? '') ||
    (metadata.hasAttribute('relocatable') && metadata.getAttribute('relocatable') !== 'false') ||
    Array.from(metadata.getElementsByTagName('relocate')).some(
      (element) => element.getElementsByTagName('*').length || element.textContent?.trim()
    )
  )
    throw new Error('安装包组件不允许系统重启或重定位Relay。')
  return metadata
}

function plist(bytes: Buffer): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  // Apple's standard plist DTD is a format declaration, not a license to load
  // arbitrary external entities. No custom entity or internal subset is allowed.
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/iu.test(text)) throw new Error('应用属性表含外部实体。')
  const raw: unknown = parsePlist(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('应用属性表无效。')
  return raw as Record<string, unknown>
}
async function paths(root: string, maximum: number, skipApplications = false): Promise<string[]> {
  const found: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 24) throw new Error('安装包目录嵌套过深。')
    for await (const entry of await opendir(directory)) {
      const path = join(directory, entry.name),
        info = await lstat(path)
      if (info.isSymbolicLink() || (await realpath(path)) !== path || !path.startsWith(root + '/'))
        throw new Error('安装包展开路径含链接或越界。')
      if (++count > maximum) throw new Error('安装包展开条目过多。')
      found.push(path)
      if (info.isDirectory() && !(skipApplications && path.endsWith('.app')))
        await visit(path, depth + 1)
      else if (!info.isDirectory() && !info.isFile()) throw new Error('安装包含特殊文件。')
    }
  }
  let count = 0
  await visit(root, 0)
  return found
}

export interface MacApplicationObservation {
  version: string
  identifier: string
  team: string
  signatureVerified: true
}
export interface MacPackageVerification {
  sha256: string
  version: string
  packageIdentifier: string
  applicationIdentifier: string
  team: string
  architecture: 'arm64' | 'x64'
  gatekeeperAccepted: true
  notarizationAssessed: true
}
export class AppInstallerAlreadyRunning extends Error {
  constructor() {
    super('请先完成或关闭现有系统Installer。')
  }
}
export class MacAppUpdatePlatform {
  constructor(private readonly store: AppUpdateCandidateStore) {}

  private run(assertCurrent: () => void) {
    return async (file: string, args: readonly string[], maximum?: number): Promise<string> => {
      assertCurrent()
      const result = await command(file, args, maximum)
      assertCurrent()
      return result
    }
  }
  currentApplicationRoot(): string {
    const executable = process.execPath,
      contents = dirname(dirname(executable)),
      root = dirname(contents)
    if (
      process.platform !== 'darwin' ||
      dirname(executable) !== join(contents, 'MacOS') ||
      !isAbsolute(root) ||
      root !== '/Applications/Relay.app' ||
      contents !== join(root, 'Contents')
    )
      throw new Error('应用更新仅支持已安装的本次Relay macOS App。')
    return root
  }
  private async application(
    root: string,
    config: Readonly<AppReleaseConfiguration>,
    assertCurrent: () => void
  ): Promise<MacApplicationObservation> {
    const run = this.run(assertCurrent)
    const info = plist(
      await readAppUpdateFile(join(root, 'Contents/Info.plist'), 1024 * 1024, false)
    )
    const executable = info.CFBundleExecutable
    if (
      info.CFBundleIdentifier !== config.applicationIdentifier ||
      typeof executable !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,128}$/u.test(executable)
    )
      throw new Error('更新App身份无效。')
    const version = appVersion(info.CFBundleShortVersionString)
    await run('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--all-architectures',
      `-R=anchor apple generic and identifier "${config.applicationIdentifier}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${config.publisherTeamID}"`,
      root
    ])
    const signature = await run('/usr/bin/codesign', ['--display', '--verbose=4', root])
    if (
      /^Identifier=(.+)$/mu.exec(signature)?.[1] !== config.applicationIdentifier ||
      /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(signature)?.[1] !== config.publisherTeamID ||
      signature.includes('Signature=adhoc')
    )
      throw new Error('更新App公开发布签名不匹配。')
    return {
      version,
      identifier: config.applicationIdentifier,
      team: config.publisherTeamID,
      signatureVerified: true
    }
  }
  // Called only during separately authorized installation/recovery, never by
  // state/prepare. OS trust evaluation may contact Apple's trust/ticket servers.
  async inspectInstalled(
    config: Readonly<AppReleaseConfiguration>,
    assertCurrent: () => void
  ): Promise<{
    application: MacApplicationObservation
    receiptVersion: string | null
  }> {
    const run = this.run(assertCurrent)
    const application = await this.application(this.currentApplicationRoot(), config, assertCurrent)
    let receiptVersion: string | null = null
    try {
      const raw = plist(
        Buffer.from(await run('/usr/sbin/pkgutil', ['--pkg-info-plist', config.packageIdentifier]))
      )
      if (raw['pkgid'] !== config.packageIdentifier) throw new Error('安装收据身份不符。')
      receiptVersion = appVersion(raw['pkg-version'])
    } catch {
      assertCurrent()
      /* Missing/unreadable receipt remains unconfirmed, never success. */
    }
    return { application, receiptVersion }
  }
  async installerRunning(assertCurrent: () => void): Promise<boolean> {
    const run = this.run(assertCurrent)
    const output = await run('/bin/ps', ['-ax', '-o', 'comm='])
    return output
      .split('\n')
      .some(
        (line) =>
          line.trim() === '/System/Library/CoreServices/Installer.app/Contents/MacOS/Installer'
      )
  }
  async verifyPackage(
    stored: StoredAppUpdate & { path: string },
    config: Readonly<AppReleaseConfiguration>,
    assertCurrent: () => void
  ): Promise<MacPackageVerification> {
    const run = this.run(assertCurrent)
    const before = await hashAppUpdateFile(stored.path, stored.release.bytes)
    if (before.sha256 !== stored.candidate.sha256) throw new Error('安装包确认后已变化。')
    const signature = await run('/usr/sbin/pkgutil', ['--check-signature', stored.path])
    if (
      !signature.includes('Status: signed by a certificate trusted by') ||
      /^\s*1\. Developer ID Installer: [^\n]+ \(([A-Z0-9]{10})\)\s*$/mu.exec(signature)?.[1] !==
        config.publisherTeamID
    )
      throw new Error('安装包不是固定发布方签名的可信PKG。')
    const assessment = await run('/usr/sbin/spctl', [
      '--assess',
      '--type',
      'install',
      '--verbose=4',
      stored.path
    ])
    if (!/^source=Notarized Developer ID$/mu.test(assessment))
      throw new Error('系统未明确确认安装包的公开公证发布来源。')
    // This authorized system trust assessment may contact Apple. Do not call
    // developer-only stapler/lipo or describe this as offline ticket validation.
    await this.store.files.directory(this.store.root, true)
    const stage = await mkdtemp(join(this.store.root, '.verify-')),
      identity = await lstat(stage)
    try {
      const expanded = join(stage, 'expanded')
      await run('/usr/sbin/pkgutil', ['--expand-full', stored.path, expanded], 1024 * 1024)
      const entries = await paths(expanded, 100000, true)
      const packageInfos = entries.filter((path) => path.endsWith('/PackageInfo'))
      if (packageInfos.length !== 1) throw new Error('安装包必须只含本次Relay组件。')
      const metadata = appUpdatePackageInfo(
        await readAppUpdateFile(packageInfos[0], 1024 * 1024, false)
      )
      if (
        metadata.getAttribute('identifier') !== config.packageIdentifier ||
        metadata.getAttribute('version') !== stored.release.version
      )
        throw new Error('安装包组件ID或版本不匹配。')
      const distribution = entries.filter((path) => path.endsWith('/Distribution'))
      if (distribution.length !== 1 || distribution[0] !== join(expanded, 'Distribution'))
        throw new Error('应用更新必须提供唯一的产品安装描述。')
      const bundle = entries.filter((path) => path.endsWith('/' + config.applicationBundleName))
      if (bundle.length !== 1) throw new Error('安装包不含唯一Relay App。')
      const payload = join(dirname(packageInfos[0]), 'Payload')
      if (!bundle[0].startsWith(payload + '/')) throw new Error('安装App不属于已核实的组件。')
      const location = metadata.getAttribute('install-location')
      if (
        !location?.startsWith('/') ||
        posix.normalize(posix.join(location, relative(payload, bundle[0]))) !==
          '/Applications/Relay.app'
      )
        throw new Error('安装包目标路径不受支持。')
      for (const path of entries.filter((path) => path.startsWith(payload + '/'))) {
        if (path === bundle[0] || bundle[0].startsWith(path + '/')) continue
        throw new Error('安装包在Relay App以外还有未知负载。')
      }
      const scripts = appUpdateDistributionScriptHashes(
        await readAppUpdateFile(distribution[0], 1024 * 1024, false),
        config,
        basename(dirname(packageInfos[0])),
        stored.release.architecture
      )
      for (const node of Array.from(metadata.getElementsByTagName('scripts')))
        scripts.push(appUpdateHash(Buffer.from(node.toString())))
      for (const path of entries) {
        if (
          (path.includes('/Scripts/') || basename(path) === 'Scripts') &&
          (await lstat(path)).isFile()
        )
          scripts.push(appUpdateHash(await readAppUpdateFile(path, 16 * 1024 * 1024, false)))
      }
      if (scripts.some((digest) => !config.approvedInstallerScriptSHA256.includes(digest)))
        throw new Error('安装包包含尚未审查的安装脚本。')
      const app = await this.application(bundle[0], config, assertCurrent)
      if (app.version !== stored.release.version) throw new Error('包内App版本不匹配。')
      const info = plist(
        await readAppUpdateFile(join(bundle[0], 'Contents/Info.plist'), 1024 * 1024, false)
      )
      const systemVersion = (raw: unknown): string => {
        if (typeof raw !== 'string' || !/^\d{1,3}(\.\d{1,3}){0,2}$/u.test(raw))
          throw new Error('系统或App最低系统版本无效。')
        const parts = raw.split('.').map((value) => String(Number(value)))
        while (parts.length < 3) parts.push('0')
        return parts.join('.')
      }
      const actualSystem = (await run('/usr/bin/sw_vers', ['-productVersion'])).trim()
      if (compare(systemVersion(actualSystem), systemVersion(info.LSMinimumSystemVersion)) < 0)
        throw new Error('本机macOS不满足更新App的最低系统要求。')
      const architectures = await macBinaryArchitectures(
        join(bundle[0], 'Contents/MacOS', String(info.CFBundleExecutable))
      )
      if (
        !architectures.includes(stored.release.architecture === 'x64' ? 'x86_64' : 'arm64') ||
        architectures.some((value) => !['arm64', 'x86_64'].includes(value))
      )
        throw new Error('包内App架构不符。')
      if (
        (await hashAppUpdateFile(stored.path, stored.release.bytes)).sha256 !==
        stored.candidate.sha256
      )
        throw new Error('安装包校验期间已变化。')
      return {
        sha256: stored.candidate.sha256,
        version: stored.release.version,
        packageIdentifier: config.packageIdentifier,
        applicationIdentifier: app.identifier,
        team: app.team,
        architecture: stored.release.architecture,
        gatekeeperAccepted: true,
        notarizationAssessed: true
      }
    } finally {
      const current = await lstat(stage)
      if (
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        current.isDirectory() &&
        !current.isSymbolicLink()
      )
        await rm(stage, { recursive: true })
    }
  }
  async openInstaller(
    stored: StoredAppUpdate & { path: string },
    assertCurrent: () => void,
    assertLeaseCurrent: () => Promise<void>
  ): Promise<void> {
    const run = this.run(assertCurrent)
    const installer = '/System/Library/CoreServices/Installer.app'
    await run('/usr/bin/codesign', [
      '--verify',
      '--strict',
      '-R=anchor apple and identifier "com.apple.installer"',
      installer
    ])
    // The durable intent, native signature check and lease observation all
    // precede this readback. Only the approved owned file may reach open.
    await assertLeaseCurrent()
    assertCurrent()
    await hashAppUpdateFile(stored.path, stored.release.bytes, async (observed) => {
      if (
        observed.bytes !== stored.release.bytes ||
        observed.sha256 !== stored.candidate.sha256 ||
        observed.sha512 !== stored.release.sha512
      )
        throw new Error('交接前安装包已变化。')
      // A different Installer may have started during package verification.
      // Recheck after reading the bytes, with the file still held for identity readback.
      if (await this.installerRunning(assertCurrent)) throw new AppInstallerAlreadyRunning()
    })
    // Use Apple's fixed Installer, never a user-changeable .pkg file association.
    await run('/usr/bin/open', ['-a', installer, '--', stored.path])
  }
}
