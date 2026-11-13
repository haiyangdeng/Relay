import { createHash } from 'crypto'
import type {
  LegacySubStoreItemReport,
  LegacySubStoreSummary
} from '../../../shared/relay/legacy-clash'
export type {
  LegacySubStoreItemReport,
  LegacySubStoreSummary
} from '../../../shared/relay/legacy-clash'

// Sub-Store 2.44.2, AGPL-3.0.
// License: https://github.com/sub-store-org/Sub-Store/blob/2.44.2/LICENSE
// https://github.com/sub-store-org/Sub-Store/blob/2.44.2/backend/src/utils/migration.js
// Original file SHA256: 36390c09bb34047554b83eab7cc5df36e3ee7fd72107d726ed5721abc307677a
// The pure migration below keeps the upstream control flow and transformations.
// Changes: TypeScript annotations and an in-memory $ adapter replace app imports;
// no backend initialization, persistence, environment, cache IO or user code runs.
export const legacySubStoreSource = {
  version: '2.44.2',
  license: 'AGPL-3.0',
  url: 'https://github.com/sub-store-org/Sub-Store/blob/2.44.2/backend/src/utils/migration.js',
  sha256: '36390c09bb34047554b83eab7cc5df36e3ee7fd72107d726ed5721abc307677a'
} as const

const MAX_BYTES = 2 * 1024 * 1024,
  MAX_ITEMS = 200
type Data = Record<string, unknown>
interface Process {
  type?: string
  args?: Record<string, unknown> | boolean
}
interface MigrationItem extends Data {
  source?: string
  process?: Process[]
}
interface MigrationCache {
  schemaVersion?: string
  subs: MigrationItem[] | Record<string, MigrationItem>
  collections: MigrationItem[] | Record<string, MigrationItem>
  artifacts: unknown[] | Data
  rules: unknown[] | Data
  files: unknown[] | Data
  tokens: unknown[] | Data
  builtin?: unknown
}

function migrate(cache: MigrationCache): void {
  const SUBS_KEY = 'subs',
    COLLECTIONS_KEY = 'collections',
    SCHEMA_VERSION_KEY = 'schemaVersion',
    ARTIFACTS_KEY = 'artifacts',
    RULES_KEY = 'rules',
    FILES_KEY = 'files',
    TOKENS_KEY = 'tokens'
  const $ = {
    cache,
    read<K extends keyof MigrationCache>(key: K): MigrationCache[K] {
      return cache[key]
    },
    write<K extends keyof MigrationCache>(value: MigrationCache[K], key: K): void {
      cache[key] = value
    },
    info(message: string): void {
      void message
    }
  }
  migrateV2()
  function migrateV2(): void {
    const version = $.read(SCHEMA_VERSION_KEY)
    if (!version) doMigrationV2()
    if (version !== '2.0') $.write('2.0', SCHEMA_VERSION_KEY)
  }
  function doMigrationV2(): void {
    $.info('Start migrating...')
    const subs = $.read(SUBS_KEY) || {}
    const newSubs = Object.values(subs).map((sub) => {
      sub.source = sub.source || 'remote'
      migrateDisplayName(sub)
      migrateProcesses(sub)
      return sub
    })
    $.write(newSubs, SUBS_KEY)
    const collections = $.read(COLLECTIONS_KEY) || {}
    const newCollections = Object.values(collections).map((collection) => {
      delete collection.ua
      migrateDisplayName(collection)
      migrateProcesses(collection)
      return collection
    })
    $.write(newCollections, COLLECTIONS_KEY)
    const artifacts = $.read(ARTIFACTS_KEY) || {}
    $.write(Object.values(artifacts), ARTIFACTS_KEY)
    const rules = $.read(RULES_KEY) || {}
    $.write(Object.values(rules), RULES_KEY)
    const files = $.read(FILES_KEY) || {}
    $.write(Object.values(files), FILES_KEY)
    const tokens = $.read(TOKENS_KEY) || {}
    $.write(Object.values(tokens), TOKENS_KEY)
    delete $.cache.builtin
    $.info('Migration complete!')
    function migrateDisplayName(item: MigrationItem): void {
      const displayName = item['display-name']
      if (displayName) {
        item.displayName = displayName
        delete item['display-name']
      }
    }
    function migrateProcesses(item: MigrationItem): void {
      const processes = item.process
      if (!processes || processes.length === 0) return
      const newProcesses: Process[] = []
      const quickSettingOperator = {
        type: 'Quick Setting Operator',
        args: {
          udp: 'DEFAULT',
          tfo: 'DEFAULT',
          scert: 'DEFAULT',
          'vmess aead': 'DEFAULT',
          useless: 'DEFAULT'
        }
      }
      for (const p of processes) {
        if (!p.type) continue
        if (p.type === 'Useless Filter') {
          quickSettingOperator.args.useless = 'ENABLED'
        } else if (p.type === 'Set Property Operator') {
          const { key, value } = p.args as Record<string, unknown>
          switch (key) {
            case 'udp':
              quickSettingOperator.args.udp = value ? 'ENABLED' : 'DISABLED'
              break
            case 'tfo':
              quickSettingOperator.args.tfo = value ? 'ENABLED' : 'DISABLED'
              break
            case 'skip-cert-verify':
              quickSettingOperator.args.scert = value ? 'ENABLED' : 'DISABLED'
              break
            case 'aead':
              quickSettingOperator.args['vmess aead'] = value ? 'ENABLED' : 'DISABLED'
              break
          }
        } else if (p.type.indexOf('Keyword') !== -1) {
          // Upstream drops keyword operators/filters. Such inputs are rejected
          // before this pure migration, rather than silently losing behavior.
        } else if (p.type === 'Flag Operator') {
          const add = typeof p.args === 'undefined' ? true : p.args
          p.args = { mode: add ? 'add' : 'remove' }
          newProcesses.push(p)
        } else {
          newProcesses.push(p)
        }
      }
      newProcesses.unshift(quickSettingOperator)
      item.process = newProcesses
    }
  }
}

