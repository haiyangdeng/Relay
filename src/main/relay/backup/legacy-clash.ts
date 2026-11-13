import { randomUUID } from 'crypto'
import { lstat, mkdir, readdir, realpath, writeFile } from 'fs/promises'
import { join, posix } from 'path'
import AdmZip from 'adm-zip'
import type {
  LegacyClashDisposition,
  LegacyClashMigrationReport
} from '../../../shared/relay/legacy-clash'
import {
  configurationEditDocument,
  defaultEditDocument,
  type ConfigurationEditDocument
} from '../../../shared/relay/configuration-edit'
import type { SourceOptions } from '../../../shared/relay/subscription-sources'
import { localProxyPort } from '../../../shared/relay/local-proxy'
import { subscriptionRequest } from '../../../shared/relay/subscription'
import { shellSettings, shellThemeLibrary, type RelayShellTheme } from '../../../shared/relay/shell'
import { decryptAgeContent } from '../../utils/age'
import { ProfileStore } from '../profiles/store'
import { inspectProfile, PROFILE_BYTE_LIMIT } from '../profiles/inspect'
import { readConfigurationMap } from '../profiles/document'
import { SubscriptionSourceStore } from '../subscriptions/source-store'
import { sourceOptions } from '../subscriptions/source-options'
import { ConfigurationEditStore } from '../configuration/edit-store'
import { readShellSnapshot, RelayShellStore } from '../shell/store'
import type { RuntimeOverride, RuntimeRulePatch } from '../configuration/merge'
import {
  BACKUP_ARCHIVE_MAX_BYTES,
  BACKUP_MAX_BYTES,
  BACKUP_MAX_FILES,
  backupHash,
  backupSnapshotSHA256,
  createBackupArchive,
  type BackupSnapshot
} from './archive'
import { RelayBackupStore } from './store'
import { convertLegacySubStore, type LegacySubStoreResult } from './legacy-substore'

