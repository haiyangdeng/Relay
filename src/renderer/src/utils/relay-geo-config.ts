import {
  configurationEditDocument,
  type ConfigurationEditDocument,
  type ConfigurationEditRecord
} from '../../../shared/relay/configuration-edit'
import {
  geoOriginSelection,
  type GeoOriginDefinition,
  type GeoOriginInfo,
  type GeoOriginInventory,
  type GeoOriginRecord,
  type GeoOriginSaveRequest,
  type GeoResourceKind
} from '../../../shared/relay/geo-origins'
import type { SourceSchedule } from '../../../shared/relay/subscription-sources'
import type { GeoMode, GeoURLKey } from '../components/resources/geo-data-view'

export async function readGeoSettings(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
): Promise<{ inventory: GeoOriginInventory; urls: Partial<Record<GeoResourceKind, string>> }> {
  const inventory = (await invoke('relayGeoOriginList')) as GeoOriginInventory
  if (!Array.isArray(inventory?.origins) || inventory.origins.length > 4 || inventory.incomplete)
    throw new Error('数据库来源列表未完整读取')
  const urls: Partial<Record<GeoResourceKind, string>> = {}
  for (const info of inventory.origins) {
    const record = (await invoke(
      'relayGeoOriginRead',
      geoOriginSelection({ id: info.id, revision: info.revision })
    )) as GeoOriginRecord
    if (
      record.info.id !== info.id ||
      record.info.revision !== info.revision ||
      Object.hasOwn(urls, info.descriptor.kind)
    )
      throw new Error('数据库来源版本已变化')
    urls[info.descriptor.kind] = geoDraft(info.descriptor.kind, record).url
  }
  return { inventory, urls }
}

export const geoFields: {
  key: GeoURLKey
  kind: GeoResourceKind
  name: string
  url: string
  selector: string
}[] = [
  {
    key: 'geoip',
    kind: 'geoip-dat',
    name: 'GeoIP DAT',
    selector: 'CN',
    url: 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/release/geoip-lite.dat'
  },
  {
    key: 'geosite',
    kind: 'geosite-dat',
    name: 'GeoSite DAT',
    selector: 'CN',
    url: 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/release/geosite.dat'
  },
  {
    key: 'mmdb',
    kind: 'country-mmdb',
    name: 'Country DB',
    selector: 'CN',
    url: 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/release/country.mmdb'
  },
  {
    key: 'asn',
    kind: 'asn-mmdb',
    name: 'ASN DB',
    selector: '64512',
    url: 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/release/GeoLite2-ASN.mmdb'
  }
]
export interface GeoOriginDraft {
  name: string
  url: string
  port: string
  headers: string
  selector: string
  expectedSHA256: string
  requested: boolean
  hours: string
  schedule: SourceSchedule
  hoursChanged: boolean
}
export function geoDraft(kind: GeoResourceKind, record?: GeoOriginRecord): GeoOriginDraft {
  const defaults = geoFields.find((f) => f.kind === kind)
  if (!defaults) throw new Error('资源类型无效')
  if (!record)
    return {
      name: defaults.name,
      url: defaults.url,
      port: '7890',
      headers: '{}',
      selector: defaults.selector,
      expectedSHA256: '',
      requested: false,
      hours: '24',
      schedule: { kind: 'interval', minutes: 1440 },
      hoursChanged: false
    }
  geoOriginSelection({ id: record.info.id, revision: record.info.revision })
  const d = record.definition,
    s = d?.source,
    a = d?.autoIntent
  if (
    record.info.descriptor.kind !== kind ||
    d?.descriptor?.kind !== kind ||
    d.descriptor.behavior !== null ||
    typeof d.descriptor.name !== 'string' ||
    typeof d.descriptor.selector !== 'string' ||
    s?.kind !== 'http' ||
    typeof s.url !== 'string' ||
    !Number.isInteger(s.proxyPort) ||
    !s.headers ||
    typeof s.headers !== 'object' ||
    Array.isArray(s.headers) ||
    Object.values(s.headers).some((v) => typeof v !== 'string') ||
    typeof d.expectedSHA256 !== 'string' ||
    typeof a?.requested !== 'boolean' ||
    !a.schedule ||
    !['manual', 'interval', 'cron'].includes(a.schedule.kind)
  )
    throw new Error('已保存来源无法安全投影，请重读')
  return {
    name: d.descriptor.name,
    url: s.url,
    port: String(s.proxyPort),
    headers: JSON.stringify(s.headers, null, 2),
    selector: d.descriptor.selector,
    expectedSHA256: d.expectedSHA256,
    requested: a.requested,
    hours: a.schedule.kind === 'interval' ? String(a.schedule.minutes / 60) : '',
    schedule: structuredClone(a.schedule),
    hoursChanged: false
  }
}
export function geoSaveRequest(
  kind: GeoResourceKind,
  draft: GeoOriginDraft,
  info?: GeoOriginInfo
): GeoOriginSaveRequest {
  const port = Number(draft.port),
    expected = draft.expectedSHA256.trim(),
    headers: unknown = JSON.parse(draft.headers),
    url = new URL(draft.url)
  if (
    !/^\d+$/u.test(draft.port) ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !headers ||
    typeof headers !== 'object' ||
    Array.isArray(headers) ||
    Object.values(headers).some((v) => typeof v !== 'string') ||
    !draft.name.trim() ||
    !draft.selector.trim() ||
    (expected !== '' && !/^[a-f0-9]{64}$/u.test(expected))
  )
    throw new Error('请核对来源字段')
  let schedule = structuredClone(draft.schedule)
  if (draft.hoursChanged || (draft.requested && schedule.kind === 'manual')) {
    const minutes = Number(draft.hours) * 60
    if (!draft.hours.trim() || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 35791)
      throw new Error('小时周期需换算为1至35791整数分钟')
    schedule = { kind: 'interval', minutes }
  }
  const entries: [string, string][] = []
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') throw new Error('私有请求头无效')
    entries.push([key, value])
  }
  // Create own data properties, including reserved names. Never silently drop
  // an input key before Main's authoritative header validation can reject it.
  const privateHeaders = Object.fromEntries(entries)
  const definition: GeoOriginDefinition = {
    descriptor: { name: draft.name, kind, behavior: null, selector: draft.selector },
    source: { kind: 'http', url: draft.url, proxyPort: port, headers: privateHeaders },
    expectedSHA256: expected,
    autoIntent: { requested: draft.requested, schedule }
  }
  return {
    origin: info ? geoOriginSelection({ id: info.id, revision: info.revision }) : null,
    definition
  }
}
export function geoModeRecord(raw: ConfigurationEditRecord): ConfigurationEditRecord {
  if (!raw || typeof raw.revision !== 'string' || typeof raw.exists !== 'boolean')
    throw new Error('受控草稿记录未确认')
  const document = configurationEditDocument(raw.document)
  geoMode(document)
  return {
    revision: raw.revision,
    exists: raw.exists,
    document
  }
}
export const geoMode = (document: ConfigurationEditDocument): GeoMode => {
  const value = document.controlled['geodata-mode']
  if (value !== undefined && typeof value !== 'boolean') throw new Error('已有Geo模式无法投影')
  return value === undefined ? 'inherit' : value ? 'dat' : 'db'
}
export function geoModeDocument(
  base: ConfigurationEditDocument,
  mode: GeoMode
): ConfigurationEditDocument {
  const next = structuredClone(base)
  if (mode === 'inherit') delete next.controlled['geodata-mode']
  else next.controlled['geodata-mode'] = mode === 'dat'
  return configurationEditDocument(next)
}