export interface LegacySubStoreResult {
  bytes?: Buffer
  summary: LegacySubStoreSummary
}
const object = (value: unknown): value is Data =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const controls = (value: string): boolean =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const name = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 128 && !controls(value)
// Compare JSON decimal values, rather than already-rounded JS numbers.
// Equivalent spellings (1e2 / 100, 1.2300 / 1.23) stay supported. This is not
// arbitrary-precision arithmetic: lossy numeric literals are refused entirely.
function decimal(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu.exec(value)
  if (!match) throw new Error()
  const fraction = match[3] ?? '',
    digits = (match[2] + fraction).replace(/^0+/u, '')
  if (!digits) return '0'
  const coefficient = digits.replace(/0+$/u, ''),
    exponent = Number(match[4] ?? 0)
  if (!Number.isSafeInteger(exponent)) throw new Error()
  return `${match[1]}${coefficient}e${exponent - fraction.length + digits.length - coefficient.length}`
}
function parse(bytes: Buffer, base64: boolean): Data {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES)
    throw new Error('Sub-Store资料超过2MiB或正文无效，原件保留。')
  try {
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    if (base64 && !text.startsWith('{')) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) throw new Error()
      const decoded = Buffer.from(text, 'base64')
      if (decoded.toString('base64').replace(/=+$/u, '') !== text.replace(/=+$/u, ''))
        throw new Error()
      text = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
    }
    const parsed: unknown = JSON.parse(
      text,
      (_key, value: unknown, context?: { source?: string }) => {
        if (
          typeof value === 'number' &&
          (!Number.isFinite(value) ||
            Object.is(value, -0) ||
            typeof context?.source !== 'string' ||
            decimal(context.source) !== decimal(JSON.stringify(value)))
        )
          throw new Error()
        return value
      }
    )
    if (!object(parsed)) throw new Error()
    return parsed
  } catch {
    throw new Error('Sub-Store资料不是有界UTF8 JSON对象或已知Base64封装，原件保留。')
  }
}
function list(value: unknown, legacy: boolean): unknown[] {
  const values = legacy
    ? value === undefined
      ? []
      : object(value)
        ? Object.values(value)
        : undefined
    : Array.isArray(value)
      ? value
      : undefined
  if (!values || values.length > MAX_ITEMS)
    throw new Error('Sub-Store订阅或集合布局无效或超过200项，原件保留。')
  return values
}
function baselineData(bytes?: Buffer): Data & { subs: Data[]; collections: Data[] } {
  const data = bytes
    ? parse(bytes, false)
    : {
        schemaVersion: '2.0',
        subs: [],
        collections: [],
        settings: {},
        artifacts: [],
        files: [],
        modules: [],
        rules: [],
        tokens: []
      }
  if (
    data.schemaVersion !== '2.0' ||
    (data.settings !== undefined && !object(data.settings)) ||
    ['artifacts', 'files', 'modules', 'rules', 'tokens'].some(
      (key) => data[key] !== undefined && !Array.isArray(data[key])
    )
  )
    throw new Error('现有Sub-Store资料不是已确认的2.0数组布局，未合并。')
  const checked = (value: unknown): Data[] => {
    const result = list(value, false)
    const used = new Set<string>()
    return result.map((item) => {
      if (!object(item) || !name(item.name) || used.has(item.name))
        throw new Error('现有Sub-Store名称或数组记录无效，未合并。')
      used.add(item.name)
      return item
    })
  }
  return { ...data, subs: checked(data.subs), collections: checked(data.collections) }
}
function label(item: Data): string | undefined {
  if (
    (item.displayName !== undefined && !name(item.displayName)) ||
    (item['display-name'] !== undefined && !name(item['display-name'])) ||
    (item.displayName !== undefined &&
      item['display-name'] !== undefined &&
      item.displayName !== item['display-name'])
  )
    return undefined
  return (item.displayName ?? item['display-name'] ?? item.name) as string
}
const noProcesses = (item: Data): boolean =>
  item.process === undefined || (Array.isArray(item.process) && item.process.length === 0)