type Item = Record<string, unknown>
interface LegacyProfile {
  id: string
  type: 'local' | 'remote' | 'plugin'
  name: string
  overrides: string[]
  url?: string
  authToken?: string
  userAgent?: string
  ageSecretKey?: string
}
interface LegacyOverride {
  id: string
  kind: 'js' | 'yaml'
  global: boolean
}
const object = (value: unknown): value is Item =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const clean = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
const legacyId = (value: unknown): string => {
  const id = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  if (!clean(id, 128) || !/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error('旧记录标识无效。')
  return id
}
const text = (bytes: Buffer, limit = PROFILE_BYTE_LIMIT, ignoreBOM = false): string => {
  if (bytes.length > limit) throw new Error('旧文本条目超限。')
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM }).decode(bytes)
}
function mapping(bytes: Buffer): Item {
  const data = readConfigurationMap(text(bytes)).data
  if (!data) throw new Error('旧索引未通过有界映射检查。')
  return data
}
const profileFields = new Set([
  'id',
  'type',
  'name',
  'url',
  'file',
  'interval',
  'home',
  'updated',
  'override',
  'useProxy',
  'extra',
  'substore',
  'allowFixedInterval',
  'autoUpdate',
  'authToken',
  'userAgent',
  'ageSecretKey',
  'updateTimeout',
  'pluginId'
])
function profileIndex(value: Item): LegacyProfile[] {
  if (
    Object.keys(value).some((k) => !['current', 'items'].includes(k)) ||
    !Array.isArray(value.items) ||
    value.items.length > 200
  )
    throw new Error('旧配置索引结构无效。')
  if (value.current !== undefined) legacyId(value.current)
  const seen = new Set<string>()
  return value.items.map((raw) => {
    if (!object(raw) || Object.keys(raw).some((k) => !profileFields.has(k)))
      throw new Error('旧配置索引含未知字段。')
    const id = legacyId(raw.id)
    if (
      seen.has(id) ||
      !['local', 'remote', 'plugin'].includes(String(raw.type)) ||
      !clean(raw.name, 120) ||
      !raw.name.trim()
    )
      throw new Error('旧配置标识、类型或名称无效。')
    seen.add(id)
    for (const key of ['url', 'file', 'home', 'authToken', 'userAgent', 'ageSecretKey', 'pluginId'])
      if (
        raw[key] !== undefined &&
        (typeof raw[key] !== 'string' || Buffer.byteLength(raw[key]) > PROFILE_BYTE_LIMIT)
      )
        throw new Error('旧配置文本字段无效。')
    for (const key of ['useProxy', 'substore', 'allowFixedInterval', 'autoUpdate'])
      if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
        throw new Error('旧配置布尔字段无效。')
    for (const key of ['updated', 'updateTimeout'])
      if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])))
        throw new Error('旧配置数值无效。')
    if (
      raw.interval !== undefined &&
      !(
        (typeof raw.interval === 'number' && Number.isFinite(raw.interval)) ||
        clean(raw.interval, 256)
      )
    )
      throw new Error('旧配置周期无效。')
    if (
      raw.extra !== undefined &&
      (!object(raw.extra) ||
        Object.entries(raw.extra).some(
          ([k, v]) =>
            !['upload', 'download', 'total', 'expire'].includes(k) ||
            typeof v !== 'number' ||
            !Number.isFinite(v)
        ))
    )
      throw new Error('旧配额元数据无效。')
    if (raw.override !== undefined && !Array.isArray(raw.override))
      throw new Error('旧覆写引用无效。')
    return {
      id,
      type: raw.type as LegacyProfile['type'],
      name: raw.name,
      overrides: Array.isArray(raw.override) ? raw.override.map(legacyId) : [],
      ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
      ...(typeof raw.authToken === 'string' ? { authToken: raw.authToken } : {}),
      ...(typeof raw.userAgent === 'string' ? { userAgent: raw.userAgent } : {}),
      ...(typeof raw.ageSecretKey === 'string' ? { ageSecretKey: raw.ageSecretKey } : {})
    }
  })
}
function overrideIndex(value: Item): LegacyOverride[] {
  if (
    Object.keys(value).join(',') !== 'items' ||
    !Array.isArray(value.items) ||
    value.items.length > 200
  )
    throw new Error('旧覆写索引无效。')
  const seen = new Set<string>()
  return value.items.map((raw) => {
    if (
      !object(raw) ||
      Object.keys(raw).some(
        (k) => !['id', 'type', 'ext', 'name', 'updated', 'global', 'url', 'file'].includes(k)
      )
    )
      throw new Error('旧覆写索引含未知字段。')
    const id = legacyId(raw.id)
    if (
      seen.has(id) ||
      !['local', 'remote'].includes(String(raw.type)) ||
      !['js', 'yaml'].includes(String(raw.ext)) ||
      !clean(raw.name, 120) ||
      !raw.name.trim() ||
      (raw.global !== undefined && typeof raw.global !== 'boolean')
    )
      throw new Error('旧覆写字段无效。')
    if (
      raw.updated !== undefined &&
      (typeof raw.updated !== 'number' || !Number.isFinite(raw.updated))
    )
      throw new Error('旧覆写时间无效。')
    for (const key of ['url', 'file'])
      if (raw[key] !== undefined && typeof raw[key] !== 'string')
        throw new Error('旧覆写文本无效。')
    seen.add(id)
    return { id, kind: raw.ext as LegacyOverride['kind'], global: raw.global === true }
  })
}