function migrateItem(item: MigrationItem, legacy: boolean, collection = false): MigrationItem {
  const cache: MigrationCache = {
    ...(legacy ? {} : { schemaVersion: '2.0' }),
    subs: legacy ? {} : [],
    collections: legacy ? {} : [],
    artifacts: {},
    rules: {},
    files: {},
    tokens: {}
  }
  const key = collection ? 'collections' : 'subs'
  cache[key] = legacy ? { candidate: { ...item } } : [{ ...item }]
  migrate(cache)
  return Object.values(cache[key])[0]
}

/** Only transforms supplied bytes. It neither reads paths nor starts Sub-Store. */
export function convertLegacySubStore(original: Buffer, baseline?: Buffer): LegacySubStoreResult {
  const input = parse(original, true)
  if (Object.keys(input).length > MAX_ITEMS)
    throw new Error('Sub-Store顶层分类超过200项，未生成无界迁移报告。')
  const legacy = !Object.hasOwn(input, 'schemaVersion')
  if (!legacy && input.schemaVersion !== '2.0')
    throw new Error('Sub-Store版本不是无版本旧map或literal2.0，未降级未知schema。')
  const subs = list(input.subs, legacy),
    collections = list(input.collections, legacy),
    merged = baselineData(baseline)
  const summary: LegacySubStoreResult['summary'] = {
    schema: legacy ? 'legacy-map' : '2.0',
    subscriptions: 0,
    collections: 0,
    items: []
  }
  const names = new Set([...merged.subs, ...merged.collections].map((item) => String(item.name)))
  const sourceHash = createHash('sha256').update(original).digest('hex')
  const technicalName = (kind: string, oldName: string): string => {
    const prefix =
      `relay-import-${kind}-` +
      createHash('sha256')
        .update(sourceHash + ':' + oldName)
        .digest('hex')
        .slice(0, 24)
    let result = prefix
    for (let index = 1; names.has(result); index++) result = prefix + '-' + index
    names.add(result)
    return result
  }
  const occurrences = (items: unknown[]): Map<string, number> => {
    const result = new Map<string, number>()
    for (const item of items)
      if (object(item) && name(item.name)) result.set(item.name, (result.get(item.name) ?? 0) + 1)
    return result
  }
  const subNames = occurrences(subs),
    collectionNames = occurrences(collections),
    mapping = new Map<string, string>()
  const retained = (
    kind: LegacySubStoreItemReport['kind'],
    item: unknown,
    reason: string
  ): void => {
    summary.items.push({
      kind,
      ...(object(item) && name(item.name) ? { oldName: item.name } : {}),
      disposition: 'retained',
      reason
    })
  }
  const append = (kind: 'subscription' | 'collection', item: Data, next: Data): boolean => {
    const target = kind === 'subscription' ? merged.subs : merged.collections
    if (target.length >= MAX_ITEMS) {
      retained(kind, item, '目标类别已达200项；未覆盖或腾空现有记录。')
      return false
    }
    target.push(next)
    if (Buffer.byteLength(JSON.stringify(merged, null, 2)) > MAX_BYTES) {
      target.pop()
      retained(kind, item, '合并候选超过2MiB；整项留在原件。')
      return false
    }
    summary.items.push({
      kind,
      oldName: String(item.name),
      newName: String(next.name),
      disposition: 'accepted',
      reason:
        kind === 'subscription'
          ? '基础订阅以新技术名称加入候选；noFlow=true，未获取订阅或执行处理器。'
          : '静态集合全部引用映射至本次接纳订阅；未执行转换。'
    })
    if (kind === 'subscription') summary.subscriptions++
    else summary.collections++
    return true
  }
  for (const value of subs) {
    if (!object(value) || !name(value.name) || subNames.get(value.name) !== 1 || !label(value)) {
      retained('subscription', value, '订阅名称、显示名或唯一身份无效；整项保留。')
      continue
    }
    if (
      !noProcesses(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            'name',
            'displayName',
            'display-name',
            'source',
            'url',
            'content',
            'noFlow',
            'process'
          ].includes(key)
      )
    ) {
      retained(
        'subscription',
        value,
        '含处理器、proxy/header/合并参数或未知行为字段；未删除行为后迁移。'
      )
      continue
    }
    const source = value.source === undefined && legacy ? 'remote' : value.source
    let valid = source === 'local' || source === 'remote'
    valid &&= value.noFlow === undefined || typeof value.noFlow === 'boolean'
    if (source === 'local') {
      valid &&= typeof value.content === 'string' && !!value.content.trim()
      valid &&= value.url === undefined || value.url === ''
    } else if (source === 'remote') {
      valid &&= typeof value.url === 'string' && !/[\s#]/u.test(value.url) && !controls(value.url)
      valid &&= value.content === undefined || value.content === ''
      try {
        const url = new URL(String(value.url))
        valid &&= ['http:', 'https:'].includes(url.protocol) && !!url.hostname
      } catch {
        valid = false
      }
    }
    if (!valid) {
      retained(
        'subscription',
        value,
        '非基础local/remote正文或单个HTTP(S)URL，或含fragment/混合来源；整项保留。'
      )
      continue
    }
    const migrated = migrateItem({ ...value, source } as MigrationItem, legacy)
    const newName = technicalName('sub', value.name)
    const next = {
      name: newName,
      displayName: label(migrated),
      source: migrated.source,
      ...(source === 'local' ? { content: migrated.content } : { url: migrated.url }),
      noFlow: true
    }
    if (append('subscription', value, next)) mapping.set(value.name, newName)
  }
  for (const value of collections) {
    if (
      !object(value) ||
      !name(value.name) ||
      collectionNames.get(value.name) !== 1 ||
      !label(value)
    ) {
      retained('collection', value, '集合名称、显示名或唯一身份无效；整项保留。')
      continue
    }
    if (
      !noProcesses(value) ||
      Object.keys(value).some(
        (key) => !['name', 'displayName', 'display-name', 'subscriptions', 'process'].includes(key)
      ) ||
      !Array.isArray(value.subscriptions) ||
      !value.subscriptions.length ||
      value.subscriptions.length > MAX_ITEMS ||
      value.subscriptions.some((ref) => !name(ref) || !mapping.has(ref)) ||
      new Set(value.subscriptions).size !== value.subscriptions.length
    ) {
      retained('collection', value, '含处理器/tag/未知行为或引用未被本次完整接纳；整项保留。')
      continue
    }
    const migrated = migrateItem(value, legacy, true)
    append('collection', value, {
      name: technicalName('collection', value.name),
      displayName: label(migrated),
      subscriptions: value.subscriptions.map((ref: string) => mapping.get(ref))
    })
  }
  for (const key of Object.keys(input))
    if (!['schemaVersion', 'subs', 'collections'].includes(key))
      summary.items.push({
        kind: 'section',
        ...([
          'settings',
          'artifacts',
          'files',
          'modules',
          'rules',
          'tokens',
          'root',
          'builtin',
          'archives'
        ].includes(key)
          ? { oldName: key }
          : {}),
        disposition: 'retained',
        reason:
          '旧设置、任务、令牌、脚本、缓存或未知分类留在原件；未知分类名与正文不公开，baseline对应字段保持。'
      })
  return {
    ...(summary.subscriptions || summary.collections
      ? { bytes: Buffer.from(JSON.stringify(merged, null, 2)) }
      : {}),
    summary
  }
}