// The fixed resolve/backup.ts uses these exact names. A failed Relay manifest
// is never reinterpreted as this format; no legacy extractAllTo call is used.
export function parseLegacyClashArchive(bytes: Buffer): {
  files: Map<string, Buffer>
  profiles: LegacyProfile[]
  overrides: LegacyOverride[]
  userAgent?: string
} {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > BACKUP_ARCHIVE_MAX_BYTES)
    throw new Error('旧备份压缩文件超限。')
  const files = new Map<string, Buffer>(),
    names = new Set<string>()
  let total = 0
  try {
    const zip = new AdmZip(bytes),
      entries = zip.getEntries()
    if (!entries.length || entries.length > BACKUP_MAX_FILES) throw new Error()
    for (const entry of entries) {
      const path = entry.isDirectory ? entry.entryName.replace(/\/$/u, '') : entry.entryName
      const folded = path.normalize('NFC').toLocaleLowerCase('en-US'),
        mode = (entry.attr >>> 16) & 0o170000,
        parts = path.split('/'),
        finderMetadata = !entry.isDirectory && path.endsWith('/.DS_Store'),
        substoreEnvironment = !entry.isDirectory && path === 'substore/.env'
      if (
        !path ||
        path.length > 1024 ||
        /[\\]/u.test(path) ||
        [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        posix.normalize(path) !== path ||
        path.startsWith('/') ||
        parts.some(
          (p, index) =>
            !p ||
            (p.startsWith('.') &&
              !((finderMetadata || substoreEnvironment) && index === parts.length - 1))
        ) ||
        names.has(folded) ||
        (entry.isDirectory &&
          ['config.yaml', 'mihomo.yaml', 'profile.yaml', 'override.yaml'].includes(path)) ||
        (!entry.isDirectory &&
          ['themes', 'profiles', 'override', 'rules', 'substore'].includes(path)) ||
        !(
          ['config.yaml', 'mihomo.yaml', 'profile.yaml', 'override.yaml'].includes(path) ||
          ['themes', 'profiles', 'override', 'rules', 'substore'].some(
            (root) => path === root || path.startsWith(root + '/')
          )
        ) ||
        (mode !== 0 && mode !== (entry.isDirectory ? 0o040000 : 0o100000)) ||
        entry.header.flags & 1
      )
        throw new Error()
      names.add(folded)
      total += entry.header.size
      if (entry.header.size > BACKUP_MAX_BYTES || total > BACKUP_MAX_BYTES) throw new Error()
      if (entry.isDirectory) continue
      if (
        !finderMetadata &&
        ['profiles', 'override', 'rules'].some((root) => path.startsWith(root + '/')) &&
        !/^(?:profiles|rules)\/[A-Za-z0-9_-]+\.yaml$|^override\/[A-Za-z0-9_-]+\.(?:js|yaml|log)$/u.test(
          path
        )
      )
        throw new Error()
      const content = entry.getData()
      if (content.length !== entry.header.size) throw new Error()
      files.set(path, Buffer.from(content))
    }
    const fileNames = new Set(
      [...files.keys()].map((path) => path.normalize('NFC').toLocaleLowerCase('en-US'))
    )
    for (const path of names) {
      const parts = path.split('/')
      for (let length = 1; length < parts.length; length++)
        if (fileNames.has(parts.slice(0, length).join('/'))) throw new Error()
    }
    const profileFile = files.get('profile.yaml')
    if (!profileFile) throw new Error()
    const profiles = profileIndex(mapping(profileFile)),
      overrideFile = files.get('override.yaml')
    const overrides = overrideFile ? overrideIndex(mapping(overrideFile)) : []
    if (!profiles.some((p) => p.id === 'default') && files.has('profiles/default.yaml'))
      profiles.push({ id: 'default', type: 'local', name: 'Legacy default', overrides: [] })
    const appFile = files.get('config.yaml'),
      app = appFile ? mapping(appFile) : undefined
    return {
      files,
      profiles,
      overrides,
      ...(clean(app?.userAgent, 4096) && app.userAgent ? { userAgent: app.userAgent } : {})
    }
  } catch {
    throw new Error('旧Clash备份布局、索引、路径或正文未通过；未解压到用户目录。')
  }
}

export async function convertLegacyClashArchive(input: {
  bytes: Buffer
  baseline: BackupSnapshot
  temporaryHome: string
  proxyPort?: number
  signal: AbortSignal
}): Promise<{
  archiveBytes?: Buffer
  expectedBaselineSHA256: string
  report: LegacyClashMigrationReport
}> {
  const check = (): void => {
    if (input.signal.aborted) throw new Error('旧备份迁移已取消。')
  }
  check()
  const expectedBaselineSHA256 = backupSnapshotSHA256(input.baseline),
    parsed = parseLegacyClashArchive(input.bytes)
  const home = await lstat(input.temporaryHome)
  if (
    !home.isDirectory() ||
    home.isSymbolicLink() ||
    home.uid !== process.getuid?.() ||
    (home.mode & 0o7777) !== 0o700 ||
    (await realpath(input.temporaryHome)) !== input.temporaryHome ||
    (await readdir(input.temporaryHome)).length
  )
    throw new Error('迁移仅写入本次独占的空私有临时home。')
  if (input.proxyPort !== undefined) localProxyPort(input.proxyPort)
  const context = {
      home: input.temporaryHome,
      stateRoot: join(input.temporaryHome, 'Library/Application Support/Relay')
    },
    profiles = new ProfileStore(context),
    sources = new SubscriptionSourceStore(context),
    edits = new ConfigurationEditStore(context)
  const baselineEdit = input.baseline.entries.find(
    (e) => e.path === 'Configuration/configuration-edit.json'
  )
  let document: ConfigurationEditDocument = baselineEdit
    ? configurationEditDocument(JSON.parse(text(baselineEdit.bytes, 1024 * 1024)))
    : defaultEditDocument()
  const report: LegacyClashMigrationReport = {
    format: 'clash-party-legacy-zip',
    archiveSHA256: backupHash(input.bytes),
    containsSecrets: true,
    files: [...parsed.files].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: backupHash(bytes),
      disposition: 'retained',
      reason: path.endsWith('/.DS_Store')
        ? 'Finder目录元数据仅保留在原ZIP中，不作为配置、覆写或规则迁移。'
        : path === 'config.yaml'
          ? '旧应用设置及秘密元数据保留原件，不继承系统或网络授权。'
          : path === 'mihomo.yaml'
            ? '旧监听、DNS、TUN等受控设置保留原件，不自动应用。'
            : path === 'profile.yaml'
              ? '索引用于识别来源；未映射的历史元数据保留原件。'
              : path === 'override.yaml'
                ? '索引用于保留覆写顺序；旧获取地址及其他元数据保留原件。'
                : path.startsWith('themes/')
                  ? '非直接CSS主题条目仅保留原件，未启用。'
                  : path.startsWith('substore/')
                    ? path === 'substore/.env'
                      ? '旧环境与秘密配置仅保留原件，不载入活动库或继承后台任务。'
                      : '旧Sub-Store缓存、设置与任务保留原件，不直接交给后台运行。'
                    : path.endsWith('.log')
                      ? '诊断日志保留原件，不作为可执行覆写迁移。'
                      : path.startsWith('profiles/')
                        ? '缓存尚未绑定到已迁移的有效索引，保留原件。'
                        : path.startsWith('rules/')
                          ? '来源级规则尚未绑定到已迁移来源，保留原件。'
                          : '覆写尚未被已迁移来源引用，保留原件且不执行。'
    })),
    profiles: [],
    counts: {
      profiles: 0,
      sources: 0,
      overrides: 0,
      rulePatches: 0,
      applied: 0,
      retained: 0,
      'decision-required': 0
    }
  }
  const rank = { applied: 0, retained: 1, 'decision-required': 2 },
    touched = new Set<string>()
  const mark = (path: string, disposition: LegacyClashDisposition, reason: string): void => {
    const row = report.files.find((f) => f.path === path)
    if (row && (!touched.has(path) || rank[disposition] >= rank[row.disposition])) {
      row.disposition = disposition
      row.reason = reason
      touched.add(path)
    }
  }
  const themeCandidates: { path: string; theme: RelayShellTheme }[] = []
  for (const [path, bytes] of parsed.files) {
    if (!/^themes\/[^/]+\.css$/u.test(path)) continue
    check()
    try {
      const css = text(bytes, 8192, true),
        file = posix.basename(path),
        name = css.startsWith('/*')
          ? css.split('\n')[0].replace('/*', '').replace('*/', '').trim() || file
          : file,
        [theme] = shellThemeLibrary([{ id: randomUUID(), name, css }])
      themeCandidates.push({ path, theme })
    } catch {
      mark(path, 'decision-required', 'theme-name-or-css-invalid-original-preserved')
    }
  }
  let migratedThemes = 0
  if (themeCandidates.length) {
    const baselineShell = input.baseline.entries.find((entry) => entry.path === 'UI/shell.json')
    const baselineDisplay = input.baseline.entries.find(
      (entry) => entry.path === 'UI/shell-display.json'
    )
    const baselineStartup = input.baseline.entries.find(
      (entry) => entry.path === 'UI/shell-startup.json'
    )
    let settings = readShellSnapshot(
      baselineShell?.bytes,
      baselineDisplay?.bytes,
      baselineStartup?.bytes
    ).record.settings
    const names = new Map<string, number>()
    for (const { theme } of themeCandidates) {
      const name = theme.name.toLowerCase()
      names.set(name, (names.get(name) ?? 0) + 1)
    }
    for (const { path, theme } of themeCandidates) {
      check()
      if (
        names.get(theme.name.toLowerCase()) !== 1 ||
        settings.themes.some((existing) => existing.name.toLowerCase() === theme.name.toLowerCase())
      ) {
        mark(path, 'decision-required', 'theme-name-conflict-original-preserved')
        continue
      }
      try {
        settings = shellSettings({ ...settings, themes: [...settings.themes, theme] })
      } catch {
        mark(path, 'decision-required', 'theme-library-capacity-exceeded-original-preserved')
        continue
      }
      migratedThemes++
      mark(path, 'applied', 'theme-added-to-library-not-enabled')
    }
    // Only the isolated conversion home is written. The selected baseline's
    // active CSS and all other settings remain the source for this library.
    if (migratedThemes) await new RelayShellStore(context).save(settings, '')
    check()
  }
  let migratedSubStore = false
  const substorePath = 'substore/sub-store.json',
    substoreBytes = parsed.files.get(substorePath)
  if (substoreBytes) {
    check()
    let converted: LegacySubStoreResult | undefined
    try {
      converted = convertLegacySubStore(
        substoreBytes,
        input.baseline.entries.find((entry) => entry.path === 'SubStore/Data/sub-store.json')?.bytes
      )
    } catch (error) {
      mark(
        substorePath,
        'decision-required',
        error instanceof Error ? error.message : 'Sub-Store已知格式检查未完成，原件保留。'
      )
    }
    check()
    if (converted) {
      report.substore = converted.summary
      const retained = converted.summary.items.some((item) => item.disposition === 'retained')
      mark(
        substorePath,
        retained || !converted.bytes ? 'decision-required' : 'applied',
        `仅准备基础订阅${converted.summary.subscriptions}项、静态集合${converted.summary.collections}项；流量自动查询关闭。其余逐项留在原件，未启动Sub-Store。`
      )
      if (converted.bytes) {
        const directory = join(context.stateRoot, 'SubStore/Data')
        await mkdir(directory, { recursive: true, mode: 0o700 })
        check()
        await writeFile(join(directory, 'sub-store.json'), converted.bytes, {
          flag: 'wx',
          mode: 0o600
        })
        migratedSubStore = true
      }
      check()
    }
  }
  const namespace = randomUUID(),
    global = parsed.overrides.filter((o) => o.global).map((o) => o.id)
  for (const legacy of parsed.profiles) {
    check()
    const path = 'profiles/' + legacy.id + '.yaml',
      bytes = parsed.files.get(path),
      references = [...new Set([...global, ...legacy.overrides])]
    if (!bytes) {
      report.profiles.push({
        legacyId: legacy.id,
        disposition: 'decision-required',
        reason: 'cached-profile-missing'
      })
      continue
    }
    const missing = references.some(
      (id) =>
        !parsed.overrides.some((o) => o.id === id) ||
        !parsed.files.has('override/' + id + '.' + parsed.overrides.find((o) => o.id === id)?.kind)
    )
    if (missing) {
      mark(path, 'decision-required', 'override-reference-missing')
      report.profiles.push({
        legacyId: legacy.id,
        disposition: 'decision-required',
        reason: 'override-reference-missing'
      })
      continue
    }
    let source: string, overrides: RuntimeOverride[], patch: RuntimeRulePatch | undefined
    try {
      source = await decryptAgeContent(text(bytes), legacy.ageSecretKey, 'legacy profile')
      check()
      if (
        Buffer.byteLength(source) > PROFILE_BYTE_LIMIT ||
        inspectProfile(source).structure !== 'passed'
      )
        throw new Error()
      overrides = []
      for (const id of references) {
        const definition = parsed.overrides.find((o) => o.id === id)
        if (!definition) throw new Error()
        const contentBytes = parsed.files.get('override/' + id + '.' + definition.kind)
        if (!contentBytes) throw new Error()
        const raw = text(contentBytes, definition.kind === 'js' ? 65536 : PROFILE_BYTE_LIMIT),
          content =
            definition.kind === 'yaml'
              ? await decryptAgeContent(raw, legacy.ageSecretKey, 'legacy override')
              : raw
        check()
        overrides.push({
          id: namespace + ':' + id,
          kind: definition.kind,
          content,
          ...(id === 'smart-core-override' ? { role: 'smart' as const } : {})
        })
      }
      const ruleBytes = parsed.files.get('rules/' + legacy.id + '.yaml')
      if (ruleBytes) {
        const checked = configurationEditDocument({
          ...defaultEditDocument(),
          rulePatch: mapping(ruleBytes)
        })
        patch = checked.rulePatch
      }
      // Validate source-scoped capacity and content before creating even the
      // isolated profile record. Existing global fields remain unchanged.
      const probeId = randomUUID()
      configurationEditDocument({
        ...document,
        ...(overrides.length
          ? {
              profileOverrideSets: [
                ...(document.profileOverrideSets ?? []),
                { profileId: probeId, overrides }
              ]
            }
          : {}),
        ...(patch
          ? {
              profileRulePatchSets: [
                ...(document.profileRulePatchSets ?? []),
                { profileId: probeId, rulePatch: patch }
              ]
            }
          : {})
      })
    } catch {
      check()
      mark(path, 'decision-required', 'profile-key-content-or-linked-edit-unavailable')
      report.profiles.push({
        legacyId: legacy.id,
        disposition: 'decision-required',
        reason: 'profile-key-content-or-linked-edit-unavailable'
      })
      continue
    }
    const saved = await profiles.save(legacy.name, source)
    check()
    if (
      input.baseline.entries.some((e) => e.path.startsWith('Configurations/' + saved.id + '/')) ||
      input.baseline.directories.includes('Configurations/' + saved.id)
    )
      throw new Error('新迁移ID与当前记录冲突。')
    if (overrides.length)
      document = configurationEditDocument({
        ...document,
        profileOverrideSets: [
          ...(document.profileOverrideSets ?? []),
          { profileId: saved.id, overrides }
        ]
      })
    if (patch)
      document = configurationEditDocument({
        ...document,
        profileRulePatchSets: [
          ...(document.profileRulePatchSets ?? []),
          { profileId: saved.id, rulePatch: patch }
        ]
      })
    report.counts.profiles++
    report.counts.overrides += overrides.length
    if (patch) report.counts.rulePatches++
    mark(path, 'applied', 'cached-profile-copied-to-new-uuid')
    for (const id of references) {
      const definition = parsed.overrides.find((o) => o.id === id)
      if (definition)
        mark(
          'override/' + id + '.' + definition.kind,
          'applied',
          'stored-for-new-source-only-not-executed'
        )
    }
    if (patch) mark('rules/' + legacy.id + '.yaml', 'applied', 'stored-for-new-source-only')
    const item: LegacyClashMigrationReport['profiles'][number] = {
      legacyId: legacy.id,
      profileId: saved.id,
      disposition: 'applied',
      reason:
        legacy.type === 'local'
          ? 'cached-local-profile'
          : legacy.type === 'plugin'
            ? 'plugin-binding-unavailable-cache-copied'
            : 'cache-copied-remote-definition-retained'
    }
    if (legacy.type === 'remote' && legacy.url && input.proxyPort !== undefined) {
      let options: SourceOptions | undefined
      try {
        options = sourceOptions({
          headers: {
            ...(legacy.authToken ? { Authorization: legacy.authToken } : {}),
            ...(legacy.userAgent || parsed.userAgent
              ? { 'User-Agent': legacy.userAgent || parsed.userAgent }
              : {})
          },
          ageSecretKey: legacy.ageSecretKey ?? '',
          redirects: 'none',
          schedule: { kind: 'manual' },
          useServerInterval: false
        })
        // Validate without issuing or authorizing a download.
        subscriptionRequest({ name: legacy.name, url: legacy.url, proxyPort: input.proxyPort })
      } catch {
        options = undefined
      }
      if (options) {
        const registered = await sources.create(
          { name: legacy.name, url: legacy.url, proxyPort: input.proxyPort },
          options
        )
        await sources.commit({ id: registered.id, revision: registered.revision }, async () => ({
          profile: { id: saved.id, sha256: saved.sha256 }
        }))
        check()
        if (
          input.baseline.entries.some((e) =>
            e.path.startsWith('SubscriptionSources/' + registered.id + '/')
          ) ||
          input.baseline.directories.includes('SubscriptionSources/' + registered.id)
        )
          throw new Error('新迁移来源ID冲突。')
        item.sourceId = registered.id
        item.reason = 'cached-profile-and-manual-source-copied'
        report.counts.sources++
      } else {
        item.disposition = 'decision-required'
        item.reason = 'remote-definition-not-supported-cached-profile-preserved'
      }
    } else if (legacy.type === 'remote' && !legacy.url) {
      item.disposition = 'decision-required'
      item.reason = 'remote-url-missing-cached-profile-preserved'
    }
    report.profiles.push(item)
  }
  check()
  for (const row of report.files) report.counts[row.disposition]++
  // Missing cache files have no archive row; source-level decisions must still
  // be visible in the summary instead of reporting a clean zero-change import.
  report.counts['decision-required'] += report.profiles.filter(
    (item) =>
      item.disposition === 'decision-required' &&
      !report.files.some(
        (row) =>
          row.path === 'profiles/' + item.legacyId + '.yaml' &&
          row.disposition === 'decision-required'
      )
  ).length
  if (!report.counts.profiles && !migratedThemes && !migratedSubStore)
    return { expectedBaselineSHA256, report }
  if (report.counts.overrides || report.counts.rulePatches) await edits.save(document)
  check()
  const generated = await new RelayBackupStore(context).snapshot(),
    entries = new Map<string, BackupSnapshot['entries'][number]>(
      input.baseline.entries.map((e) => [e.path, { ...e, bytes: Buffer.from(e.bytes) }])
    )
  for (const entry of generated.entries) {
    if (
      entries.has(entry.path) &&
      entry.path !== 'Configuration/configuration-edit.json' &&
      !(
        migratedThemes &&
        ['UI/shell.json', 'UI/shell-display.json', 'UI/shell-startup.json'].includes(entry.path)
      ) &&
      !(migratedSubStore && entry.path === 'SubStore/Data/sub-store.json')
    )
      throw new Error('迁移拒绝覆盖既有数据。')
    entries.set(entry.path, entry)
  }
  const merged: BackupSnapshot = {
    directories: [...new Set([...input.baseline.directories, ...generated.directories])],
    entries: [...entries.values()]
  }
  if (backupSnapshotSHA256(input.baseline) !== expectedBaselineSHA256)
    throw new Error('转换期间当前基线输入已变化。')
  check()
  return { archiveBytes: createBackupArchive(merged), expectedBaselineSHA256, report }
}
